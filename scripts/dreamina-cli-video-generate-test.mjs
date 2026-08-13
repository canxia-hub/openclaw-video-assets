import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-dreamina-video-"));
const repo = path.join(tmp, "repo");
const source = path.join(tmp, "main-reference.png");
const videoSource = path.join(tmp, "motion-reference.mp4");
const audioSource = path.join(tmp, "audio-reference.mp3");
await fs.promises.writeFile(source, Buffer.from(png1x1, "base64"));
await fs.promises.writeFile(videoSource, Buffer.from("fixture video reference"));
await fs.promises.writeFile(audioSource, Buffer.from("fixture audio reference"));

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const project = svc.createProject({ title: "Dreamina CLI Video Generate Test" });
  svc.updateProjectSpec({
    project_id: project.project_id,
    target_platforms: ["douyin"],
    aspect_ratio: "16:9",
    resolution: "1920x1080",
    fps: 24
  });

  const asset = await svc.ingestAsset({ file_path: source, title: "Main Reference Image", kind: "working" });
  const videoAsset = await svc.ingestAsset({ file_path: videoSource, title: "Motion Reference Video", kind: "working" });
  const audioAsset = await svc.ingestAsset({ file_path: audioSource, title: "Audio Reference", kind: "working" });
  svc.updateAssetRights({
    asset_id: asset.asset_id,
    license_status: "cleared",
    risk_level: "low",
    source: { source_type: "internal_fixture", license_hint: "test fixture" }
  });
  svc.updateAssetRights({
    asset_id: videoAsset.asset_id,
    license_status: "cleared",
    risk_level: "low",
    source: { source_type: "internal_fixture", license_hint: "test fixture" }
  });
  svc.updateAssetRights({
    asset_id: audioAsset.asset_id,
    license_status: "cleared",
    risk_level: "low",
    source: { source_type: "internal_fixture", license_hint: "test fixture" }
  });
  svc.classifyAsset({ asset_id: asset.asset_id, asset_version_id: asset.default_version_id, domain: "reference", type: "main_reference", confidence: "confirmed", source: "agent" });
  svc.classifyAsset({ asset_id: videoAsset.asset_id, asset_version_id: videoAsset.default_version_id, domain: "reference", type: "motion_reference", confidence: "confirmed", source: "agent" });
  svc.classifyAsset({ asset_id: audioAsset.asset_id, asset_version_id: audioAsset.default_version_id, domain: "reference", type: "audio_reference", confidence: "confirmed", source: "agent" });
  const ref = svc.addProjectRef({
    project_id: project.project_id,
    asset_id: asset.asset_id,
    asset_version_id: asset.default_version_id,
    role: "reference",
    usage_scope: "Dreamina CLI video source image.",
    pin_mode: "pinned",
    required: true
  });
  const videoRef = svc.addProjectRef({
    project_id: project.project_id,
    asset_id: videoAsset.asset_id,
    asset_version_id: videoAsset.default_version_id,
    role: "motion reference",
    usage_scope: "Dreamina CLI multimodal motion reference.",
    pin_mode: "pinned",
    required: false
  });
  const audioRef = svc.addProjectRef({
    project_id: project.project_id,
    asset_id: audioAsset.asset_id,
    asset_version_id: audioAsset.default_version_id,
    role: "audio reference",
    usage_scope: "Dreamina CLI multimodal audio reference.",
    pin_mode: "pinned",
    required: false
  });

  const canvas = svc.createCanvas({ project_id: project.project_id, title: "Dreamina CLI Video Canvas" });
  svc.upsertCanvasShape({
    canvas_id: canvas.canvas_id,
    shape_type: "reference_card",
    subject_type: "project_ref",
    subject_id: ref.reference_id,
    title: "Bound image reference",
    x: 0,
    y: 0,
    width: 260,
    height: 140,
    props: {
      generation_slot: "main_reference",
      stage: "shots",
      role: "project_ref"
    }
  });
  svc.upsertCanvasShape({
    canvas_id: canvas.canvas_id,
    shape_type: "reference_card",
    subject_type: "project_ref",
    subject_id: videoRef.reference_id,
    title: "Bound motion reference",
    x: 300,
    y: 0,
    width: 260,
    height: 140,
    props: {
      generation_slot: "motion_reference",
      stage: "shots",
      role: "project_ref"
    }
  });
  svc.upsertCanvasShape({
    canvas_id: canvas.canvas_id,
    shape_type: "reference_card",
    subject_type: "project_ref",
    subject_id: audioRef.reference_id,
    title: "Bound audio reference",
    x: 600,
    y: 0,
    width: 260,
    height: 140,
    props: {
      generation_slot: "audio",
      stage: "audio",
      role: "project_ref"
    }
  });

  const plan = svc.canvasDreaminaCliPlan({ canvas_id: canvas.canvas_id, generation_type: "image_to_video" });
  assert.equal(plan.command.kind, "image2video");
  assert.equal(plan.command.argv.includes("--ratio"), false, "image2video must not receive --ratio");
  assert.ok(plan.command.argv.includes("--model_version"));
  assert.ok(plan.command.argv.includes("seedance2.0fast"));
  assert.ok(plan.command.argv.includes("--video_resolution"));
  assert.ok(plan.command.argv.includes("720p"));

  const dryRun = await svc.canvasDreaminaCliGenerateVideo({
    canvas_id: canvas.canvas_id,
    generation_type: "image_to_video",
    model_version: "seedance2.0fast",
    duration: 5,
    video_resolution: "720p",
    execute: false
  });
  assert.equal(dryRun.source, "canvas_dreamina_cli_video_generation");
  assert.equal(dryRun.status, "ready");
  assert.equal(dryRun.safety.video_only, true);
  assert.equal(dryRun.safety.dry_run, true);
  assert.equal(dryRun.command.kind, "image2video");
  assert.equal(dryRun.command.argv.includes("--ratio"), false);
  assert.equal(dryRun.parameters.model_version, "seedance2.0fast");
  assert.equal(dryRun.parameters.duration, 5);
  assert.equal(dryRun.parameters.video_resolution, "720p");

  const multimodalDryRun = await svc.canvasDreaminaCliGenerateVideo({
    canvas_id: canvas.canvas_id,
    generation_type: "multimodal_to_video",
    model_version: "seedance2.0fast",
    duration: 5,
    ratio: "16:9",
    video_resolution: "720p",
    execute: false
  });
  assert.equal(multimodalDryRun.status, "ready");
  assert.equal(multimodalDryRun.command.kind, "multimodal2video");
  assert.ok(multimodalDryRun.command.argv.includes("multimodal2video"));
  assert.ok(multimodalDryRun.command.argv.includes("--image"));
  assert.ok(multimodalDryRun.command.argv.includes("--video"));
  assert.ok(multimodalDryRun.command.argv.includes("--audio"));
  assert.equal(multimodalDryRun.parameters.ratio, "16:9");
  assert.equal(multimodalDryRun.reference_inputs.images.length, 1);
  assert.equal(multimodalDryRun.reference_inputs.videos.length, 1);
  assert.equal(multimodalDryRun.reference_inputs.audios.length, 1);

  await assert.rejects(
    () => svc.canvasDreaminaCliGenerateVideo({
      canvas_id: canvas.canvas_id,
      generation_type: "text_to_video",
      model_version: "seedance2.0fast",
      video_resolution: "1080p",
      execute: false
    }),
    /1080p is only supported/
  );

  await assert.rejects(
    () => svc.canvasDreaminaCliGenerateVideo({
      canvas_id: canvas.canvas_id,
      generation_type: "text_to_video",
      model_version: "3.5pro",
      execute: false
    }),
    /text_to_video model_version/
  );

  console.log("dreamina cli video generate test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
