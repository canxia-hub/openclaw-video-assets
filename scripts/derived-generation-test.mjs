import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-derived-generation-"));
const repo = path.join(tmp, "repo");
const imagePath = path.join(tmp, "source.png");
const videoPath = path.join(tmp, "source.mp4");

await fs.promises.writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"));
await fs.promises.writeFile(videoPath, Buffer.concat([
  Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom", "ascii"),
  Buffer.from([0, 0, 2, 0]), Buffer.from("isomiso2avc1mp41", "ascii"),
  Buffer.from([0, 0, 0, 8]), Buffer.from("free", "ascii")
]));

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const image = await svc.ingestAsset({ file_path: imagePath, title: "Derived Image Source", kind: "working" });
  const video = await svc.ingestAsset({ file_path: videoPath, title: "Derived Video Source", kind: "working" });

  const thumbnail = await svc.generateDerivedFile({
    asset_version_id: image.default_version_id,
    derivative_type: "thumbnail",
    width: 64
  });
  assert.equal(thumbnail.derivative_type, "thumbnail");
  assert.equal(thumbnail.mime_type, "image/png");
  assert.equal(thumbnail.metadata.generator, "safe-copy");
  assert.equal(thumbnail.metadata.parameters.width, 64);

  const proxy = await svc.generateDerivedFile({
    asset_version_id: video.default_version_id,
    derivative_type: "proxy",
    width: 64
  });
  assert.equal(proxy.derivative_type, "proxy");
  assert.equal(proxy.mime_type, "video/mp4");
  assert.equal(proxy.metadata.generator, "safe-copy");

  const resolvedThumbnail = svc.resolveDerivedFile(image.default_version_id, ["thumbnail"]);
  assert.equal(resolvedThumbnail.derived_file_id, thumbnail.derived_file_id);
  assert.equal(resolvedThumbnail.sha256, await sha256(resolvedThumbnail.file_path));

  const resolvedProxy = svc.resolveDerivedFile(proxy.derived_file_id, ["proxy"]);
  assert.equal(resolvedProxy.derived_file_id, proxy.derived_file_id);
  assert.equal(resolvedProxy.sha256, await sha256(resolvedProxy.file_path));

  const scan = svc.integrityScan({ deep: true });
  assert.equal(scan.ok, true, JSON.stringify(scan, null, 2));
  assert.equal(scan.scanned.derived_files, 2);
  console.log("derived generation test passed");
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
