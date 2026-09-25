import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeKieSunoRequest, validateKieSunoRequest } from "../src/kie-suno-adapter.js";
import { normalizeDoubaoAudioRequest, validateDoubaoAudioRequest } from "../src/doubao-audio-adapter.js";
import { VideoAssetService } from "../src/service.js";

const KIE_ENV = "KIE_API_KEY";
const DOUBAO_ENV = "VOLCENGINE_DOUBAO_AUDIO_API_KEY";

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

const kieRequest = normalizeKieSunoRequest({
  backend: "api",
  customMode: true,
  instrumental: false,
  prompt: "test prompt",
  style: "test style",
  title: "Test Title"
});
const doubaoRequest = normalizeDoubaoAudioRequest({
  backend: "api",
  prompt_text: "这是一段用于密钥解析测试的配音文本。"
});

withEnv(KIE_ENV, undefined, () => {
  const blocked = validateKieSunoRequest(kieRequest);
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.blockers.includes("KIE_API_KEY is required for backend=api"));

  const viaConfig = validateKieSunoRequest(kieRequest, { apiKey: "cfg-kie-key" });
  assert.equal(viaConfig.status, "ready");
  assert.match(viaConfig.checks.auth, /plugin config audio\.kie\.apiKey/);

  const refObjectIgnored = validateKieSunoRequest(kieRequest, { apiKey: { source: "store", provider: "default", id: "KIE_API_KEY" } });
  assert.equal(refObjectIgnored.status, "blocked");
});

withEnv(KIE_ENV, "env-kie-key", () => {
  const viaEnv = validateKieSunoRequest(kieRequest);
  assert.equal(viaEnv.status, "ready");
  assert.match(viaEnv.checks.auth, /environment variable/);

  const configWins = validateKieSunoRequest(kieRequest, { apiKey: "cfg-kie-key" });
  assert.match(configWins.checks.auth, /plugin config/);
});

withEnv(DOUBAO_ENV, undefined, () => {
  const blocked = validateDoubaoAudioRequest(doubaoRequest);
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.blockers.includes("VOLCENGINE_DOUBAO_AUDIO_API_KEY is required for backend=api"));

  const viaConfig = validateDoubaoAudioRequest(doubaoRequest, { apiKey: "cfg-doubao-key" });
  assert.equal(viaConfig.status, "ready");
  assert.match(viaConfig.checks.auth, /plugin config audio\.doubao\.apiKey/);
});

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-audio-key-"));
const svc = new VideoAssetService({
  pluginConfig: {
    repositoryRoot: path.join(tmp, "repo"),
    audio: { kie: { apiKey: "svc-cfg-key" }, doubao: { apiKey: "svc-doubao-key" } }
  }
}).init();
try {
  const project = svc.createProject({ title: "密钥解析验收测试" });
  withEnv(KIE_ENV, undefined, () => {
    const plan = svc.kieSunoPlan({ project_id: project.project_id, backend: "api", prompt: "test prompt", style: "test style", title: "Test Title" });
    assert.equal(plan.validation.status, "ready");
    assert.match(plan.validation.checks.auth, /plugin config audio\.kie\.apiKey/);
  });
  withEnv(DOUBAO_ENV, undefined, () => {
    const plan = svc.doubaoAudioPlan({ project_id: project.project_id, backend: "api", prompt_text: "这是测试配音。" });
    assert.equal(plan.validation.status, "ready");
    assert.match(plan.validation.checks.auth, /plugin config audio\.doubao\.apiKey/);
  });
  withEnv(KIE_ENV, "env-only-key", () => {
    const svc2 = new VideoAssetService({ pluginConfig: { repositoryRoot: path.join(tmp, "repo2") } }).init();
    try {
      const p2 = svc2.createProject({ title: "环境回退测试" });
      const plan = svc2.kieSunoPlan({ project_id: p2.project_id, backend: "api", prompt: "test prompt", style: "test style", title: "Test Title" });
      assert.equal(plan.validation.status, "ready");
      assert.match(plan.validation.checks.auth, /environment variable/);
    } finally {
      svc2.close();
    }
  });
  console.log("audio key resolution test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
