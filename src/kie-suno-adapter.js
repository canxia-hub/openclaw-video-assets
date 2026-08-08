import fs from "node:fs";
import path from "node:path";

export const KIE_SUNO_SCHEMA_VERSION = "kie_suno_request_v1";
export const KIE_SUNO_PROVIDER = "kie.ai/suno-api";
export const KIE_SUNO_BASE_URL = "https://api.kie.ai";
export const KIE_SUNO_DEFAULT_ENDPOINT = "/api/v1/generate";
export const KIE_SUNO_DEFAULT_MODEL = "V5_5";
const KIE_API_KEY_ENV = "KIE_API_KEY";
const TERMINAL_STATUSES = new Set(["SUCCESS", "CREATE_TASK_FAILED", "GENERATE_AUDIO_FAILED", "SENSITIVE_WORD_ERROR", "CALLBACK_EXCEPTION"]);
const FAILURE_STATUSES = new Set(["CREATE_TASK_FAILED", "GENERATE_AUDIO_FAILED", "SENSITIVE_WORD_ERROR", "CALLBACK_EXCEPTION"]);
const AUDIO_URL_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"]);
const IMAGE_URL_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp", ".svg"]);
const SUPPORTED_ENDPOINTS = new Set([
  "/api/v1/generate",
  "/api/v1/generate/extend",
  "/api/v1/generate/upload-cover",
  "/api/v1/generate/upload-extend",
  "/api/v1/generate/add-instrumental",
  "/api/v1/generate/add-vocals",
  "/api/v1/lyrics",
  "/api/v1/wav/convert",
  "/api/v1/vocal-removal/separate",
  "/api/v1/mp4/generate",
  "/api/v1/generate/replace-section",
  "/api/v1/generate/generate-persona",
  "/api/v1/generate/mashup"
]);

export const KIE_SUNO_GUIDE_SOURCE = Object.freeze({
  title: "KIE Suno API 调用、音乐创作、回调轮询与音频资产治理",
  source: "openclaw-video-assets public adapter contract",
  docs_checked_at: "2026-07-20",
  docs: [
    "https://docs.kie.ai/",
    "https://docs.kie.ai/suno-api/quickstart",
    "https://docs.kie.ai/suno-api/generate-music",
    "https://docs.kie.ai/suno-api/get-music-details",
    "https://docs.kie.ai/common-api/webhook-verification"
  ]
});

export function normalizeKieSunoRequest(input = {}, context = {}) {
  const endpoint = normalizeEndpoint(input.endpoint ?? KIE_SUNO_DEFAULT_ENDPOINT);
  const model = String(input.model ?? input.request?.model ?? KIE_SUNO_DEFAULT_MODEL);
  const customMode = input.customMode ?? input.request?.customMode ?? true;
  const instrumental = input.instrumental ?? input.request?.instrumental ?? false;
  const prompt = String(input.prompt ?? input.lyrics ?? input.request?.prompt ?? context.prompt ?? "").trim();
  const style = String(input.style ?? input.request?.style ?? "").trim();
  const title = String(input.title ?? input.output_title ?? input.request?.title ?? "KIE Suno 音乐输出").trim();
  const trackRole = String(input.track_role ?? input.handoff?.track_role ?? "music");
  const tags = normalizeStringArray(input.tags ?? input.asset_policy?.tags ?? ["kie_suno", "suno", "audio_generation", "generated", trackRole]);
  const providerParameters = normalizeObject(input.provider_parameters ?? input.request?.provider_parameters ?? {});

  return {
    schema_version: KIE_SUNO_SCHEMA_VERSION,
    provider: KIE_SUNO_PROVIDER,
    baseUrl: KIE_SUNO_BASE_URL,
    endpoint,
    source_docs_checked_at: String(input.source_docs_checked_at ?? KIE_SUNO_GUIDE_SOURCE.docs_checked_at),
    intent: String(input.intent ?? input.purpose ?? context.intent ?? "project music generation"),
    project: {
      project_id: input.project_id ?? input.project?.project_id ?? context.project_id ?? null,
      canvas_id: input.canvas_id ?? input.project?.canvas_id ?? context.canvas_id ?? null,
      slot_shape_id: input.slot_shape_id ?? input.project?.slot_shape_id ?? context.slot_shape_id ?? null,
      slug: input.slug ?? input.project?.slug ?? null,
      stage: input.stage ?? input.project?.stage ?? null,
      scene: input.scene ?? input.project?.scene ?? null,
      shot_id: input.shot_id ?? input.project?.shot_id ?? null,
      timecode: input.timecode ?? input.project?.timecode ?? null,
      target_duration: input.target_duration ?? input.duration_seconds ?? input.project?.target_duration ?? context.duration_seconds ?? null,
      platform: input.platform ?? input.project?.platform ?? null
    },
    request: {
      model,
      customMode: customMode === true,
      instrumental: instrumental === true,
      prompt,
      style,
      title,
      negativeTags: String(input.negativeTags ?? input.negative_tags ?? input.request?.negativeTags ?? ""),
      callBackUrl: String(input.callBackUrl ?? input.callback_url ?? input.request?.callBackUrl ?? ""),
      ...(input.vocalGender ?? input.request?.vocalGender ? { vocalGender: String(input.vocalGender ?? input.request?.vocalGender) } : {}),
      ...providerParameters
    },
    execution: {
      backend: String(input.backend ?? input.execution?.backend ?? "mock"),
      execute: input.execute === true,
      accept_cost: input.accept_cost === true || input.accept_credit_spend === true,
      timeout_ms: clampInteger(input.timeout_ms ?? input.execution?.timeout_ms ?? 900000, 30000, 3600000),
      poll_result: input.poll_result === true,
      poll_interval_seconds: clampInteger(input.poll_interval_seconds ?? input.execution?.poll_interval_seconds ?? 8, 5, 60),
      output_dir: input.output_dir ?? input.execution?.output_dir ?? null,
      download_outputs: input.download_outputs !== false,
      ingest_outputs: input.ingest_outputs !== false,
      writeback_canvas: input.writeback_canvas !== false
    },
    rights: {
      input: String(input.input_rights ?? input.rights?.input ?? "unknown"),
      output: String(input.output_rights ?? input.rights?.output ?? "unknown"),
      speaker_or_voice_consent: String(input.speaker_or_voice_consent ?? input.rights?.speaker_or_voice_consent ?? "not_applicable"),
      notes: String(input.rights_notes ?? input.rights?.notes ?? "third-party gateway; verify commercial terms before public delivery")
    },
    handoff: {
      track_role: trackRole,
      dialogue_priority: String(input.dialogue_priority ?? input.handoff?.dialogue_priority ?? ""),
      mix_priority: String(input.mix_priority ?? input.handoff?.mix_priority ?? ""),
      downstream_target: String(input.downstream_target ?? input.handoff?.downstream_target ?? "postproduction"),
      review_notes: String(input.review_notes ?? input.handoff?.review_notes ?? "")
    },
    asset_policy: {
      title,
      kind: input.kind === "raw" ? "raw" : "working",
      tags,
      license_status: "unknown",
      risk_level: "unknown",
      platform_review_status: "pending",
      classification: normalizeObject(input.classification ?? input.asset_policy?.classification ?? {
        domain: "audio",
        type: "generated_output",
        subtype: trackRole,
        confidence: "candidate",
        source: "agent"
      })
    }
  };
}

export function validateKieSunoRequest(request) {
  const blockers = [];
  const warnings = [];
  const promptLimit = promptLimitForModel(request.request.model, request.request.customMode);
  const styleLimit = styleLimitForModel(request.request.model);

  if (!SUPPORTED_ENDPOINTS.has(request.endpoint)) warnings.push(`未在技能快照中确认 endpoint：${request.endpoint}，真实执行前请回查 KIE 文档。`);
  if (request.endpoint === KIE_SUNO_DEFAULT_ENDPOINT) {
    if (!request.request.customMode && !request.request.prompt) blockers.push("prompt is required when customMode=false");
    if (request.request.customMode && request.request.instrumental && (!request.request.style || !request.request.title)) {
      blockers.push("custom instrumental generation requires style and title");
    }
    if (request.request.customMode && !request.request.instrumental && (!request.request.prompt || !request.request.style || !request.request.title)) {
      blockers.push("custom vocal/song generation requires prompt, style, and title");
    }
  }
  if (countChars(request.request.prompt) > promptLimit) blockers.push(`prompt exceeds ${promptLimit} characters for ${request.request.model}`);
  if (countChars(request.request.style) > styleLimit) blockers.push(`style exceeds ${styleLimit} characters for ${request.request.model}`);
  if (countChars(request.request.title) > 100) blockers.push("title exceeds 100 characters");
  if (request.execution.execute && !request.execution.accept_cost) blockers.push("execute=true requires accept_cost=true");
  if (!["mock", "api"].includes(request.execution.backend)) blockers.push("execution.backend must be mock or api");
  if (request.execution.backend === "api" && !getKieApiKey()) blockers.push(`${KIE_API_KEY_ENV} is required for backend=api`);
  if (request.handoff.track_role === "music" && !request.handoff.dialogue_priority) warnings.push("用于视频时建议补充 dialogue_priority，避免音乐遮挡对白。");
  if (request.rights.output !== "unknown") warnings.push("KIE/Suno 输出默认应保持 rights.output=unknown，公开交付前需要人工授权复核。");

  return {
    status: blockers.length ? "blocked" : "ready",
    blockers,
    warnings,
    checks: {
      endpoint: `${KIE_SUNO_BASE_URL}${request.endpoint}`,
      auth: `${KIE_API_KEY_ENV} environment variable`,
      prompt_chars: countChars(request.request.prompt),
      prompt_limit: promptLimit,
      style_chars: countChars(request.request.style),
      style_limit: styleLimit,
      title_chars: countChars(request.request.title),
      retention_note: "KIE Suno docs snapshot says generated files are retained for 14 days; download promptly.",
      license_status_on_success: "unknown",
      risk_level_on_success: "unknown"
    }
  };
}

export async function runKieSunoGeneration(request, { outputDir } = {}) {
  if (request.execution.backend === "api") return runKieSunoApiGeneration(request, { outputDir });
  const dir = outputDir ?? request.execution.output_dir ?? process.cwd();
  await fs.promises.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, mockAudioFileName(request));
  await writeMockWav(filePath, { durationSeconds: 3, sampleRate: 44100, channels: 2 });
  const now = new Date().toISOString();
  return {
    provider: request.provider,
    backend: "mock",
    endpoint: request.endpoint,
    status: "success",
    task_id: `kie_suno_mock_${Date.now()}`,
    audio_ids: [`audio_mock_${Date.now()}`],
    created_at: now,
    completed_at: now,
    remote_urls: [],
    outputs: [{ file_path: filePath, mime_type: "audio/wav", output_format: "wav" }],
    rights: request.rights,
    cost: { credits: 0, currency: "mock" }
  };
}

export function buildKieSunoApiPayload(request) {
  const payload = { ...request.request };
  if (!payload.callBackUrl) delete payload.callBackUrl;
  for (const [key, value] of Object.entries(payload)) {
    if (value === "" || value === null || value === undefined) delete payload[key];
  }
  return payload;
}

export function kieSunoNextActions({ request, validation, generated = null }) {
  if (validation.blockers.length) return ["修正 blockers 后重新生成 KIE Suno 请求包。"];
  if (!request.execution.execute) return ["确认项目、版权边界、成本与输出留存风险后，以 execute=true 且 accept_cost=true 执行。"];
  if (!generated) return ["执行后记录 taskId；优先通过回调或轮询拿到音频 URL，并尽快下载入库。"];
  if (generated.status === "submitted") return [`已提交 taskId=${generated.task_id}；后续轮询或回调完成后下载并登记资产。`];
  if (generated.status === "success") return ["试听结构、人声稳定性和对白遮挡风险；公开交付前保持授权复核。"];
  return ["生成未成功，检查 KIE task 状态、敏感词或回调异常。"];
}

function normalizeEndpoint(value) {
  const endpoint = String(value ?? KIE_SUNO_DEFAULT_ENDPOINT).trim();
  return endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
}

async function runKieSunoApiGeneration(request, { outputDir } = {}) {
  const startedAt = new Date().toISOString();
  const submit = await kieFetch("POST", request.endpoint, buildKieSunoApiPayload(request), request.execution.timeout_ms);
  const taskId = extractTaskId(submit);
  if (!taskId) throw new Error(`KIE Suno submit succeeded but no taskId was found in response: ${JSON.stringify(sanitizeKieResult(submit))}`);
  if (!request.execution.poll_result) {
    return {
      provider: request.provider,
      backend: "api",
      endpoint: request.endpoint,
      status: "submitted",
      task_id: taskId,
      created_at: startedAt,
      response_summary: sanitizeKieResult(submit),
      outputs: [],
      remote_urls: []
    };
  }
  const record = await pollKieSunoRecord(taskId, request);
  const status = extractStatus(record);
  if (FAILURE_STATUSES.has(status)) throw new Error(`KIE Suno task failed: ${status}`);
  const remoteUrls = extractAudioUrls(record);
  const audioIds = extractAudioIds(record);
  const outputs = [];
  if (remoteUrls.length && request.execution.download_outputs !== false) {
    const dir = outputDir ?? request.execution.output_dir ?? process.cwd();
    await fs.promises.mkdir(dir, { recursive: true });
    for (let i = 0; i < remoteUrls.length; i += 1) {
      const targetPath = path.join(dir, remoteAudioFileName(request, i, remoteUrls[i]));
      await downloadFile(remoteUrls[i], targetPath, request.execution.timeout_ms);
      outputs.push({ file_path: targetPath, mime_type: mimeTypeForPath(targetPath), output_format: path.extname(targetPath).slice(1), remote_url: remoteUrls[i] });
    }
  }
  return {
    provider: request.provider,
    backend: "api",
    endpoint: request.endpoint,
    status: "success",
    task_id: taskId,
    audio_ids: audioIds,
    created_at: startedAt,
    completed_at: new Date().toISOString(),
    remote_urls: remoteUrls,
    outputs,
    response_summary: sanitizeKieResult(record),
    retention_note: "Remote output URLs may expire; local downloads are the durable project assets."
  };
}

async function kieFetch(method, endpoint, payload, timeoutMs) {
  const apiKey = getKieApiKey();
  if (!apiKey) throw new Error(`${KIE_API_KEY_ENV} is required`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${KIE_SUNO_BASE_URL}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  const result = parseJsonOrRaw(text);
  if (!response.ok) throw new Error(`KIE Suno HTTP ${response.status}: ${text}`);
  if (result && typeof result === "object" && result.code != null && Number(result.code) !== 200) {
    throw new Error(`KIE Suno API code ${result.code}: ${result.msg ?? result.message ?? "request failed"}`);
  }
  return result;
}

async function pollKieSunoRecord(taskId, request) {
  const deadline = Date.now() + request.execution.timeout_ms;
  while (true) {
    const record = await kieFetch("GET", `/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`, null, request.execution.timeout_ms);
    const status = extractStatus(record);
    if (TERMINAL_STATUSES.has(status)) return record;
    if (Date.now() >= deadline) throw new Error(`KIE Suno polling timed out for taskId=${taskId}`);
    await new Promise((resolve) => setTimeout(resolve, request.execution.poll_interval_seconds * 1000));
  }
}

function parseJsonOrRaw(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw_body: text };
  }
}

function extractTaskId(result) {
  const direct = result?.data?.taskId ?? result?.data?.task_id ?? result?.taskId ?? result?.task_id;
  if (direct) return String(direct);
  if (typeof result?.data === "string" && looksLikeTaskId(result.data)) return result.data;
  let found = null;
  walk(result, (key, value) => {
    if (found || typeof value !== "string") return;
    const normalizedKey = String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (normalizedKey === "taskid" && looksLikeTaskId(value)) found = value;
  });
  return found;
}

function looksLikeTaskId(value) {
  return /^task[_-]/i.test(String(value)) || /^[a-f0-9]{16,}$/i.test(String(value));
}

function extractStatus(result) {
  return String(result?.data?.status ?? result?.status ?? "").toUpperCase();
}

function extractAudioIds(result) {
  const ids = new Set();
  walk(result, (key, value) => {
    if (/(^|_)audio(id|_id)$/i.test(key) && typeof value === "string") ids.add(value);
  });
  return [...ids];
}

function extractAudioUrls(result) {
  const urls = new Set();
  walk(result, (key, value) => {
    if (isLikelyAudioUrl(key, value)) urls.add(value);
  });
  return [...urls];
}

function isLikelyAudioUrl(key, value) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return false;
  const keyText = String(key);
  const lowerKey = keyText.toLowerCase();
  const ext = extensionFromUrl(value);
  if (IMAGE_URL_EXTENSIONS.has(ext) || /image|cover|artwork|avatar|thumbnail|poster/i.test(keyText)) return false;
  if (AUDIO_URL_EXTENSIONS.has(ext)) return true;
  return /audio|sourceaudio|stream|download|music/i.test(lowerKey);
}

function extensionFromUrl(value) {
  try {
    return path.extname(new URL(value).pathname).toLowerCase();
  } catch {
    return "";
  }
}

function walk(value, visitor, key = "") {
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visitor, key));
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) walk(childValue, visitor, childKey);
    return;
  }
  visitor(key, value);
}

function sanitizeKieResult(result = {}) {
  return {
    code: result.code ?? null,
    msg: result.msg ?? result.message ?? null,
    status: extractStatus(result) || null,
    task_id: extractTaskId(result),
    audio_ids: extractAudioIds(result),
    remote_url_count: extractAudioUrls(result).length
  };
}

function getKieApiKey() {
  return String(process.env[KIE_API_KEY_ENV] ?? "").trim();
}

function promptLimitForModel(model, customMode) {
  if (!customMode) return 500;
  return String(model).toUpperCase() === "V4" ? 3000 : 5000;
}

function styleLimitForModel(model) {
  return String(model).toUpperCase() === "V4" ? 200 : 1000;
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function countChars(value) {
  return Array.from(String(value ?? "")).length;
}

function clampInteger(value, min, max) {
  const num = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : min;
  return Math.max(min, Math.min(max, num));
}

function mockAudioFileName(request) {
  const safeTitle = safeToken(request.asset_policy.title || "kie_suno_audio");
  return `${safeTitle}_${Date.now()}.wav`;
}

function remoteAudioFileName(request, index, url) {
  let ext = ".mp3";
  try {
    ext = path.extname(new URL(url).pathname).toLowerCase() || ext;
  } catch {
    // keep default
  }
  if (![".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"].includes(ext)) ext = ".mp3";
  return `${safeToken(request.asset_policy.title || "kie_suno_audio")}_${index + 1}${ext}`;
}

function safeToken(value) {
  return String(value).replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 40) || "kie_suno_audio";
}

function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg"
  }[ext] ?? "application/octet-stream";
}

async function downloadFile(url, filePath, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`KIE Suno output download failed: status=${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error(`KIE Suno output download is empty: ${url}`);
  await fs.promises.writeFile(filePath, buffer, { flag: "wx" });
}

async function writeMockWav(filePath, { durationSeconds, sampleRate, channels }) {
  const bitsPerSample = 16;
  const totalFrames = Math.max(1, Math.floor(durationSeconds * sampleRate));
  const dataSize = totalFrames * channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  await fs.promises.writeFile(filePath, buffer);
}
