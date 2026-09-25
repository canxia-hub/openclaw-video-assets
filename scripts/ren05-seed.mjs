// REN-05 / scripts/ren05-seed.mjs
//
// Builds the isolated REN-05 workspace: an empty repository root, the synthesized fixtures, the
// ingest of those fixtures, and a full set of REAL derivations. Everything lands in one run
// directory, and `seed.json` records every id and hash the later checks need.
//
// Nothing here touches production: the repository root is a fresh directory under the run path, and
// no production object, database, or configuration is read or written.
//
// Usage: node scripts/ren05-seed.mjs --run <dir> [--fixtures <dir>]

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";
import { resolveMediaTools } from "../src/media-transcode.js";

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const runDir = arg("run");
const fixturesDir = arg("fixtures", path.join(runDir ?? ".", "fixtures"));
if (!runDir) {
  console.error("usage: node scripts/ren05-seed.mjs --run <dir> [--fixtures <dir>]");
  process.exit(2);
}

const repoRoot = path.join(runDir, "repo");
const evidenceDir = path.join(runDir, "evidence");
await fs.promises.mkdir(repoRoot, { recursive: true });
await fs.promises.mkdir(evidenceDir, { recursive: true });

const fixtureIndex = JSON.parse(fs.readFileSync(path.join(fixturesDir, "fixtures-index.json"), "utf8"));
const tools = await resolveMediaTools();

const service = new VideoAssetService({ pluginConfig: { repositoryRoot: repoRoot }, logger: { info() {}, warn() {}, error() {}, debug() {} } }).init();
const result = {
  generated_at: new Date().toISOString(),
  run_dir: runDir,
  repository_root: repoRoot,
  fixtures_index: path.join(fixturesDir, "fixtures-index.json"),
  toolchain: { ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, ffmpeg_version: tools.ffmpeg_version, available: tools.available },
  assets: [],
  derivations: [],
  notes: []
};

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

try {
  // --- ingest every fixture so each media kind has a resident asset ---------------------------
  const ingestPlan = [
    { file: "clip_720p_2s.mp4", title: "REN-05 720p clip", kind: "raw" },
    { file: "clip_480p_3s.mov", title: "REN-05 480p mov clip", kind: "raw" },
    { file: "audio_440hz_3s.wav", title: "REN-05 440Hz wav", kind: "raw" },
    { file: "audio_220hz_2s.mp3", title: "REN-05 220Hz mp3", kind: "raw" },
    { file: "still_1024x768.png", title: "REN-05 1024x768 still", kind: "raw" },
    { file: "still_640x480.jpg", title: "REN-05 640x480 still", kind: "raw" }
  ];
  for (const item of ingestPlan) {
    const filePath = path.join(fixturesDir, item.file);
    const asset = await service.ingestAsset({ file_path: filePath, title: item.title, kind: item.kind });
    const version = service.getVersionRow(asset.default_version_id);
    const entry = {
      file: item.file,
      title: item.title,
      asset_id: asset.asset_id,
      asset_version_id: asset.default_version_id,
      media_type: asset.media_type,
      extension: version.extension,
      mime_type: version.mime_type,
      size_bytes: version.size_bytes,
      sha256: version.sha256,
      probe: {
        width: version.width ?? null,
        height: version.height ?? null,
        duration_ms: version.duration_ms ?? null,
        codec: version.codec ?? null,
        sample_rate: version.sample_rate ?? null,
        channels: version.channels ?? null,
        frame_rate: version.frame_rate ?? null
      }
    };
    result.assets.push(entry);
    console.log(`ingested ${item.file.padEnd(24)} -> ${asset.asset_id} ver=${asset.default_version_id} type=${asset.media_type} dur=${version.duration_ms ?? "-"} codec=${version.codec ?? "-"}`);
  }
  const byFile = Object.fromEntries(result.assets.map((a) => [a.file, a]));

  // --- real derivations -----------------------------------------------------------------------
  const derivationPlan = [
    { file: "still_1024x768.png", derivative_type: "thumbnail", parameters: { width: 256 } },
    { file: "clip_720p_2s.mp4", derivative_type: "thumbnail", parameters: { width: 320, offset_ms: 500 } },
    { file: "clip_720p_2s.mp4", derivative_type: "proxy", parameters: { width: 640 } },
    { file: "clip_480p_3s.mov", derivative_type: "proxy", parameters: { width: 480 } },
    { file: "audio_440hz_3s.wav", derivative_type: "audio_proxy", parameters: {} },
    { file: "audio_440hz_3s.wav", derivative_type: "waveform", parameters: { width: 512, height: 128 } }
  ];
  for (const item of derivationPlan) {
    const asset = byFile[item.file];
    const derived = await service.generateDerivedFile({
      asset_version_id: asset.asset_version_id,
      derivative_type: item.derivative_type,
      parameters: item.parameters
    });
    const stored = service.resolveDerivedFile(derived.derived_file_id, [item.derivative_type]);
    result.derivations.push({
      source_file: item.file,
      source_asset_version_id: asset.asset_version_id,
      derivative_type: derived.derivative_type,
      derived_file_id: derived.derived_file_id,
      profile: derived.profile,
      mime_type: derived.mime_type,
      size_bytes: derived.size_bytes,
      sha256: derived.sha256,
      width: derived.width ?? null,
      height: derived.height ?? null,
      duration_ms: derived.duration_ms ?? null,
      generator: derived.metadata?.generator ?? null,
      profile_key: derived.metadata?.profile_key ?? null,
      verification: derived.metadata?.verification ?? null,
      source_size_bytes: asset.size_bytes,
      distinct_from_source: derived.sha256 !== asset.sha256,
      object_path_exists: fs.existsSync(stored.file_path)
    });
    console.log(`derived  ${item.derivative_type.padEnd(12)} from ${item.file.padEnd(24)} -> ${derived.derived_file_id} ${derived.size_bytes} B profile=${derived.profile}`);
  }

  // --- a project that references the media, so the routes serve within a real catalog ----------
  const project = service.createProject({ title: "REN-05 protected stream project", target_platforms: ["douyin"] });
  for (const asset of result.assets.slice(0, 4)) {
    service.addProjectRef({ project_id: project.project_id, asset_id: asset.asset_id, asset_version_id: asset.asset_version_id, role: "source", required: false });
  }
  result.project_id = project.project_id;

  // --- evidence: capabilities + integrity before any fault injection --------------------------
  const capabilities = await service.derivationCapabilities();
  const scanBefore = service.integrityScan({ deep: true });
  const stateBefore = {
    assets: service.db.prepare("SELECT COUNT(*) AS n FROM assets").get().n,
    versions: service.db.prepare("SELECT COUNT(*) AS n FROM asset_versions").get().n,
    derived_files: service.db.prepare("SELECT COUNT(*) AS n FROM derived_files").get().n,
    default_versions: Object.fromEntries(result.assets.map((a) => [a.asset_id, service.getAsset({ asset_id: a.asset_id }).default_version_id]))
  };
  result.capabilities = capabilities;
  result.integrity_before = { ok: scanBefore.ok, scanned: scanBefore.scanned, issue_count: scanBefore.issues.length, errors: scanBefore.errors };
  result.state_before = stateBefore;
  result.fixture_hashes = Object.fromEntries(await Promise.all(fixtureIndex.fixtures.map(async (f) => [f.file, await sha256File(path.join(fixturesDir, f.file))])));

  await fs.promises.writeFile(path.join(runDir, "seed.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`seed written -> ${path.join(runDir, "seed.json")}`);
  console.log(`integrity before: ok=${scanBefore.ok} issues=${scanBefore.issues.length}`);
} finally {
  service.close();
}
