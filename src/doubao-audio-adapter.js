import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const DOUBAO_AUDIO_SCHEMA_VERSION = "doubao_audio_request_v1";
export const DOUBAO_AUDIO_PROVIDER = "doubao_seed_audio";
export const DOUBAO_AUDIO_DEFAULT_MODEL_ID = "seed-audio-1.0";
export const DOUBAO_AUDIO_ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/create";
const DOUBAO_AUDIO_API_KEY_ENV = "VOLCENGINE_DOUBAO_AUDIO_API_KEY";
const DOUBAO_AUDIO_API_KEY_ID_ENV = "VOLCENGINE_DOUBAO_AUDIO_API_KEY_ID";
const SUPPORTED_OUTPUT_FORMATS = new Set(["wav", "mp3", "pcm", "ogg_opus"]);
const SUPPORTED_SAMPLE_RATES = new Set([8000, 16000, 24000, 32000, 44100, 48000]);

export const DOUBAO_AUDIO_GUIDE_SOURCE = Object.freeze({
  title: "豆包音频生成 1.0 请求规范与声音导演提示词约束",
  source: "openclaw-video-assets public adapter contract",
  official_http_doc: "https://docs.volcengine.com/docs/6561/2550782?lang=zh"
});

export function normalizeDoubaoAudioRequest(input = {}, context = {}) {
  const promptText = String(input.prompt_text ?? input.prompt?.text ?? input.prompt ?? context.prompt_text ?? "").trim();
  const durationSeconds = clampNumber(input.duration_seconds ?? input.generation?.duration_seconds ?? context.duration_seconds ?? 10, 1, 120);
  const charLimit = clampInteger(input.char_limit ?? input.prompt?.char_limit ?? 3000, 1, 3000);
  const outputFormat = normalizeOutputFormat(input.output_format ?? input.generation?.output_format ?? "wav");
  const sampleRate = normalizeSampleRate(input.sample_rate ?? input.generation?.sample_rate ?? 24000);
  const channels = clampInteger(input.channels ?? input.generation?.channels ?? 2, 1, 2);
  const voices = normalizeVoices(input.voices ?? input.voice_cards ?? []);
  const tags = normalizeStringArray(input.tags ?? input.asset_policy?.tags ?? ["doubao_audio", "audio_generation", "generated", "voice_or_soundtrack"]);
  const purpose = String(input.purpose ?? input.project?.purpose ?? context.purpose ?? "video_audio_track");
  const providerParameters = normalizeObject(input.provider_parameters ?? input.generation?.provider_parameters ?? {});
  const audioConfigInput = {
    ...normalizeObject(providerParameters.audio_config),
    ...normalizeObject(input.audio_config),
    ...(input.speech_rate !== undefined ? { speech_rate: input.speech_rate } : {}),
    ...(input.loudness_rate !== undefined ? { loudness_rate: input.loudness_rate } : {}),
    ...(input.pitch_rate !== undefined ? { pitch_rate: input.pitch_rate } : {}),
    ...(input.enable_subtitle !== undefined ? { enable_subtitle: input.enable_subtitle } : {})
  };
  return {
    schema_version: DOUBAO_AUDIO_SCHEMA_VERSION,
    provider: DOUBAO_AUDIO_PROVIDER,
    model: {
      model_id: String(input.model_id ?? input.model?.model_id ?? DOUBAO_AUDIO_DEFAULT_MODEL_ID),
      api_model_id: input.api_model_id ?? input.model?.api_model_id ?? null,
      adapter_version: String(input.adapter_version ?? input.model?.adapter_version ?? "v1")
    },
    project: {
      project_id: input.project_id ?? input.project?.project_id ?? context.project_id ?? null,
      canvas_id: input.canvas_id ?? input.project?.canvas_id ?? context.canvas_id ?? null,
      slot_shape_id: input.slot_shape_id ?? input.project?.slot_shape_id ?? context.slot_shape_id ?? null,
      purpose
    },
    prompt: {
      text: promptText,
      language: String(input.language ?? input.prompt?.language ?? "zh-CN"),
      char_limit: charLimit,
      estimated_chars: countChars(promptText),
      video_linkage_block: String(input.video_linkage_block ?? input.prompt?.video_linkage_block ?? context.video_linkage_block ?? "@音频1：由豆包音频生成 1.0 生成，作为整段视频的声音总轨参考。")
    },
    timeline: normalizeTimeline(input.timeline ?? []),
    voices,
    sound_layers: normalizeSoundLayers(input.sound_layers ?? {}),
    generation: {
      duration_seconds: durationSeconds,
      output_format: outputFormat,
      sample_rate: sampleRate,
      channels,
      seed: input.seed ?? input.generation?.seed ?? null,
      references: normalizeReferences(input.references ?? input.generation?.references ?? providerParameters.references ?? []),
      audio_config: normalizeAudioConfig(audioConfigInput, { format: outputFormat, sample_rate: sampleRate }),
      watermark: normalizeWatermark(input.watermark ?? providerParameters.watermark ?? {}),
      provider_parameters: providerParameters
    },
    execution: {
      backend: String(input.backend ?? input.execution?.backend ?? "mock"),
      execute: input.execute === true,
      accept_cost: input.accept_cost === true || input.accept_credit_spend === true,
      timeout_ms: clampInteger(input.timeout_ms ?? input.execution?.timeout_ms ?? 600000, 30000, 1800000),
      output_dir: input.output_dir ?? input.execution?.output_dir ?? null,
      download_outputs: input.download_outputs !== false,
      ingest_outputs: input.ingest_outputs !== false,
      writeback_canvas: input.writeback_canvas !== false
    },
    asset_policy: {
      title: String(input.output_title ?? input.title ?? input.asset_policy?.title ?? "豆包音频输出"),
      kind: input.kind === "raw" ? "raw" : "working",
      tags,
      license_status: "cleared",
      risk_level: "low",
      platform_review_status: "pending",
      classification: normalizeObject(input.classification ?? input.asset_policy?.classification ?? {
        domain: "audio",
        type: "generated_output",
        subtype: purpose
      })
    }
  };
}

export function validateDoubaoAudioRequest(request) {
  const blockers = [];
  const warnings = [];
  const prompt = request?.prompt?.text ?? "";
  if (!prompt.trim()) blockers.push("prompt.text is required");
  if (countChars(prompt) > request.prompt.char_limit) blockers.push(`prompt.text exceeds ${request.prompt.char_limit} characters`);
  if (request.execution.execute && !request.execution.accept_cost) blockers.push("execute=true requires accept_cost=true");
  if (!["mock", "api"].includes(request.execution.backend)) blockers.push("execution.backend must be mock or api");
  if (request.execution.backend === "api" && !getDoubaoAudioApiKey()) blockers.push(`${DOUBAO_AUDIO_API_KEY_ENV} is required for backend=api`);
  if (request.model.model_id !== DOUBAO_AUDIO_DEFAULT_MODEL_ID) blockers.push("model_id must be seed-audio-1.0 for Volcengine Doubao Audio HTTP");
  if (!SUPPORTED_OUTPUT_FORMATS.has(request.generation.output_format)) blockers.push("output_format must be wav, mp3, pcm, or ogg_opus");
  if (!SUPPORTED_SAMPLE_RATES.has(request.generation.sample_rate)) blockers.push("sample_rate must be one of 8000, 16000, 24000, 32000, 44100, 48000");
  if (request.generation.references.length > 3) blockers.push("references supports at most three audio references, or one image reference");
  if (countImageReferences(request.generation.references) > 1) blockers.push("references supports at most one image reference");
  if (hasInvalidReferenceShape(request.generation.references)) blockers.push("each reference must contain exactly one of speaker, audio_data, audio_url, image_data, or image_url");
  if (hasMixedAudioAndImageReferences(request.generation.references)) blockers.push("audio and image references cannot be mixed");
  if (!containsTimelineHint(prompt) && request.timeline.length === 0) warnings.push("提示词缺少明确时间轴，建议补充 0-X 秒声音事件。");
  if (!containsMixHint(prompt)) warnings.push("提示词缺少混音层级，建议补充前景/中景/后景。");
  const dialogueCount = countDialogueBlocks(prompt);
  if (dialogueCount > 0 && !containsVoiceCard(prompt)) warnings.push("提示词包含对白引号，但未检测到完整“饰演音色”音色卡。");
  return {
    status: blockers.length ? "blocked" : "ready",
    blockers,
    warnings,
    checks: {
      char_count: countChars(prompt),
      char_limit: request.prompt.char_limit,
      dialogue_blocks: dialogueCount,
      endpoint: DOUBAO_AUDIO_ENDPOINT,
      auth: `${DOUBAO_AUDIO_API_KEY_ENV} environment variable`,
      auth_key_id: `${DOUBAO_AUDIO_API_KEY_ID_ENV} environment variable`,
      platform_review_policy: "passed_generation_sets_license_status_cleared",
      license_status_on_success: "cleared",
      risk_level_on_success: "low"
    }
  };
}

export async function runDoubaoAudioGeneration(request, { outputDir } = {}) {
  if (request.execution.backend === "api") {
    return runDoubaoAudioApiGeneration(request, { outputDir });
  }
  const dir = outputDir ?? request.execution.output_dir ?? process.cwd();
  await fs.promises.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, mockAudioFileName(request));
  await writeMockWav(filePath, {
    durationSeconds: Math.min(request.generation.duration_seconds, 3),
    sampleRate: request.generation.sample_rate,
    channels: request.generation.channels
  });
  const now = new Date().toISOString();
  return {
    provider: request.provider,
    backend: "mock",
    status: "success",
    platform_review_status: "passed",
    task_id: `doubao_mock_${Date.now()}`,
    created_at: now,
    completed_at: now,
    outputs: [{ file_path: filePath, mime_type: "audio/wav", output_format: "wav" }],
    cost: { credits: 0, currency: "mock" }
  };
}

export function buildDoubaoAudioApiPayload(request) {
  const payload = {
    model: request.model.model_id,
    text_prompt: request.prompt.text,
    audio_config: {
      format: request.generation.audio_config.format,
      sample_rate: request.generation.audio_config.sample_rate,
      speech_rate: request.generation.audio_config.speech_rate,
      loudness_rate: request.generation.audio_config.loudness_rate,
      pitch_rate: request.generation.audio_config.pitch_rate,
      enable_subtitle: request.generation.audio_config.enable_subtitle
    }
  };
  if (request.generation.references.length) payload.references = request.generation.references;
  if (Object.keys(request.generation.watermark).length) payload.watermark = request.generation.watermark;
  return payload;
}

export function doubaoAudioNextActions({ request, validation, generated = null }) {
  if (validation.blockers.length) return ["修正 blockers 后重新生成计划。"];
  if (!request.execution.execute) return ["确认请求包、平台审核即 cleared 策略和成本后，以 execute=true 且 accept_cost=true 执行生成。"];
  if (!generated) return ["执行生成后下载或接收音频输出，再写入资产库。"];
  return ["检查音频技术规格与听感；如用于视频，将其作为 @音频1 绑定到画布或生成槽。"];
}

function normalizeOutputFormat(value) {
  const normalized = String(value ?? "wav").toLowerCase();
  return SUPPORTED_OUTPUT_FORMATS.has(normalized) ? normalized : "wav";
}

function normalizeSampleRate(value) {
  const sampleRate = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 24000;
  return SUPPORTED_SAMPLE_RATES.has(sampleRate) ? sampleRate : 24000;
}

function normalizeAudioConfig(value, defaults) {
  return {
    format: normalizeOutputFormat(value.format ?? defaults.format),
    sample_rate: normalizeSampleRate(value.sample_rate ?? defaults.sample_rate),
    speech_rate: clampInteger(value.speech_rate ?? 0, -50, 100),
    loudness_rate: clampInteger(value.loudness_rate ?? 0, -50, 100),
    pitch_rate: clampInteger(value.pitch_rate ?? 0, -12, 12),
    enable_subtitle: value.enable_subtitle === true
  };
}

function normalizeWatermark(value) {
  const result = {};
  if (value.aigc_watermark !== undefined) result.aigc_watermark = value.aigc_watermark === true;
  if (value.aigc_metadata && typeof value.aigc_metadata === "object" && !Array.isArray(value.aigc_metadata)) {
    result.aigc_metadata = {
      enable: value.aigc_metadata.enable === true,
      ...(value.aigc_metadata.content_producer ? { content_producer: String(value.aigc_metadata.content_producer) } : {}),
      ...(value.aigc_metadata.produce_id ? { produce_id: String(value.aigc_metadata.produce_id) } : {}),
      ...(value.aigc_metadata.content_propagator ? { content_propagator: String(value.aigc_metadata.content_propagator) } : {}),
      ...(value.aigc_metadata.propagate_id ? { propagate_id: String(value.aigc_metadata.propagate_id) } : {})
    };
  }
  return result;
}

function normalizeReferences(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).map((item) => {
    const ref = {};
    for (const key of ["speaker", "audio_data", "audio_url", "image_data", "image_url"]) {
      if (item?.[key]) ref[key] = String(item[key]);
    }
    return ref;
  }).filter((item) => Object.keys(item).length > 0);
}

function hasMixedAudioAndImageReferences(references) {
  const hasAudio = references.some((item) => item.speaker || item.audio_data || item.audio_url);
  const hasImage = references.some((item) => item.image_data || item.image_url);
  return hasAudio && hasImage;
}

function countImageReferences(references) {
  return references.filter((item) => item.image_data || item.image_url).length;
}

function hasInvalidReferenceShape(references) {
  const keys = ["speaker", "audio_data", "audio_url", "image_data", "image_url"];
  return references.some((item) => keys.filter((key) => item[key]).length !== 1);
}

async function runDoubaoAudioApiGeneration(request, { outputDir } = {}) {
  const apiKey = getDoubaoAudioApiKey();
  if (!apiKey) throw new Error(`${DOUBAO_AUDIO_API_KEY_ENV} is required for backend=api`);
  const requestId = request.generation.provider_parameters.request_id ?? cryptoRandomId();
  const payload = buildDoubaoAudioApiPayload(request);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.execution.timeout_ms);
  let response;
  const startedAt = new Date().toISOString();
  try {
    response = await fetch(DOUBAO_AUDIO_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
        "X-Api-Request-Id": requestId
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let result;
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    result = { raw_body: text };
  }
  if (!response.ok || (Number.isFinite(Number(result.code)) && Number(result.code) !== 0)) {
    throw new Error(`豆包音频 HTTP 生成失败：status=${response.status}; code=${result.code ?? "unknown"}; message=${result.message ?? "unknown"}; logid=${response.headers.get("x-tt-logid") ?? ""}`);
  }
  const dir = outputDir ?? request.execution.output_dir ?? process.cwd();
  await fs.promises.mkdir(dir, { recursive: true });
  const outputs = [];
  const extension = outputExtension(request.generation.output_format);
  const filePath = path.join(dir, apiAudioFileName(request, extension));
  if (result.audio) {
    await fs.promises.writeFile(filePath, Buffer.from(String(result.audio), "base64"));
    outputs.push({ file_path: filePath, mime_type: mimeTypeForFormat(request.generation.output_format), output_format: request.generation.output_format, source: "base64" });
  } else if (result.url && request.execution.download_outputs !== false) {
    await downloadFile(result.url, filePath, request.execution.timeout_ms);
    outputs.push({ file_path: filePath, mime_type: mimeTypeForFormat(request.generation.output_format), output_format: request.generation.output_format, source: "url", url_expires_in_hours: 2 });
  }
  if (!outputs.length) {
    throw new Error(`豆包音频 HTTP 生成成功但未返回 audio 或 url；logid=${response.headers.get("x-tt-logid") ?? ""}`);
  }
  return {
    provider: request.provider,
    backend: "api",
    endpoint: DOUBAO_AUDIO_ENDPOINT,
    status: "success",
    platform_review_status: "passed",
    task_id: requestId,
    created_at: startedAt,
    completed_at: new Date().toISOString(),
    volcengine_logid: response.headers.get("x-tt-logid") ?? null,
    duration: result.duration ?? null,
    original_duration: result.original_duration ?? null,
    subtitle: result.subtitle ?? null,
    outputs,
    cost: { original_duration: result.original_duration ?? null, unit: "seconds" },
    response_summary: sanitizeApiResult(result)
  };
}

function getDoubaoAudioApiKey() {
  return String(process.env[DOUBAO_AUDIO_API_KEY_ENV] ?? "").trim();
}

function cryptoRandomId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

function outputExtension(format) {
  return {
    wav: "wav",
    mp3: "mp3",
    pcm: "pcm",
    ogg_opus: "ogg"
  }[format] ?? "wav";
}

function apiAudioFileName(request, extension) {
  const safeTitle = request.asset_policy.title.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 40) || "doubao_audio";
  return `${safeTitle}_${Date.now()}.${extension}`;
}

function mimeTypeForFormat(format) {
  return {
    wav: "audio/wav",
    mp3: "audio/mpeg",
    pcm: "application/octet-stream",
    ogg_opus: "audio/ogg"
  }[format] ?? "application/octet-stream";
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
  if (!response.ok) throw new Error(`豆包音频输出下载失败：status=${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.promises.writeFile(filePath, buffer);
}

function sanitizeApiResult(result = {}) {
  return {
    code: result.code ?? null,
    message: result.message ?? null,
    has_audio: Boolean(result.audio),
    has_url: Boolean(result.url),
    duration: result.duration ?? null,
    original_duration: result.original_duration ?? null,
    has_subtitle: Boolean(result.subtitle)
  };
}

function normalizeVoices(value) {
  if (!Array.isArray(value)) return [];
  return value.map((voice, index) => {
    if (typeof voice === "string") {
      return { role_name: `角色${index + 1}`, voice_card: voice, dialogue_language: "zh-CN", is_original_voice: true, reference_asset_id: null, reference_rights_required: true };
    }
    return {
      role_name: String(voice?.role_name ?? voice?.name ?? `角色${index + 1}`),
      voice_card: String(voice?.voice_card ?? voice?.description ?? ""),
      dialogue_language: String(voice?.dialogue_language ?? "zh-CN"),
      is_original_voice: voice?.is_original_voice !== false,
      reference_asset_id: voice?.reference_asset_id ?? null,
      reference_rights_required: voice?.reference_rights_required !== false
    };
  });
}

function normalizeTimeline(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    start: item?.start ?? null,
    end: item?.end ?? null,
    event: String(item?.event ?? item?.text ?? ""),
    layer: String(item?.layer ?? "foreground")
  }));
}

function normalizeSoundLayers(value) {
  return {
    foreground: normalizeStringArray(value.foreground ?? ["dialogue", "narration", "key_foley"]),
    midground: normalizeStringArray(value.midground ?? ["footsteps", "cloth", "action_foley"]),
    background: normalizeStringArray(value.background ?? ["ambience", "room_tone", "music"]),
    silence_tail_seconds: clampNumber(value.silence_tail_seconds ?? 0.5, 0, 5)
  };
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

function countDialogueBlocks(prompt) {
  return (String(prompt).match(/[“「『"][^”」』"]+[”」』"]/g) ?? []).length;
}

function containsVoiceCard(prompt) {
  return /（[^）]*饰演音色[:：][^）]*）/.test(String(prompt));
}

function containsTimelineHint(prompt) {
  return /\d+(\.\d+)?\s*[-—~至到]\s*\d+(\.\d+)?\s*秒/.test(String(prompt));
}

function containsMixHint(prompt) {
  return /前景|中景|后景|混音层级/.test(String(prompt));
}

function mockAudioFileName(request) {
  const safeTitle = request.asset_policy.title.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 40) || "doubao_audio";
  return `${safeTitle}_${Date.now()}.wav`;
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

function clampInteger(value, min, max) {
  const num = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : min;
  return Math.max(min, Math.min(max, num));
}

function clampNumber(value, min, max) {
  const num = Number.isFinite(Number(value)) ? Number(value) : min;
  return Math.max(min, Math.min(max, num));
}
