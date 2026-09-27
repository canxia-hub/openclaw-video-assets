// ============================================================================
// REN-09 · 外部调用的超时 / 错误规范化与脱敏
// ============================================================================
// 目标：把「CLI 子进程 / HTTPS provider」两类外部调用的失败统一成可机读结构，
// 让上层（服务层、任务记录、UI、报告）不再各自解析自由文本错误串。
//
// 纪律：
//   1. 只规范化，不自动重试。生成类提交的自动重试可能导致重复计费，
//      任务书 stopConditions 明令禁止；`retryable` 仅作提示，由调用方显式决策。
//   2. 不吞原始信息：规范化后的 message 保留原始错误文本，便于既有排障习惯沿用。
//   3. 超时上下界来自 capability-registry 的 provider 条目，避免第二份真相源。
//   4. **脱敏**：外部错误文本、URL 与上游 detail 可能带回凭证或长 base64 载体，
//      写入消息前必须经 redactText / redactUrl 处理；本模块保证规范化错误自身不泄露。
//      **URL userinfo 与原始 cause 也是凭证载体**：仅遮蔽查询串、仅让 cause 不可枚举都不够
//      （toJSON 安全 ≠ inspect/stack 安全），因此 cause 只保留**已脱敏的纯对象摘要**。
//   5. 分类按**实际响应与错误类型**区分，不做「一刀切」：超时 / 主动中止 / 网络 /
//      HTTP 状态失败 / HTTP 2xx 但业务码失败 —— 五类语义不同，不可互相冒充。
import { PROVIDER_REGISTRY } from "./capability-registry.js";

export const EXTERNAL_ERROR_CODES = Object.freeze({
  TIMEOUT: "external_timeout",
  ABORTED: "external_aborted",
  NETWORK: "external_network",
  HTTP_STATUS: "external_http_status",
  UPSTREAM_CODE: "external_upstream_code",
  INVALID_RESPONSE: "external_invalid_response",
  MISSING_CREDENTIAL: "external_missing_credential",
  UNKNOWN: "external_unknown"
});

/** 脱敏：查询串中这些参数名视为敏感（含常见变体与大小写） */
const SENSITIVE_QUERY_KEYS = Object.freeze([
  "key",
  "api_key",
  "apikey",
  "api-key",
  "access_key",
  "secret",
  "secret_key",
  "token",
  "access_token",
  "refresh_token",
  "auth",
  "authorization",
  "password",
  "passwd",
  "signature",
  "sign",
  "code",
  "credential"
]);

const REDACTED = "***";

/** 长 base64 连续串（≥200 字符）视为载荷而不是可读文本，整体遮蔽 */
const LONG_BASE64_RE = /[A-Za-z0-9+/]{200,}={0,2}/g;

/** URL userinfo（scheme://user:pass@host）——userinfo 是凭证载体，必须遮蔽 */
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi;

/**
 * 文本脱敏。用于任何要写进错误消息、日志、审计记录的外部文本。
 * 覆盖：URL userinfo、Bearer/Basic 凭证、X-Api-Key 等头部形态、key=value 形态、超长 base64 载荷。
 */
export function redactText(value) {
  if (value === undefined || value === null) return value;
  let text = String(value);
  // URL userinfo（先处理，否则 user:pass 会先被后续规则拆开）
  text = text.replace(URL_USERINFO_RE, (_m, scheme) => `${scheme}${REDACTED}@`);
  // 头部与认证形态
  text = text.replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, (_m, scheme) => `${scheme} ${REDACTED}`);
  text = text.replace(/(["']?(?:x-api-key|x-api-access-key|api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|secret[-_]?key|client[-_]?secret)["']?\s*[:=]\s*["']?)([^"',;\s)\]}]{6,})/gi, (_m, prefix) => `${prefix}${REDACTED}`);
  // URL 查询串形态（含 & 分隔的后续参数）
  text = text.replace(/([?&](?:[A-Za-z0-9_.-]*(?:key|token|secret|sign|auth|password|credential)[A-Za-z0-9_.-]*)=)([^&\s"']+)/gi, (_m, prefix) => `${prefix}${REDACTED}`);
  // 超长 base64 载荷
  text = text.replace(LONG_BASE64_RE, (m) => `***<redacted ${m.length} chars>`);
  return text;
}

/**
 * URL 脱敏：遮蔽 userinfo 与敏感查询值，保留主机与路径以便排障。
 * 注意：userinfo（`https://user:pass@host`）是**凭证载体**，仅遮蔽查询串是不够的。
 */
export function redactUrl(url) {
  if (url === undefined || url === null) return url;
  const raw = String(url);
  try {
    const parsed = new URL(raw);
    let touched = false;
    if (parsed.username || parsed.password) {
      parsed.username = REDACTED;
      parsed.password = "";
      touched = true;
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.includes(key.toLowerCase())) {
        parsed.searchParams.set(key, REDACTED);
        touched = true;
      }
    }
    return touched ? parsed.toString() : raw;
  } catch {
    return redactText(raw);
  }
}

/**
 * 把任意异常转成**已脱敏的纯对象摘要**。
 *
 * 为什么不是「把原 Error 挂到 cause 上、再设为不可枚举」：
 *   node `util.inspect(err)` / 日志器 / 崩溃报告器会递归输出 cause（包括其 stack），
 *   不可枚举只能欺骗`JSON.stringify`，阻止不了 inspect 回显原始凭证。
 *   因此这里**不保留原 Error 实例**，只保留可分类、可排障的字段，且所有文本经脱敏。
 */
export function sanitizeCause(cause) {
  if (cause === undefined || cause === null) return null;
  if (cause instanceof Error) {
    const stackLines = String(cause.stack ?? "").split("\n").slice(0, 3).join("\n");
    return Object.freeze({
      name: String(cause.name ?? "Error"),
      code: cause.code === undefined ? null : redactText(String(cause.code)),
      errno: cause.errno === undefined ? null : String(cause.errno),
      syscall: cause.syscall === undefined ? null : String(cause.syscall),
      message: redactText(cause.message ?? ""),
      stack_summary: redactText(stackLines)
    });
  }
  if (typeof cause === "object") {
    const summary = { name: "Object", message: redactText(String(cause.message ?? "")) };
    if (cause.code !== undefined) summary.code = redactText(String(cause.code));
    return Object.freeze(summary);
  }
  return Object.freeze({ name: "Value", message: redactText(String(cause)) });
}

/** 超时失败：请求（含正文读取与解析阶段）超出配置窗口 */
export function timeoutFailure({ provider, endpoint = null, phase = "http_timeout", detail = "" }) {
  const parts = ["request exceeded the configured timeout"];
  if (detail) parts.push(redactText(detail));
  return new ExternalCallError(`[${provider}/${phase}] ${parts.join("; ")}`, {
    code: EXTERNAL_ERROR_CODES.TIMEOUT,
    provider,
    endpoint,
    phase,
    retryable: true
  });
}

/**
 * 超时守卫：把 AbortController + 计时器 + 「是否由我们触发超时」的判定封在一起，
 * 供适配器在 **请求 + 正文读取** 的整个窗口内共享。
 *
 * 设计要点：调用方必须在 finally 里 `guard.clear()`；本对象不自行清理，
 * 以免出现「收到响应头就想清掉计时器」而把正文阶段挤出超时窗口的旧缺陷。
 */
export function createTimeoutGuard(timeoutMs, { provider = "unknown", endpoint = null } = {}) {
  const controller = new AbortController();
  const numeric = Number(timeoutMs);
  const effectiveMs = Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
  const state = { timedOut: false, cleared: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, effectiveMs);
  return {
    controller,
    signal: controller.signal,
    provider,
    endpoint: endpoint === null ? null : redactUrl(endpoint),
    timeout_ms: effectiveMs,
    get timedOut() {
      return state.timedOut;
    },
    get cleared() {
      return state.cleared;
    },
    clear() {
      if (!state.cleared) {
        state.cleared = true;
        clearTimeout(timer);
      }
      return true;
    }
  };
}

/**
 * 读取响应正文（text 或 buffer）——**必须在超时窗口内完成**。
 *
 * 旧实现先在收到响应头时 clearTimeout，再到窗口外读正文：
 * 于是「头很快、正文很慢」的响应可以无限期拖下去，正文阶段任何异常也会以原始形态冒出。
 * 本助手把三件事一次性做对：留在窗口内、把 timedOut 转成明确超时、把正文异常规范化。
 */
export async function readResponseBody({ response, guard, provider = "unknown", endpoint = null, as = "text", phase = "http_body" }) {
  if (!response || typeof response[as === "buffer" ? "arrayBuffer" : "text"] !== "function") {
    throw invalidResponseFailure({ provider, endpoint, phase, detail: `response has no ${as === "buffer" ? "arrayBuffer" : "text"}() method` });
  }
  let body;
  try {
    body = as === "buffer" ? await response.arrayBuffer() : await response.text();
  } catch (err) {
    // 由我们计时器触发的 abort → 记超时；其余（网络中断、解码失败等）保留原分类
    throw normalizeExternalCallError(err, {
      provider,
      endpoint,
      phase: guard?.timedOut ? `${phase}_timeout` : phase,
      hint: guard?.timedOut ? EXTERNAL_ERROR_CODES.TIMEOUT : null
    });
  }
  if (guard?.timedOut) {
    // 响应头已收到、正文也回来了，但整体已经越窗：不得当成成功
    throw timeoutFailure({ provider, endpoint, phase: `${phase}_timeout`, detail: `body arrived after the ${guard.timeout_ms}ms window` });
  }
  return as === "buffer" ? Buffer.from(body) : body;
}

/** 便捷包装：读文本正文 */
export function readResponseText(args) {
  return readResponseBody({ ...args, as: "text" });
}

export class ExternalCallError extends Error {
  constructor(message, { code, provider = "unknown", endpoint = null, phase = "request", status = null, upstream_code = null, logid = null, retryable = false, cause = null } = {}) {
    super(redactText(message));
    this.name = "ExternalCallError";
    this.code = code ?? EXTERNAL_ERROR_CODES.UNKNOWN;
    this.provider = provider;
    this.endpoint = endpoint === null ? null : redactUrl(endpoint);
    this.phase = phase;
    this.status = status;
    this.upstream_code = upstream_code;
    this.logid = logid === null ? null : redactText(logid);
    this.retryable = retryable;
    this.auto_retry_allowed = false;
    // 只挂**已脱敏的纯对象摘要**，不挂原 Error：见 sanitizeCause 的说明
    if (cause) this.cause = sanitizeCause(cause);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      provider: this.provider,
      endpoint: this.endpoint,
      phase: this.phase,
      status: this.status,
      upstream_code: this.upstream_code,
      logid: this.logid,
      retryable: this.retryable,
      auto_retry_allowed: this.auto_retry_allowed,
      message: this.message,
      cause_summary: this.cause ?? null
    };
  }
}

/** 超时策略单一来源：capability-registry 的 provider.timeout 块 */
export function providerTimeoutPolicy(providerId) {
  const provider = PROVIDER_REGISTRY[providerId];
  if (!provider) throw new Error(`unknown provider: ${providerId}`);
  const policy = provider.timeout ?? {};
  const min = policy.min_ms ?? (policy.cli_poll_max_seconds ? policy.cli_poll_max_seconds * 1000 : 30000);
  const max = policy.max_ms ?? min;
  const def = policy.default_ms ?? min;
  return Object.freeze({
    provider: providerId,
    min_ms: min,
    default_ms: def,
    max_ms: max,
    cli_poll_default_seconds: policy.cli_poll_default_seconds ?? null,
    cli_poll_max_seconds: policy.cli_poll_max_seconds ?? null,
    error_normalization: policy.error_normalization ?? "external-call"
  });
}

/** 依据状态码给出可重试判定（仅提示；本模块永不自动重试） */
export function isRetryableStatus(status) {
  const code = Number(status);
  if (!Number.isFinite(code)) return false;
  return code === 408 || code === 429 || code >= 500;
}

/**
 * 错误分类。按**错误类型与 code**区分，不做一刀切：
 *   - DOMException name=TimeoutError（AbortSignal.timeout）→ TIMEOUT
 *   - AbortError（AbortController.abort 主动中止，默认含超时计时器触发）→ 需调用方以 hint 区分，
 *     未给 hint 时按 ABORTED 记（保守：不冒充超时）
 *   - 系统码 ETIMEDOUT / UND_ERR_HEADERS_TIMEOUT → TIMEOUT
 *   - 系统码 ENOTFOUND/ECONNREFUSED/... 与 fetch 的 TypeError → NETWORK
 */
export function classifyExternalError(err) {
  const name = err?.name ?? "";
  const code = String(err?.code ?? "");
  if (name === "TimeoutError" || code === "ETIMEDOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return EXTERNAL_ERROR_CODES.TIMEOUT;
  }
  if (name === "AbortError" || code === "ABORT_ERR") return EXTERNAL_ERROR_CODES.ABORTED;
  if (["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"].includes(code)) {
    return EXTERNAL_ERROR_CODES.NETWORK;
  }
  if (err instanceof TypeError) return EXTERNAL_ERROR_CODES.NETWORK;
  return EXTERNAL_ERROR_CODES.UNKNOWN;
}

/**
 * 规范化任意外部调用异常。
 * - 已是 ExternalCallError 则原样返回（幂等）
 * - 否则包装为 ExternalCallError，message 保留原始文本（经脱敏）并在前缀标出 provider/phase
 * - `hint` 用于调用方把「abort 超时计时器触发」这类无法从错误本身判定的情形显式标成 TIMEOUT
 */
export function normalizeExternalCallError(err, { provider = "unknown", endpoint = null, phase = "request", status = null, upstream_code = null, logid = null, hint = null } = {}) {
  if (err instanceof ExternalCallError) return err;
  const original = err instanceof Error ? err.message : String(err ?? "unknown error");
  const code = hint ?? classifyExternalError(err);
  const retryable = status != null ? isRetryableStatus(status) : code === EXTERNAL_ERROR_CODES.TIMEOUT || code === EXTERNAL_ERROR_CODES.NETWORK;
  const suffixParts = [];
  if (endpoint) suffixParts.push(`endpoint=${redactUrl(endpoint)}`);
  if (status != null) suffixParts.push(`status=${status}`);
  if (upstream_code != null) suffixParts.push(`upstream_code=${redactText(upstream_code)}`);
  if (logid) suffixParts.push(`logid=${redactText(logid)}`);
  const suffix = suffixParts.length ? ` (${suffixParts.join("; ")})` : "";
  return new ExternalCallError(`[${provider}/${phase}] ${redactText(original)}${suffix}`, {
    code,
    provider,
    endpoint,
    phase,
    status,
    upstream_code,
    logid,
    retryable,
    cause: err instanceof Error ? err : null
  });
}

/**
 * HTTP 传输层失败（status 非 2xx）→ `external_http_status`。
 * 与「HTTP 2xx 但业务码失败」严格区分，后者用 upstreamFailure()。
 */
export function httpFailure({ provider, endpoint = null, phase = "http", status, upstreamCode = null, logid = null, detail = "" }) {
  const retryable = isRetryableStatus(status);
  const parts = [`http status=${status}`];
  if (upstreamCode != null) parts.push(`upstream_code=${redactText(upstreamCode)}`);
  if (logid) parts.push(`logid=${redactText(logid)}`);
  if (detail) parts.push(redactText(detail));
  return new ExternalCallError(`[${provider}/${phase}] ${parts.join("; ")}`, {
    code: EXTERNAL_ERROR_CODES.HTTP_STATUS,
    provider,
    endpoint,
    phase,
    status,
    upstream_code: upstreamCode,
    logid,
    retryable
  });
}

/**
 * 上游业务码失败（HTTP 2xx 但业务 code/status 表示失败，如 KIE 的 `code != 200`）
 * → `external_upstream_code`。业务失败**不按 HTTP 可重试规则判定**（重试可能重复计费）。
 */
export function upstreamFailure({ provider, endpoint = null, phase = "upstream_code", httpStatus = null, upstreamCode, message = "", logid = null }) {
  const parts = [`upstream_code=${redactText(upstreamCode)}`];
  if (httpStatus != null) parts.push(`http_status=${httpStatus}`);
  if (logid) parts.push(`logid=${redactText(logid)}`);
  if (message) parts.push(redactText(message));
  return new ExternalCallError(`[${provider}/${phase}] ${parts.join("; ")}`, {
    code: EXTERNAL_ERROR_CODES.UPSTREAM_CODE,
    provider,
    endpoint,
    phase,
    status: httpStatus,
    upstream_code: upstreamCode,
    logid,
    retryable: false
  });
}

/** 响应体无法解析成预期结构 → `external_invalid_response` */
export function invalidResponseFailure({ provider, endpoint = null, phase = "response_parse", detail = "", httpStatus = null }) {
  return new ExternalCallError(`[${provider}/${phase}] ${redactText(detail) || "unparseable response"}`, {
    code: EXTERNAL_ERROR_CODES.INVALID_RESPONSE,
    provider,
    endpoint,
    phase,
    status: httpStatus,
    retryable: false
  });
}

/** CLI 子进程结果 → 规范化错误（用于 execFile 失败/非零退出/结构化失败） */
export function cliFailure({ provider, command, phase = "cli", exitCode = null, stderr = "", parsed = null }) {
  const detail = parsed?.error?.message ?? parsed?.message ?? (stderr ? String(stderr).trim().slice(0, 400) : "no stderr");
  return new ExternalCallError(`[${provider}/${phase}] ${command} failed exit=${exitCode ?? "unknown"}; ${redactText(detail)}`, {
    code: EXTERNAL_ERROR_CODES.UPSTREAM_CODE,
    provider,
    endpoint: command,
    phase,
    status: exitCode,
    upstream_code: parsed?.error?.code ?? parsed?.code ?? null,
    retryable: false
  });
}
