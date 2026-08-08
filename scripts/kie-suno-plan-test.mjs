import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildKieSunoApiPayload } from "../src/kie-suno-adapter.js";
import { VideoAssetService } from "../src/service.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-kie-suno-plan-"));
const repo = path.join(tmp, "repo");

const prompt = `[Verse]
City lights are breathing slow
Footsteps fade where rivers glow

[Chorus]
Hold the night, keep the signal clear
We are close, we are almost here`;

const style = "cinematic electronic pop, 95 BPM, restrained drums, warm synth bass, clear female vocal, polished but intimate mix";

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const project = svc.createProject({ title: "KIE Suno 计划测试" });
  const plan = svc.kieSunoPlan({
    project_id: project.project_id,
    prompt,
    style,
    title: "Night Signal",
    track_role: "song",
    dialogue_priority: "must not mask dialogue",
    output_title: "KIE Suno 计划测试输出"
  });

  assert.equal(plan.source, "kie_suno_plan");
  assert.equal(plan.status, "ready");
  assert.equal(plan.request.schema_version, "kie_suno_request_v1");
  assert.equal(plan.request.provider, "kie.ai/suno-api");
  assert.equal(plan.request.asset_policy.license_status, "unknown");
  assert.equal(plan.request.asset_policy.risk_level, "unknown");
  assert.equal(plan.validation.checks.license_status_on_success, "unknown");
  assert.ok(plan.cost_policy.some((item) => item.includes("license_status=unknown")));
  const payload = buildKieSunoApiPayload(plan.request);
  assert.equal(payload.model, "V5_5");
  assert.equal(payload.customMode, true);
  assert.equal(payload.instrumental, false);
  assert.equal(payload.prompt, prompt);
  assert.equal(payload.style, style);

  const canvas = svc.createCanvas({ project_id: project.project_id, title: "KIE Suno 画布计划测试" });
  const slot = svc.createGenerationSlot({
    canvas_id: canvas.canvas_id,
    title: "音乐生成槽",
    slot: "audio",
    generation_slot: "audio",
    generation_type: "voice",
    duration_seconds: 12,
    stage: "audio"
  });
  const canvasPlan = svc.canvasKieSunoPlan({
    canvas_id: canvas.canvas_id,
    slot_shape_id: slot.shape_id,
    prompt,
    style,
    title: "Canvas Night Signal",
    dialogue_priority: "background bed under narration"
  });
  assert.equal(canvasPlan.source, "canvas_kie_suno_plan");
  assert.equal(canvasPlan.status, "ready");
  assert.equal(canvasPlan.request.project.canvas_id, canvas.canvas_id);
  assert.equal(canvasPlan.request.project.slot_shape_id, slot.shape_id);
  assert.equal(canvasPlan.request.project.target_duration, 12);

  const blocked = svc.kieSunoPlan({
    project_id: project.project_id,
    customMode: true,
    instrumental: false,
    prompt,
    title: "Missing Style"
  });
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.validation.blockers.some((item) => item.includes("style")));

  console.log("kie suno plan test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
