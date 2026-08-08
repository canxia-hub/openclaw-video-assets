import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-doubao-audio-generate-"));
const repo = path.join(tmp, "repo");
const outputDir = path.join(tmp, "outputs");

const prompt = "生成 6 秒音频，用于即梦视频 @音频1。场景是清晨书房，空间声学是安静近距离。0-2 秒：窗外轻风；2-5 秒：旁白（成年女性，普通话，中低音，温和稳定，饰演音色：原创知识类旁白）说：“素材入库，从声音开始。”；5-6 秒：环境声自然收束。旁白在前景，风声在中景，音乐在后景，结尾留 0.5 秒安静。";

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const project = svc.createProject({ title: "豆包音频生成测试" });

  const dryRun = await svc.doubaoAudioGenerate({
    project_id: project.project_id,
    prompt_text: prompt,
    execute: false,
    output_dir: outputDir
  });
  assert.equal(dryRun.status, "ready");
  assert.equal(dryRun.dry_run, true);

  const generated = await svc.doubaoAudioGenerate({
    project_id: project.project_id,
    prompt_text: prompt,
    output_title: "豆包音频项目级输出",
    duration_seconds: 6,
    execute: true,
    accept_cost: true,
    backend: "mock",
    output_dir: outputDir
  });
  assert.equal(generated.status, "success");
  assert.equal(generated.provider_result.platform_review_status, "passed");
  assert.equal(generated.registered_assets.length, 1);
  assert.ok(await exists(generated.registered_assets[0].file_path));
  const asset = svc.getAsset({ asset_id: generated.registered_assets[0].asset_id });
  assert.equal(asset.media_type, "audio");
  assert.equal(asset.license_status, "cleared");
  assert.equal(asset.risk_level, "low");
  assert.equal(asset.versions[0].sample_rate, 24000);
  assert.equal(asset.versions[0].channels, 2);
  assert.ok(asset.sources.some((source) => source.source_type === "doubao_audio_platform_review"));

  const canvas = svc.createCanvas({ project_id: project.project_id, title: "豆包音频画布生成测试" });
  const slot = svc.createGenerationSlot({
    canvas_id: canvas.canvas_id,
    title: "声音总轨槽",
    slot: "audio",
    generation_slot: "audio",
    generation_type: "voice",
    duration_seconds: 6,
    stage: "audio"
  });
  const canvasGenerated = await svc.canvasDoubaoAudioGenerate({
    canvas_id: canvas.canvas_id,
    slot_shape_id: slot.shape_id,
    prompt_text: prompt,
    output_title: "豆包音频画布输出",
    execute: true,
    accept_cost: true,
    backend: "mock",
    output_dir: outputDir
  });
  assert.equal(canvasGenerated.status, "success");
  assert.equal(canvasGenerated.provider_result.platform_review_status, "passed");
  assert.equal(canvasGenerated.registered_assets.length, 1);
  const canvasAsset = svc.getAsset({ asset_id: canvasGenerated.registered_assets[0].asset_id });
  assert.equal(canvasAsset.media_type, "audio");
  assert.equal(canvasAsset.license_status, "cleared");
  assert.equal(canvasAsset.risk_level, "low");
  const updatedCanvas = svc.getCanvas({ canvas_id: canvas.canvas_id });
  assert.ok(updatedCanvas.shapes.some((shape) => shape.props?.asset_id === canvasAsset.asset_id));
  const updatedSlot = updatedCanvas.shapes.find((shape) => shape.shape_id === slot.shape_id);
  assert.equal(updatedSlot.props.status, "filled");

  console.log("doubao audio generate test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}

async function exists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}
