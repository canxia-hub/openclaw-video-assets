#!/usr/bin/env node
// REN-09 父审修正 · KIE 现行端点（candidate）离线契约测试
// 父审第 3 项：新端点可以先实现「显式候选适配器 + 离线契约」，不切默认、不停止旧链。
// 本测试全程使用 **stub fetch**（不发起任何真实网络请求、不消耗额度）。
import assert from "node:assert/strict";
import {
  KIE_SUNO_CANDIDATE_ENDPOINTS,
  KIE_SUNO_CANDIDATE_CONTRACT_GAPS,
  buildKieSunoCandidatePayload,
  validateKieSunoCandidatePayload,
  parseKieSunoCandidateCreateTaskResponse,
  buildKieSunoCandidateRecordInfoRequest,
  parseKieSunoCandidateRecordInfoResponse,
  runKieSunoCandidateCreateTask
} from "../src/kie-suno-candidate-adapter.js";
import { normalizeKieSunoRequest } from "../src/kie-suno-adapter.js";
import { PROVIDER_REGISTRY } from "../src/capability-registry.js";

const failures = [];
const gate = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push({ name, message: err?.message ?? String(err) });
    console.log(`FAIL ${name}: ${err?.message ?? err}`);
  }
};

const SYNTHETIC_KEY = "sk-SYNTHETIC-0000000000000000";

function stubFetch(handler) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const result = await handler({ url: String(url), options });
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      headers: { get: () => null },
      text: async () => (typeof result.body === "string" ? result.body : JSON.stringify(result.body ?? {}))
    };
  };
  return { impl, calls };
}

const normalized = normalizeKieSunoRequest({
  endpoint: "/api/v1/generate",
  customMode: true,
  instrumental: false,
  model: "V4",
  prompt: "synthetic lyrics",
  style: "Classical",
  title: "Synthetic Title",
  negativeTags: "Heavy Metal",
  vocalGender: "m",
  duration: 20,
  styleWeight: 0.65,
  weirdnessConstraint: 0.65,
  audioWeight: 0.65
});

// ---------------------------------------------------------------- 端点定义
await gate("K1 candidate endpoints match the official documented paths", () => {
  assert.equal(KIE_SUNO_CANDIDATE_ENDPOINTS.create_task.method, "POST");
  assert.equal(KIE_SUNO_CANDIDATE_ENDPOINTS.create_task.path, "/api/v1/jobs/createTask");
  assert.equal(KIE_SUNO_CANDIDATE_ENDPOINTS.create_task.task_type, "ai-music-api/generate");
  assert.equal(KIE_SUNO_CANDIDATE_ENDPOINTS.record_info.method, "GET");
  assert.equal(KIE_SUNO_CANDIDATE_ENDPOINTS.record_info.path, "/api/v1/jobs/recordInfo");
  for (const endpoint of Object.values(KIE_SUNO_CANDIDATE_ENDPOINTS)) {
    assert.equal(endpoint.lifecycle, "candidate");
    assert.equal(endpoint.in_use, false, "candidate endpoints must never be marked in use");
  }
});

await gate("K2 registry agrees: candidate endpoints are unused, legacy endpoints stay in use", () => {
  const fresh = PROVIDER_REGISTRY["kie.ai/suno-api"].endpoints.find((ep) => ep.ref.endsWith("/api/v1/jobs/createTask"));
  assert.ok(fresh, "registry must carry the documented candidate endpoint");
  assert.equal(fresh.lifecycle, "candidate");
  assert.equal(fresh.in_use, false);
  const legacy = PROVIDER_REGISTRY["kie.ai/suno-api"].endpoints.find((ep) => ep.ref.endsWith("/api/v1/generate"));
  assert.equal(legacy.lifecycle, "legacy");
  assert.equal(legacy.in_use, true, "the legacy endpoint must remain the in-use default until a replacement chain is verified");
});

// ---------------------------------------------------------------- payload 契约
await gate("K3 payload follows the documented shape (task type + nested input)", () => {
  const payload = buildKieSunoCandidatePayload(normalized);
  assert.equal(payload.model, "ai-music-api/generate", "top-level model is the task type, not the music model");
  assert.ok(payload.input, "payload must nest generation params under input");
  assert.equal(payload.input.model, "V4", "the music model lives in input.model");
  assert.equal(payload.input.custom_mode, true, "official doc spells this custom_mode");
  assert.equal(payload.input.instrumental, false);
  assert.equal(payload.input.negative_tags, "Heavy Metal", "official doc uses negative_tags");
  assert.equal(payload.input.vocal_gender, "m");
  assert.equal(payload.input.style_weight, 0.65);
  assert.equal(payload.input.duration, 20);
  // 不得把旧端点的 camelCase 泄漏到新端点
  for (const legacyKey of ["customMode", "negativeTags", "vocalGender", "styleWeight", "weirdnessConstraint", "audioWeight"]) {
    assert.equal(payload.input[legacyKey], undefined, `legacy camelCase key ${legacyKey} must not appear in the candidate payload`);
  }
  assert.equal(validateKieSunoCandidatePayload(payload).status, "ready");
});

await gate("K4 non-custom mode omits custom-mode-only parameters", () => {
  const nonCustom = normalizeKieSunoRequest({
    endpoint: "/api/v1/generate",
    customMode: false,
    instrumental: false,
    model: "V4",
    prompt: "synthetic idea",
    style: "Ambient",
    duration: 20,
    vocalGender: "m",
    styleWeight: 0.5
  });
  const payload = buildKieSunoCandidatePayload(nonCustom);
  assert.equal(payload.input.custom_mode, false);
  for (const forbidden of ["duration", "vocal_gender", "style_weight", "weirdness_constraint", "audio_weight", "variety"]) {
    assert.equal(payload.input[forbidden], undefined, `${forbidden} is custom-mode-only and must be omitted`);
  }
  assert.equal(validateKieSunoCandidatePayload(payload).status, "ready");
  // 契约校验器本身也要能拦下违规载荷
  const illegal = { model: "ai-music-api/generate", input: { custom_mode: false, instrumental: false, model: "V4", duration: 20 } };
  const verdict = validateKieSunoCandidatePayload(illegal);
  assert.equal(verdict.status, "blocked");
  assert.match(verdict.blockers.join(" | "), /only effective in custom mode/);
});

await gate("K5 callBackUrl only appears when explicitly supplied (official camelCase preserved)", () => {
  const withoutCallback = buildKieSunoCandidatePayload(normalized);
  assert.equal(withoutCallback.callBackUrl, undefined);
  const withCallback = buildKieSunoCandidatePayload(normalized, { callBackUrl: "https://example.invalid/cb" });
  assert.equal(withCallback.callBackUrl, "https://example.invalid/cb", "official example spells it callBackUrl");
  assert.equal(validateKieSunoCandidatePayload({ ...withCallback, callBackUrl: 42 }).status, "blocked");
});

await gate("K6 wrong task type is rejected by the offline validator", () => {
  const wrong = { model: "V4", input: { custom_mode: true, instrumental: false, model: "V4" } };
  const verdict = validateKieSunoCandidatePayload(wrong);
  assert.equal(verdict.status, "blocked");
  assert.match(verdict.blockers.join(" | "), /must be "ai-music-api\/generate"/);
  assert.equal(validateKieSunoCandidatePayload(null).status, "blocked");
  assert.equal(validateKieSunoCandidatePayload({ model: "ai-music-api/generate" }).status, "blocked");
});

// ---------------------------------------------------------------- 响应解析
await gate("K7 createTask response parsing", () => {
  assert.deepEqual(parseKieSunoCandidateCreateTaskResponse({ code: 200, msg: "success", data: { taskId: "5c79xxxxbe8e" } }), {
    ok: true,
    task_id: "5c79xxxxbe8e"
  });
  const failure = parseKieSunoCandidateCreateTaskResponse({ code: 402, msg: "insufficient credits" });
  assert.equal(failure.ok, false);
  assert.equal(failure.upstream_code, 402);
  assert.equal(parseKieSunoCandidateCreateTaskResponse({ code: 200, msg: "success", data: {} }).ok, false);
  assert.equal(parseKieSunoCandidateCreateTaskResponse("not json").ok, false);
});

await gate("K8 recordInfo request building + response parsing (status parsing declared as gap)", () => {
  const requestSpec = buildKieSunoCandidateRecordInfoRequest({ taskId: "5c79xxxxbe8e" });
  assert.equal(requestSpec.method, "GET");
  assert.match(requestSpec.url, /\/api\/v1\/jobs\/recordInfo\?taskId=5c79xxxxbe8e$/);
  assert.throws(() => buildKieSunoCandidateRecordInfoRequest({}), /taskId is required/);
  const parsed = parseKieSunoCandidateRecordInfoResponse({ code: 200, data: { taskId: "5c79xxxxbe8e" } });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.status_parsing, "not_implemented_contract_gap", "status parsing must be declared as a contract gap, not faked");
  assert.equal(parseKieSunoCandidateRecordInfoResponse({ code: 500, msg: "boom" }).ok, false);
});

// ---------------------------------------------------------------- 硬门：候选默认关闭
await gate("K9 candidate execution is refused unless explicitly enabled", async () => {
  const { impl, calls } = stubFetch(() => ({ status: 200, body: { code: 200, msg: "success", data: { taskId: "t1" } } }));
  const payload = buildKieSunoCandidatePayload(normalized);
  await assert.rejects(
    () => runKieSunoCandidateCreateTask(payload, { apiKey: SYNTHETIC_KEY, fetchImpl: impl }),
    /candidate endpoint is not enabled/,
    "the candidate chain must not run by default"
  );
  assert.equal(calls.length, 0, "no network call may happen when the candidate gate is closed");
  await assert.rejects(
    () => runKieSunoCandidateCreateTask(payload, { apiKey: SYNTHETIC_KEY, allowCandidateEndpoint: false, fetchImpl: impl }),
    /candidate endpoint is not enabled/
  );
  assert.equal(calls.length, 0);
});

await gate("K10 candidate execution when enabled: request shape + success parsing", async () => {
  const { impl, calls } = stubFetch(() => ({ status: 200, body: { code: 200, msg: "success", data: { taskId: "task-synthetic-1" } } }));
  const payload = buildKieSunoCandidatePayload(normalized);
  const result = await runKieSunoCandidateCreateTask(payload, {
    apiKey: SYNTHETIC_KEY,
    allowCandidateEndpoint: true,
    fetchImpl: impl
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.kie.ai/api/v1/jobs/createTask");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
  assert.match(calls[0].options.headers.Authorization, /^Bearer /);
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.model, "ai-music-api/generate");
  assert.equal(sent.input.model, "V4");
  assert.equal(result.task_id, "task-synthetic-1");
  assert.equal(result.lifecycle, "candidate");
  assert.equal(result.contract_status, "documented_unverified", "must not claim the candidate chain is verified");
});

await gate("K11 failure classification for the candidate chain (offline stubs)", async () => {
  const payload = buildKieSunoCandidatePayload(normalized);
  // 传输层失败 → external_http_status
  const transport = stubFetch(() => ({ status: 503, body: "service unavailable" }));
  await assert.rejects(
    () => runKieSunoCandidateCreateTask(payload, { apiKey: SYNTHETIC_KEY, allowCandidateEndpoint: true, fetchImpl: transport.impl }),
    (err) => {
      assert.equal(err.code, "external_http_status");
      assert.equal(err.status, 503);
      assert.equal(err.auto_retry_allowed, false);
      return true;
    }
  );
  // HTTP 200 但业务码失败 → external_upstream_code（不得冒充 HTTP 失败）
  const business = stubFetch(() => ({ status: 200, body: { code: 402, msg: "insufficient credits" } }));
  await assert.rejects(
    () => runKieSunoCandidateCreateTask(payload, { apiKey: SYNTHETIC_KEY, allowCandidateEndpoint: true, fetchImpl: business.impl }),
    (err) => {
      assert.equal(err.code, "external_upstream_code");
      assert.equal(err.status, 200, "transport succeeded; status must stay 200");
      assert.equal(err.retryable, false);
      return true;
    }
  );
  // 响应不可解析 → external_invalid_response
  const broken = stubFetch(() => ({ status: 200, body: "<html>not json</html>" }));
  await assert.rejects(
    () => runKieSunoCandidateCreateTask(payload, { apiKey: SYNTHETIC_KEY, allowCandidateEndpoint: true, fetchImpl: broken.impl }),
    (err) => {
      assert.ok(["external_invalid_response", "external_upstream_code"].includes(err.code), `unexpected code ${err.code}`);
      return true;
    }
  );
  // 缺失凭证 → 明确报错且不发起请求
  const unused = stubFetch(() => ({ status: 200, body: {} }));
  await assert.rejects(
    () => runKieSunoCandidateCreateTask(payload, { apiKey: "", allowCandidateEndpoint: true, fetchImpl: unused.impl }),
    /KIE_API_KEY is required/
  );
  assert.equal(unused.calls.length, 0);
});

await gate("K12 credentials never leak into candidate error messages", async () => {
  const payload = buildKieSunoCandidatePayload(normalized);
  const echo = stubFetch(() => ({ status: 200, body: { code: 500, msg: `bad request x-api-key: ${SYNTHETIC_KEY}` } }));
  await assert.rejects(
    () => runKieSunoCandidateCreateTask(payload, { apiKey: SYNTHETIC_KEY, allowCandidateEndpoint: true, fetchImpl: echo.impl }),
    (err) => {
      assert.equal(JSON.stringify(err.toJSON()).includes(SYNTHETIC_KEY), false, "synthetic key leaked into candidate error");
      return true;
    }
  );
});

// ---------------------------------------------------------------- 缺口登记
await gate("K13 unverifiable contract parts are declared as gaps, not invented", () => {
  assert.ok(KIE_SUNO_CANDIDATE_CONTRACT_GAPS.length >= 3);
  for (const gap of KIE_SUNO_CANDIDATE_CONTRACT_GAPS) {
    for (const field of ["field", "status", "documented", "assumption", "risk", "verification"]) {
      assert.ok(typeof gap[field] === "string" && gap[field].trim().length > 0, `gap needs ${field}`);
    }
    assert.notEqual(gap.status, "verified", "no candidate contract part may claim verification before a real call");
  }
  const fields = KIE_SUNO_CANDIDATE_CONTRACT_GAPS.map((gap) => gap.field);
  assert.ok(fields.includes("record_info.query_param"), "the inferred recordInfo query param must be declared");
  assert.ok(fields.includes("record_info.status_fields"), "the unknown status fields must be declared");
});

if (failures.length) {
  console.error(`\nkie candidate contract test FAILED (${failures.length})`);
  for (const f of failures) console.error(` - ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log("\nkie candidate contract test passed");
