#!/usr/bin/env node
// REN-09 · 能力注册表验收用例（零成本、离线）
// 覆盖工作包验收门：
//   G1 生命周期完备性（每个在表模型都有状态、理由、可解析证据）
//   G2 注册表 ↔ CLI 1.4.18 --help 固件一致（模型/默认值/时长/分辨率/比例/放大档）
//   G3 read_only_history 不进入新请求枚举，但历史可读（经真实计划工具路径）
//   G4 legacy 值仍被运行时接受（不得误删）
//   G5 provider 条目完整（端点/鉴权/计费/超时/授权默认值 + 端点生命周期理由）
//   G6 schema 枚举由注册表派生且与兼容视图一致（无第二份清单漂移）
//   G7 provider-model-matrix.md 由注册表派生且内容完整
//   G8 SecretRef 走宿主受支持流程（secretInputs 声明），插件不新造私有凭证流
//   G9 外部调用超时/错误规范化
// 注：真实生成、付费样本与账户资格不在此用例内，属 blocked 验证项（见 acceptance.md）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_REGISTRY_SCHEMA_VERSION,
  EVIDENCE,
  LIFECYCLE_STATES,
  NEW_REQUEST_LIFECYCLE_STATES,
  DREAMINA_VIDEO_MODEL_SPECS,
  DREAMINA_VIDEO_MODEL_VALUES,
  DREAMINA_VIDEO_MODEL_LIFECYCLE,
  DREAMINA_VIDEO_MODEL_HISTORY,
  DREAMINA_IMAGE_MODEL_SPECS,
  DREAMINA_IMAGE_MODEL_VALUES,
  DREAMINA_IMAGE_MODEL_LIFECYCLE,
  DREAMINA_IMAGE_UPSCALE_SPEC,
  PROVIDER_REGISTRY,
  describeHistoricalModel,
  lifecycleOf,
  providerModelMatrix,
  renderProviderModelMatrixMarkdown,
  retirementMapping,
  schemaEnums,
  selectableModels,
  dreaminaModelCatalog
} from "../src/capability-registry.js";
import { normalizeExternalCallError, httpFailure, cliFailure, providerTimeoutPolicy, EXTERNAL_ERROR_CODES, ExternalCallError } from "../src/external-call.js";
import { VideoAssetService } from "../src/service.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "dreamina-cli-help-1.4.18.json"), "utf8"));
const failures = [];
const record = (gate, fn) => {
  try {
    fn();
    console.log(`PASS ${gate}`);
  } catch (err) {
    failures.push({ gate, message: err?.message ?? String(err) });
    console.log(`FAIL ${gate}: ${err?.message ?? err}`);
  }
};

console.log(`capability registry schema: ${CAPABILITY_REGISTRY_SCHEMA_VERSION}`);
console.log(`CLI fixture: ${fixture.source.cli_version} build ${fixture.source.cli_build} captured ${fixture.source.captured_at}`);

// ---------------------------------------------------------------- G1
record("G1 lifecycle completeness", () => {
  assert.ok(LIFECYCLE_STATES.includes("read_only_history"));
  assert.ok(NEW_REQUEST_LIFECYCLE_STATES.includes("default"));
  assert.equal(NEW_REQUEST_LIFECYCLE_STATES.includes("read_only_history"), false, "read_only_history must not be selectable for new requests");

  const checkEntry = (kind, model, entry) => {
    assert.ok(entry, `${kind} ${model} must have a lifecycle entry`);
    assert.ok(LIFECYCLE_STATES.includes(entry.lifecycle), `${kind} ${model} lifecycle must be a known state`);
    assert.ok(typeof entry.reason === "string" && entry.reason.trim().length > 0, `${kind} ${model} must record a retain/retire reason`);
    assert.ok(Array.isArray(entry.evidence) && entry.evidence.length > 0, `${kind} ${model} must cite at least one evidence id`);
    for (const id of entry.evidence) assert.ok(EVIDENCE[id], `${kind} ${model} cites unknown evidence id: ${id}`);
  };

  for (const model of DREAMINA_VIDEO_MODEL_VALUES) checkEntry("video", model, DREAMINA_VIDEO_MODEL_LIFECYCLE[model]);
  for (const model of Object.keys(DREAMINA_VIDEO_MODEL_HISTORY)) {
    const entry = DREAMINA_VIDEO_MODEL_HISTORY[model];
    assert.equal(entry.lifecycle, "read_only_history");
    assert.ok(entry.reason && entry.replacement, `${model} history entry needs reason + replacement`);
    for (const id of entry.evidence ?? []) assert.ok(EVIDENCE[id], `${model} cites unknown evidence id: ${id}`);
  }
  for (const model of DREAMINA_IMAGE_MODEL_VALUES) checkEntry("image", model, DREAMINA_IMAGE_MODEL_LIFECYCLE[model]);
  checkEntry("image_upscale", "image_upscale", DREAMINA_IMAGE_UPSCALE_SPEC);

  // 每个 provider/模型值都必须有明确生命周期：KIE 模型列表逐项校验
  for (const model of PROVIDER_REGISTRY["kie.ai/suno-api"].models) {
    assert.ok(LIFECYCLE_STATES.includes(model.lifecycle), `kie model ${model.model_id} lifecycle missing`);
    assert.ok(model.reason && model.reason.trim().length > 0, `kie model ${model.model_id} needs reason`);
  }
  // 默认值必须恰好一个 default
  const videoDefaults = DREAMINA_VIDEO_MODEL_VALUES.filter((m) => DREAMINA_VIDEO_MODEL_LIFECYCLE[m].lifecycle === "default");
  assert.deepEqual(videoDefaults, ["seedance2.0fast"], "video default must stay seedance2.0fast");
  const imageDefaults = DREAMINA_IMAGE_MODEL_VALUES.filter((m) => DREAMINA_IMAGE_MODEL_LIFECYCLE[m].lifecycle === "default");
  assert.deepEqual(imageDefaults, ["5.0"], "image default must stay 5.0");
});

// ---------------------------------------------------------------- G2
record("G2 registry matches CLI help fixture", () => {
  const videoCommands = { image2video: "image_to_video", text2video: "text_to_video", multimodal2video: "multimodal_to_video" };
  for (const [command, generationType] of Object.entries(videoCommands)) {
    const cliModels = fixture.commands[command].model_version;
    const registryModels = DREAMINA_VIDEO_MODEL_VALUES.filter((m) =>
      DREAMINA_VIDEO_MODEL_SPECS[m].generation_types.includes(generationType) && !DREAMINA_VIDEO_MODEL_SPECS[m].legacy_cli_unlisted
    );
    assert.deepEqual(registryModels.slice().sort(), cliModels.slice().sort(), `${command} model set must equal CLI --help support set`);
    // CLI help 不列的 legacy 值必须仍在注册表（后端白名单仍受理）
    const legacy = DREAMINA_VIDEO_MODEL_VALUES.filter((m) => DREAMINA_VIDEO_MODEL_SPECS[m].legacy_cli_unlisted);
    assert.ok(legacy.length === 6, "the six legacy CLI-unlisted values must stay registered");
  }

  for (const [model, expected] of Object.entries(fixture.commands.image2video.duration)) {
    if (model === "*") continue;
    assert.deepEqual([...DREAMINA_VIDEO_MODEL_SPECS[model].duration], expected, `image2video duration for ${model}`);
  }
  for (const [model, expected] of Object.entries(fixture.commands.image2video.video_resolution)) {
    if (model === "*") continue;
    assert.deepEqual([...DREAMINA_VIDEO_MODEL_SPECS[model].resolutions], expected, `image2video resolutions for ${model}`);
  }
  assert.deepEqual([...DREAMINA_VIDEO_MODEL_SPECS["seedance2.5"].duration], fixture.commands.text2video.duration["seedance2.5"]);
  assert.deepEqual([...DREAMINA_VIDEO_MODEL_SPECS["seedance2.5"].multimodal_limits.media_duration], fixture.commands.multimodal2video.input_limits["seedance2.5"].media_duration);
  assert.equal(DREAMINA_VIDEO_MODEL_SPECS["seedance2.5"].multimodal_limits.image, fixture.commands.multimodal2video.input_limits["seedance2.5"].image);
  assert.equal(DREAMINA_VIDEO_MODEL_SPECS["seedance2.0fast"].multimodal_limits.total, fixture.commands.multimodal2video.input_limits["*"].total);
  assert.equal(DREAMINA_VIDEO_MODEL_SPECS["seedance2.5"].vip_only, true, "seedance2.5 is VIP-only per CLI help");

  for (const [model, expected] of Object.entries(fixture.commands.text2image.resolution_type)) {
    assert.deepEqual([...DREAMINA_IMAGE_MODEL_SPECS[model].resolutions], expected, `text2image resolution_type for ${model}`);
  }
  const text2imageModels = DREAMINA_IMAGE_MODEL_VALUES.filter((m) => DREAMINA_IMAGE_MODEL_SPECS[m].generation_types.includes("text2image"));
  assert.deepEqual(text2imageModels.slice().sort(), fixture.commands.text2image.model_version.slice().sort());
  const image2imageModels = DREAMINA_IMAGE_MODEL_VALUES.filter((m) => DREAMINA_IMAGE_MODEL_SPECS[m].generation_types.includes("image2image"));
  assert.deepEqual(image2imageModels.slice().sort(), fixture.commands.image2image.model_version.slice().sort());
  assert.deepEqual([...DREAMINA_IMAGE_UPSCALE_SPEC.resolutions], fixture.commands.image_upscale.resolution_type);
  assert.equal(fixture.commands.image_upscale.exposes_model_version, false, "image_upscale exposes no model_version in CLI help");
});

// ---------------------------------------------------------------- G3
record("G3 read-only history is excluded from new requests but stays readable", () => {
  const videoSelectable = selectableModels("video");
  assert.equal(videoSelectable.includes("3.0"), false, "bare 3.0 must never be selectable");
  assert.deepEqual(videoSelectable.slice().sort(), DREAMINA_VIDEO_MODEL_VALUES.slice().sort(), "all registered video models stay selectable (none is disabled_new yet)");

  const described = describeHistoricalModel("video", "3.0");
  assert.equal(described.recognized, true, "bare 3.0 must be recognised as history, not as unknown");
  assert.equal(described.lifecycle, "read_only_history");
  assert.equal(described.selectable_for_new_request, false);
  assert.ok(described.replacement, "history entry must point at a replacement");

  // 永不对历史值抛错
  for (const value of ["3.0", "seedance9.9", "", null, undefined, "SEEDANCE2.5"]) {
    assert.doesNotThrow(() => describeHistoricalModel("video", value));
  }
  assert.equal(describeHistoricalModel("video", "SEEDANCE2.5").canonical, "seedance2.5", "case-insensitive canonicalisation must keep history readable");
  assert.equal(describeHistoricalModel("video", "seedance9.9").recognized, false);
  assert.equal(describeHistoricalModel("video", "seedance9.9").lifecycle, "unrecognized");
  assert.equal(lifecycleOf("video", "3.0").lifecycle, "read_only_history");
  assert.equal(lifecycleOf("video", "seedance1.0"), null, "seedance1.0 stays unregistered (only in the backend whitelist, never verified)");
});

// ---------------------------------------------------------------- G4
record("G4 legacy values remain accepted by runtime validation", () => {
  assert.equal(selectableModels("video", "image_to_video").filter((m) => m.startsWith("3.")).length, 6, "six legacy i2v values must stay usable");
  const mapping = retirementMapping();
  const legacyRows = mapping.filter((row) => row.kind === "video" && row.lifecycle === "legacy");
  assert.equal(legacyRows.length, 6, "retirement mapping must cover every legacy value");
  for (const row of legacyRows) assert.ok(row.replacement, `legacy ${row.model} must map to a replacement`);
  const kieLegacy = mapping.filter((row) => row.kind === "endpoint" && row.lifecycle === "legacy");
  assert.ok(kieLegacy.length >= 2, "KIE legacy endpoints must appear in the retirement mapping");
  for (const row of kieLegacy) assert.ok(row.replacement, "legacy endpoints must map to a documented replacement");
});

// ---------------------------------------------------------------- G5
record("G5 provider entries are complete", () => {
  const requiredProviders = ["dreamina_cli", "doubao_seed_audio", "kie.ai/suno-api"];
  assert.deepEqual(Object.keys(PROVIDER_REGISTRY).sort(), requiredProviders.slice().sort(), "exactly the three implemented providers");
  for (const [id, provider] of Object.entries(PROVIDER_REGISTRY)) {
    assert.ok(provider.endpoints?.length > 0, `${id} needs at least one endpoint`);
    assert.ok(provider.auth?.mode, `${id} needs an auth mode`);
    assert.ok(provider.rights?.license_status_default, `${id} needs an explicit default license status`);
    assert.ok(provider.rights?.risk_level_default, `${id} needs an explicit default risk level`);
    assert.ok(provider.evidence?.length > 0, `${id} needs evidence ids`);
    for (const evidenceId of provider.evidence) assert.ok(EVIDENCE[evidenceId], `${id} cites unknown evidence id ${evidenceId}`);
    for (const endpoint of provider.endpoints) {
      assert.ok(LIFECYCLE_STATES.includes(endpoint.lifecycle), `${id} endpoint ${endpoint.ref} lifecycle must be explicit`);
      assert.ok(endpoint.evidence?.length > 0, `${id} endpoint ${endpoint.ref} must cite evidence`);
      if (endpoint.lifecycle !== "default") assert.ok(endpoint.reason, `${id} non-default endpoint ${endpoint.ref} must state a reason`);
    }
    const costStatus = provider.billing?.cost_status;
    assert.ok(["verified", "unknown", "partially_verified"].includes(costStatus), `${id} billing.cost_status must be explicitly verified / partially_verified / unknown`);
    if (costStatus === "partially_verified") {
      assert.ok(provider.billing.verified_samples?.length > 0, `${id} partially_verified cost requires per-sample evidence`);
      for (const sample of provider.billing.verified_samples) {
        assert.ok(["verified", "unknown"].includes(sample.cost_status), `${id} sample ${sample.model} needs an explicit cost_status`);
        if (sample.cost_status === "unknown") assert.equal(sample.credits, "unknown", "unknown cost must not carry a number");
      }
    }
    assert.ok(!/cleared/.test(provider.rights.license_status_default), `${id} must not default to cleared without a citable authorization`);
    assert.doesNotThrow(() => providerTimeoutPolicy(id), `${id} must resolve a timeout policy`);
  }
  // 官方端点事实：豆包现行端点与 KIE 新旧端点必须都在册
  const doubao = PROVIDER_REGISTRY.doubao_seed_audio;
  assert.ok(doubao.endpoints.some((ep) => ep.ref === "https://openspeech.bytedance.com/api/v3/tts/create" && ep.lifecycle === "default"));
  const kie = PROVIDER_REGISTRY["kie.ai/suno-api"];
  assert.ok(kie.endpoints.some((ep) => ep.ref.endsWith("/api/v1/generate") && ep.lifecycle === "legacy" && ep.in_use === true), "current KIE default must be recorded as legacy-but-in-use");
  assert.ok(kie.endpoints.some((ep) => ep.ref.endsWith("/api/v1/jobs/createTask") && ep.lifecycle === "candidate" && ep.in_use === false), "documented KIE replacement must be recorded as unused candidate");
  // 未取证的成本必须显式 unknown，不得编造数字
  const doubaoCost = doubao.billing.cost_status;
  assert.equal(doubaoCost, "unknown", "Volcengine per-unit price is not evidenced in this round");
  assert.ok(doubao.billing.verified_samples === undefined);
  const sampleCosts = PROVIDER_REGISTRY.dreamina_cli.billing.verified_samples;
  // 2026-09-20 三条（2.5 480p/4s、2.5 720p/5s、5.0Pro 2k 出图）+ 2026-09-25 两条（image_upscale 2k / 4k）= 5 条有真机收据
  assert.equal(sampleCosts.filter((s) => s.cost_status === "verified").length, 5, "exactly five credit costs are backed by real receipts");
  for (const sample of sampleCosts) {
    if (sample.cost_status === "unknown") assert.equal(sample.credits, "unknown", "unknown cost must not carry a number");
  }

  // 命名映射：官方产品名只用于解释，不得发明插件别名；映射值必须真实存在于契约列表
  const naming = PROVIDER_REGISTRY.dreamina_cli.naming;
  assert.ok(naming && Object.keys(naming).length > 0, "dreamina_cli must map official product names to CLI contract values");
  assert.equal(naming["Seedream 5.0 Pro"], "5.0Pro", "the CLI original spelling must be preserved in naming maps");
  for (const value of Object.values(naming)) {
    assert.ok(DREAMINA_VIDEO_MODEL_VALUES.includes(value) || DREAMINA_IMAGE_MODEL_VALUES.includes(value), `naming target ${value} must be a real contract value`);
  }
  assert.equal(Object.values(naming).some((value) => /seedream/i.test(value)), false, "no invented Seedream alias may appear as a contract value");
  assert.equal(PROVIDER_REGISTRY.doubao_seed_audio.naming["Seed Audio 1.0"], "seed-audio-1.0");
  assert.equal(PROVIDER_REGISTRY.doubao_seed_audio.models[0].model_id, PROVIDER_REGISTRY.doubao_seed_audio.naming["Seed Audio 1.0"]);

  // 已知校验差异必须被记录下来（官方限制 vs 插件实现），不能静默丢失
  const gaps = PROVIDER_REGISTRY.doubao_seed_audio.validation_gaps;
  assert.ok(Array.isArray(gaps) && gaps.length >= 2, "documented validation gaps must not be silently dropped");
  for (const gap of gaps) {
    for (const field of ["gap", "official_limits", "plugin_behaviour", "action"]) {
      assert.ok(typeof gap[field] === "string" && gap[field].trim().length > 0, `validation gap needs ${field}`);
    }
    assert.ok(gap.evidence?.length > 0, "validation gaps must cite official evidence");
    for (const id of gap.evidence) assert.ok(EVIDENCE[id], `validation gap cites unknown evidence ${id}`);
  }
});

// ---------------------------------------------------------------- G6
record("G6 schema enums are derived from the registry", () => {
  const video = schemaEnums({ kind: "video" });
  const image = schemaEnums({ kind: "image" });
  assert.deepEqual(video.model_version, dreaminaModelCatalog.video.models, "video enum must equal the compatibility catalog projection");
  assert.deepEqual(video.video_resolution.slice().sort(), dreaminaModelCatalog.video.resolutions.slice().sort());
  assert.deepEqual(video.ratio.slice().sort(), dreaminaModelCatalog.video.ratios.slice().sort());
  assert.deepEqual(image.model_version.slice().sort(), dreaminaModelCatalog.image.models.slice().sort());
  assert.deepEqual(image.resolution_type, dreaminaModelCatalog.image.resolutions);
  assert.deepEqual(image.upscale_resolution, dreaminaModelCatalog.image.upscale_resolutions);
  assert.deepEqual(schemaEnums({ kind: "video", generation_type: "text_to_video" }).model_version.slice().sort(), ["seedance2.0", "seedance2.0_vip", "seedance2.0fast", "seedance2.0fast_vip", "seedance2.0mini", "seedance2.5"].sort());
  assert.equal(schemaEnums({ kind: "video", generation_type: "text_to_video" }).model_version.includes("3.0fast"), false, "text_to_video must not offer image_to_video-only legacy values");
  assert.deepEqual(schemaEnums({ kind: "video", generation_type: "image_to_video" }).model_version.filter((m) => m.startsWith("3.")).length, 6);
  assert.throws(() => schemaEnums({ kind: "nope" }), /unknown capability kind/);
});

// ---------------------------------------------------------------- G7
record("G7 matrix markdown is generated from the registry", () => {
  const md = renderProviderModelMatrixMarkdown();
  assert.ok(md.includes("GENERATED FILE"), "generated file must be marked as generated");
  for (const section of ["## 1. 生命周期分层", "## 2. 官方证据", "## 3. Provider 现状", "## 4. 即梦视频模型矩阵", "## 5. 即梦图像模型矩阵", "## 6. 默认值", "## 7. 退役 / 替代 / 回退映射"]) {
    assert.ok(md.includes(section), `matrix must contain ${section}`);
  }
  assert.ok(md.includes("https://docs.kie.ai/suno-api/generate-music"), "matrix must cite the KIE current-endpoint doc");
  assert.ok(md.includes("https://docs.volcengine.com/docs/6561/2550782?lang=zh"), "matrix must cite the Volcengine doc");
  assert.ok(md.includes("seedance2.0fast"), "matrix must show defaults");
  assert.ok(!/TODO|TBD|FIXME/.test(md), "matrix must not ship placeholders");
  const matrix = providerModelMatrix();
  assert.equal(matrix.schema_version, CAPABILITY_REGISTRY_SCHEMA_VERSION);
  assert.equal(matrix.retirement_mapping.length, retirementMapping().length);

  // 可选漂移门：交付物 provider-model-matrix.md 必须与注册表当前投影一致
  const target = process.env.REN09_MATRIX_PATH;
  if (target) {
    const onDisk = fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n");
    assert.equal(onDisk, md.replace(/\r\n/g, "\n"), `provider-model-matrix.md is stale; regenerate with scripts/provider-model-matrix.mjs (${target})`);
  } else {
    console.log("  note: REN09_MATRIX_PATH not set — on-disk matrix drift gate skipped");
  }
});

// ---------------------------------------------------------------- G8
record("G8 SecretRef uses the host-supported flow only", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "openclaw.plugin.json"), "utf8"));
  const secretPaths = (manifest.configContracts?.secretInputs?.paths ?? []).map((entry) => entry.path).sort();
  assert.deepEqual(secretPaths, ["audio.doubao.apiKey", "audio.kie.apiKey"], "manifest must declare exactly the two audio credential paths");
  for (const entry of manifest.configContracts.secretInputs.paths) {
    assert.equal(entry.expected, "string", `${entry.path} must be materialised as a string (no in-plugin credential objects)`);
  }
  assert.match(manifest.configSchema.properties.audio.description, /SecretRef/, "configSchema must document the host SecretRef flow");
  const registrySources = [PROVIDER_REGISTRY.doubao_seed_audio.auth.credential_source, PROVIDER_REGISTRY["kie.ai/suno-api"].auth.credential_source];
  for (const source of registrySources) {
    assert.match(source, /host secretInputs materialized string/, "registry must describe the host-materialised SecretRef flow");
    assert.match(source, /不接受凭证对象/, "registry must state that credential objects are rejected in-plugin");
  }
});

// ---------------------------------------------------------------- G9
record("G9 external call timeout / error normalisation", () => {
  const abort = new Error("This operation was aborted");
  abort.name = "AbortError";
  const timeout = normalizeExternalCallError(abort, { provider: "kie.ai/suno-api", endpoint: "https://api.kie.ai/api/v1/generate", phase: "http_timeout", hint: EXTERNAL_ERROR_CODES.TIMEOUT });
  assert.equal(timeout.code, EXTERNAL_ERROR_CODES.TIMEOUT);
  assert.equal(timeout.provider, "kie.ai/suno-api");
  assert.match(timeout.message, /api\.kie\.ai/);
  assert.match(timeout.message, /aborted/, "original message must survive normalisation");
  assert.equal(timeout.auto_retry_allowed, false, "normalisation must never authorise automatic retry (duplicate billing risk)");
  assert.equal(timeout.retryable, true);

  const dns = Object.assign(new Error("getaddrinfo ENOTFOUND api.kie.ai"), { code: "ENOTFOUND" });
  assert.equal(normalizeExternalCallError(dns, {}).code, EXTERNAL_ERROR_CODES.NETWORK);

  const http = httpFailure({ provider: "doubao_seed_audio", endpoint: "https://openspeech.bytedance.com/api/v3/tts/create", status: 429, logid: "abc123" });
  assert.equal(http.code, EXTERNAL_ERROR_CODES.HTTP_STATUS);
  assert.equal(http.status, 429);
  assert.equal(http.retryable, true);
  assert.match(http.message, /logid=abc123/);
  assert.equal(httpFailure({ provider: "x", status: 400 }).retryable, false);

  const cli = cliFailure({ provider: "dreamina_cli", command: "dreamina image2video", exitCode: 1, parsed: { error: { code: "4010", message: "compliance not confirmed" } } });
  assert.equal(cli.code, EXTERNAL_ERROR_CODES.UPSTREAM_CODE);
  assert.equal(cli.upstream_code, "4010");
  assert.equal(cli.retryable, false, "CLI compliance failures must not look retryable");
  assert.ok(cli instanceof ExternalCallError);
  assert.ok(JSON.parse(JSON.stringify(cli)).code);

  // 幂等：已规范化错误不得被二次包装
  assert.equal(normalizeExternalCallError(timeout, {}), timeout);

  // 超时策略来自注册表
  const kiePolicy = providerTimeoutPolicy("kie.ai/suno-api");
  assert.deepEqual([kiePolicy.min_ms, kiePolicy.default_ms, kiePolicy.max_ms], [30000, 900000, 3600000]);
  const doubaoPolicy = providerTimeoutPolicy("doubao_seed_audio");
  assert.deepEqual([doubaoPolicy.min_ms, doubaoPolicy.default_ms, doubaoPolicy.max_ms], [30000, 600000, 1800000]);
  assert.equal(typeof providerTimeoutPolicy("dreamina_cli").cli_poll_max_seconds, "number");
  assert.throws(() => providerTimeoutPolicy("nope"), /unknown provider/);
});

// ---------------------------------------------------------------- G10 回归契约
record("G10 regression contract for preserved behaviours", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  for (const script of ["check:canvas-draft-output", "check:handoff-model-version", "check:dreamina-model-specs", "check:dreamina-cli-image", "check:dreamina-cli-video", "check:capability-registry"]) {
    assert.ok(pkg.scripts[script], `package.json must keep ${script}`);
    assert.ok(pkg.scripts.check.includes(`npm run ${script}`), `check chain must include ${script}`);
  }
});

// ---------------------------------------------------------------- G11 真实工具路径（历史可读 + 无效值拒绝）
const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-ren09-registry-"));
const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: path.join(tmp, "repo") } }).init();
try {
  const source = path.join(tmp, "main-reference.png");
  await fs.promises.writeFile(source, Buffer.from(png1x1, "base64"));
  const project = svc.createProject({ title: "REN-09 registry check" });
  const asset = await svc.ingestAsset({ file_path: source, title: "reference", kind: "working" });
  svc.updateAssetRights({ asset_id: asset.asset_id, license_status: "cleared", risk_level: "low", source: { source_type: "internal_fixture", license_hint: "fixture" } });
  svc.classifyAsset({ asset_id: asset.asset_id, asset_version_id: asset.default_version_id, domain: "reference", type: "main_reference", confidence: "confirmed", source: "agent" });
  const ref = svc.addProjectRef({ project_id: project.project_id, asset_id: asset.asset_id, asset_version_id: asset.default_version_id, role: "reference", usage_scope: "ren09", pin_mode: "pinned", required: true });
  const canvas = svc.createCanvas({ project_id: project.project_id, title: "REN-09 canvas" });
  svc.upsertCanvasShape({
    canvas_id: canvas.canvas_id,
    shape_type: "reference_card",
    subject_type: "project_ref",
    subject_id: ref.reference_id,
    title: "bound reference",
    x: 0,
    y: 0,
    width: 260,
    height: 140,
    props: { generation_slot: "main_reference", stage: "shots", role: "project_ref" }
  });

  record("G11 plan exposes lifecycle for valid values", () => {
    const defaultPlan = svc.canvasDreaminaCliPlan({ canvas_id: canvas.canvas_id, generation_type: "image_to_video" });
    assert.equal(defaultPlan.model_lifecycle.lifecycle, "default");
    assert.equal(defaultPlan.model_lifecycle.effective_default, "seedance2.0fast");
    const legacyPlan = svc.canvasDreaminaCliPlan({ canvas_id: canvas.canvas_id, generation_type: "image_to_video", model_version: "3.0fast" });
    assert.equal(legacyPlan.model_lifecycle.lifecycle, "legacy");
    assert.equal(legacyPlan.model_lifecycle.selectable_for_new_request, true);
    const candidatePlan = svc.canvasDreaminaCliPlan({ canvas_id: canvas.canvas_id, generation_type: "image_to_video", model_version: "seedance2.5" });
    assert.equal(candidatePlan.model_lifecycle.verified, true);
    assert.equal(candidatePlan.model_lifecycle.lifecycle, "candidate");
  });

  record("G12 read-only lifecycle query explains history and never throws", () => {
    const history = svc.describeModelLifecycle({ generation_type: "image_to_video", model_version: "3.0" });
    assert.equal(history.source, "capability_registry_readonly");
    assert.equal(history.lifecycle, "read_only_history");
    assert.equal(history.recognized, true);
    assert.equal(history.selectable_for_new_request, false);
    assert.ok(history.replacement);
    assert.equal(history.kind, "video");

    assert.equal(svc.describeModelLifecycle({ kind: "video", model_version: "3.0fast" }).lifecycle, "legacy");
    assert.equal(svc.describeModelLifecycle({ kind: "video", model_version: "seedance2.5" }).verified, true);
    assert.equal(svc.describeModelLifecycle({ kind: "image", model_version: "5.0Pro" }).verified, true);
    assert.equal(svc.describeModelLifecycle({ kind: "image", model_version: "5.0" }).lifecycle, "default");
    assert.equal(svc.describeModelLifecycle({ kind: "image" }).effective_default, "5.0");
    assert.equal(svc.describeModelLifecycle({ kind: "video", model_version: "seedance1.0" }).recognized, false);
    for (const value of ["", null, undefined, "garbage", "3.0", 42, {}]) {
      assert.doesNotThrow(() => svc.describeModelLifecycle({ kind: "video", model_version: value }));
    }
    // 只读查询不得写入任何资产/项目/画布数据
    const before = svc.searchAssets({ limit: 100 }).total;
    svc.describeModelLifecycle({ kind: "video", model_version: "3.0" });
    const after = svc.searchAssets({ limit: 100 }).total;
    assert.equal(after, before, "read-only lifecycle query must not mutate asset data");
  });

  try {
    await assert.rejects(
      () => svc.canvasDreaminaCliGenerateVideo({ canvas_id: canvas.canvas_id, generation_type: "image_to_video", model_version: "3.0", execute: false, run_preflight: false }),
      /model_version must be one of/,
      "bare 3.0 must be rejected on the new-request path with an explanatory error"
    );
    console.log("PASS G13 runtime still rejects the invalid bare 3.0 for new video requests");
  } catch (err) {
    failures.push({ gate: "G13 invalid value rejection", message: err?.message ?? String(err) });
    console.log(`FAIL G13 invalid value rejection: ${err?.message ?? err}`);
  }
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\ncapability registry test FAILED (${failures.length} gate(s))`);
  for (const f of failures) console.error(` - ${f.gate}: ${f.message}`);
  process.exit(1);
}
console.log("\ncapability registry test passed");
