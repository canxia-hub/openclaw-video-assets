#!/usr/bin/env node
// REN-09 父审修正 · 外部调用分类与脱敏（离线，零成本）
// 覆盖父审第 5 项：
//   - TimeoutError / AbortError / 网络错误 / HTTP 状态失败 / HTTP 2xx 但业务码失败 五类严格区分
//   - 原始错误、detail、endpoint 的脱敏边界
//   - 夹具只用**合成**敏感值（下例中的 key 均为明显虚构字符串）
import assert from "node:assert/strict";
import {
  EXTERNAL_ERROR_CODES,
  ExternalCallError,
  classifyExternalError,
  normalizeExternalCallError,
  httpFailure,
  upstreamFailure,
  invalidResponseFailure,
  cliFailure,
  redactText,
  redactUrl,
  isRetryableStatus,
  providerTimeoutPolicy
} from "../src/external-call.js";
import { buildKieSunoCandidatePayload, validateKieSunoCandidatePayload } from "../src/kie-suno-candidate-adapter.js";

const failures = [];
const gate = (name, fn) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push({ name, message: err?.message ?? String(err) });
    console.log(`FAIL ${name}: ${err?.message ?? err}`);
  }
};

// ---------------------------------------------------------------- 分类
gate("C1 TimeoutError is classified as timeout (not abort)", () => {
  const timeoutError = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  assert.equal(classifyExternalError(timeoutError), EXTERNAL_ERROR_CODES.TIMEOUT);
  const normalized = normalizeExternalCallError(timeoutError, { provider: "kie.ai/suno-api", phase: "http_timeout" });
  assert.equal(normalized.code, EXTERNAL_ERROR_CODES.TIMEOUT);
  assert.equal(normalized.retryable, true);
  assert.equal(normalized.auto_retry_allowed, false);
});

gate("C2 bare AbortError is abort, not timeout", () => {
  const abortError = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  assert.equal(classifyExternalError(abortError), EXTERNAL_ERROR_CODES.ABORTED);
  const normalized = normalizeExternalCallError(abortError, { provider: "kie.ai/suno-api", phase: "http_request" });
  assert.equal(normalized.code, EXTERNAL_ERROR_CODES.ABORTED, "abort must not masquerade as timeout");
  assert.equal(normalized.retryable, false, "a consumer-initiated abort is not retryable by default");
  // 调用方确知是我们的计时器触发时，可用 hint 显式升级为 timeout
  const withHint = normalizeExternalCallError(abortError, { phase: "http_timeout", hint: EXTERNAL_ERROR_CODES.TIMEOUT });
  assert.equal(withHint.code, EXTERNAL_ERROR_CODES.TIMEOUT);
  assert.equal(withHint.retryable, true);
});

gate("C3 socket timeouts and network failures are distinguished", () => {
  assert.equal(classifyExternalError(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })), EXTERNAL_ERROR_CODES.TIMEOUT);
  assert.equal(classifyExternalError(Object.assign(new Error("headers timeout"), { code: "UND_ERR_HEADERS_TIMEOUT" })), EXTERNAL_ERROR_CODES.TIMEOUT);
  assert.equal(classifyExternalError(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })), EXTERNAL_ERROR_CODES.NETWORK);
  assert.equal(classifyExternalError(new TypeError("fetch failed")), EXTERNAL_ERROR_CODES.NETWORK);
  assert.equal(classifyExternalError(new Error("something odd")), EXTERNAL_ERROR_CODES.UNKNOWN);
});

gate("C4 transport failure vs upstream business-code failure are separate codes", () => {
  const transport = httpFailure({ provider: "doubao_seed_audio", status: 503 });
  assert.equal(transport.code, EXTERNAL_ERROR_CODES.HTTP_STATUS);
  assert.equal(transport.retryable, true);
  const business = upstreamFailure({ provider: "kie.ai/suno-api", httpStatus: 200, upstreamCode: 402, message: "insufficient credits" });
  assert.equal(business.code, EXTERNAL_ERROR_CODES.UPSTREAM_CODE, "business failure must not be reported as an HTTP status failure");
  assert.equal(business.status, 200, "the transport actually succeeded; status must stay 200");
  assert.equal(business.retryable, false, "business failures must never look retryable (duplicate billing risk)");
  const badShape = invalidResponseFailure({ provider: "kie.ai/suno-api", detail: "data.taskId missing" });
  assert.equal(badShape.code, EXTERNAL_ERROR_CODES.INVALID_RESPONSE);
  assert.equal(badShape.retryable, false);
  assert.equal(isRetryableStatus(408), true);
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(501), true);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus("nope"), false);
});

gate("C5 CLI failures stay non-retryable with upstream code preserved", () => {
  const cli = cliFailure({ provider: "dreamina_cli", command: "dreamina image2video", exitCode: 1, parsed: { error: { code: "4010", message: "AigcComplianceConfirmationRequired" } } });
  assert.equal(cli.code, EXTERNAL_ERROR_CODES.UPSTREAM_CODE);
  assert.equal(cli.upstream_code, "4010");
  assert.equal(cli.retryable, false);
  assert.ok(cli instanceof ExternalCallError);
});

// ---------------------------------------------------------------- 脱敏
gate("R1 synthetic secrets never survive redaction", () => {
  // 全部为明显虚构的合成值，不来自任何真实凭证
  const syntheticKeys = [
    "sk-SYNTHETIC-0000000000000000",
    "SYNTHETIC_TOKEN_abcdef123456",
    "SYNTHETIC-SECRET-9876543210"
  ];
  const samples = [
    `Authorization: Bearer ${syntheticKeys[0]}`,
    `X-Api-Key: ${syntheticKeys[0]}`,
    `{"api_key":"${syntheticKeys[0]}"}`,
    `apiKey=${syntheticKeys[1]}`,
    `access_token=${syntheticKeys[1]}`,
    `client_secret: ${syntheticKeys[2]}`
  ];
  for (const sample of samples) {
    const redacted = redactText(sample);
    for (const key of syntheticKeys) {
      assert.equal(redacted.includes(key), false, `synthetic secret leaked through: ${redacted}`);
    }
    assert.ok(redacted.includes("***"), `redaction marker missing: ${redacted}`);
  }
});

gate("R2 query-string credentials are redacted but host and path survive", () => {
  const url = "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=SYNTHETIC123&api_key=sk-SYNTHETIC-0000000000000000&page=1";
  const redacted = redactUrl(url);
  assert.equal(redacted.includes("sk-SYNTHETIC-0000000000000000"), false, "query credential leaked");
  assert.ok(redacted.includes("api.kie.ai"), "host must survive for troubleshooting");
  assert.ok(redacted.includes("/api/v1/jobs/recordInfo"), "path must survive for troubleshooting");
  assert.ok(redacted.includes("taskId=SYNTHETIC123"), "non-sensitive params must survive");
  assert.ok(redacted.includes("page=1"), "non-sensitive params must survive");
});

gate("R3 long base64 payloads are collapsed in messages", () => {
  const payload = "A".repeat(400);
  const text = `upstream echoed audio_data=${payload}`;
  const redacted = redactText(text);
  assert.equal(redacted.includes(payload), false);
  assert.match(redacted, /redacted 400 chars/);
  // 短 id 不应被误伤
  const shortId = "5c79xxxxbe8e";
  assert.ok(redactText(`taskId=${shortId}`).includes(shortId));
});

gate("R4 normalized errors redact endpoint/upstream detail/logid", () => {
  const error = normalizeExternalCallError(new Error("boom"), {
    provider: "kie.ai/suno-api",
    endpoint: "https://api.kie.ai/api/v1/generate?api_key=sk-SYNTHETIC-0000000000000000",
    phase: "http_request",
    upstream_code: "SYNTHETIC-CODE",
    logid: "Bearer sk-SYNTHETIC-0000000000000000"
  });
  const json = JSON.stringify(error.toJSON());
  assert.equal(json.includes("sk-SYNTHETIC-0000000000000000"), false, "secret leaked via normalized error JSON");
  const http = httpFailure({ provider: "doubao_seed_audio", status: 400, detail: `X-Api-Key: sk-SYNTHETIC-0000000000000000` });
  assert.equal(http.message.includes("sk-SYNTHETIC-0000000000000000"), false, "secret leaked via httpFailure detail");
  // 幂等：已规范化错误不再二次包装
  assert.equal(normalizeExternalCallError(error, {}), error);
});

// ---------------------------------------------------------------- 与候选适配器协同
gate("R5 candidate adapter payload carries no credential material", () => {
  const payload = buildKieSunoCandidatePayload({
    request: { prompt: "synthetic prompt", customMode: true, instrumental: true, model: "V4", style: "test", title: "t", negativeTags: "n", vocalGender: "m" }
  });
  assert.equal(validateKieSunoCandidatePayload(payload).status, "ready");
  assert.equal(JSON.stringify(payload).match(/bearer|api[_-]?key|authorization/i), null, "payload must not contain credential-like fields");
  assert.equal(payload.callBackUrl, undefined, "callBackUrl must only appear when explicitly provided");
});

gate("C6 timeout policies come from the registry", () => {
  assert.deepEqual(Object.values(providerTimeoutPolicy("kie.ai/suno-api")).slice(1, 4), [30000, 900000, 3600000]);
  assert.throws(() => providerTimeoutPolicy("nope"), /unknown provider/);
});

if (failures.length) {
  console.error(`\nexternal-call classification/redaction test FAILED (${failures.length})`);
  for (const f of failures) console.error(` - ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log("\nexternal-call classification/redaction test passed");
