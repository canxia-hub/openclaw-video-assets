import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

if (process.env.RUN_DOUBAO_AUDIO_LIVE !== "1") {
  console.log("doubao audio live smoke skipped; set RUN_DOUBAO_AUDIO_LIVE=1 to call Volcengine.");
  process.exit(0);
}

if (!process.env.VOLCENGINE_DOUBAO_AUDIO_API_KEY) {
  throw new Error("VOLCENGINE_DOUBAO_AUDIO_API_KEY is required");
}

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-doubao-audio-live-"));
const repo = path.join(tmp, "repo");
const outputDir = path.join(tmp, "outputs");

const prompt = [
  "生成 3 秒中文旁白音频，用于接口连通性测试。",
  "0-3 秒：成年女性普通话说：“豆包音频接口已接入资产库。”",
  "声音清晰、自然、无背景音乐，结尾留 0.2 秒安静。"
].join("");

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const project = svc.createProject({ title: "豆包音频真实接口连通测试" });
  const generated = await svc.doubaoAudioGenerate({
    project_id: project.project_id,
    prompt_text: prompt,
    output_title: "豆包音频真实接口连通测试输出",
    duration_seconds: 3,
    output_format: "wav",
    sample_rate: 24000,
    speech_rate: 0,
    loudness_rate: 0,
    pitch_rate: 0,
    backend: "api",
    execute: true,
    accept_cost: true,
    output_dir: outputDir
  });

  assert.equal(generated.status, "success");
  assert.equal(generated.provider_result.backend, "api");
  assert.equal(generated.provider_result.platform_review_status, "passed");
  assert.equal(generated.registered_assets.length, 1);

  const registered = generated.registered_assets[0];
  const stat = await fs.promises.stat(registered.file_path);
  assert.ok(stat.size > 44);
  const asset = svc.getAsset({ asset_id: registered.asset_id });
  assert.equal(asset.media_type, "audio");
  assert.equal(asset.license_status, "cleared");
  assert.equal(asset.risk_level, "low");
  assert.ok(asset.sources.some((source) => source.source_type === "doubao_audio_platform_review"));

  console.log(JSON.stringify({
    ok: true,
    asset_id: registered.asset_id,
    asset_version_id: registered.asset_version_id,
    file_size_bytes: stat.size,
    duration: generated.provider_result.duration,
    original_duration: generated.provider_result.original_duration,
    volcengine_logid: generated.provider_result.volcengine_logid,
    license_status: asset.license_status,
    risk_level: asset.risk_level
  }, null, 2));
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
