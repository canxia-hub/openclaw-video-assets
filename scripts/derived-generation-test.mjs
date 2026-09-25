// REN-05: rewritten. The previous version asserted the behaviour REN-05 removes.
//
// WHAT CHANGED AND WHY THIS TEST CHANGED WITH IT
// ----------------------------------------------
// The baseline generated a "derived file" by copying the source and recorded
// `metadata.generator = "safe-copy"`. This test used to assert exactly that: it wrote a 143-byte
// PNG and a 32-byte fake MP4 (ftyp/free boxes only, no frames), asked for a thumbnail and a proxy,
// and checked that the results were byte-copies of the inputs. It passed because nothing decoded
// anything.
//
// REN-05 replaces that path with real ffmpeg derivations, so the old assertions are no longer the
// contract and are not merely "fixed up": the test now synthesises REAL media with ffmpeg, and the
// assertions are about the artifact that was actually produced (dimensions, duration, codec,
// distinctness from the source). The cases that must now FAIL - a derivative this build can not
// produce - are asserted as coded refusals, including the guarantee that no copy is left behind.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";
import { resolveMediaTools } from "../src/media-transcode.js";

const tools = await resolveMediaTools();
if (!tools.available) {
  // A missing toolchain is a real capability gap in this build, not a reason to skip silently.
  throw new Error(`ffmpeg/ffprobe are required to generate derived media, and the toolchain is unavailable (ffmpeg=${tools.ffmpeg}, ffprobe=${tools.ffprobe})`);
}

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-derived-generation-"));
const repo = path.join(tmp, "repo");
const imagePath = path.join(tmp, "source.png");
const videoPath = path.join(tmp, "source.mp4");
const textPath = path.join(tmp, "notes.txt");

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(tools.ffmpeg, ["-hide_banner", "-nostdin", "-y", ...args], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`ffmpeg failed: ${String(stderr).slice(-500)}`));
      else resolve(stdout);
    });
  });
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// Real fixtures, synthesized locally.
await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1024x768:rate=1:duration=1", "-frames:v", "1", imagePath]);
await ffmpeg([
  "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=2",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
  "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k",
  "-movflags", "+faststart", videoPath
]);
await fs.promises.writeFile(textPath, "not a media file", "utf8");

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const image = await svc.ingestAsset({ file_path: imagePath, title: "Derived Image Source", kind: "working" });
  const video = await svc.ingestAsset({ file_path: videoPath, title: "Derived Video Source", kind: "working" });
  const text = await svc.ingestAsset({ file_path: textPath, title: "Derived Text Source", kind: "working" });

  // ---- real thumbnail from an image ----------------------------------------------------------
  const thumbnail = await svc.generateDerivedFile({
    asset_version_id: image.default_version_id,
    derivative_type: "thumbnail",
    parameters: { width: 256 }
  });
  assert.equal(thumbnail.derivative_type, "thumbnail");
  assert.equal(thumbnail.mime_type, "image/jpeg");
  assert.equal(thumbnail.metadata.generator, "ffmpeg");
  assert.equal(thumbnail.metadata.profile_key, "thumbnail_image");
  assert.equal(thumbnail.metadata.parameters.width, 256);
  assert.equal(thumbnail.width, 256, "the produced thumbnail must be the requested width");
  assert.notEqual(thumbnail.sha256, image.sha256 ?? (await sha256(imagePath)), "a thumbnail must not be a copy of its source");
  assert.ok(thumbnail.metadata.verification.some((c) => c.name === "width_matches_request" && c.ok === true), "the artifact must be ffprobe-verified");

  // ---- real thumbnail + proxy from a video ---------------------------------------------------
  const poster = await svc.generateDerivedFile({
    asset_version_id: video.default_version_id,
    derivative_type: "thumbnail",
    parameters: { width: 320, offset_ms: 500 }
  });
  assert.equal(poster.mime_type, "image/jpeg");
  assert.equal(poster.metadata.profile_key, "thumbnail_video");
  assert.equal(poster.width, 320);

  const proxy = await svc.generateDerivedFile({
    asset_version_id: video.default_version_id,
    derivative_type: "proxy",
    parameters: { width: 320 }
  });
  assert.equal(proxy.derivative_type, "proxy");
  assert.equal(proxy.mime_type, "video/mp4");
  assert.equal(proxy.metadata.generator, "ffmpeg");
  assert.equal(proxy.metadata.profile_key, "proxy_video");
  assert.ok(proxy.duration_ms >= 1800 && proxy.duration_ms <= 2200, `the proxy must carry the clip's duration, got ${proxy.duration_ms}ms`);

  // ---- the resolution helpers still behave ---------------------------------------------------
  const resolvedThumbnail = svc.resolveDerivedFile(image.default_version_id, ["thumbnail"]);
  assert.equal(resolvedThumbnail.derived_file_id, thumbnail.derived_file_id);
  assert.equal(resolvedThumbnail.sha256, await sha256(resolvedThumbnail.file_path));

  const resolvedProxy = svc.resolveDerivedFile(proxy.derived_file_id, ["proxy"]);
  assert.equal(resolvedProxy.derived_file_id, proxy.derived_file_id);
  assert.equal(resolvedProxy.sha256, await sha256(resolvedProxy.file_path));

  // ---- refusals: unsupported pairs fail, and never copy --------------------------------------
  await assert.rejects(
    () => svc.generateDerivedFile({ asset_version_id: text.default_version_id, derivative_type: "thumbnail" }),
    (error) => error.code === "DERIVATION_KIND_UNKNOWN",
    "a text file must not yield a thumbnail"
  );
  await assert.rejects(
    () => svc.generateDerivedFile({ asset_version_id: image.default_version_id, derivative_type: "proxy" }),
    (error) => error.code === "DERIVATION_UNSUPPORTED",
    "an image must not yield a video proxy"
  );
  await assert.rejects(
    () => svc.generateDerivedFile({ asset_version_id: video.default_version_id, derivative_type: "waveform" }),
    (error) => error.code === "DERIVATION_UNSUPPORTED",
    "a video must not yield an audio waveform"
  );

  // A refused derivation must not have registered anything.
  const derivedForText = svc.listDerivedFiles({ asset_version_id: text.default_version_id });
  assert.equal(derivedForText.length, 0, "a refused derivation must not register a derived file");
  const derivedForImage = svc.listDerivedFiles({ asset_version_id: image.default_version_id });
  assert.ok(derivedForImage.every((d) => d.derivative_type === "thumbnail"), "only the supported derivative was registered for the image");

  // ---- the source objects are untouched ------------------------------------------------------
  assert.equal(svc.resolveVersionFile(image.default_version_id).sha256, await sha256(imagePath));
  assert.equal(svc.resolveVersionFile(video.default_version_id).sha256, await sha256(videoPath));

  const scan = svc.integrityScan({ deep: true });
  assert.equal(scan.ok, true, JSON.stringify(scan, null, 2));
  assert.equal(scan.scanned.derived_files, 3, "image thumbnail + video poster + video proxy");

  console.log("derived generation test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
