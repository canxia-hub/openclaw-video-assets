import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-media-"));
const repo = path.join(tmp, "repo");
const fixtures = [
  {
    name: "fixture.png",
    media_type: "image",
    mime_type: "image/png",
    bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64")
  },
  {
    name: "fixture.webp",
    media_type: "image",
    mime_type: "image/webp",
    bytes: Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AA/vuUAAA=", "base64")
  },
  {
    name: "fixture.svg",
    media_type: "image",
    format_family: "vector",
    mime_type: "image/svg+xml",
    width: 640,
    height: 360,
    bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360"/></svg>', "utf8")
  },
  {
    name: "fixture.mp4",
    media_type: "video",
    mime_type: "video/mp4",
    bytes: Buffer.concat([
      Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom", "ascii"),
      Buffer.from([0, 0, 2, 0]), Buffer.from("isomiso2avc1mp41", "ascii"),
      Buffer.from([0, 0, 0, 8]), Buffer.from("free", "ascii")
    ])
  },
  {
    name: "fixture.wav",
    media_type: "audio",
    mime_type: "audio/wav",
    bytes: createTinyWav()
  },
  {
    name: "fixture.mp3",
    media_type: "audio",
    mime_type: "audio/mpeg",
    bytes: Buffer.concat([Buffer.from([73, 68, 51, 3, 0, 0, 0, 0, 0, 0]), Buffer.from([255, 251, 144, 100, 0, 0, 0, 0])])
  }
];

const realVideoFixture = findRealMp4Fixture();
if (realVideoFixture) fixtures.push(realVideoFixture);

for (const fixture of fixtures) {
  const filePath = path.join(tmp, fixture.name);
  if (fixture.source_path) {
    fixture.path = fixture.source_path;
  } else {
    await fs.promises.writeFile(filePath, fixture.bytes);
    fixture.path = filePath;
  }
  assert.ok((await fs.promises.stat(fixture.path)).size > 0, `${fixture.name} should be non-empty`);
}

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const project = svc.createProject({ title: "Real Media Fixtures" });
  for (const fixture of fixtures) {
    const ingested = await svc.ingestAsset({ file_path: fixture.path, title: fixture.name, kind: "raw" });
    assert.equal(ingested.media_type, fixture.media_type);
    if (fixture.format_family) assert.equal(ingested.format_family, fixture.format_family);
    assert.equal(ingested.versions[0].mime_type, fixture.mime_type);
    if (fixture.width) assert.equal(ingested.versions[0].width, fixture.width);
    if (fixture.height) assert.equal(ingested.versions[0].height, fixture.height);

    const updated = await svc.createVersion({
      asset_id: ingested.asset_id,
      file_path: fixture.path,
      change_summary: `Re-save ${fixture.name}`,
      change_items: [{ category: "fixture", summary: `Verified ${fixture.name}`, tool: "inline-fixture" }]
    });
    assert.equal(updated.versions.length, 2);

    const ref = svc.addProjectRef({ project_id: project.project_id, asset_id: ingested.asset_id, role: "fixture", usage_scope: fixture.media_type });
    assert.equal(ref.asset_version_id, updated.default_version_id);

    const resolved = svc.resolveVersionFile(ref.asset_version_id);
    assert.equal(resolved.sha256, await sha256(resolved.file_path));
    assert.equal(resolved.size_bytes, (await fs.promises.stat(resolved.file_path)).size);
    assert.equal(resolved.mime_type, fixture.mime_type);
    if (fixture.expect) {
      assertVideoProbe(ingested.versions[0], fixture.expect, `${fixture.name} initial version`);
      assertVideoProbe(updated.versions.at(-1), fixture.expect, `${fixture.name} updated version`);
      assertVideoProbe(resolved, fixture.expect, `${fixture.name} resolved version`);

      clearVideoMetadata(svc, ref.asset_version_id);
      const lazyAsset = svc.getAsset({ asset_id: ingested.asset_id });
      assertVideoProbe(lazyAsset.versions.find((version) => version.asset_version_id === ref.asset_version_id), fixture.expect, `${fixture.name} lazy asset get`);

      clearVideoMetadata(svc, ref.asset_version_id);
      const lazyResolved = svc.resolveVersionFile(ref.asset_version_id);
      assertVideoProbe(lazyResolved, fixture.expect, `${fixture.name} lazy resolved version`);
    }
  }
  assert.equal(svc.listProjectRefs({ project_id: project.project_id }).length, fixtures.length);
  console.log("media fixtures test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function createTinyWav() {
  const dataBytes = 16;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(8000, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

function findRealMp4Fixture() {
  const workspace = process.env.OVA_WORKSPACE_ROOT || path.resolve(process.cwd(), "../../../..");
  const sourcePath = path.join(workspace, "assets/source-video/by-project/openclaw-video-asset-plugin/video-assets-b4__srcvid__metadata-probe__20260523__v01.mp4");
  if (fs.existsSync(sourcePath)) {
    return {
      name: "fixture-real.mp4",
      media_type: "video",
      mime_type: "video/mp4",
      source_path: sourcePath,
      expect: { width: 160, height: 90, duration_ms: 2000, frame_rate: 24, codec: "h264" }
    };
  }
  console.warn("real MP4 metadata fixture unavailable; skipping deep video assertions");
  return null;
}

function assertVideoProbe(actual, expected, label) {
  assert.equal(actual.width, expected.width, `${label} width`);
  assert.equal(actual.height, expected.height, `${label} height`);
  assert.ok(Math.abs(actual.duration_ms - expected.duration_ms) <= 50, `${label} duration_ms`);
  assert.ok(Math.abs(actual.frame_rate - expected.frame_rate) <= 0.001, `${label} frame_rate`);
  assert.equal(actual.codec, expected.codec, `${label} codec`);
}

function clearVideoMetadata(svc, assetVersionId) {
  svc.db.prepare(`UPDATE asset_versions
    SET width = NULL, height = NULL, duration_ms = NULL, frame_rate = NULL, codec = NULL
    WHERE asset_version_id = ?`).run(assetVersionId);
}
