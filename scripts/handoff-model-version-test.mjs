import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

// 回归目标（2026-09-20，由画布 draft_output 门禁修复的附带发现立项）：
// canvasDreaminaCliGenerateVideo 构造 handoff 时未转发 model_version，导致 handoff 阶段
// dreaminaCliHandoff 的 `videoModel = requestedModel ?? "seedance2.0fast"` 回退成 2.0fast，
// 多模态输入上限按 DREAMINA_MULTIMODAL_LIMITS_2X 校验（video<=3/image<=9/audio<=3/total<=12），
// 而非请求的 seedance2.5（DREAMINA_MULTIMODAL_LIMITS_25：video<=10/image<=30/audio<=10/total<=50）。
// 两个可观测后果：
//   ① seedance2.5 + 4~10 个 video 输入被误判阻断（本应放行）；
//   ② reference_inputs 摘要按 2.0fast 上限静默截断（5 个 video 只显示 3 个）。
// 同时守住反向边界：seedance2.0fast 下超过 3 个 video 输入必须继续阻断。
// 注意：图像生成路径（canvasDreaminaCliGenerateImage）本就正确转发，本用例不覆盖它以免混淆归因。

const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const mp4Stub = Buffer.concat([
  Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom", "ascii"),
  Buffer.from([0, 0, 2, 0]), Buffer.from("isomiso2avc1mp41", "ascii"),
  Buffer.from([0, 0, 0, 8]), Buffer.from("free", "ascii")
]);

const VIDEO_INPUT_COUNT = 5;      // > 2.0fast 上限 3，且 <= 2.5 上限 10
const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-handoff-model-"));
const repo = path.join(tmp, "repo");
const imageSource = path.join(tmp, "reference-image.png");
const videoSource = path.join(tmp, "reference-video.mp4");
await fs.promises.writeFile(imageSource, Buffer.from(png1x1, "base64"));
await fs.promises.writeFile(videoSource, mp4Stub);

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();

const clearRights = (asset) => svc.updateAssetRights({
  asset_id: asset.asset_id,
  license_status: "cleared",
  risk_level: "low",
  source: { source_type: "internal_fixture", license_hint: "qa fixture" }
});
const classify = (asset, type) => svc.classifyAsset({
  asset_id: asset.asset_id,
  asset_version_id: asset.default_version_id,
  domain: "reference",
  type,
  confidence: "confirmed",
  source: "agent"
});

try {
  const project = svc.createProject({ title: "handoff model_version 回归项目" });
  svc.updateProjectSpec({
    project_id: project.project_id,
    target_platforms: ["bilibili"],
    aspect_ratio: "16:9",
    resolution: "1280x720",
    fps: 24
  });

  const canvas = svc.createCanvas({ project_id: project.project_id, title: "handoff model_version 回归画布" });
  svc.createGenerationSlot({
    canvas_id: canvas.canvas_id,
    generation_type: "multimodal_to_video",
    required_refs: [],
    status: "ready"
  });

  const bind = async ({ file, title, slot, type }) => {
    const asset = await svc.ingestAsset({ file_path: file, title, kind: "working" });
    await clearRights(asset);
    classify(asset, type);
    const ref = svc.addProjectRef({
      project_id: project.project_id,
      asset_id: asset.asset_id,
      asset_version_id: asset.default_version_id,
      role: type,
      pin_mode: "pinned",
      required: false
    });
    svc.upsertCanvasShape({
      canvas_id: canvas.canvas_id,
      shape_type: "reference_card",
      subject_type: "project_ref",
      subject_id: ref.reference_id,
      title,
      props: { generation_slot: slot, stage: "shots", role: "project_ref" }
    });
  };

  await bind({ file: imageSource, title: "输入图 · 主参考", slot: "main_reference", type: "main_reference" });
  for (let index = 1; index <= VIDEO_INPUT_COUNT; index += 1) {
    await bind({ file: videoSource, title: `输入视频 · 镜头参考 ${index}`, slot: "video_clip", type: "motion_reference" });
  }

  // ---- ① seedance2.5：4~10 个 video 输入必须放行 ----
  const run25 = await svc.canvasDreaminaCliGenerateVideo({
    canvas_id: canvas.canvas_id,
    generation_type: "multimodal_to_video",
    model_version: "seedance2.5",
    duration: 5,
    ratio: "16:9",
    video_resolution: "720p",
    execute: false,
    accept_credit_spend: false,
    run_preflight: false,
    download_outputs: false,
    ingest_outputs: false,
    writeback_canvas: false
  });

  assert.equal(
    run25.blockers.some((item) => item.includes("supports at most")),
    false,
    `seedance2.5 下 ${VIDEO_INPUT_COUNT} 个视频输入不得被 2.0fast 上限误判：${JSON.stringify(run25.blockers)}`
  );
  assert.equal(run25.status, "ready", `seedance2.5 应放行：${JSON.stringify(run25.blockers)}`);
  assert.equal(run25.command.kind, "multimodal2video");
  assert.equal(run25.parameters.model_version, "seedance2.5");
  assert.equal(
    run25.reference_inputs.videos.length,
    VIDEO_INPUT_COUNT,
    `reference_inputs 摘要不得按 2.0fast 上限截断：期望 ${VIDEO_INPUT_COUNT} 条，实际 ${run25.reference_inputs.videos.length}`
  );
  assert.equal(run25.reference_inputs.images.length, 1);

  // ---- ② 反向边界：seedance2.0fast 下超过 3 个视频输入仍必须阻断 ----
  const run20 = await svc.canvasDreaminaCliGenerateVideo({
    canvas_id: canvas.canvas_id,
    generation_type: "multimodal_to_video",
    model_version: "seedance2.0fast",
    duration: 5,
    ratio: "16:9",
    video_resolution: "720p",
    execute: false,
    accept_credit_spend: false,
    run_preflight: false,
    download_outputs: false,
    ingest_outputs: false,
    writeback_canvas: false
  });
  assert.equal(run20.status, "blocked", JSON.stringify(run20.blockers));
  assert.ok(
    run20.blockers.some((item) => item.includes("supports at most 3 video inputs for model seedance2.0fast")),
    `seedance2.0fast 的 3 视频上限必须继续阻断：${JSON.stringify(run20.blockers)}`
  );

  console.log("handoff model_version regression test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
