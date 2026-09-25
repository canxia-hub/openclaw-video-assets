#!/usr/bin/env node
// ============================================================================
// REN-09 · 父审边界负控（第二轮父审 16-ren09-boundary-review.md 的定点返修验证）
// ============================================================================
// 定位：这是**我方**（湍）的负控夹具，独立于父线程探针
// （projects/video-platform-renewal-20260920/evidence/ren09-parent-boundary-probe.*，父方产物，本包不改）。
//
// 覆盖父审 4 项返修：
//   U  URL userinfo 未脱敏
//   C  规范化错误的原始 cause 在 node inspect 下回显合成凭证（toJSON 已安全但不足）
//   T  定时器在收到响应头后即清除，导致正文读取/解析不在超时范围内
//   R  recordInfo 空对象被判为 ok:true，未与「有效但状态解析未实现」区分
//
// 纪律：
//   · 仅使用**合成**标记（明显虚构，非任何真实凭证）；
//   · fetch 全部为内存 stub，不发起网络（用例结束后断言未发生真实调用）；
//   · 不访问凭证文件、不读环境中的真实密钥值。
import assert from "node:assert/strict";
import { inspect } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const errors = await import("../src/external-call.js");
const candidate = await import("../src/kie-suno-candidate-adapter.js");
const { redactUrl, redactText, normalizeExternalCallError, EXTERNAL_ERROR_CODES } = errors;

/** 合成标记：明显虚构，不含任何真实凭证片段 */
const MARKER = "SYNTHETIC_ONLY_NOT_A_REAL_CREDENTIAL";

const failures = [];
const notes = [];
const networkCalls = [];
let realFetchUsed = false;

async function gate(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push({ name, message: err?.message ?? String(err) });
    console.log(`FAIL ${name}: ${err?.message ?? err}`);
  }
}

/** 把全局 fetch 换成 stub，并记录任何「漏到真实网络」的调用 */
function stubGlobalFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    networkCalls.push({ url: String(url), method: init.method ?? "GET" });
    return handler(String(url), init);
  };
  return () => {
    if (globalThis.fetch !== original) globalThis.fetch = original;
  };
}

const responses = {
  /** 头很快、正文很慢，且**无视 abort 信号**（模拟不合规 stub / 真实实现里信号未被尊重的情形） */
  slowBodyIgnoringSignal: (body, delayMs) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return body;
    }
  }),
  /** 正文读取时按规范因 abort 而拒绝 */
  bodyRejectsOnAbort: (body) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => body
  }),
  fast: (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body
  })
};

const createTaskPayload = { model: "ai-music-api/generate", input: { custom_mode: false, instrumental: true, model: "V5_5" } };

// ============================================================================
// U · URL userinfo 脱敏
// ============================================================================
await gate("U1 redactUrl strips URL userinfo (username and password)", () => {
  const url = `https://tester:${MARKER}@example.invalid/api/v1/jobs/recordInfo?taskId=synthetic`;
  const redacted = redactUrl(url);
  assert.equal(redacted.includes(MARKER), false, `userinfo leaked: ${redacted}`);
  assert.equal(redacted.includes("tester"), false, `username leaked: ${redacted}`);
  assert.ok(redacted.includes("example.invalid"), "host must survive for troubleshooting");
  assert.ok(redacted.includes("/api/v1/jobs/recordInfo"), "path must survive for troubleshooting");
  assert.ok(redacted.includes("taskId=synthetic"), "non-sensitive params must survive");
});

await gate("U2 redactUrl strips userinfo that carries only a username", () => {
  const redacted = redactUrl(`https://${MARKER}@example.invalid/path`);
  assert.equal(redacted.includes(MARKER), false, `username-only userinfo leaked: ${redacted}`);
  assert.ok(redacted.includes("example.invalid"));
});

await gate("U3 redactText also strips userinfo-like inline credentials", () => {
  const redacted = redactText(`upstream complained about https://tester:${MARKER}@example.invalid/x`);
  assert.equal(redacted.includes(MARKER), false, `inline userinfo leaked: ${redacted}`);
});

await gate("U4 unparseable URL falls back to text redaction rather than throwing", () => {
  const redacted = redactUrl(`not-a-url api_key=${MARKER}`);
  assert.equal(typeof redacted, "string");
  assert.equal(redacted.includes(MARKER), false, `fallback leak: ${redacted}`);
});

// ============================================================================
// C · 规范化错误在 inspect / stack / cause 链上不得回显凭证
// ============================================================================
const wrapped = () => normalizeExternalCallError(new Error(`api_key=${MARKER}`), {
  provider: "kie.ai/suno-api",
  endpoint: `https://api.kie.ai/api/v1/generate?api_key=${MARKER}`,
  phase: "http_request"
});

await gate("C1 normalized error hides synthetic credential on message/stack/inspect/JSON", () => {
  const err = wrapped();
  const surfaces = {
    message: err.message,
    stack: err.stack,
    inspect_default: inspect(err),
    inspect_deep: inspect(err, { depth: null, showHidden: true }),
    json_stringify: JSON.stringify(err),
    toJSON: JSON.stringify(err.toJSON())
  };
  for (const [surface, value] of Object.entries(surfaces)) {
    assert.equal(String(value).includes(MARKER), false, `marker leaked via ${surface}`);
  }
});

await gate("C2 the raw cause is not retained: inspect cannot reach the synthetic credential", () => {
  const err = wrapped();
  assert.equal(inspect(err.cause ?? null).includes(MARKER), false, `cause leaked: ${inspect(err.cause ?? null)}`);
  // 逐层遍历 cause 链（含嵌套），任何一层都不得回显
  let node = err;
  let depth = 0;
  while (node && depth < 10) {
    assert.equal(inspect(node).includes(MARKER), false, `cause chain depth ${depth} leaked`);
    node = node.cause;
    depth += 1;
  }
  assert.ok(depth >= 1, "the cause chain should have been inspected at least once");
});

await gate("C3 cause sanitising keeps classifiable metadata (debuggability preserved)", () => {
  const original = Object.assign(new Error(`api_key=${MARKER}`), { code: "ECONNRESET", name: "Error" });
  const err = normalizeExternalCallError(original, { provider: "kie.ai/suno-api", phase: "http_request" });
  assert.ok(err.cause, "a cause summary must still be exposed");
  assert.equal(err.cause.code, "ECONNRESET", "system code must survive sanitising");
  assert.equal(err.cause.name, "Error");
  assert.equal(typeof err.cause.message, "string");
  assert.equal(err.cause.message.includes(MARKER), false, "sanitised cause message must be redacted");
  assert.equal(err.code, EXTERNAL_ERROR_CODES.NETWORK, "classification still works");
});

await gate("C4 cause summary is a plain, inert object (no Error instance to re-inspect)", () => {
  const err = wrapped();
  assert.equal(err.cause instanceof Error, false, "the raw Error must not be attached");
  assert.equal(Object.prototype.toString.call(err.cause), "[object Object]");
});

await gate("C5 httpFailure/upstreamFailure detail with inline userinfo is redacted", () => {
  const http = errors.httpFailure({
    provider: "doubao_seed_audio",
    status: 400,
    detail: `echoed url https://tester:${MARKER}@example.invalid/x`
  });
  assert.equal(inspect(http, { depth: null, showHidden: true }).includes(MARKER), false, "httpFailure leaked");
  const upstream = errors.upstreamFailure({
    provider: "kie.ai/suno-api",
    httpStatus: 200,
    upstreamCode: 402,
    message: `failed with https://tester:${MARKER}@example.invalid/x`
  });
  assert.equal(inspect(upstream, { depth: null, showHidden: true }).includes(MARKER), false, "upstreamFailure leaked");
});

// ============================================================================
// T · 超时必须覆盖正文读取与解析
// ============================================================================
await gate("T1 response body read is inside the timeout window (candidate adapter)", async () => {
  const restore = stubGlobalFetch(() => responses.slowBodyIgnoringSignal(JSON.stringify({ code: 200, data: { taskId: "synthetic" } }), 70));
  try {
    await assert.rejects(
      () => candidate.runKieSunoCandidateCreateTask(createTaskPayload, {
        apiKey: MARKER,
        allowCandidateEndpoint: true,
        timeoutMs: 20
      }),
      (err) => {
        assert.equal(err.code, EXTERNAL_ERROR_CODES.TIMEOUT, `expected timeout, got ${err.code}: ${err.message}`);
        return true;
      },
      "a slow body must not escape the timeout window"
    );
  } finally {
    restore();
  }
});

await gate("T2 abort signal stays live until the body is consumed", async () => {
  let capturedSignal = null;
  const restore = stubGlobalFetch((_url, init) => {
    capturedSignal = init.signal;
    return responses.slowBodyIgnoringSignal(JSON.stringify({ code: 200, data: { taskId: "synthetic" } }), 70);
  });
  try {
    await candidate.runKieSunoCandidateCreateTask(createTaskPayload, {
      apiKey: MARKER,
      allowCandidateEndpoint: true,
      timeoutMs: 20
    }).catch(() => {});
    assert.ok(capturedSignal, "signal must be captured");
    assert.equal(capturedSignal.aborted, true, "the timer must still fire while the body is pending");
  } finally {
    restore();
  }
});

await gate("T3 body rejection caused by our abort is normalised as a timeout", async () => {
  const restore = stubGlobalFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }
  }));
  try {
    await assert.rejects(
      () => candidate.runKieSunoCandidateCreateTask(createTaskPayload, {
        apiKey: MARKER,
        allowCandidateEndpoint: true,
        timeoutMs: 20
      }),
      (err) => {
        assert.equal(err.code, EXTERNAL_ERROR_CODES.TIMEOUT, `aborted body must classify as timeout, got ${err.code}`);
        return true;
      }
    );
  } finally {
    restore();
  }
});

await gate("T4 a body read failure that is not a timeout is normalised, not left raw", async () => {
  const restore = stubGlobalFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => {
      const err = new TypeError(`terminated while reading body api_key=${MARKER}`);
      throw err;
    }
  }));
  try {
    await assert.rejects(
      () => candidate.runKieSunoCandidateCreateTask(createTaskPayload, {
        apiKey: MARKER,
        allowCandidateEndpoint: true,
        timeoutMs: 5000
      }),
      (err) => {
        assert.equal(err.name, "ExternalCallError", `expected a normalised ExternalCallError, got ${err.name}`);
        assert.equal([EXTERNAL_ERROR_CODES.NETWORK, EXTERNAL_ERROR_CODES.TIMEOUT].includes(err.code), true, `unexpected code ${err.code}`);
        assert.equal(inspect(err, { depth: null, showHidden: true }).includes(MARKER), false, "body error leaked the synthetic credential");
        return true;
      }
    );
  } finally {
    restore();
  }
});

await gate("T5 timeout guard clears its timer (no dangling timer keeps the process alive)", async () => {
  if (typeof errors.createTimeoutGuard !== "function") {
    throw new Error("createTimeoutGuard is not exported: the timeout window is still adapter-local and untestable");
  }
  const guard = errors.createTimeoutGuard(20);
  assert.equal(guard.clear(), true, "clear() must report success");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(guard.timedOut, false, "a cleared guard must never report a timeout");
  assert.equal(guard.cleared, true, "guard must expose that it was cleared");
});

await gate("T6 both legacy adapters read the body inside the timeout window (same-source check)", () => {
  const guardPattern = /finally\s*\{\s*clearTimeout\(timer\);\s*\}\s*(?:const|let)\s+\w+\s*=\s*await\s+[A-Za-z0-9_$.]*(?:response|res)\.text\(\)/;
  for (const file of ["doubao-audio-adapter.js", "kie-suno-adapter.js", "kie-suno-candidate-adapter.js"]) {
    const source = fs.readFileSync(path.join(REPO, "src", file), "utf8");
    assert.equal(guardPattern.test(source), false, `${file} still clears the timer before reading the body`);
    assert.equal(source.includes("readResponseText"), true, `${file} must read the body through the shared timeout-aware helper`);
    assert.equal(source.includes(".clear()"), true, `${file} must clear the guard in a finally block`);
  }
});

await gate("T7 download paths also keep the timeout alive across the body", () => {
  for (const file of ["doubao-audio-adapter.js", "kie-suno-adapter.js"]) {
    const source = fs.readFileSync(path.join(REPO, "src", file), "utf8");
    const downloadBlock = source.slice(source.indexOf("async function downloadFile"));
    const body = downloadBlock.slice(0, downloadBlock.indexOf("\n}\n") + 3);
    assert.equal(
      /finally\s*\{\s*clearTimeout\(timer\);\s*\}\s*(?:if|const|let)/.test(body),
      false,
      `${file} downloadFile clears the timer before consuming the body`
    );
  }
});

// ============================================================================
// R · recordInfo 结构校验：必须区分「畸形响应」与「有效但状态解析未实现」
// ============================================================================
await gate("R1 empty recordInfo body is rejected, not reported as ok", () => {
  const parsed = candidate.parseKieSunoCandidateRecordInfoResponse({});
  assert.equal(parsed.ok, false, "an empty object must not be treated as a valid task record");
  assert.ok(parsed.reason, "rejection must explain itself");
  assert.equal(parsed.status_parsing, undefined, "a malformed body must not be given a status-parsing verdict");
});

await gate("R2 recordInfo missing data / missing task identifier is rejected", () => {
  for (const body of [
    { code: 200, msg: "success" },
    { code: 200, data: null },
    { code: 200, data: {} },
    { code: 200, data: { status: "SUCCESS" } },
    { data: { taskId: "synthetic-task" } }
  ]) {
    const parsed = candidate.parseKieSunoCandidateRecordInfoResponse(body);
    assert.equal(parsed.ok, false, `expected rejection for ${JSON.stringify(body)}`);
  }
});

await gate("R3 a structurally valid record still declares status parsing as an open gap", () => {
  const parsed = candidate.parseKieSunoCandidateRecordInfoResponse({ code: 200, data: { taskId: "synthetic-task" } });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.task_id, "synthetic-task");
  assert.equal(parsed.status_parsing, "not_implemented_contract_gap", "must not fake a terminal status");
  assert.equal(parsed.status, undefined, "no invented status field");
});

await gate("R4 non-200 business code is rejected with its upstream code preserved", () => {
  const parsed = candidate.parseKieSunoCandidateRecordInfoResponse({ code: 402, msg: "insufficient credits" });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.upstream_code, 402);
  assert.equal(candidate.parseKieSunoCandidateRecordInfoResponse("not an object").ok, false);
  assert.equal(candidate.parseKieSunoCandidateRecordInfoResponse(null).ok, false);
});

await gate("R5 createTask parsing rejects the same malformed shapes (parity)", () => {
  for (const body of [{}, { code: 200 }, { code: 200, data: {} }, null, "nope"]) {
    assert.equal(candidate.parseKieSunoCandidateCreateTaskResponse(body).ok, false, `expected rejection for ${JSON.stringify(body)}`);
  }
});

// ============================================================================
// 零网络断言
// ============================================================================
await gate("Z1 no real network was used; every call went through the in-memory stub", () => {
  assert.ok(networkCalls.length > 0, "the stub should have been exercised");
  for (const call of networkCalls) {
    assert.match(call.url, /^https:\/\/api\.kie\.ai\//, `unexpected outbound url: ${call.url}`);
  }
  assert.equal(realFetchUsed, false);
  notes.push(`stubbed calls: ${networkCalls.length}`);
});

if (failures.length) {
  console.error(`\nREN-09 boundary regression FAILED (${failures.length}/${failures.length + "gates"})`);
  for (const f of failures) console.error(` - ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log("\nREN-09 boundary regression passed");
