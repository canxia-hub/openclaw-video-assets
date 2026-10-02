import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { normalizeExternalCallError, httpFailure, redactText, createTimeoutGuard, readResponseText, readResponseBody, EXTERNAL_ERROR_CODES } from "./external-call.js";
export const DOUBAO_AUDIO_SCHEMA_VERSION = "doubao_audio_request_v1";
export const DOUBAO_AUDIO_PROVIDER = "doubao_seed_audio";
export const DOUBAO_AUDIO_DEFAULT_MODEL_ID = "seed-audio-1.0";
export const DOUBAO_AUDIO_ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/create";
const DOUBAO_AUDIO_API_KEY_ENV = "VOLCENGINE_DOUBAO_AUDIO_API_KEY";
const DOUBAO_AUDIO_API_KEY_ID_ENV = "VOLCENGINE_DOUBAO_AUDIO_API_KEY_ID";
const SUPPORTED_OUTPUT_FORMATS = new Set(["wav", "mp3", "pcm", "ogg_opus"]);
// 采样率按官方文档逐格式约束（来源：https://docs.volcengine.com/docs/6561/2550782?lang=zh，核查于 2026-09-20）：
//   wav/pcm 默认 40000，允许 [8000,16000,24000,32000,40000,44100,48000]
//   mp3     默认 44100，允许 [8000,16000,24000,32000,44100,48000]（不含 40000）
//   ogg_opus 仅支持 48000
// 统一允许集为官方三者的并集；逐格式合法性另由 assertFormatSampleRate() 判定。
const SUPPORTED_SAMPLE_RATES = new Set([8000, 16000, 24000, 32000, 40000, 44100, 48000]);
export const DOUBAO_SAMPLE_RATES_BY_FORMAT = Object.freeze({
  wav: Object.freeze([8000, 16000, 24000, 32000, 40000, 44100, 48000]),
  pcm: Object.freeze([8000, 16000, 24000, 32000, 40000, 44100, 48000]),
  mp3: Object.freeze([8000, 16000, 24000, 32000, 44100, 48000]),
  ogg_opus: Object.freeze([48000])
});
export const DOUBAO_DEFAULT_SAMPLE_RATE_BY_FORMAT = Object.freeze({ wav: 40000, pcm: 40000, mp3: 44100, ogg_opus: 48000 });

/** 官方参考资源上限（仅结构性规则，可离线判定） */
export const DOUBAO_REFERENCE_LIMITS = Object.freeze({
  max_audio_references: 3,
  max_image_references: 1,
  max_reference_bytes: 10 * 1024 * 1024,
  /** 官方：图片参考不能与音频参考混用（image_* 不得与 audio_* / speaker 同时传入） */
  mixing_allowed: false
});

/** 归一化阶段的防御性上限（远高于官方上限；超过则在校验阶段报错，而非静默截断） */
export const DOUBAO_REFERENCE_NORMALIZE_CAP = 64;

export const DOUBAO_AUDIO_GUIDE_SOURCE = Object.freeze({
  title: "豆包音频生成 1.0 中文声音导演稿方法库",
  skill: "doubao-seed-audio-prompt-engineering",
  wiki: "wiki/doubao-audio-1-0",
  plan: "projects/active/openclaw-video-asset-plugin/100-doubao-audio-plugin-integration-plan-2026-07-20.md",
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
    // 记录调用方**原始**参考条数：用于发现超限输入，避免归一化截断把它变得合法
    references_input_count: Array.isArray(input.references)
      ? input.references.length
      : (Array.isArray(input.generation?.references)
        ? input.generation.references.length
        : (Array.isArray(providerParameters.references) ? providerParameters.references.length : 0)),
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
      license_status: String(input.license_status ?? input.asset_policy?.license_status ?? "unknown"),
      risk_level: String(input.risk_level ?? input.asset_policy?.risk_level ?? "unknown"),
      platform_review_status: "pending",
      classification: normalizeObject(input.classification ?? input.asset_policy?.classification ?? {
        domain: "audio",
        type: "generated_output",
        subtype: purpose
      })
    }
  };
}

export function validateDoubaoAudioRequest(request, { apiKey: configuredApiKey } = {}) {
  const blockers = [];
  const warnings = [];
  const keyResolution = resolveDoubaoAudioApiKey(configuredApiKey);
  const prompt = request?.prompt?.text ?? "";
  if (!prompt.trim()) blockers.push("prompt.text is required");
  if (countChars(prompt) > request.prompt.char_limit) blockers.push(`prompt.text exceeds ${request.prompt.char_limit} characters`);
  if (request.execution.execute && !request.execution.accept_cost) blockers.push("execute=true requires accept_cost=true");
  if (!["mock", "api"].includes(request.execution.backend)) blockers.push("execution.backend must be mock or api");
  if (request.execution.backend === "api" && !keyResolution.apiKey) blockers.push(`${DOUBAO_AUDIO_API_KEY_ENV} is required for backend=api`);
  if (request.model.model_id !== DOUBAO_AUDIO_DEFAULT_MODEL_ID) blockers.push("model_id must be seed-audio-1.0 for Volcengine Doubao Audio HTTP");
  if (!SUPPORTED_OUTPUT_FORMATS.has(request.generation.output_format)) blockers.push("output_format must be wav, mp3, pcm, or ogg_opus");
  if (!SUPPORTED_SAMPLE_RATES.has(request.generation.sample_rate)) blockers.push(`sample_rate must be one of ${[...SUPPORTED_SAMPLE_RATES].join(", ")}`);
  // 逐格式采样率约束（官方：mp3 不含 40000；ogg_opus 仅 48000）
  const allowedRates = DOUBAO_SAMPLE_RATES_BY_FORMAT[request.generation.output_format];
  if (allowedRates && !allowedRates.includes(request.generation.sample_rate)) {
    blockers.push(`sample_rate ${request.generation.sample_rate} is not supported by output_format ${request.generation.output_format}; supported: ${allowedRates.join(", ")}`);
  }
  // 参考资源限制：条数按官方逐类计数（音频 ≤3、图片 ≤1），并禁止图文混用。
  // 官方原文：最多 3 条参考音频（各 ≤30s / ≤10MB）、最多 1 张参考图片（≤10MB）；
  //           图片参考不能与音频参考混用（image_* 不得与 audio_* / speaker 同时传入）。
  const audioReferenceCount = countAudioReferences(request.generation.references);
  const imageReferenceCount = countImageReferences(request.generation.references);
  if (audioReferenceCount > DOUBAO_REFERENCE_LIMITS.max_audio_references) {
    blockers.push(`references supports at most ${DOUBAO_REFERENCE_LIMITS.max_audio_references} audio references; got ${audioReferenceCount}`);
  }
  if (imageReferenceCount > DOUBAO_REFERENCE_LIMITS.max_image_references) {
    blockers.push(`references supports at most ${DOUBAO_REFERENCE_LIMITS.max_image_references} image reference; got ${imageReferenceCount}`);
  }
  if (hasInvalidReferenceShape(request.generation.references)) blockers.push("each reference must contain exactly one of speaker, audio_data, audio_url, image_data, or image_url");
  if (hasMixedAudioAndImageReferences(request.generation.references)) blockers.push("audio and image references cannot be mixed");
  // 内联 base64 参考可离线判定体积（官方上限 10MB）；远端 URL 无法离线判定，不在此处报错。
  for (const [index, oversize] of findOversizeInlineReferences(request.generation.references).entries()) {
    blockers.push(`inline reference #${oversize.index} decoded size ${oversize.bytes} exceeds ${DOUBAO_REFERENCE_LIMITS.max_reference_bytes} bytes`);
    void index;
  }
  // 官方原文：参考音频的上传顺序须与 text_prompt 中 @音频N 的编号顺序严格对应。
  // 能确证的只是「有参考音频时，编号不得悬空」；
  // 无参考音频时提示词里的 @音频N 无法判定是引用还是用途说明（例如「用于即梦视频 @音频1」），
  // 因此只在有参考时硬拦，无参考时降为提示，不误伤合法请求。
  const referencedAudioIndices = extractReferencedAudioIndices(prompt);
  if (referencedAudioIndices.length) {
    const maxIndex = Math.max(...referencedAudioIndices);
    if (audioReferenceCount > 0 && maxIndex > audioReferenceCount) {
      blockers.push(`prompt references @音频${maxIndex} but only ${audioReferenceCount} audio reference(s) were provided`);
    } else if (audioReferenceCount === 0) {
      warnings.push("提示词引用了 @音频N，但未提供任何参考音频；若这是引用参考音频需补 references，若只是用途说明可忽略。");
    }
  }
  // 归一化上限溢出：超限必须被拒绝，不得静默截断成合法请求
  if (Number(request.generation.references_input_count ?? 0) > DOUBAO_REFERENCE_NORMALIZE_CAP) {
    blockers.push(`references count ${request.generation.references_input_count} exceeds the normalisation cap ${DOUBAO_REFERENCE_NORMALIZE_CAP}`);
  }
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
      auth: keyResolution.source === "config" ? `${DOUBAO_AUDIO_API_KEY_ENV} via plugin config audio.doubao.apiKey` : `${DOUBAO_AUDIO_API_KEY_ENV} environment variable`,
      auth_key_id: `${DOUBAO_AUDIO_API_KEY_ID_ENV} environment variable`,
      platform_review_policy: "platform_review_passed_is_content_review_only",
      license_status_on_success: request.asset_policy.license_status,
      risk_level_on_success: request.asset_policy.risk_level,
      audio_reference_count: audioReferenceCount,
      image_reference_count: imageReferenceCount,
      referenced_audio_indices: referencedAudioIndices,
    }
  };
}

export async function runDoubaoAudioGeneration(request, { outputDir, apiKey } = {}) {
  if (request.execution.backend === "api") {
    return runDoubaoAudioApiGeneration(request, { outputDir, apiKey });
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
  if (!request.execution.execute) return ["确认请求包、平台审核状态与成本后，以 execute=true 且 accept_cost=true 执行生成；生成成功不会自动把授权标为 cleared。"];
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
  // 曾经是 slice(0, 3)：把 4 条参考音频静默降为 3 条，导致超限输入看起来合法。
  // 现在只做防御性上限（防止超大数组拖垮校验），且超限必须能被校验阶段发现。
  return value.slice(0, DOUBAO_REFERENCE_NORMALIZE_CAP).map((item) => {
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

/** 音频类参考计数：官方把 speaker / audio_data / audio_url 都视为音频参考（三者在一参内互斥） */
function countAudioReferences(references) {
  return references.filter((item) => item.speaker || item.audio_data || item.audio_url).length;
}

/**
 * 抽取提示词中引用的 @音频N 编号（官方约定：上传的第 N 条参考音频对应 @音频N，编号从 1 开始）。
 * 用于校验引用是否悬空——这是纯文本+结构即可离线判定的规则。
 */
function extractReferencedAudioIndices(prompt) {
  const indices = new Set();
  const re = /@音频\s*(\d+)/g;
  let match;
  while ((match = re.exec(prompt)) !== null) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) indices.add(value);
  }
  return [...indices].sort((a, b) => a - b);
}

/** 内联 base64 参考体积检查（离线可判定）；远端 URL 返回空列表，属已登记的能力缺口 */
function findOversizeInlineReferences(references) {  const oversize = [];
  references.forEach((item, index) => {
    for (const key of ["audio_data", "image_data"]) {
      const value = item[key];
      if (typeof value !== "string" || !value) continue;
      // base64 解码后字节数 ≈ len * 3/4（扣除 padding）
      const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
      const bytes = Math.floor((value.length * 3) / 4) - padding;
      if (bytes > DOUBAO_REFERENCE_LIMITS.max_reference_bytes) oversize.push({ index, bytes });
    }
  });
  return oversize;
}

function hasInvalidReferenceShape(references) {
  const keys = ["speaker", "audio_data", "audio_url", "image_data", "image_url"];
  return references.some((item) => keys.filter((key) => item[key]).length !== 1);
}

async function runDoubaoAudioApiGeneration(request, { outputDir, apiKey: configuredApiKey } = {}) {
  const apiKey = resolveDoubaoAudioApiKey(configuredApiKey).apiKey;
  if (!apiKey) throw new Error(`${DOUBAO_AUDIO_API_KEY_ENV} is required for backend=api`);
  const requestId = request.generation.provider_parameters.request_id ?? cryptoRandomId();
  const payload = buildDoubaoAudioApiPayload(request);
  // 超时窗口覆盖**请求 + 正文读取**：收到响应头**不清**计时器
  const guard = createTimeoutGuard(request.execution.timeout_ms, { provider: DOUBAO_AUDIO_PROVIDER, endpoint: DOUBAO_AUDIO_ENDPOINT });
  let response;
  let text;
  const startedAt = new Date().toISOString();
  try {
    try {
      response = await fetch(DOUBAO_AUDIO_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": apiKey,
          "X-Api-Request-Id": requestId
        },
        body: JSON.stringify(payload),
        signal: guard.signal
      });
    } catch (err) {
      // 超时 / 主动中止 / 网络失败：保留原始信息（经脱敏），附 provider、端点与阶段
      throw normalizeExternalCallError(err, {
        provider: DOUBAO_AUDIO_PROVIDER,
        endpoint: DOUBAO_AUDIO_ENDPOINT,
        phase: guard.timedOut ? "http_timeout" : "http_request",
        hint: guard.timedOut ? EXTERNAL_ERROR_CODES.TIMEOUT : null
      });
    }
    // 正文读取留在窗口内；越窗或正文异常均在这里规范化
    text = await readResponseText({ response, guard, provider: DOUBAO_AUDIO_PROVIDER, endpoint: DOUBAO_AUDIO_ENDPOINT });
  } finally {
    guard.clear();
  }
  let result;
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    result = { raw_body: text };
  }
  if (!response.ok || (Number.isFinite(Number(result.code)) && Number(result.code) !== 0)) {
    const logid = response.headers.get("x-tt-logid") ?? "";
    const normalized = httpFailure({
      provider: DOUBAO_AUDIO_PROVIDER,
      endpoint: DOUBAO_AUDIO_ENDPOINT,
      phase: "http_status",
      status: response.status,
      upstreamCode: result.code ?? null,
      logid: logid || null,
      detail: `code=${result.code ?? "unknown"}; message=${result.message ?? "unknown"}`
    });
    normalized.message = `豆包音频 HTTP 生成失败：${normalized.message}`;
    throw normalized;
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

function resolveDoubaoAudioApiKey(configuredValue) {
  const fromConfig = typeof configuredValue === "string" ? configuredValue.trim() : "";
  if (fromConfig) return { apiKey: fromConfig, source: "config" };
  const fromEnv = getDoubaoAudioApiKey();
  if (fromEnv) return { apiKey: fromEnv, source: "env" };
  return { apiKey: "", source: "missing" };
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
  // 下载路径同样把超时窗口盖到**正文（字节流）读取**：旧实现在收到响应头后就清计时器，
  // 慢下载可无限拖，且正文异常以原始形态冒出。
  const guard = createTimeoutGuard(timeoutMs, { provider: DOUBAO_AUDIO_PROVIDER, endpoint: url });
  let response;
  let buffer;
  try {
    try {
      response = await fetch(url, { signal: guard.signal });
    } catch (err) {
      throw normalizeExternalCallError(err, {
        provider: DOUBAO_AUDIO_PROVIDER,
        endpoint: url,
        phase: guard.timedOut ? "download_timeout" : "download_request",
        hint: guard.timedOut ? EXTERNAL_ERROR_CODES.TIMEOUT : null
      });
    }
    if (!response.ok) throw httpFailure({ provider: DOUBAO_AUDIO_PROVIDER, endpoint: url, phase: "download_status", status: response.status });
    buffer = await readResponseBody({ response, guard, provider: DOUBAO_AUDIO_PROVIDER, endpoint: url, as: "buffer", phase: "download_body" });
  } finally {
    guard.clear();
  }
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
