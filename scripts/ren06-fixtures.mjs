// REN-06 / scripts/ren06-fixtures.mjs
//
// Media fixtures for the upload acceptance run, each with its command, hash and purpose recorded.
//
// Rules followed here, same as REN-05:
//   * Everything is synthesized LOCALLY by ffmpeg from lavfi sources. No download, no third-party
//     material, no production asset is read or copied.
//   * The index records the exact command, the ffmpeg version and the sha256 of every file, so the
//     fixtures can be identified later even though they live only in this package.
//   * The 200 MiB fixture is a REAL decodable h264+aac file, not a stub with a valid header: the point of
//     the acceptance run is that legitimate large media uploads work, and a fake file would not test the
//     hash-verified ingest path or the content check honestly.
//
// Usage: node scripts/ren06-fixtures.mjs --out <dir>

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

/**
 * Resolve the ffmpeg binary the same way the plugin itself does (env override, then PATH, then the known
 * install locations). `execFile("ffmpeg")` alone failed under this host even though `where.exe` finds it,
 * which is exactly the PATH difference the plugin's own resolver already handles.
 */
async function resolveFfmpeg() {
  const candidates = [
    process.env.VIDEO_ASSETS_FFMPEG,
    "ffmpeg",
    "C:\\tools\\ffmpeg\\ffmpeg.exe",
    "C:\\Tools\\ffmpeg\\ffmpeg.exe"
  ].filter((value) => value && String(value).trim() !== "");
  for (const candidate of candidates) {
    try {
      // `ffmpeg -version` writes to STDOUT, not stderr. Reading only stderr made every candidate look
      // empty and the resolver reported "could not be resolved" for a binary that runs fine - so both
      // streams are checked and the first non-empty line wins.
      const { stdout, stderr } = await execFileAsync(candidate, ["-version"], { windowsHide: true });
      const line = `${String(stdout ?? "")}${String(stderr ?? "")}`.split("\n").map((value) => value.trim()).find((value) => value !== "") ?? "";
      if (line) return { binary: candidate, version: line };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const outDir = arg("out");
if (!outDir) {
  console.error("usage: node scripts/ren06-fixtures.mjs --out <dir>");
  process.exit(2);
}
await fs.promises.mkdir(outDir, { recursive: true });

const records = [];

async function ffmpegVersion() {
  const resolved = await resolveFfmpeg();
  return resolved ? { binary: resolved.binary, version: resolved.version } : null;
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function synthesise({ file, args, purpose, kind = "ffmpeg-synthesized" }) {
  const target = path.join(outDir, file);
  if (fs.existsSync(target)) await fs.promises.rm(target, { force: true });
  const command = `${FFMPEG_BINARY} ${args.map((value) => (String(value).includes(" ") ? `"${value}"` : value)).join(" ")}`;
  if (kind === "ffmpeg-synthesized") {
    await execFileAsync(FFMPEG_BINARY, [...args, "-y", target], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  }
  const stat = await fs.promises.stat(target);
  const sha256 = await sha256File(target);
  records.push({ file, purpose, provenance: { kind, command, tool: kind === "ffmpeg-synthesized" ? "ffmpeg" : "local-bytes" }, size_bytes: stat.size, sha256 });
  return { file, size_bytes: stat.size, sha256, target };
}

const resolved = await ffmpegVersion();
if (!resolved) {
  console.error("ABORT: ffmpeg could not be resolved; the large fixture must be a real decodable file.");
  process.exit(3);
}
const version = resolved.version;
const FFMPEG_BINARY = resolved.binary;

// 1) The acceptance file: a real decodable MP4 of at least 200 MB (decimal).
//
// The noise filter is not decoration: x264 undershoots a target bitrate badly on synthetic test patterns
// (a first attempt at 25 Mbps produced only 119 MB), so a plain testsrc2 gradient would have quietly
// produced a file well under the acceptance size. Noise makes the content genuinely hard to compress, which
// is what a real 200 MB video looks like from a size standpoint. The actual size is measured and recorded
// rather than assumed.
await synthesise({
  file: "upload_200mb.mp4",
  purpose: "the acceptance upload: a real decodable MP4 of at least 200 MB, used for the hash-verified upload and the peak-RSS measurement",
  args: [
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-vf", "noise=alls=30:allf=t",
    "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "45M", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-t", "40", "-shortest", "-movflags", "+faststart"
  ]
});

// 2) The size control: the same pipeline at a small fraction of the size. If peak memory grew with file
//    size, these two runs would differ by two orders of magnitude; they must not.
await synthesise({
  file: "upload_4mb.mp4",
  purpose: "size control for the peak-RSS comparison: identical codec, filter chain and muxer, ~4 MB",
  args: [
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-vf", "noise=alls=30:allf=t",
    "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "45M", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-t", "0.75", "-shortest", "-movflags", "+faststart"
  ]
});

// 3) A legitimately small image and text file, to show the accepting path is not video-only.
await synthesise({
  file: "upload_thumb.png",
  purpose: "small legitimate image upload through the same route",
  args: ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=1", "-frames:v", "1"]
});
// The text fixture is written directly: `synthesise` runs ffmpeg, and a text file has no encoder. Writing
// it through the ffmpeg branch (as an earlier version did) produced no file at all and then failed on the
// stat - the record below is what keeps it in the provenance index.
{
  const textPath = path.join(outDir, "upload_notes.txt");
  const text = "REN-06 fixture: text-family upload used to show the text path is accepted.\n";
  await fs.promises.writeFile(textPath, text);
  const stat = await fs.promises.stat(textPath);
  records.push({
    file: "upload_notes.txt",
    purpose: "text-family upload (no magic number; the text path must accept it)",
    provenance: { kind: "local-bytes", command: "literal UTF-8 string written by the fixtures script", tool: "node:fs" },
    size_bytes: stat.size,
    sha256: await sha256File(textPath)
  });
}

// 4) Deliberately wrong content, both kinds.
const mismatched = path.join(outDir, "mismatched_video.mp4"); // PNG bytes under a .mp4 name
await fs.promises.writeFile(mismatched, await fs.promises.readFile(path.join(outDir, "upload_thumb.png")));
{
  const stat = await fs.promises.stat(mismatched);
  records.push({
    file: "mismatched_video.mp4",
    purpose: "content contradiction: PNG bytes under a .mp4 name, which must be refused/quarantined rather than catalogued as a video",
    provenance: { kind: "derived-from-fixture", command: "copy upload_thumb.png -> mismatched_video.mp4", tool: "node:fs" },
    size_bytes: stat.size,
    sha256: await sha256File(mismatched)
  });
}
const unknown = path.join(outDir, "unknown_media.mp4"); // bytes matching no signature
await fs.promises.writeFile(unknown, crypto.randomBytes(256 * 1024));
{
  const stat = await fs.promises.stat(unknown);
  records.push({
    file: "unknown_media.mp4",
    purpose: "unrecognisable content under a permitted extension: must be QUARANTINED (kept) and never ingested",
    provenance: { kind: "local-bytes", command: "node:crypto.randomBytes(262144)", tool: "node:crypto" },
    size_bytes: stat.size,
    sha256: await sha256File(unknown)
  });
}
const archive = path.join(outDir, "notes.txt"); // text content, allowed extension
await fs.promises.writeFile(archive, "REN-06 fixture note: synthesized locally for the upload acceptance run.\n");
{
  const stat = await fs.promises.stat(archive);
  records.push({
    file: "notes.txt",
    purpose: "plain text fixture",
    provenance: { kind: "local-bytes", command: "literal string written by the fixtures script", tool: "node:fs" },
    size_bytes: stat.size,
    sha256: await sha256File(archive)
  });
}
// Overwrite the placeholder produced by the ffmpeg call above for notes.txt with real text.await fs.promises.writeFile(path.join(outDir, "upload_notes.txt"), "REN-06 fixture: text-family upload used to show the text path is accepted.\n");

const index = {
  generated_at: new Date().toISOString(),
  toolchain: { ffmpeg_binary: FFMPEG_BINARY, ffmpeg_version: version },
  acceptance_size_check: {
    requirement: "at least 200 MB (decimal)",
    largest_fixture_bytes: records.filter((r) => r.file === "upload_200mb.mp4").map((r) => r.size_bytes)[0] ?? 0,
    satisfies_requirement: (records.filter((r) => r.file === "upload_200mb.mp4").map((r) => r.size_bytes)[0] ?? 0) >= 200 * 1000 * 1000
  },
  provenance_policy: "Every fixture is synthesized locally by ffmpeg from lavfi synthetic sources or written from local bytes. No download, no third-party material, no production asset. Each entry records the exact command and the sha256 of the result.",
  out_dir: outDir,
  fixtures: records
};
await fs.promises.writeFile(path.join(outDir, "fixtures-index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");

for (const record of records) {
  console.log(`${record.file.padEnd(24)} ${String(record.size_bytes).padStart(11)} bytes  sha256=${record.sha256.slice(0, 16)}…  ${record.purpose.slice(0, 60)}`);
}
console.log(`fixtures written to ${outDir}`);
