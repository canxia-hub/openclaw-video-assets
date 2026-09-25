import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

// 回归目标（2026-09-20 真机缺陷）：
// draft_output 是写回产出槽，不是生成输入。写回产出卡不得被当作下一轮生成的输入，
// 具体表现为两处误判：
//   ① canvasGenerationGates 的输入门禁循环（taxonomy / 授权 / 风险 / 资产版本）；
//   ② dreaminaMultimodalInputs 的模型输入上限与参考输入摘要。
// 本用例同时守住反向边界：真正的输入槽缺 taxonomy 仍必须阻断。

const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
// 与 media-fixtures-test / dreamina-cli-video-generate-test 保持一致的轻量视频夹具
const mp4Stub = Buffer.concat([
  Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom", "ascii"),
  Buffer.from([0, 0, 2, 0]), Buffer.from("isomiso2avc1mp41", "ascii"),
  Buffer.from([0, 0, 0, 8]), Buffer.from("free", "ascii")
]);

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-draft-output-gate-"));
const repo = path.join(tmp, "repo");
const imageSource = path.join(tmp, "input-image.png");
const videoSource = path.join(tmp, "input-video.mp4");
await fs.promises.writeFile(imageSource, Buffer.from(png1x1, "base64"));
await fs.promises.writeFile(videoSource, mp4Stub);

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();

const clearRights = (asset) => svc.updateAssetRights({
  asset_id: asset.asset_id,
  license_status: "cleared",
  risk_level: "low",
  source: { source_type: "internal_fixture", license_hint: "qa fixture" }
});
const classify = (asset, domain, type) => svc.classifyAsset({
  asset_id: asset.asset_id,
  asset_version_id: asset.default_version_id,
  domain,
  type,
  confidence: "confirmed",
  source: "agent"
});
const bindCard = ({ canvas_id, ref, title, slot }) => svc.upsertCanvasShape({
  canvas_id,
  shape_type: "reference_card",
  subject_type: "project_ref",
  subject_id: ref.reference_id,
  title,
  props: { generation_slot: slot, stage: "shots", role: slot === "draft_output" ? "generated_output" : "project_ref" }
});

try {
  const project = svc.createProject({ title: "draft_output 门禁回归项目" });
  svc.updateProjectSpec({
    project_id: project.project_id,
    target_platforms: ["bilibili"],
    aspect_ratio: "16:9",
    resolution: "1280x720",
    fps: 24
  });

  // ---- 素材 ----
  const inputImage = await svc.ingestAsset({ file_path: imageSource, title: "输入图 · 主参考", kind: "working" });
  await clearRights(inputImage);
  classify(inputImage, "reference", "main_reference");

  const inputVideo = await svc.ingestAsset({ file_path: videoSource, title: "输入视频 · 镜头参考", kind: "working" });
  await clearRights(inputVideo);
  classify(inputVideo, "reference", "motion_reference");

  // 写回产出：已清权但【未分类】的产出图 —— taxonomy 误判分支
  const unclassifiedOutput = await svc.ingestAsset({ file_path: imageSource, title: "写回产出 · 未分类样图", kind: "working" });
  await clearRights(unclassifiedOutput);

  // 写回产出：4 条视频产出 —— 输入上限误判分支（2.0 家族 video 上限为 3）
  const outputVideos = [];
  for (let index = 1; index <= 4; index += 1) {
    const asset = await svc.ingestAsset({ file_path: videoSource, title: `写回产出 · 成片 ${index}`, kind: "working" });
    await clearRights(asset);
    classify(asset, "delivery", "generated_output");
    outputVideos.push(asset);
  }

  // ---- 画布 A：混合合法输入 + 写回产出 ----
  const canvas = svc.createCanvas({ project_id: project.project_id, title: "draft_output 门禁回归画布" });
  const slot = svc.createGenerationSlot({
    canvas_id: canvas.canvas_id,
    generation_type: "multimodal_to_video",
    required_refs: ["main_reference"],
    status: "ready"
  });

  const addRef = (asset, role) => svc.addProjectRef({
    project_id: project.project_id,
    asset_id: asset.asset_id,
    asset_version_id: asset.default_version_id,
    role,
    pin_mode: "pinned",
    required: false
  });

  bindCard({ canvas_id: canvas.canvas_id, ref: addRef(inputImage, "main_reference"), title: "输入图 · 主参考", slot: "main_reference" });
  bindCard({ canvas_id: canvas.canvas_id, ref: addRef(inputVideo, "motion reference"), title: "输入视频 · 镜头参考", slot: "video_clip" });
  bindCard({ canvas_id: canvas.canvas_id, ref: addRef(unclassifiedOutput, "generated_output"), title: "写回产出 · 未分类样图", slot: "draft_output" });
  outputVideos.forEach((asset, index) => {
    bindCard({ canvas_id: canvas.canvas_id, ref: addRef(asset, "generated_output"), title: `写回产出 · 成片 ${index + 1}`, slot: "draft_output" });
  });

  const pkg = svc.canvasGenerationPackage({
    canvas_id: canvas.canvas_id,
    generation_type: "multimodal_to_video",
    slot_shape_id: slot.shape_id
  });

  // ① 产出仍作为槽位暴露，但不再进入输入的强校验
  assert.equal(pkg.slots.draft_output.length, 5, JSON.stringify(pkg.slots.draft_output.map((item) => item.title)));
  assert.equal(pkg.gates.ok, true, JSON.stringify(pkg.gates, null, 2));
  assert.equal(
    pkg.gates.errors.some((item) => item.includes("缺少 taxonomy")),
    false,
    "draft_output 写回产出不得触发 taxonomy 输入门"
  );
  assert.equal(
    pkg.gates.errors.some((item) => item.includes("写回产出")),
    false,
    "draft_output 写回产出不得出现在任何输入门错误中"
  );

  // ② 交接包不再因产出卡被阻断
  const handoff = svc.canvasGenerationHandoff({
    canvas_id: canvas.canvas_id,
    generation_type: "multimodal_to_video",
    slot_shape_id: slot.shape_id
  });
  assert.equal(handoff.status, "ready", JSON.stringify(handoff.validation, null, 2));
  assert.equal(handoff.validation.dreamina_cli_ready, true, JSON.stringify(handoff.validation.dreamina_cli_blockers));

  // ③ 模型输入上限只统计真正的输入（2.0 家族 video 上限 3，未过滤时为 5 条）
  const plan = svc.canvasDreaminaCliPlan({
    canvas_id: canvas.canvas_id,
    generation_type: "multimodal_to_video",
    model_version: "seedance2.0fast",
    slot_shape_id: slot.shape_id
  });
  assert.equal(plan.status, "ready", JSON.stringify(plan.blockers, null, 2));
  assert.equal(
    plan.blockers.some((item) => item.includes("supports at most")),
    false,
    `模型输入上限不得把 draft_output 产出计入：${JSON.stringify(plan.blockers)}`
  );

  const dryRun = await svc.canvasDreaminaCliGenerateVideo({
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
  assert.equal(dryRun.status, "ready", JSON.stringify(dryRun.blockers, null, 2));
  assert.equal(dryRun.reference_inputs.images.length, 1, JSON.stringify(dryRun.reference_inputs));
  assert.equal(dryRun.reference_inputs.videos.length, 1, JSON.stringify(dryRun.reference_inputs));
  assert.equal(
    dryRun.reference_inputs.videos.some((item) => String(item.title).includes("写回产出")),
    false,
    "参考输入摘要不得包含 draft_output 写回产出"
  );

  // ④ 反向边界：真正的输入槽缺 taxonomy 仍必须阻断（防止过度过滤）
  const canvasB = svc.createCanvas({ project_id: project.project_id, title: "输入门禁反向边界画布" });
  const slotB = svc.createGenerationSlot({
    canvas_id: canvasB.canvas_id,
    generation_type: "image_to_video",
    required_refs: ["main_reference"],
    status: "ready"
  });
  const unclassifiedInputRef = svc.addProjectRef({
    project_id: project.project_id,
    asset_id: unclassifiedOutput.asset_id,
    asset_version_id: unclassifiedOutput.default_version_id,
    role: "style_reference",
    pin_mode: "pinned",
    required: false
  });
  bindCard({ canvas_id: canvasB.canvas_id, ref: addRef(inputImage, "main_reference"), title: "输入图 · 主参考", slot: "main_reference" });
  svc.upsertCanvasShape({
    canvas_id: canvasB.canvas_id,
    shape_type: "reference_card",
    subject_type: "project_ref",
    subject_id: unclassifiedInputRef.reference_id,
    title: "未分类输入 · 风格参考",
    props: { generation_slot: "style_reference", stage: "shots", role: "project_ref" }
  });

  const strict = svc.canvasGenerationPackage({
    canvas_id: canvasB.canvas_id,
    generation_type: "image_to_video",
    slot_shape_id: slotB.shape_id
  });
  assert.equal(strict.gates.ok, false, JSON.stringify(strict.gates, null, 2));
  assert.ok(
    strict.gates.errors.some((item) => item.includes("缺少 taxonomy")),
    `真正的输入槽缺 taxonomy 必须继续阻断：${JSON.stringify(strict.gates.errors)}`
  );

  console.log("canvas draft_output gate test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
