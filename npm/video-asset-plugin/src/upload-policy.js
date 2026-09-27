/**
 * REN-06: upload policy - the ONE place where upload limits are defined.
 *
 * Why a single module
 * -------------------
 * Before REN-06 the only upload limit was `MAX_STAGING_UPLOAD_BYTES` (100 MiB) inside
 * `service.uploadStagingFile`, checked AFTER the caller had already handed the whole file over as a
 * base64 string. That has three consequences this module exists to remove:
 *
 *   1. The limit was enforced by the SERVICE, not by the transport, so the bytes had already been
 *      buffered in memory (and in the JSON body) before anyone objected.
 *   2. There was no concurrency cap, no staging total, no disk floor, and no notion of an abandoned
 *      upload, because "upload" was a single synchronous call.
 *   3. Nothing stopped a future entry point from picking its own limit, so "the limit" was really
 *      "whichever code path you happened to use".
 *
 * Every limit below is enforced server-side. The client is told about them so it can pre-check, but a
 * client that ignores them is refused here rather than trusted.
 */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/**
 * Defaults. `maxFileBytes` is deliberately larger than the 100 MiB legacy constant and larger than
 * the 200 MiB acceptance fixture, because REN-06 is about accepting large files SAFELY - a limit
 * below the target size would "pass" the quota tests by refusing the legitimate case.
 */
export const DEFAULT_UPLOAD_POLICY = Object.freeze({
  enabled: true,
  maxFileBytes: 512 * MIB,
  maxConcurrentTransfers: 2,
  maxQueuedTransfers: 8,
  stagingTotalBytes: 4 * GIB,
  minFreeBytes: 512 * MIB,
  maxChunkBytes: 16 * MIB,
  sessionTtlMinutes: 720,
  quarantineUnknownTypes: true,
  allowedExtensions: [
    ".mp4", ".mov", ".m4v", ".webm", ".mkv",
    ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus",
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".svg",
    ".pdf", ".txt", ".md", ".json", ".csv", ".srt", ".vtt", ".zip"
  ]
});

/** Error carrying a stable code and an HTTP status, so every refusal is structured and greppable. */
export class UploadError extends Error {
  constructor(code, message, { status = 400, details = {} } = {}) {
    super(message);
    this.name = "UploadError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
  toJSON() {
    return { ok: false, code: this.code, error: this.message, details: this.details };
  }
}

function clampNumber(value, { min, max, fallback, label }) {
  if (value === undefined || value === null) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new UploadError("UPLOAD_CONFIG_INVALID", `${label} must be a number`, { details: { label, value } });
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

/**
 * Resolve the effective upload policy from plugin config.
 *
 * Values are CLAMPED to sane ranges rather than accepted verbatim: a config that sets the file limit
 * to 8 EiB or the concurrency to 0 should not silently disable a gate or produce an unusable service.
 * The clamp bounds are wide enough that no realistic deployment is affected.
 */
export function resolveUploadPolicy(pluginConfig = {}) {
  const raw = pluginConfig?.upload ?? {};
  const policy = {
    enabled: raw.enabled === undefined ? DEFAULT_UPLOAD_POLICY.enabled : raw.enabled !== false,
    maxFileBytes: clampNumber(raw.maxFileBytes, { min: MIB, max: 64 * GIB, fallback: DEFAULT_UPLOAD_POLICY.maxFileBytes, label: "upload.maxFileBytes" }),
    maxConcurrentTransfers: clampNumber(raw.maxConcurrentTransfers, { min: 1, max: 64, fallback: DEFAULT_UPLOAD_POLICY.maxConcurrentTransfers, label: "upload.maxConcurrentTransfers" }),
    maxQueuedTransfers: clampNumber(raw.maxQueuedTransfers, { min: 0, max: 4096, fallback: DEFAULT_UPLOAD_POLICY.maxQueuedTransfers, label: "upload.maxQueuedTransfers" }),
    stagingTotalBytes: clampNumber(raw.stagingTotalBytes, { min: MIB, max: 1024 * GIB, fallback: DEFAULT_UPLOAD_POLICY.stagingTotalBytes, label: "upload.stagingTotalBytes" }),
    minFreeBytes: clampNumber(raw.minFreeBytes, { min: 0, max: 512 * GIB, fallback: DEFAULT_UPLOAD_POLICY.minFreeBytes, label: "upload.minFreeBytes" }),
    maxChunkBytes: clampNumber(raw.maxChunkBytes, { min: 64 * 1024, max: 256 * MIB, fallback: DEFAULT_UPLOAD_POLICY.maxChunkBytes, label: "upload.maxChunkBytes" }),
    sessionTtlMinutes: clampNumber(raw.sessionTtlMinutes, { min: 1, max: 1440 * 7, fallback: DEFAULT_UPLOAD_POLICY.sessionTtlMinutes, label: "upload.sessionTtlMinutes" }),
    quarantineUnknownTypes: raw.quarantineUnknownTypes === undefined ? DEFAULT_UPLOAD_POLICY.quarantineUnknownTypes : raw.quarantineUnknownTypes !== false,
    allowedExtensions: Array.isArray(raw.allowedExtensions) && raw.allowedExtensions.length > 0
      ? raw.allowedExtensions.map((value) => String(value).toLowerCase())
      : [...DEFAULT_UPLOAD_POLICY.allowedExtensions]
  };
  return Object.freeze(policy);
}

/** Human-readable policy summary for the client adapter and the acceptance evidence. */
export function describeUploadPolicy(policy) {
  return {
    max_file_bytes: policy.maxFileBytes,
    max_concurrent_transfers: policy.maxConcurrentTransfers,
    max_queued_transfers: policy.maxQueuedTransfers,
    staging_total_bytes: policy.stagingTotalBytes,
    min_free_bytes: policy.minFreeBytes,
    max_chunk_bytes: policy.maxChunkBytes,
    session_ttl_minutes: policy.sessionTtlMinutes,
    quarantine_unknown_types: policy.quarantineUnknownTypes,
    allowed_extension_count: policy.allowedExtensions.length
  };
}
