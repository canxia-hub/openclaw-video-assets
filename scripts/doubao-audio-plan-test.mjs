import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDoubaoAudioApiPayload } from "../src/doubao-audio-adapter.js";
import { VideoAssetService } from "../src/service.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-doubao-audio-plan-"));
const repo = path.join(tmp, "repo");

const prompt = "生成 8 秒音频，用于即梦视频 @音频1。场景是夜晚室内，空间声学是小房间近距离。0-2 秒：轻微房间底噪；2-6 秒：旁白（成年男性，普通话，低音微沙，语速克制，饰演音色：原创纪录片旁白）说：“今晚，我们先把声音做好。”；6-8 秒：音乐后景淡出。对白在前景，房间声在中景，音乐在后景，结尾留 0.5 秒安静。";

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const project = svc.createProject({ title: "豆包音频计划测试" });
  const plan = svc.doubaoAudioPlan({
    project_id: project.project_id,
    prompt_text: prompt,
    duration_seconds: 8,
    output_format: "wav",
    sample_rate: 48000,
    speech_rate: 8,
    loudness_rate: 5,
    pitch_rate: -1,
    enable_subtitle: true,
    channels: 2,
    output_title: "豆包音频计划测试输出"
  });

  assert.equal(plan.source, "doubao_audio_plan");
  assert.equal(plan.status, "ready");
  assert.equal(plan.request.schema_version, "doubao_audio_request_v1");
  assert.equal(plan.request.asset_policy.license_status, "cleared");
  assert.equal(plan.request.asset_policy.risk_level, "low");
  assert.equal(plan.validation.checks.license_status_on_success, "cleared");
  assert.ok(plan.cost_policy.some((item) => item.includes("platform_review_status=passed") || item.includes("license_status=cleared")));
  const payload = buildDoubaoAudioApiPayload(plan.request);
  assert.equal(payload.model, "seed-audio-1.0");
  assert.equal(payload.text_prompt, prompt);
  assert.deepEqual(payload.audio_config, {
    format: "wav",
    sample_rate: 48000,
    speech_rate: 8,
    loudness_rate: 5,
    pitch_rate: -1,
    enable_subtitle: true
  });

  const canvas = svc.createCanvas({ project_id: project.project_id, title: "豆包音频画布计划测试" });
  const slot = svc.createGenerationSlot({
    canvas_id: canvas.canvas_id,
    title: "豆包声音总轨槽",
    slot: "audio",
    generation_slot: "audio",
    generation_type: "voice",
    duration_seconds: 8,
    stage: "audio"
  });
  const canvasPlan = svc.canvasDoubaoAudioPlan({
    canvas_id: canvas.canvas_id,
    slot_shape_id: slot.shape_id,
    prompt_text: prompt
  });
  assert.equal(canvasPlan.source, "canvas_doubao_audio_plan");
  assert.equal(canvasPlan.status, "ready");
  assert.equal(canvasPlan.request.project.canvas_id, canvas.canvas_id);
  assert.equal(canvasPlan.request.project.slot_shape_id, slot.shape_id);
  assert.equal(canvasPlan.request.generation.duration_seconds, 8);

  const blocked = svc.doubaoAudioPlan({
    project_id: project.project_id,
    prompt_text: "过长".repeat(1600)
  });
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.validation.blockers.some((item) => item.includes("exceeds")));

  console.log("doubao audio plan test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
