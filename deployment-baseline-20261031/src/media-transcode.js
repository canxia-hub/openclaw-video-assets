// REN-05 / src/media-transcode.js
//
// REAL FFmpeg / ffprobe adapter for derived-media generation and probing.
//
// WHY THIS FILE EXISTS
// --------------------
// The accepted 28204fe baseline generates every "derived file" by COPYING the source file
// (`service.js` buildSafeDerivedCopyPlan -> fs.copyFile) and then labelling the result
// `generator: "safe-copy"`. A copied video is not a thumbnail, and the workbench then shows a
// poster-sized copy of the original as if it were one. This module replaces that path with real
// derivations and makes the unsupported cases FAIL AS ERRORS instead of silently producing a copy.
//
// PROCESS DISCIPLINE (the parts that matter for safety)
//   * execFile with an ARGUMENT ARRAY. `shell` is never enabled, so no path or parameter can be
//     re-parsed by a shell.
//   * Every invocation carries an explicit timeout and a byte cap on captured output; a hung
//     ffmpeg can not pin a worker forever.
//   * Inputs are always local files under the repository root (no URLs), so ffmpeg is never asked
//     to open a network resource. Proxy variables are stripped from the child environment for the
//     same reason.
//   * ffprobe is used to VERIFY the artifact that ffmpeg produced. "ffmpeg exited 0" is not taken
//     as proof that a usable file exists.
//
// WHAT THIS MODULE DOES NOT DO
//   It does not decide authorization, it does not write database rows, and it does not touch the
//   original object. Callers own those steps.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

/** Media kinds this adapter reasons about. */
const KIND_IMAGE = "image";
const KIND_VIDEO = "video";
const KIND_AUDIO = "audio";

const IMAGE_INPUT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"]);
const VIDEO_INPUT_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"]);
const AUDIO_INPUT_EXTENSIONS = new Set([".wav", ".mp3", ".aac", ".m4a", ".flac", ".ogg", ".opus"]);

/**
 * A derivation error that carries a stable machine-readable code. Callers can map `code` onto an
 * HTTP status or a tool failure envelope without string-matching the message.
 */
export class DerivationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DerivationError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------------------------
// Tool discovery
// ---------------------------------------------------------------------------------------------

let cachedTools = null;

const PROXY_ENV_KEYS = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
  "NO_PROXY", "no_proxy"
];

/**
 * The child environment for ffmpeg/ffprobe: the process environment without proxy variables.
 * Derivation only ever reads local files, so proxy settings can only add failure modes (a proxy
 * variable made a different tool in this project fail on an unrelated transport error).
 */
function childEnv() {
  const env = { ...process.env };
  for (const key of PROXY_ENV_KEYS) delete env[key];
  return env;
}

function candidatePaths(name) {
  const configured = name === "ffmpeg" ? process.env.VIDEO_ASSETS_FFMPEG : process.env.VIDEO_ASSETS_FFPROBE;
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const list = [];
  if (configured && configured.trim()) list.push(configured.trim());
  list.push(exe); // resolved through PATH
  if (process.platform === "win32") {
    list.push(`C:\\tools\\ffmpeg\\${exe}`, `C:\\Tools\\ffmpeg\\${exe}`);
  }
  return list;
}

function runOnce(file, args, { timeoutMs = PROBE_TIMEOUT_MS, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      // maxBuffer caps captured output; the argument array plus the absence of `shell: true` is
      // what keeps a path or a parameter from ever being interpreted by a shell. `signal` lets a
      // queue-level cancel actually TERMINATE the child instead of merely abandoning it.
      { timeout: timeoutMs, maxBuffer: MAX_CAPTURE_BYTES, windowsHide: true, env: childEnv(), shell: false, ...(signal ? { signal } : {}) },
      (error, stdout, stderr) => {
        if (error) {
          const aborted = error.name === "AbortError" || error.code === "ABORT_ERR" || signal?.aborted === true;
          const timedOut = !aborted && (error.killed === true || error.signal === "SIGTERM" || error.code === "ETIMEDOUT");
          const missing = error.code === "ENOENT";
          reject(new DerivationError(
            aborted ? "DERIVATION_CANCELLED" : timedOut ? "DERIVATION_TIMEOUT" : missing ? "TOOL_NOT_FOUND" : "DERIVATION_FAILED",
            aborted
              ? `${path.basename(file)} was cancelled`
              : timedOut
                ? `${path.basename(file)} exceeded the ${timeoutMs}ms timeout`
                : missing
                  ? `${path.basename(file)} is not available`
                  : `${path.basename(file)} failed: ${String(stderr || error.message).trim().slice(0, 500)}`,
            { tool: path.basename(file), exit_code: error.code ?? null, stderr: String(stderr ?? "").slice(0, 2000) }
          ));
          return;
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      }
    );
  });
}

/**
 * Locate a working ffmpeg/ffprobe pair once, then reuse the result.
 * `available: false` is a normal, expected state: the caller degrades explicitly instead of
 * guessing (see probeMediaAsync).
 */
export async function resolveMediaTools({ refresh = false } = {}) {
  if (cachedTools && !refresh) return cachedTools;
  const found = { ffmpeg: null, ffprobe: null, ffmpeg_version: null, ffprobe_version: null, available: false, probed_from: null };
  for (const candidate of candidatePaths("ffprobe")) {
    try {
      const { stdout } = await runOnce(candidate, ["-version"], { timeoutMs: PROBE_TIMEOUT_MS });
      found.ffprobe = candidate;
      found.ffprobe_version = stdout.split(/\r?\n/)[0] ?? null;
      break;
    } catch {
      /* try the next candidate */
    }
  }
  for (const candidate of candidatePaths("ffmpeg")) {
    try {
      const { stdout } = await runOnce(candidate, ["-version"], { timeoutMs: PROBE_TIMEOUT_MS });
      found.ffmpeg = candidate;
      found.ffmpeg_version = stdout.split(/\r?\n/)[0] ?? null;
      break;
    } catch {
      /* try the next candidate */
    }
  }
  found.available = Boolean(found.ffmpeg && found.ffprobe);
  found.probed_from = process.env.VIDEO_ASSETS_FFMPEG || process.env.VIDEO_ASSETS_FFPROBE || (found.available ? "PATH" : null);
  cachedTools = found;
  return found;
}

/** Test seam: forget the cached tool resolution. */
export function resetMediaToolsCache() {
  cachedTools = null;
}

// ---------------------------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------------------------

function parseRational(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!text || text === "0/0") return undefined;
  const [num, den] = text.split("/").map(Number);
  if (Number.isFinite(den) && den !== 0) return Number((num / den).toFixed(4));
  const single = Number(text);
  return Number.isFinite(single) ? Number(single.toFixed(4)) : undefined;
}

function secondsToMs(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined;
}

/**
 * ffprobe a local file into the plugin's flat metadata vocabulary.
 * Returns `null` when ffprobe reports no usable stream, which the caller treats as
 * "this input can not be decoded" rather than as "no metadata available".
 */
export async function probeWithFfprobe(filePath, { timeoutMs = PROBE_TIMEOUT_MS, tools = null } = {}) {
  const resolved = tools ?? (await resolveMediaTools());
  if (!resolved.ffprobe) {
    throw new DerivationError("TOOL_NOT_FOUND", "ffprobe is not available", { tool: "ffprobe" });
  }
  const args = [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    path.resolve(filePath)
  ];
  const { stdout } = await runOnce(resolved.ffprobe, args, { timeoutMs });
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new DerivationError("PROBE_UNPARSEABLE", "ffprobe did not return JSON", { raw: stdout.slice(0, 500) });
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === "audio");
  const format = parsed.format ?? {};
  if (!video && !audio) return null;

  const kind = video ? KIND_VIDEO : KIND_AUDIO;
  const durationSeconds = format.duration ?? video?.duration ?? audio?.duration;
  const frameRate = video ? parseRational(video.avg_frame_rate) ?? parseRational(video.r_frame_rate) : undefined;
  return {
    media_type: kind,
    format_family: kind,
    container: format.format_name ? String(format.format_name).split(",")[0] : undefined,
    codec: video?.codec_name ?? audio?.codec_name,
    width: video?.width,
    height: video?.height,
    duration_ms: secondsToMs(durationSeconds),
    frame_rate: frameRate,
    sample_rate: audio?.sample_rate ? Number(audio.sample_rate) : undefined,
    channels: audio?.channels,
    bit_rate: format.bit_rate ? Number(format.bit_rate) : undefined,
    probed_by: "ffprobe",
    probe_degraded: false,
    ffprobe_version: resolved.ffprobe_version
  };
}

/** ffprobe an image file (which ffprobe reports as a single-frame video stream). */
export async function probeImageWithFfprobe(filePath, { timeoutMs = PROBE_TIMEOUT_MS, tools = null } = {}) {
  const base = await probeWithFfprobe(filePath, { timeoutMs, tools });
  if (!base) return null;
  return { ...base, media_type: KIND_IMAGE, format_family: "raster", duration_ms: undefined, frame_rate: undefined, sample_rate: undefined, channels: undefined };
}

// ---------------------------------------------------------------------------------------------
// Derivation profiles
// ---------------------------------------------------------------------------------------------

const PROFILE_MODE = "ffmpeg";

/**
 * Every profile names the exact derivative type it satisfies, the media kinds it accepts, and how
 * its output is verified. Adding a profile is the only way to make a new (kind, derivative_type)
 * pair derivable; anything not listed here fails with DERIVATION_UNSUPPORTED rather than copying.
 */
export const DERIVATION_PROFILES = Object.freeze({
  thumbnail_image: Object.freeze({
    id: "thumbnail-image-w{width}-{format}",
    derivative_type: "thumbnail",
    accepts: [KIND_IMAGE],
    default_width: 512,
    output_extension: ".jpg",
    description: "Downscaled still frame for image assets.",
    verify: "image-dimensions"
  }),
  thumbnail_video: Object.freeze({
    id: "thumbnail-video-w{width}-at{offset_ms}",
    derivative_type: "thumbnail",
    accepts: [KIND_VIDEO],
    default_width: 512,
    default_offset_ms: 0,
    output_extension: ".jpg",
    description: "Poster frame extracted at an offset, scaled to the requested width.",
    verify: "image-dimensions"
  }),
  proxy_video: Object.freeze({
    id: "proxy-video-w{width}-h264-aac",
    derivative_type: "proxy",
    accepts: [KIND_VIDEO],
    default_width: 1280,
    output_extension: ".mp4",
    description: "Streamable H.264/AAC proxy with the moov atom moved to the front.",
    verify: "audiovisual-duration"
  }),
  transcode_video: Object.freeze({
    id: "transcode-video-w{width}-h264-aac",
    derivative_type: "transcode",
    accepts: [KIND_VIDEO],
    default_width: 1920,
    output_extension: ".mp4",
    description: "Full-size H.264/AAC transcode for delivery.",
    verify: "audiovisual-duration"
  }),
  audio_proxy: Object.freeze({
    id: "audio-proxy-aac-{bitrate}k",
    derivative_type: "audio_proxy",
    accepts: [KIND_AUDIO],
    default_bitrate_kbps: 128,
    output_extension: ".m4a",
    description: "AAC audition copy of an audio asset.",
    verify: "audio-duration"
  }),
  waveform: Object.freeze({
    id: "waveform-png-w{width}-h{height}",
    derivative_type: "waveform",
    accepts: [KIND_AUDIO],
    default_width: 1024,
    default_height: 256,
    output_extension: ".png",
    description: "Rendered waveform image of an audio asset.",
    verify: "image-dimensions"
  })
});

/** The (kind, derivative_type) -> profile mapping. Absence is a deliberate, reported failure. */
const PROFILE_BY_KIND_AND_TYPE = Object.freeze({
  [`${KIND_IMAGE}:thumbnail`]: "thumbnail_image",
  [`${KIND_VIDEO}:thumbnail`]: "thumbnail_video",
  [`${KIND_VIDEO}:proxy`]: "proxy_video",
  [`${KIND_VIDEO}:transcode`]: "transcode_video",
  [`${KIND_AUDIO}:audio_proxy`]: "audio_proxy",
  [`${KIND_AUDIO}:waveform`]: "waveform"
});

const EXTENSIONS_BY_KIND = Object.freeze({
  [KIND_IMAGE]: IMAGE_INPUT_EXTENSIONS,
  [KIND_VIDEO]: VIDEO_INPUT_EXTENSIONS,
  [KIND_AUDIO]: AUDIO_INPUT_EXTENSIONS
});

/** Media kind implied by a file name, or null when the extension is not a derivation input. */
export function derivationKindForFileName(fileName) {
  const extension = path.extname(String(fileName ?? "")).toLowerCase();
  if (IMAGE_INPUT_EXTENSIONS.has(extension)) return KIND_IMAGE;
  if (VIDEO_INPUT_EXTENSIONS.has(extension)) return KIND_VIDEO;
  if (AUDIO_INPUT_EXTENSIONS.has(extension)) return KIND_AUDIO;
  return null;
}

export function resolveProfileName(kind, derivativeType) {
  return PROFILE_BY_KIND_AND_TYPE[`${kind}:${derivativeType}`] ?? null;
}

function clampInteger(value, min, max, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new DerivationError("DERIVATION_BAD_PARAMETER", `${name} must be an integer between ${min} and ${max}`, { parameter: name, value });
  }
  return number;
}

function evenInteger(value) {
  return value % 2 === 0 ? value : value - 1;
}

function profileId(profileKey, profile, parameters) {
  return profile.id
    .replace("{width}", String(parameters.width ?? ""))
    .replace("{height}", String(parameters.height ?? ""))
    .replace("{format}", String(parameters.format ?? ""))
    .replace("{offset_ms}", String(parameters.offset_ms ?? ""))
    .replace("{bitrate}", String(parameters.bitrate_kbps ?? ""));
}

/**
 * Resolve a derivation request into an executable plan, or throw a coded error.
 *
 * The three refusal shapes are distinct on purpose:
 *   DERIVATION_KIND_UNKNOWN     - the extension is not a media input at all
 *   DERIVATION_UNSUPPORTED      - the media kind has no profile for this derivative type
 *   DERIVATION_INPUT_UNSUPPORTED- the profile exists but not for this container
 * None of them falls back to copying the source.
 */
export function planDerivation({ source, derivativeType, parameters = {}, outputDir }) {
  const kind = derivationKindForFileName(source.file_name ?? source.file_path);
  const extension = path.extname(String(source.file_name ?? source.file_path ?? "")).toLowerCase();
  if (!kind) {
    throw new DerivationError(
      "DERIVATION_KIND_UNKNOWN",
      `no media kind is known for extension ${extension || "(none)"}`,
      { extension, derivative_type: derivativeType }
    );
  }
  const profileKey = resolveProfileName(kind, derivativeType);
  if (!profileKey) {
    throw new DerivationError(
      "DERIVATION_UNSUPPORTED",
      `${derivativeType} generation is not supported for ${kind} sources`,
      { media_kind: kind, derivative_type: derivativeType, supported: Object.keys(PROFILE_BY_KIND_AND_TYPE) }
    );
  }
  const profile = DERIVATION_PROFILES[profileKey];
  if (!EXTENSIONS_BY_KIND[kind].has(extension)) {
    throw new DerivationError(
      "DERIVATION_INPUT_UNSUPPORTED",
      `no ${kind} derivation input is supported for ${extension}`,
      { extension, media_kind: kind, profile: profileKey }
    );
  }

  const resolved = { kind, profileKey, profile, extension };
  if (profileKey === "thumbnail_image") {
    resolved.parameters = { width: clampInteger(parameters.width ?? profile.default_width, 16, 4096, "width"), format: "jpg" };
  } else if (profileKey === "thumbnail_video") {
    resolved.parameters = {
      width: clampInteger(parameters.width ?? profile.default_width, 16, 4096, "width"),
      offset_ms: clampInteger(parameters.offset_ms ?? profile.default_offset_ms, 0, 86_400_000, "offset_ms"),
      format: "jpg"
    };
  } else if (profileKey === "proxy_video" || profileKey === "transcode_video") {
    resolved.parameters = { width: evenInteger(clampInteger(parameters.width ?? profile.default_width, 64, 4096, "width")) };
  } else if (profileKey === "audio_proxy") {
    resolved.parameters = { bitrate_kbps: clampInteger(parameters.bitrate_kbps ?? profile.default_bitrate_kbps, 32, 320, "bitrate_kbps") };
  } else if (profileKey === "waveform") {
    resolved.parameters = {
      width: evenInteger(clampInteger(parameters.width ?? profile.default_width, 128, 4096, "width")),
      height: evenInteger(clampInteger(parameters.height ?? profile.default_height, 64, 2048, "height"))
    };
  }
  resolved.profile_id = profileId(profileKey, profile, resolved.parameters);
  resolved.output_extension = profile.output_extension;
  resolved.output_path = path.join(outputDir, `${crypto.randomUUID()}${profile.output_extension}`);
  resolved.mode = PROFILE_MODE;
  return resolved;
}

function ffmpegArgsFor(plan, inputPath, durationMs) {
  const common = ["-hide_banner", "-nostdin", "-y", "-i", inputPath];
  switch (plan.profileKey) {
    case "thumbnail_image":
      return [...common, "-frames:v", "1", "-vf", `scale=${plan.parameters.width}:-2`, "-q:v", "3", plan.output_path];
    case "thumbnail_video": {
      const offset = plan.parameters.offset_ms / 1000;
      // A poster frame can not be taken beyond the end of the file, so clamp to the last tenth of
      // a second rather than emitting a zero-byte file for a short clip.
      const safeOffset = durationMs && plan.parameters.offset_ms > durationMs ? Math.max(0, durationMs - 100) / 1000 : offset;
      return [...common, "-ss", String(safeOffset), "-frames:v", "1", "-vf", `scale=${plan.parameters.width}:-2`, "-q:v", "3", plan.output_path];
    }
    case "proxy_video":
      return [...common, "-vf", `scale=${plan.parameters.width}:-2`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", plan.output_path];
    case "transcode_video":
      return [...common, "-vf", `scale=${plan.parameters.width}:-2`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", plan.output_path];
    case "audio_proxy":
      return [...common, "-vn", "-c:a", "aac", "-b:a", `${plan.parameters.bitrate_kbps}k`, plan.output_path];
    case "waveform":
      return [...common, "-filter_complex", `showwavespic=s=${plan.parameters.width}x${plan.parameters.height}:colors=#4c8bf5`, "-frames:v", "1", plan.output_path];
    default:
      throw new DerivationError("DERIVATION_UNSUPPORTED", `no ffmpeg argument builder for ${plan.profileKey}`, { profile: plan.profileKey });
  }
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Verify a produced artifact with ffprobe. Existence and a non-zero size are checked first, because
 * an ffmpeg run can exit 0 having written an empty file.
 */
async function verifyArtifact(plan, tools, { expectedDurationMs = null } = {}) {
  const stat = await fs.promises.stat(plan.output_path).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new DerivationError("DERIVATION_OUTPUT_MISSING", "the derivation did not produce an output file", { output_path: plan.output_path });
  }
  if (stat.size === 0) {
    throw new DerivationError("DERIVATION_OUTPUT_EMPTY", "the derivation produced a zero-byte output", { output_path: plan.output_path });
  }
  const probe = plan.profile.verify === "image-dimensions"
    ? await probeImageWithFfprobe(plan.output_path, { tools })
    : await probeWithFfprobe(plan.output_path, { tools });
  if (!probe) {
    throw new DerivationError("DERIVATION_OUTPUT_UNDECODABLE", "the produced artifact could not be probed", { output_path: plan.output_path });
  }
  const checks = [];
  if (plan.profile.verify === "image-dimensions") {
    checks.push({ name: "width_matches_request", ok: Number(probe.width) === Number(plan.parameters.width), expected: plan.parameters.width, actual: probe.width });
  }
  if (plan.profile.verify === "audiovisual-duration" || plan.profile.verify === "audio-duration") {
    checks.push({ name: "duration_present", ok: Number.isFinite(probe.duration_ms) && probe.duration_ms > 0, actual: probe.duration_ms });
    if (expectedDurationMs) {
      // Re-encoding changes duration slightly; 2% or 250ms of slack, whichever is larger.
      const slack = Math.max(250, Math.round(expectedDurationMs * 0.02));
      checks.push({ name: "duration_within_tolerance", ok: Math.abs((probe.duration_ms ?? 0) - expectedDurationMs) <= slack, expected: expectedDurationMs, actual: probe.duration_ms, slack_ms: slack });
    }
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    throw new DerivationError("DERIVATION_OUTPUT_UNVERIFIED", `artifact verification failed: ${failed.map((c) => c.name).join(", ")}`, { checks, output_path: plan.output_path });
  }
  return { probe, checks, size_bytes: stat.size, sha256: await hashFile(plan.output_path) };
}

/**
 * Generate a derivation for real. Returns the artifact description; it does not register anything.
 *
 * `tools.available === false` yields DERIVATION_TOOLCHAIN_UNAVAILABLE, which the service surfaces
 * as a failure. There is no copy fallback here by design: a "thumbnail" that is a copy of the
 * source is the defect this package exists to remove.
 */
export async function generateDerivation({ source, derivativeType, parameters = {}, outputDir, timeoutMs = DEFAULT_TIMEOUT_MS, tools = null, ffprobe = null, signal = null }) {
  const resolvedTools = tools ?? (await resolveMediaTools());
  if (!resolvedTools.available) {
    throw new DerivationError("DERIVATION_TOOLCHAIN_UNAVAILABLE", "ffmpeg/ffprobe are not available, so no real derivation can be produced", {
      ffmpeg: resolvedTools.ffmpeg,
      ffprobe: resolvedTools.ffprobe
    });
  }
  const sourceStat = await fs.promises.stat(source.file_path).catch(() => null);
  if (!sourceStat || !sourceStat.isFile()) {
    throw new DerivationError("DERIVATION_SOURCE_MISSING", "the source object could not be read", { asset_version_id: source.asset_version_id });
  }
  const plan = planDerivation({ source, derivativeType, parameters, outputDir });
  await fs.promises.mkdir(path.dirname(plan.output_path), { recursive: true });

  let sourceProbe = ffprobe;
  if (!sourceProbe) {
    const probeFn = plan.kind === KIND_IMAGE ? probeImageWithFfprobe : probeWithFfprobe;
    sourceProbe = await probeFn(source.file_path, { tools: resolvedTools });
  }
  if (!sourceProbe) {
    throw new DerivationError("DERIVATION_INPUT_UNDECODABLE", "ffprobe found no usable stream in the source", { asset_version_id: source.asset_version_id, profile: plan.profileKey });
  }

  const args = ffmpegArgsFor(plan, source.file_path, sourceProbe.duration_ms ?? null);
  const startedAt = Date.now();
  try {
    await runOnce(resolvedTools.ffmpeg, args, { timeoutMs, signal });
  } catch (error) {
    // A failed derivation must not leave a partial artifact behind for a later "exists" check to
    // mistake for a real one.
    await fs.promises.rm(plan.output_path, { force: true }).catch(() => {});
    if (error instanceof DerivationError) throw error;
    throw new DerivationError("DERIVATION_FAILED", "ffmpeg failed", { profile: plan.profileKey });
  }

  let verification;
  try {
    verification = await verifyArtifact(plan, resolvedTools, { expectedDurationMs: sourceProbe.duration_ms ?? null });
  } catch (error) {
    await fs.promises.rm(plan.output_path, { force: true }).catch(() => {});
    throw error;
  }

  return {
    derivative_type: plan.profile.derivative_type,
    profile: plan.profile_id,
    profile_key: plan.profileKey,
    mode: plan.mode,
    output_path: plan.output_path,
    output_extension: plan.output_extension,
    parameters: { ...plan.parameters },
    mime_type: mimeForExtension(plan.output_extension),
    size_bytes: verification.size_bytes,
    sha256: verification.sha256,
    source_probe: sourceProbe,
    output_probe: verification.probe,
    verification: verification.checks,
    duration_ms: verification.probe.duration_ms ?? null,
    width: verification.probe.width ?? null,
    height: verification.probe.height ?? null,
    elapsed_ms: Date.now() - startedAt,
    ffmpeg_version: resolvedTools.ffmpeg_version,
    ffprobe_version: resolvedTools.ffprobe_version
  };
}

export function mimeForExtension(extension) {
  return {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav"
  }[String(extension ?? "").toLowerCase()] ?? "application/octet-stream";
}

/** Directory used for a derivative type, relative to the repository root. */
export function cacheDirectoryFor(derivativeType) {
  switch (derivativeType) {
    case "thumbnail":
    case "contact_sheet":
      return path.join("cache", "thumbnails");
    case "proxy":
    case "transcode":
      return path.join("cache", "proxies");
    case "audio_proxy":
      return path.join("cache", "audio");
    case "waveform":
      return path.join("cache", "waveforms");
    default:
      return path.join("cache", "derived");
  }
}

/** True when the platform can host the toolchain at all; used for clear skip messaging in tests. */
export function platformSupportsDerivation() {
  return process.platform === "win32" || process.platform === "linux" || process.platform === "darwin";
}

export const MEDIA_KINDS = Object.freeze({ IMAGE: KIND_IMAGE, VIDEO: KIND_VIDEO, AUDIO: KIND_AUDIO });

/** Exposed for tests that need a scratch path without touching the repository. */
export function tempDirFor(prefix = "ren05-derive-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
