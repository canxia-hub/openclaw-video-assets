import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-dreamina-video-"));
const repo = path.join(tmp, "repo");
const argvValue = (argv, flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : null;
};
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
  // 上传路径必须已从内容寻址 .blob 物化为带正确扩展名的文件（实测 2026-09-20：CLI 按扩展名判定，.blob 会被拒）
  const planImageArg = argvValue(plan.command.argv, "--image");
  assert.equal(planImageArg.endsWith(".blob"), false, "CLI upload path must not keep the .blob extension");
  assert.equal(planImageArg.endsWith(".png"), true, `materialized upload path must carry the real media extension: ${planImageArg}`);
  assert.equal(fs.existsSync(planImageArg), true, "materialized upload file must exist on disk");

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
  assert.equal(argvValue(dryRun.command.argv, "--image").endsWith(".png"), true, "image2video dry-run must use the materialized upload path");
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

  // ---- seedance2.5 放行矩阵（2026-09-20 新增：对齐 CLI 1.4.18 实测）----
  for (const resolution of ["480p", "720p", "1080p"]) {
    const i2v = await svc.canvasDreaminaCliGenerateVideo({
      canvas_id: canvas.canvas_id,
      generation_type: "image_to_video",
      model_version: "seedance2.5",
      duration: 5,
      video_resolution: resolution,
      execute: false
    });
    assert.equal(i2v.status, "ready", `seedance2.5 image_to_video must be ready at ${resolution}`);
    assert.equal(i2v.parameters.video_resolution, resolution);
    assert.equal(argvValue(i2v.command.argv, "--model_version"), "seedance2.5");
    assert.equal(argvValue(i2v.command.argv, "--video_resolution"), resolution);
    assert.equal(i2v.command.argv.includes("--ratio"), false, "seedance2.5 image2video rejects --ratio");
  }

  for (const duration of [4, 30]) {
    const boundary = await svc.canvasDreaminaCliGenerateVideo({
      canvas_id: canvas.canvas_id,
      generation_type: "image_to_video",
      model_version: "seedance2.5",
      duration,
      video_resolution: "720p",
      execute: false
    });
    assert.equal(boundary.parameters.duration, duration, `seedance2.5 duration ${duration} must pass`);
  }

  const t2v25 = await svc.canvasDreaminaCliGenerateVideo({
    canvas_id: canvas.canvas_id,
    generation_type: "text_to_video",
    model_version: "seedance2.5",
    duration: 30,
    ratio: "16:9",
    video_resolution: "1080p",
    execute: false
  });
  assert.equal(t2v25.status, "ready");
  assert.equal(t2v25.command.kind, "text2video");
  assert.equal(argvValue(t2v25.command.argv, "--ratio"), "16:9");
  assert.equal(argvValue(t2v25.command.argv, "--duration"), "30");

  const m2v25 = await svc.canvasDreaminaCliGenerateVideo({
    canvas_id: canvas.canvas_id,
    generation_type: "multimodal_to_video",
    model_version: "seedance2.5",
    duration: 20,
    ratio: "16:9",
    video_resolution: "720p",
    execute: false
  });
  assert.equal(m2v25.status, "ready");
  assert.equal(m2v25.command.kind, "multimodal2video");
  assert.equal(m2v25.reference_inputs.audios.length, 1);
  assert.equal(m2v25.parameters.duration, 20);

  // 大小写容错：Seedance2.5 归一到 CLI 原值 seedance2.5
  const cased = await svc.canvasDreaminaCliGenerateVideo({
    canvas_id: canvas.canvas_id,
    generation_type: "image_to_video",
    model_version: "Seedance2.5",
    video_resolution: "720p",
    execute: false
  });
  assert.equal(cased.parameters.model_version, "seedance2.5");

  // 2.5 边界拒绝：3s / 31s 均越界
  await assert.rejects(
    () => svc.canvasDreaminaCliGenerateVideo({ canvas_id: canvas.canvas_id, generation_type: "image_to_video", model_version: "seedance2.5", duration: 3, video_resolution: "720p", execute: false }),
    /duration for seedance2.5 must be 4-30 seconds/
  );
  await assert.rejects(
    () => svc.canvasDreaminaCliGenerateVideo({ canvas_id: canvas.canvas_id, generation_type: "image_to_video", model_version: "seedance2.5", duration: 31, video_resolution: "720p", execute: false }),
    /duration must be an integer between 1 and 30/
  );

  // 分辨率白名单：480p 仅 2.5；2.0 家族仍限 720p
  await assert.rejects(
    () => svc.canvasDreaminaCliGenerateVideo({ canvas_id: canvas.canvas_id, generation_type: "image_to_video", model_version: "seedance2.0fast", video_resolution: "480p", execute: false }),
    /480p is only supported by model_version seedance2.5/
  );
  await assert.rejects(
    () => svc.canvasDreaminaCliGenerateVideo({ canvas_id: canvas.canvas_id, generation_type: "image_to_video", model_version: "seedance2.0fast", video_resolution: "4k", execute: false }),
    /4k is only supported by model_version seedance2.0_vip/
  );

  // 4k 仅 seedance2.0_vip 可用（P2 新放行，对齐 CLI help）
  const vip4k = await svc.canvasDreaminaCliGenerateVideo({
    canvas_id: canvas.canvas_id,
    generation_type: "image_to_video",
    model_version: "seedance2.0_vip",
    duration: 5,
    video_resolution: "4k",
    execute: false
  });
  assert.equal(vip4k.status, "ready");
  assert.equal(vip4k.parameters.video_resolution, "4k");
  assert.equal(argvValue(vip4k.command.argv, "--video_resolution"), "4k");

  // 2.0 家族零回归：4-15s、720p 上限不变
  const family20 = await svc.canvasDreaminaCliGenerateVideo({
    canvas_id: canvas.canvas_id,
    generation_type: "image_to_video",
    model_version: "seedance2.0fast",
    duration: 15,
    video_resolution: "720p",
    execute: false
  });
  assert.equal(family20.status, "ready");
  assert.equal(family20.parameters.duration, 15);
  await assert.rejects(
    () => svc.canvasDreaminaCliGenerateVideo({ canvas_id: canvas.canvas_id, generation_type: "image_to_video", model_version: "seedance2.0fast", duration: 16, video_resolution: "720p", execute: false }),
    /duration for seedance2.0fast must be 4-15 seconds/
  );

  // 新接入的旧模型：seedance1.0fast 5-10s、seedance1.5pro 5-12s，且均限图生视频
  const legacy10 = await svc.canvasDreaminaCliGenerateVideo({
    canvas_id: canvas.canvas_id,
    generation_type: "image_to_video",
    model_version: "seedance1.0fast",
    duration: 5,
    video_resolution: "720p",
    execute: false
  });
  assert.equal(legacy10.status, "ready");
  await assert.rejects(
    () => svc.canvasDreaminaCliGenerateVideo({ canvas_id: canvas.canvas_id, generation_type: "image_to_video", model_version: "seedance1.0fast", duration: 12, video_resolution: "720p", execute: false }),
    /duration for seedance1.0fast must be 5-10 seconds/
  );
  const legacy15 = await svc.canvasDreaminaCliGenerateVideo({
    canvas_id: canvas.canvas_id,
    generation_type: "image_to_video",
    model_version: "seedance1.5pro",
    duration: 12,
    video_resolution: "720p",
    execute: false
  });
  assert.equal(legacy15.status, "ready");
  await assert.rejects(
    () => svc.canvasDreaminaCliGenerateVideo({ canvas_id: canvas.canvas_id, generation_type: "text_to_video", model_version: "seedance1.0fast", execute: false }),
    /text_to_video model_version must be one of/
  );

  // legacy 3.0 家族：图生视频 3-10s 行为保持（仅文档标注 CLI 已不列出）
  // 注意：裸值 "3.0" 已被后端 version 白名单拒绝，故规格表只保留带后缀变体（实测核验 2026-09-20）。
  const legacy30 = await svc.canvasDreaminaCliGenerateVideo({
    canvas_id: canvas.canvas_id,
    generation_type: "image_to_video",
    model_version: "3.0fast",
    duration: 3,
    video_resolution: "720p",
    execute: false
  });
  assert.equal(legacy30.status, "ready");
  await assert.rejects(
    () => svc.canvasDreaminaCliGenerateVideo({ canvas_id: canvas.canvas_id, generation_type: "image_to_video", model_version: "3.0", duration: 5, video_resolution: "720p", execute: false }),
    /image_to_video model_version must be one of/,
    "bare 3.0 must be rejected: it is not in the backend version whitelist"
  );

  console.log("dreamina cli video generate test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
