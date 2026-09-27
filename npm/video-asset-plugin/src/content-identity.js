/**
 * REN-06: content identity - what the bytes ARE, not what the client says they are.
 *
 * The audit's finding was that a "video" could be a 32-byte stub and a "thumbnail" could be a copy of
 * its source, because the pipeline trusted names and extensions. The same failure applies to uploads:
 * a client can declare `movie.mp4` and send anything, and if the only check is the extension then the
 * catalog records a video that no decoder can open.
 *
 * This module answers two questions separately:
 *   * What does the DECLARATION claim? (extension + declared MIME)
 *   * What do the BYTES look like? (magic numbers, sniffed at the start of the stream)
 *
 * and then classifies the upload as consistent, mismatched, or unknown. Unknown content is not
 * silently accepted and not silently deleted: it is QUARANTINED so a human can look at it, because
 * "unknown" is exactly the case where automatically destroying evidence is worst.
 *
 * On scanning: `scanUpload` is an INTERFACE with no scanner behind it. It reports
 * `verdict: "not-scanned"` and `scanner_available: false`. It must never report a clean scan, because
 * a false "clean" is worse than an honest "not scanned".
 */

import { UploadError } from "./upload-policy.js";

/**
 * Magic-number table. Each entry: offset, bytes, and what it identifies.
 * Deliberately small and exact - a loose signature table that guesses is how a PDF gets called a video.
 */
const SIGNATURES = [
  { name: "mp4", offset: 4, bytes: Buffer.from("ftyp"), media_type: "video", format_family: "mp4", mime: "video/mp4", extensions: [".mp4", ".m4v", ".mov"] },
  { name: "matroska", offset: 0, bytes: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), media_type: "video", format_family: "matroska", mime: "video/x-matroska", extensions: [".mkv", ".webm"] },
  { name: "png", offset: 0, bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), media_type: "image", format_family: "png", mime: "image/png", extensions: [".png"] },
  { name: "jpeg", offset: 0, bytes: Buffer.from([0xff, 0xd8, 0xff]), media_type: "image", format_family: "jpeg", mime: "image/jpeg", extensions: [".jpg", ".jpeg"] },
  { name: "gif", offset: 0, bytes: Buffer.from("GIF8"), media_type: "image", format_family: "gif", mime: "image/gif", extensions: [".gif"] },
  { name: "webp", offset: 8, bytes: Buffer.from("WEBP"), media_type: "image", format_family: "webp", mime: "image/webp", extensions: [".webp"] },
  { name: "bmp", offset: 0, bytes: Buffer.from("BM"), media_type: "image", format_family: "bmp", mime: "image/bmp", extensions: [".bmp"] },
  { name: "tiff", offset: 0, bytes: Buffer.from([0x49, 0x49, 0x2a, 0x00]), media_type: "image", format_family: "tiff", mime: "image/tiff", extensions: [".tif", ".tiff"] },
  { name: "tiff-be", offset: 0, bytes: Buffer.from([0x4d, 0x4d, 0x00, 0x2a]), media_type: "image", format_family: "tiff", mime: "image/tiff", extensions: [".tif", ".tiff"] },
  { name: "wav", offset: 8, bytes: Buffer.from("WAVE"), media_type: "audio", format_family: "wav", mime: "audio/wav", extensions: [".wav"] },
  { name: "flac", offset: 0, bytes: Buffer.from("fLaC"), media_type: "audio", format_family: "flac", mime: "audio/flac", extensions: [".flac"] },
  { name: "ogg", offset: 0, bytes: Buffer.from("OggS"), media_type: "audio", format_family: "ogg", mime: "audio/ogg", extensions: [".ogg", ".opus"] },
  { name: "id3", offset: 0, bytes: Buffer.from("ID3"), media_type: "audio", format_family: "mp3", mime: "audio/mpeg", extensions: [".mp3"] },
  { name: "pdf", offset: 0, bytes: Buffer.from("%PDF"), media_type: "document", format_family: "pdf", mime: "application/pdf", extensions: [".pdf"] },
  { name: "zip", offset: 0, bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]), media_type: "archive", format_family: "zip", mime: "application/zip", extensions: [".zip"] }
];

/** Extensions whose content is text, so a magic-number check would always say "unknown". */
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".json", ".csv", ".srt", ".vtt", ".xml", ".svg"]);

/** Is this buffer decodable as text? Used only for the text-family extensions. */
function looksLikeText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.length === 0) return false;
  for (const byte of sample) {
    if (byte === 0) return false; // NUL byte: not text
    if (byte < 9 || (byte > 13 && byte < 32)) return false; // control characters other than tab/newline
  }
  return true;
}

/**
 * Identify a byte sample. Returns `null` when nothing matches - callers must treat that as unknown,
 * never as "fine".
 */
export function sniffMediaType(sample, { extension = "" } = {}) {
  if (!sample || sample.length === 0) return null;
  for (const signature of SIGNATURES) {
    const start = signature.offset;
    const end = start + signature.bytes.length;
    if (sample.length < end) continue;
    if (sample.subarray(start, end).equals(signature.bytes)) {
      return { name: signature.name, media_type: signature.media_type, format_family: signature.format_family, mime: signature.mime, extensions: signature.extensions };
    }
  }
  // A `ftyp` box can also sit at offset 0 for a few fragmented files; check that variant too rather
  // than reporting a real MP4 as unknown.
  if (sample.length >= 8 && sample.subarray(0, 4).toString("latin1") === "ftyp") {
    const mp4 = SIGNATURES.find((s) => s.name === "mp4");
    return { name: mp4.name, media_type: mp4.media_type, format_family: mp4.format_family, mime: mp4.mime, extensions: mp4.extensions };
  }
  if (TEXT_EXTENSIONS.has(String(extension).toLowerCase()) && looksLikeText(sample)) {
    return { name: "text", media_type: "document", format_family: "text", mime: "text/plain", extensions: [...TEXT_EXTENSIONS] };
  }
  return null;
}

export function extensionOf(fileName) {
  const name = String(fileName ?? "");
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot).toLowerCase();
}

/**
 * Decide whether a declared file may proceed.
 *
 * Outcomes:
 *   accept      - bytes agree with the declaration (or the type is text-family and the bytes are text)
 *   mismatch    - bytes are a KNOWN type that the declaration contradicts, or the extension is not
 *                 allowed at all; refused, because accepting this would put a mislabelled object in
 *                 the catalog
 *   unknown     - nothing recognisable; quarantined rather than refused or ingested
 */
export function classifyContent({ file_name, declared_mime = null, sample, policy }) {
  const extension = extensionOf(file_name);
  if (!file_name || extension === "") {
    return { decision: "mismatch", code: "UPLOAD_EXTENSION_MISSING", reason: "the file name has no extension, so the declared type can not be checked" };
  }
  if (!policy.allowedExtensions.includes(extension)) {
    return { decision: "mismatch", code: "UPLOAD_EXTENSION_NOT_ALLOWED", reason: `extension ${extension} is not in the allowed list`, extension };
  }

  const sniffed = sniffMediaType(sample, { extension });
  if (!sniffed) {
    return { decision: "unknown", code: "UPLOAD_CONTENT_UNKNOWN", reason: "the leading bytes match no known media signature", extension, declared_mime };
  }

  if (!sniffed.extensions.includes(extension)) {
    // The bytes are a known type, but not the one the name claims. A `.mp4` full of PNG bytes is a
    // mislabelled file, and the honest answer is to refuse rather than to relabel it silently.
    return {
      decision: "mismatch",
      code: "UPLOAD_CONTENT_MISMATCH",
      reason: `the bytes look like ${sniffed.name} (${sniffed.mime}) but the name claims ${extension}`,
      extension,
      declared_mime,
      detected_mime: sniffed.mime,
      detected_format: sniffed.format_family
    };
  }

  if (declared_mime) {
    const declared = String(declared_mime).toLowerCase().split(";")[0].trim();
    // Only reject when the declared MIME names a DIFFERENT known family; browsers send
    // `application/octet-stream` for large binaries and that must not be treated as a contradiction.
    const neutral = declared === "application/octet-stream" || declared === "" || declared === "binary/octet-stream";
    if (!neutral && declared !== sniffed.mime && !declared.startsWith(`${sniffed.media_type}/`)) {
      return {
        decision: "mismatch",
        code: "UPLOAD_MIME_MISMATCH",
        reason: `declared content-type ${declared} contradicts the detected ${sniffed.mime}`,
        extension,
        declared_mime: declared,
        detected_mime: sniffed.mime
      };
    }
  }

  return {
    decision: "accept",
    extension,
    declared_mime,
    detected_mime: sniffed.mime,
    detected_format: sniffed.format_family,
    detected_media_type: sniffed.media_type
  };
}

/**
 * Scanning interface.
 *
 * There is NO scanner installed. This function exists so the upload pipeline has the seam where a
 * scanner would be called, and so the API can say honestly that scanning has not happened. It never
 * returns a clean verdict.
 */
export function scanUpload({ upload_id, staging_path, declared_mime = null } = {}) {
  return {
    upload_id: upload_id ?? null,
    staging_path: staging_path ?? null,
    scanner_available: false,
    scanner: null,
    verdict: "not-scanned",
    declared_mime,
    note: "No malware scanner is installed in this deployment. The upload has NOT been scanned; this interface exists so a scanner can be wired in without changing the upload path."
  };
}

/** Turn a classifyContent outcome into the refusal the caller sees. */
export function assertContentAcceptable({ file_name, declared_mime, sample, policy }) {
  const result = classifyContent({ file_name, declared_mime, sample, policy });
  if (result.decision === "accept") return result;
  if (result.decision === "unknown" && policy.quarantineUnknownTypes) {
    // NotFound-style refusal is NOT used here: quarantine is a deliberate state, and the caller needs
    // to know the bytes were kept rather than destroyed.
    throw new UploadError(result.code, result.reason, {
      status: 415,
      details: { decision: "quarantined", quarantine: true, detected: null, extension: result.extension ?? null }
    });
  }
  throw new UploadError(result.code, result.reason, {
    status: 415,
    details: {
      decision: result.decision,
      extension: result.extension ?? null,
      declared_mime: result.declared_mime ?? null,
      detected_mime: result.detected_mime ?? null,
      detected_format: result.detected_format ?? null
    }
  });
}
