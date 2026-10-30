// ============================================================================
// REN-09 · KIE Suno 现行端点（candidate）适配器
// ============================================================================
// 背景：KIE 官方现行文档已把音乐生成集成指向
//   POST https://api.kie.ai/api/v1/jobs/createTask
//   GET  https://api.kie.ai/api/v1/jobs/recordInfo
// 而本插件现网默认走的仍是旧端点族（/api/v1/generate + /api/v1/generate/record-info），
// 官方把旧端点归入 /old-model/… 文档。
//
// 本模块的定位（严格按父审与工作包约束）：
//   * 只是**显式声明的候选适配器**：不切换默认、不改动旧链路、不停止旧端点新请求。
//   * 只有调用方显式传 `allow_candidate_endpoint: true` 才会被构建/执行。
//   * 契约来自官方文档原文；**无法从原文确证的部分一律标为未知缺口**，不臆测补全。
//
// 官方契约（来源：https://docs.kie.ai/suno-api/generate-music ，核查于 2026-09-20 23:47）
//   请求体：
//     {
//       "model": "ai-music-api/generate",      // 任务类型，非音乐模型名
//       "callBackUrl": "https://...",          // 注意：官方示例此处为 camelCase
//       "input": {
//         "prompt", "custom_mode", "instrumental", "model",   // custom_mode/instrumental/model 恒为必填
//         "style", "title", "negative_tags", "vocal_gender",
//         "style_weight", "weirdness_constraint", "audio_weight",
//         "persona_id", "persona_model", "duration",
//         "image_urls", "video_urls", "audio_urls"             // 仅非 custom 模式有效
//       }
//     }
//   成功响应：{ "code": 200, "msg": "success", "data": { "taskId": "..." } }
//   说明：HTTP 200 仅代表任务创建成功，不等于生成完成；需回调或轮询取任务详情。
// ============================================================================

import { normalizeExternalCallError, httpFailure, upstreamFailure, invalidResponseFailure, redactText, createTimeoutGuard, readResponseText, EXTERNAL_ERROR_CODES } from "./external-call.js";

export const KIE_SUNO_CANDIDATE_SCHEMA_VERSION = "kie_suno_candidate_v1";
export const KIE_SUNO_CANDIDATE_PROVIDER = "kie.ai/suno-api";

/** 官方现行端点（与 capability-registry 中的 candidate 条目一一对应） */
export const KIE_SUNO_CANDIDATE_ENDPOINTS = Object.freeze({
  create_task: Object.freeze({
    method: "POST",
    path: "/api/v1/jobs/createTask",
    task_type: "ai-music-api/generate",
    lifecycle: "candidate",
    in_use: false
  }),
  record_info: Object.freeze({
    method: "GET",
    path: "/api/v1/jobs/recordInfo",
    lifecycle: "candidate",
    in_use: false
  })
});

/**
 * 从官方文档原文即可确证 / 无法确证的部分，逐条如实登记。
 * 这些缺口决定了「候选适配器可以构建请求，但不能被当作已验收链路」。
 */
export const KIE_SUNO_CANDIDATE_CONTRACT_GAPS = Object.freeze([
  Object.freeze({
    field: "record_info.query_param",
    status: "inferred",
    documented: "官方新文档正文只写「actively poll the query record info API using the task_id」；示例为通用任务详情入口",
    assumption: "本适配器按 `taskId` 作为查询参数名（与 createTask 响应字段同名；旧端点族亦用 taskId）",
    risk: "参数名若为其它拼写，轮询会稳定失败（HTTP 4xx），不会被误判为成功",
    verification: "用一次最小真实调用确认（blocked-verification B12）"
  }),
  Object.freeze({
    field: "record_info.status_fields",
    status: "unknown",
    documented: "官方新文档未列出 recordInfo 响应中的任务状态字段名与终态取值集合",
    assumption: "本适配器只解析 data.taskId，不解析 status；状态判定留给后续验收",
    risk: "无法据此实现终态判断，故本适配器不提供「等待完成」能力",
    verification: "获取一次真实响应体后补齐（blocked-verification B12）"
  }),
  Object.freeze({
    field: "input.model 取值集合",
    status: "partially_documented",
    documented: "新文档在字符上限段落列出 V4 / V4_5 / V4_5PLUS / V4_5ALL / V5 / V5_5 / V6 / V6_MINI / V6_WILD",
    assumption: "不在此表内的模型值不进入候选适配器的默认校验集，交由后端判定",
    risk: "新模型上线后需要同步此表",
    verification: "与 capability-registry 的 KIE 模型生命周期同步"
  }),
  Object.freeze({
    field: "错误码语义",
    status: "unknown",
    documented: "官方仅给出成功示例 code=200 与鉴权失败的 401 示例",
    assumption: "两个候选解析器都要求业务码**存在**且等于 200 才算成功；缺业务码一律视为无法识别结构而拒绝；任何 code != 200 按 upstream_code 失败处理，不尝试细分",
    risk: "无法区分「可重试失败」与「不可重试失败」，故本适配器不自动重试任何失败",
    verification: "采集若干真实错误响应后分类（blocked-verification B14）"
  }),
  Object.freeze({
    field: "record_info 响应中的任务标识字段名",
    status: "inferred",
    documented: "官方新文档只确认 createTask 返回 data.taskId；recordInfo 响应体未给字段表",
    assumption: "本适配器接受 data.taskId / data.task_id 两种形态，但**必须存在其一**，否则视为结构无法识别",
    risk: "若实际字段名两者都不是，轮询解析会稳定报 invalid（不会误报成功，但会阻断状态查询）",
    verification: "获取一次真实 recordInfo 响应体后对齐（blocked-verification B12）"
  })
]);

/** 内部归一化请求 → 官方 createTask 请求体。字段名严格照官方示例，不「顺手改成 camelCase」。 */
export function buildKieSunoCandidatePayload(request, { callBackUrl = null } = {}) {
  const input = {
    prompt: request.request.prompt ?? "",
    custom_mode: request.request.customMode === true,
    instrumental: request.request.instrumental === true,
    model: request.request.model
  };
  if (request.request.title) input.title = request.request.title;
  if (request.request.style) input.style = request.request.style;
  if (request.request.negativeTags) input.negative_tags = request.request.negativeTags;
  if (request.request.personaId) input.persona_id = request.request.personaId;
  if (request.request.personaModel) input.persona_model = request.request.personaModel;
  // 官方明确：「Do not pass parameters that are only effective in custom mode:
  // duration, vocal_gender, style_weight, weirdness_constraint, audio_weight, variety」
  // 因此这些参数**全部**只能在 custom_mode=true 时输出（含 vocal_gender）。
  if (input.custom_mode) {
    if (request.request.vocalGender) input.vocal_gender = request.request.vocalGender;
    if (request.request.duration !== undefined && request.request.duration !== null) input.duration = request.request.duration;
    if (request.request.styleWeight !== undefined && request.request.styleWeight !== null) input.style_weight = request.request.styleWeight;
    if (request.request.weirdnessConstraint !== undefined && request.request.weirdnessConstraint !== null) input.weirdness_constraint = request.request.weirdnessConstraint;
    if (request.request.audioWeight !== undefined && request.request.audioWeight !== null) input.audio_weight = request.request.audioWeight;
    if (request.request.variety !== undefined && request.request.variety !== null) input.variety = request.request.variety;
  }
  const payload = {
    model: KIE_SUNO_CANDIDATE_ENDPOINTS.create_task.task_type,
    input
  };
  if (callBackUrl) payload.callBackUrl = callBackUrl;
  return payload;
}

/** 离线契约校验：只断言能从官方原文确证的结构 */
export function validateKieSunoCandidatePayload(payload) {
  const blockers = [];
  if (!payload || typeof payload !== "object") return { status: "blocked", blockers: ["payload must be an object"] };
  if (payload.model !== KIE_SUNO_CANDIDATE_ENDPOINTS.create_task.task_type) {
    blockers.push(`payload.model must be "${KIE_SUNO_CANDIDATE_ENDPOINTS.create_task.task_type}" (task type, not a music model name)`);
  }
  if (!payload.input || typeof payload.input !== "object") {
    blockers.push("payload.input is required");
  } else {
    for (const required of ["custom_mode", "instrumental", "model"]) {
      if (payload.input[required] === undefined) blockers.push(`payload.input.${required} is required by the official contract`);
    }
    if (!payload.input.custom_mode) {
      for (const forbidden of ["duration", "vocal_gender", "style_weight", "weirdness_constraint", "audio_weight", "variety"]) {
        if (payload.input[forbidden] !== undefined) blockers.push(`payload.input.${forbidden} is only effective in custom mode and must not be sent when custom_mode=false`);
      }
    }
  }
  if (payload.callBackUrl !== undefined && typeof payload.callBackUrl !== "string") blockers.push("payload.callBackUrl must be a string when provided");
  return { status: blockers.length ? "blocked" : "ready", blockers };
}

/** 解析 createTask 响应：只提取已确证字段 */
export function parseKieSunoCandidateCreateTaskResponse(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "response must be a JSON object" };
  // 官方成功响应恒为 `{code:200,msg,data:{taskId}}`：缺业务码的响应属**无法识别结构**，
  // 不得因为「反正后面还会看 data」而宽免。
  if (body.code === undefined || body.code === null) return { ok: false, reason: "response is missing the business `code` field" };
  if (Number(body.code) !== 200) return { ok: false, upstream_code: body.code, message: redactText(body.msg ?? body.message ?? "") };
  const data = body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, reason: "response is missing an object `data` payload" };
  const taskId = data.taskId ?? null;
  if (taskId === null || taskId === "") return { ok: false, reason: "data.taskId missing" };
  return { ok: true, task_id: String(taskId) };
}

/** 构建 recordInfo 轮询请求（参数名为推断，见 CONTRACT_GAPS） */
export function buildKieSunoCandidateRecordInfoRequest({ baseUrl = "https://api.kie.ai", taskId }) {
  if (!taskId) throw new Error("taskId is required to poll recordInfo");
  const url = `${baseUrl}${KIE_SUNO_CANDIDATE_ENDPOINTS.record_info.path}?taskId=${encodeURIComponent(String(taskId))}`;
  return { method: "GET", url };
}

/**
 * 解析 recordInfo 响应。
 *
 * 父审修正：“状态解析未实现”不能成为**结构校验**的宽免理由。
 * 因此这里先做本可确证的结构断言（对象 / data 对象 / 任务标识），
 * 再对**有效结构**声明状态解析仍是开放缺口。
 */
export function parseKieSunoCandidateRecordInfoResponse(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "recordInfo response must be a JSON object" };
  }
  // 与 createTask 同构：先看业务码，再看 data 与任务标识。
  // “状态解析未实现”只能宽免**状态字段**，不能宽免**结构校验**。
  if (body.code === undefined || body.code === null) {
    return { ok: false, reason: "recordInfo response is missing the business `code` field" };
  }
  if (Number(body.code) !== 200) {
    return { ok: false, upstream_code: body.code, message: redactText(body.msg ?? body.message ?? "") };
  }
  const data = body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "recordInfo response is missing an object `data` payload" };
  }
  // 任务标识：官方新文档只确认 createTask 返回 data.taskId；轮询响应里的标识字段未在原文列明，
  // 因此接受 taskId / task_id 两种常见形态，但**必须存在其中一个**，否则视为无法识别的结构。
  const taskId = data.taskId ?? data.task_id ?? null;
  if (taskId === null || taskId === "") {
    return { ok: false, reason: "recordInfo response carries no task identifier (taskId/task_id)" };
  }
  return {
    ok: true,
    task_id: String(taskId),
    // 状态字段未在官方新文档列明，且未做真机采集：明确标注为缺口，**不得伪造终态**
    status_parsing: "not_implemented_contract_gap",
    status_fields_declared: null
  };
}

/**
 * 候选适配器的执行入口。
 * 硬门：调用方必须显式传 allow_candidate_endpoint=true；否则一律拒绝
 * （防止候选链路被默认启用、误停旧链路）。
 */
export async function runKieSunoCandidateCreateTask(payload, { apiKey, allowCandidateEndpoint = false, timeoutMs = 900000, baseUrl = "https://api.kie.ai", callBackUrl = null, fetchImpl = fetch } = {}) {
  if (allowCandidateEndpoint !== true) {
    throw new Error("candidate endpoint is not enabled: pass allow_candidate_endpoint=true explicitly (default stays on the legacy /api/v1/generate path)");
  }
  const withCallback = callBackUrl ? { ...payload, callBackUrl } : payload;
  const validation = validateKieSunoCandidatePayload(withCallback);
  if (validation.status !== "ready") {
    throw new Error(`candidate payload is invalid: ${validation.blockers.join("; ")}`);
  }
  if (!apiKey) throw new Error("KIE_API_KEY is required");
  const target = `${baseUrl}${KIE_SUNO_CANDIDATE_ENDPOINTS.create_task.path}`;
  // 超时窗口覆盖**请求 + 正文读取**：收到响应头**不清**计时器，避免正文阶段脱离超时
  const guard = createTimeoutGuard(timeoutMs, { provider: KIE_SUNO_CANDIDATE_PROVIDER, endpoint: target });
  let response;
  let text;
  try {
    try {
      response = await fetchImpl(target, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(withCallback),
        signal: guard.signal
      });
    } catch (err) {
      throw normalizeExternalCallError(err, {
        provider: KIE_SUNO_CANDIDATE_PROVIDER,
        endpoint: target,
        phase: guard.timedOut ? "http_timeout" : "http_request",
        hint: guard.timedOut ? EXTERNAL_ERROR_CODES.TIMEOUT : null
      });
    }
    // 正文读取留在窗口内；越窗或正文异常均在这里规范化（含超时与解析前阶段）
    text = await readResponseText({ response, guard, provider: KIE_SUNO_CANDIDATE_PROVIDER, endpoint: target });
  } finally {
    guard.clear();
  }
  if (!response.ok) {
    const normalized = httpFailure({ provider: KIE_SUNO_CANDIDATE_PROVIDER, endpoint: target, phase: "http_status", status: response.status, detail: text.slice(0, 400) });
    normalized.message = redactText(`KIE candidate createTask HTTP ${response.status}: ${text}`);
    throw normalized;
  }
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw invalidResponseFailure({ provider: KIE_SUNO_CANDIDATE_PROVIDER, endpoint: target, detail: text.slice(0, 200), httpStatus: response.status });
  }
  const parsed = parseKieSunoCandidateCreateTaskResponse(body);
  if (!parsed.ok) {
    if (parsed.upstream_code != null) {
      throw upstreamFailure({ provider: KIE_SUNO_CANDIDATE_PROVIDER, endpoint: target, httpStatus: response.status, upstreamCode: parsed.upstream_code, message: parsed.message ?? "" });
    }
    throw invalidResponseFailure({ provider: KIE_SUNO_CANDIDATE_PROVIDER, endpoint: target, detail: parsed.reason ?? "unexpected response shape", httpStatus: response.status });
  }
  return {
    provider: KIE_SUNO_CANDIDATE_PROVIDER,
    endpoint: KIE_SUNO_CANDIDATE_ENDPOINTS.create_task.path,
    lifecycle: "candidate",
    contract_status: "documented_unverified",
    task_id: parsed.task_id,
    created_at: new Date().toISOString()
  };
}
