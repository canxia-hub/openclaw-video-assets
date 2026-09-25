#!/usr/bin/env node
// ============================================================================
// REN-09 · 父审边界探针同口径复跑（我方副本）
// ============================================================================
// 为什么不直接重跑父审脚本：
//   父审探针与其 JSON 输出位于 projects/video-platform-renewal-20260920/evidence/
//   （父方产物），父审明确要求「保留不改」。直接重跑会就地覆盖那份 JSON。
//   因此这里按**同一口径**复刻 7 个观测字段，输出写入 implementation/REN-09/logs/，
//   二者可直接并排比对。
//
// 读法（重要）：
//   父审原脚本里的 `true` 是**缺陷观测**，不是通过断言。
//   本脚本因此把每个观测同时给出 `defect_present` 布尔与期望值，避免再次误读。
//
// 纪律：仅合成标记；fetch 为内存 stub；无网络调用；不读真实凭证。
import { inspect } from "node:util";
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
// 插件仓库位于 <工程根>/repo/video-assets ⇒ 上两级即工程根（implementation/REN-09）
const REN09_ROOT = path.resolve(REPO, "..", "..");
const OUT_DIR = path.join(REN09_ROOT, "logs");
mkdirSync(OUT_DIR, { recursive: true });
const OUT = path.join(OUT_DIR, "boundary-probe-recheck.json");

const errors = await import("../src/external-call.js");
const candidate = await import("../src/kie-suno-candidate-adapter.js");

/** 与父审探针相同的合成标记语义（明显虚构） */
const marker = "SYNTHETIC_ONLY_NOT_A_REAL_CREDENTIAL";

const observed = {};
observed.candidate_commit = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
observed.network_calls = 0;

// 1) URL userinfo
observed.url_userinfo_retained = errors.redactUrl(`https://tester:${marker}@example.invalid/path`).includes(marker);

// 2) 规范化错误的 inspect 是否还能摸到原始 cause 里的合成凭证
const wrapped = errors.normalizeExternalCallError(new Error(`api_key=${marker}`));
observed.error_inspect_retains_raw_cause = inspect(wrapped).includes(marker);
observed.error_inspect_deep_retains_raw_cause = inspect(wrapped, { depth: null, showHidden: true }).includes(marker);
observed.error_inspect_cause_chain_retains_marker = inspect(wrapped.cause ?? null).includes(marker);
observed.error_json_retains_marker = JSON.stringify(wrapped).includes(marker);
observed.error_stack_retains_marker = String(wrapped.stack ?? "").includes(marker);

// 3) recordInfo 空对象
observed.null_task_record_claims_ok = candidate.parseKieSunoCandidateRecordInfoResponse({}).ok;
observed.missing_data_record_claims_ok = candidate.parseKieSunoCandidateRecordInfoResponse({ code: 200 }).ok;
observed.valid_record_still_ok = candidate.parseKieSunoCandidateRecordInfoResponse({ code: 200, data: { taskId: "synthetic-task" } }).ok;

// 4) 超时是否覆盖正文读取
let signal;
let receivedAuth;
let returnedAfterTimeout = false;
let rejectionCode = null;
const start = Date.now();
await candidate.runKieSunoCandidateCreateTask({ model: "ai-music-api/generate", input: { custom_mode: false, instrumental: true, model: "V5_5" } }, {
  apiKey: marker,
  allowCandidateEndpoint: true,
  timeoutMs: 20,
  fetchImpl: async (_url, init) => {
    signal = init.signal;
    receivedAuth = init.headers.Authorization;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => {
        await new Promise((resolve) => setTimeout(resolve, 70));
        return JSON.stringify({ code: 200, data: { taskId: "synthetic-task" } });
      }
    };
  }
}).then(() => {
  returnedAfterTimeout = true;
}, (err) => {
  rejectionCode = err?.code ?? null;
});

observed.auth_header_matches_synthetic_key = receivedAuth === "Bearer " + marker;
observed.body_succeeded_beyond_timeout = returnedAfterTimeout && Date.now() - start >= 60;
observed.body_rejection_code = rejectionCode;
observed.signal_aborted_after_body = signal.aborted;

/** 期望值：修复后不应再出现「缺陷观测为 true」的项（认证头一项例外，它本来就正确） */
const expectations = {
  url_userinfo_retained: false,
  error_inspect_retains_raw_cause: false,
  error_inspect_deep_retains_raw_cause: false,
  error_inspect_cause_chain_retains_marker: false,
  error_json_retains_marker: false,
  error_stack_retains_marker: false,
  null_task_record_claims_ok: false,
  missing_data_record_claims_ok: false,
  valid_record_still_ok: true,
  body_succeeded_beyond_timeout: false,
  signal_aborted_after_body: true,
  auth_header_matches_synthetic_key: true
};

const comparison = {};
let defects = 0;
for (const [key, expected] of Object.entries(expectations)) {
  const actual = observed[key];
  const defect = actual !== expected;
  if (defect) defects += 1;
  comparison[key] = { observed: actual, expected, defect_present: defect };
}

const report = {
  probe: "ren09-boundary-probe-recheck",
  note: "父审探针结果的 true 是缺陷观测；本表同时给出 observed / expected / defect_present，避免误读为通过断言",
  candidate_commit: observed.candidate_commit,
  network_calls: observed.network_calls,
  observed,
  comparison,
  defects_present: defects
};
writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (defects > 0) {
  console.error(`\nboundary probe recheck: ${defects} defect(s) still observable`);
  process.exit(1);
}
console.log("\nboundary probe recheck: 0 defects present");
