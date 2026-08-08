import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-kie-suno-generate-"));
const repo = path.join(tmp, "repo");
const outputDir = path.join(tmp, "outputs");

const prompt = `[Verse]
Morning glass and silver rain
Every note remembers names

[Chorus]
Start again, start again
Let the quiet become flame`;

const style = "gentle cinematic pop, 88 BPM, piano, soft strings, airy female vocal, warm close mix";

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const project = svc.createProject({ title: "KIE Suno 生成测试" });

  const dryRun = await svc.kieSunoGenerate({
    project_id: project.project_id,
    prompt,
    style,
    title: "Start Again",
    execute: false,
    output_dir: outputDir
  });
  assert.equal(dryRun.status, "ready");
  assert.equal(dryRun.dry_run, true);

  const generated = await svc.kieSunoGenerate({
    project_id: project.project_id,
    prompt,
    style,
    title: "Start Again",
    output_title: "KIE Suno 项目级输出",
    dialogue_priority: "music must stay behind narration",
    execute: true,
    accept_cost: true,
    backend: "mock",
    output_dir: outputDir
  });
  assert.equal(generated.status, "success");
  assert.equal(generated.provider_result.provider, "kie.ai/suno-api");
  assert.equal(generated.registered_assets.length, 1);
  assert.ok(await exists(generated.registered_assets[0].file_path));
  const asset = svc.getAsset({ asset_id: generated.registered_assets[0].asset_id });
  assert.equal(asset.media_type, "audio");
  assert.equal(asset.license_status, "unknown");
  assert.equal(asset.risk_level, "unknown");
  assert.ok(asset.sources.some((source) => source.source_type === "kie_suno_generation_record"));

  const canvas = svc.createCanvas({ project_id: project.project_id, title: "KIE Suno 画布生成测试" });
  const slot = svc.createGenerationSlot({
    canvas_id: canvas.canvas_id,
    title: "音乐总轨槽",
    slot: "audio",
    generation_slot: "audio",
    generation_type: "voice",
    duration_seconds: 10,
    stage: "audio"
  });
  const canvasGenerated = await svc.canvasKieSunoGenerate({
    canvas_id: canvas.canvas_id,
    slot_shape_id: slot.shape_id,
    prompt,
    style,
    title: "Canvas Start Again",
    output_title: "KIE Suno 画布输出",
    dialogue_priority: "background only",
    execute: true,
    accept_cost: true,
    backend: "mock",
    output_dir: outputDir
  });
  assert.equal(canvasGenerated.status, "success");
  assert.equal(canvasGenerated.registered_assets.length, 1);
  const canvasAsset = svc.getAsset({ asset_id: canvasGenerated.registered_assets[0].asset_id });
  assert.equal(canvasAsset.media_type, "audio");
  assert.equal(canvasAsset.license_status, "unknown");
  assert.equal(canvasAsset.risk_level, "unknown");
  const updatedCanvas = svc.getCanvas({ canvas_id: canvas.canvas_id });
  assert.ok(updatedCanvas.shapes.some((shape) => shape.props?.asset_id === canvasAsset.asset_id));
  const updatedSlot = updatedCanvas.shapes.find((shape) => shape.shape_id === slot.shape_id);
  assert.equal(updatedSlot.props.status, "filled");

  const originalFetch = globalThis.fetch;
  process.env.KIE_API_KEY = "test_kie_key";
  const apiOutputDir = path.join(tmp, "api-outputs");
  try {
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (options.method === "POST" && target.endsWith("/api/v1/generate")) {
        return jsonResponse({ code: 200, msg: "success", data: "4f5aac83dcc95d04cd684ea8cd7b6432" });
      }
      if (options.method === "GET" && target.includes("/api/v1/generate/record-info")) {
        return jsonResponse({
          code: 200,
          data: {
            status: "SUCCESS",
            response: {
              audioUrl: "https://cdn.example.test/kie/audio-one.mp3",
              sourceAudioUrl: "https://cdn.example.test/kie/audio-two.m4a",
              imageUrl: "https://cdn.example.test/kie/cover.jpeg"
            }
          }
        });
      }
      if (target.endsWith("/audio-one.mp3") || target.endsWith("/audio-two.m4a")) {
        return new Response(Buffer.from("fake audio bytes"), { status: 200 });
      }
      throw new Error(`unexpected fetch in KIE test: ${target}`);
    };

    const apiGenerated = await svc.kieSunoGenerate({
      project_id: project.project_id,
      prompt,
      style,
      title: "API Mixed URLs",
      output_title: "KIE Suno API URL 过滤测试",
      execute: true,
      accept_cost: true,
      backend: "api",
      poll_result: true,
      download_outputs: true,
      ingest_outputs: true,
      output_dir: apiOutputDir
    });
    assert.equal(apiGenerated.status, "success");
    assert.equal(apiGenerated.provider_result.task_id, "4f5aac83dcc95d04cd684ea8cd7b6432");
    assert.deepEqual(apiGenerated.provider_result.remote_urls.sort(), [
      "https://cdn.example.test/kie/audio-one.mp3",
      "https://cdn.example.test/kie/audio-two.m4a"
    ]);
    assert.equal(apiGenerated.registered_assets.length, 2);
    assert.ok(apiGenerated.registered_assets.every((asset) => !asset.file_path.endsWith(".jpeg")));
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.KIE_API_KEY;
  }

  console.log("kie suno generate test passed");
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

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
