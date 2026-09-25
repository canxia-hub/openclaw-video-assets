// REN-05 / scripts/ren05-fixtures.mjs
//
// Builds the LOCAL, SYNTHESIZED media fixture set used by every REN-05 acceptance check.
//
// Provenance: every fixture is produced on this machine by ffmpeg from synthetic sources
// (testsrc / sine / solid colour). Nothing is downloaded, nothing is paid for, and no production
// or third-party asset is copied in. The index written next to the fixtures records, per file, the
// exact ffmpeg command that produced it, its sha256, and what it is used for.
//
// Usage: node scripts/ren05-fixtures.mjs --out <dir> [--force]

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveMediaTools } from "../src/media-transcode.js";

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const outDir = arg("out");
const force = process.argv.includes("--force");
if (!outDir) {
  console.error("usage: node scripts/ren05-fixtures.mjs --out <dir> [--force]");
  process.exit(2);
}

const tools = await resolveMediaTools();
if (!tools.available) {
  console.error(`ffmpeg/ffprobe unavailable (ffmpeg=${tools.ffmpeg}, ffprobe=${tools.ffprobe})`);
  process.exit(3);
}

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(tools.ffmpeg, ["-hide_banner", "-nostdin", "-y", ...args], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${path.basename(tools.ffmpeg)} failed: ${String(stderr).slice(-800)}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * name        - output file name
 * purpose     - what the acceptance check uses it for
 * args        - ffmpeg arguments (recorded verbatim as provenance)
 * constraints - what the fixture must satisfy (asserted by the verification step)
 */
const FIXTURES = [
  {
    name: "clip_720p_2s.mp4",
    purpose: "video derivation source: poster thumbnail, H.264 proxy, range/seek playback",
    constraints: { container: "mp4", duration_ms: [1800, 2200], width: 1280, height: 720 },
    args: ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "{out}"]
  },
  {
    name: "clip_480p_3s.mov",
    purpose: "video derivation source in a second container (mov), range playback",
    constraints: { container: "mov", duration_ms: [2800, 3200], width: 854, height: 480 },
    args: ["-f", "lavfi", "-i", "testsrc2=size=854x480:rate=24:duration=3", "-f", "lavfi", "-i", "sine=frequency=330:duration=3", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "{out}"]
  },
  {
    name: "audio_440hz_3s.wav",
    purpose: "audio derivation source: AAC audition copy and waveform image",
    constraints: { container: "wav", duration_ms: [2800, 3200], sample_rate: 44100, channels: 1 },
    args: ["-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=44100", "-c:a", "pcm_s16le", "{out}"]
  },
  {
    name: "audio_220hz_2s.mp3",
    purpose: "audio derivation source in a container the baseline probe could not read (mp3)",
    constraints: { container: "mp3", duration_ms: [1800, 2200], sample_rate: 44100, channels: 1 },
    args: ["-f", "lavfi", "-i", "sine=frequency=220:duration=2:sample_rate=44100", "-c:a", "libmp3lame", "-b:a", "128k", "{out}"]
  },
  {
    name: "still_1024x768.png",
    purpose: "image derivation source: downscaled thumbnail",
    constraints: { container: "png", width: 1024, height: 768 },
    args: ["-f", "lavfi", "-i", "testsrc2=size=1024x768:rate=1:duration=1", "-frames:v", "1", "{out}"]
  },
  {
    name: "still_640x480.jpg",
    purpose: "image derivation source in a lossy container",
    constraints: { container: "jpeg", width: 640, height: 480 },
    args: ["-f", "lavfi", "-i", "testsrc2=size=640x480:rate=1:duration=1", "-frames:v", "1", "-q:v", "3", "{out}"]
  },
  {
    name: "unsupported_archive.zip",
    purpose: "NEGATIVE control: a non-media file that must be refused rather than copied as a thumbnail",
    constraints: { not_media: true },
    args: null,
    raw: Buffer.from("PK\x03\x04REN-05 negative-control fixture (not a media file)\n", "utf8")
  }
];

await fs.promises.mkdir(outDir, { recursive: true });

const entries = [];
for (const fixture of FIXTURES) {
  const target = path.join(outDir, fixture.name);
  const already = fs.existsSync(target);
  if (fixture.raw) {
    if (!already || force) await fs.promises.writeFile(target, fixture.raw);
  } else if (!already || force) {
    const args = fixture.args.map((a) => (a === "{out}" ? target : a));
    await run(args);
  }
  if (!fs.existsSync(target)) throw new Error(`fixture was not created: ${fixture.name}`);
  const stat = await fs.promises.stat(target);
  entries.push({
    file: fixture.name,
    purpose: fixture.purpose,
    size_bytes: stat.size,
    sha256: await sha256(target),
    constraints: fixture.constraints,
    provenance: fixture.raw
      ? { kind: "synthesized-bytes", note: "written directly by this script; not media" }
      : { kind: "ffmpeg-synthesized", tool: tools.ffmpeg, version: tools.ffmpeg_version, args: fixture.args }
  });
}

const index = {
  generated_at: new Date().toISOString(),
  generator: "scripts/ren05-fixtures.mjs",
  provenance_policy: "Every fixture is synthesized locally by ffmpeg from lavfi synthetic sources. No download, no purchase, no production asset, no third-party asset.",
  toolchain: { ffmpeg: tools.ffmpeg, ffmpeg_version: tools.ffmpeg_version, ffprobe: tools.ffprobe, ffprobe_version: tools.ffprobe_version },
  fixtures: entries
};
const indexPath = path.join(outDir, "fixtures-index.json");
await fs.promises.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
console.log(`fixtures: ${entries.length} written -> ${indexPath}`);
for (const e of entries) console.log(`  ${e.file.padEnd(28)} ${String(e.size_bytes).padStart(9)} B  ${e.sha256.slice(0, 16)}`);
