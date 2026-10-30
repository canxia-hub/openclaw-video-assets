// REN-05 / src/protected-stream.js
//
// HTTP streaming for protected media: byte ranges, HEAD, If-Range, and an explicit
// inline-vs-download split.
//
// WHY THIS EXISTS
// ---------------
// The accepted baseline streams a file with `content-length` + `createReadStream().pipe(res)` and
// nothing else: no `accept-ranges`, no 206, no 416, no `If-Range`. Browsers seek video by issuing a
// range request, so a `<video>` element in front of that route can not scrub - and the whole file
// is re-sent for any position change. Separately, `/file/` is hard-wired to
// `content-disposition: attachment`, so the original media is deliberately not playable inline.
//
// WHAT THIS MODULE DOES
//   * Parses `Range` (including suffix and open-ended forms) and answers 206 with a correct
//     `content-range`, or 416 with `content-range: bytes */<size>` when unsatisfiable.
//   * Honours `If-Range` (strong ETag or an exact Last-Modified) and falls back to a full 200 when
//     the representation changed, which is what stops a seek from assembling a spliced file.
//   * Answers HEAD with the same headers and no body.
//   * Keeps the content-addressed ETag (`sha256`) stable, so a client can resume safely.
//
// WHAT IT DOES NOT DO
//   It does not authenticate, and it does not decide which file may be served. The caller passes a
//   resolved descriptor only after the existing security gate has run, and this module never widens
//   access. Errors carry a stable `code` and a message that names the route - never a filesystem
//   path, so a refusal can not be used to enumerate the object store layout.

import fs from "node:fs";
import { pipeline } from "node:stream/promises";

export const DISPOSITION_INLINE = "inline";
export const DISPOSITION_ATTACHMENT = "attachment";

/**
 * Parse a single-range `Range` header against a known resource size.
 *
 * Returns one of:
 *   { kind: "none" }                      no usable Range header
 *   { kind: "unsatisfiable", ... }        a syntactically valid range that can not be served
 *   { kind: "range", start, end, length } a satisfiable byte range
 *
 * Multi-range requests (`bytes=0-1,5-6`) are deliberately NOT served as multipart/byteranges: the
 * honest answer is the full representation, which the caller sends as 200. Silently serving only
 * the first range would give a client bytes it did not ask for under a 206 status.
 */
export function parseRangeHeader(headerValue, size) {
  if (!headerValue || typeof headerValue !== "string") return { kind: "none", reason: "absent" };
  const value = headerValue.trim();
  const match = /^bytes=(.+)$/i.exec(value);
  if (!match) return { kind: "none", reason: "not-a-bytes-range" };
  const specs = match[1].split(",").map((s) => s.trim()).filter(Boolean);
  if (specs.length === 0) return { kind: "none", reason: "empty-range-set" };
  if (specs.length > 1) return { kind: "none", reason: "multi-range-not-supported" };

  const spec = specs[0];
  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (!parts) return { kind: "unsatisfiable", reason: "malformed-range", raw: spec };
  const [, rawStart, rawEnd] = parts;
  if (rawStart === "" && rawEnd === "") return { kind: "unsatisfiable", reason: "empty-range", raw: spec };

  // Suffix form: `bytes=-N` means the LAST N bytes.
  if (rawStart === "") {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { kind: "unsatisfiable", reason: "zero-length-suffix", raw: spec };
    if (size === 0) return { kind: "unsatisfiable", reason: "empty-resource", raw: spec };
    const start = Math.max(0, size - suffixLength);
    return { kind: "range", start, end: size - 1, length: size - start, raw: spec, form: "suffix" };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start < 0) return { kind: "unsatisfiable", reason: "bad-start", raw: spec };
  // A start beyond the end is unsatisfiable (416). This is the case the acceptance calls out.
  if (start >= size) return { kind: "unsatisfiable", reason: "start-beyond-end", raw: spec, start, size };

  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(end) || end < start) return { kind: "unsatisfiable", reason: "end-before-start", raw: spec };
  return { kind: "range", start, end, length: end - start + 1, raw: spec, form: rawEnd === "" ? "open-ended" : "closed" };
}

/**
 * HTTP-date has ONE-SECOND resolution. The server emits Last-Modified via toUTCString(), which
 * truncates the sub-second part of the file mtime; a client can only ever echo that truncated
 * value back. Comparing the echoed date against the full millisecond mtime therefore reported
 * "changed" for every file whose mtime had a non-zero millisecond component — the range request
 * was downgraded to a full 200 even though the representation had not changed at all.
 *
 * Comparison is done at the precision the protocol actually carries: seconds, truncated (not
 * rounded), so the date the server itself emitted for a file always compares equal to that file.
 */
function httpDateToSeconds(value) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : Math.floor(time / 1000);
}

/**
 * Decide whether an `If-Range` header still matches the current representation.
 *
 * A STRONG validator (our content-addressed ETag) must match exactly.
 * A WEAK validator never satisfies If-Range: `W/"..."` does not identify a byte-identical
 *   representation, so the only safe answer is "changed", which downgrades the response to a full
 *   200 rather than splicing bytes from two different representations.
 * A DATE validator is compared at HTTP-date precision (seconds) against Last-Modified.
 * Anything unparseable, or absent, means "assume changed".
 */
export function ifRangeMatches(ifRangeValue, { etag, lastModified }) {
  if (!ifRangeValue) return true;
  const value = String(ifRangeValue).trim();
  if (!value) return true;

  if (value.startsWith("W/")) return false;
  if (value.startsWith('"')) return Boolean(etag) && value === etag;

  const sentSeconds = httpDateToSeconds(value);
  if (sentSeconds === null) return false;
  if (lastModified === undefined || lastModified === null) return false;
  const currentSeconds = httpDateToSeconds(lastModified);
  if (currentSeconds === null) return false;
  return sentSeconds === currentSeconds;
}

function contentDisposition(disposition, fileName) {
  const safe = String(fileName ?? "download").replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "download";
  // `inline` still needs a filename for "save as", and both forms are quoted so a comma or space in
  // the name can not break the header.
  return `${disposition === DISPOSITION_ATTACHMENT ? "attachment" : "inline"}; filename="${safe}"`;
}

/**
 * Set the cache/validator headers shared by every media response.
 * `no-store` is kept: these are access-controlled objects behind a session, and a shared cache
 * holding them would be an authorization leak.
 */
function applyCommonHeaders(res, descriptor) {
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("content-type", descriptor.mime_type || "application/octet-stream");
  if (descriptor.etag) res.setHeader("etag", descriptor.etag);
  if (descriptor.last_modified) res.setHeader("last-modified", new Date(descriptor.last_modified).toUTCString());
  for (const [key, value] of Object.entries(descriptor.headers ?? {})) {
    if (value !== undefined && value !== null) res.setHeader(key, String(value));
  }
}

/** Descriptor metadata echoed back so a client can correlate a response with a catalog row. */
function descriptorHeaders(descriptor) {
  return {
    ...(descriptor.asset_id ? { "x-openclaw-asset-id": descriptor.asset_id } : {}),
    ...(descriptor.asset_version_id ? { "x-openclaw-asset-version-id": descriptor.asset_version_id } : {}),
    ...(descriptor.derived_file_id ? { "x-openclaw-derived-file-id": descriptor.derived_file_id } : {}),
    ...(descriptor.derivative_type ? { "x-openclaw-derivative-type": descriptor.derivative_type } : {}),
    ...(descriptor.sha256 ? { "x-openclaw-content-sha256": descriptor.sha256 } : {})
  };
}

/**
 * Serve a resolved media descriptor over HTTP with range support.
 *
 * @param {object} req
 * @param {object} res
 * @param {object} descriptor  { file_path, mime_type, file_name, sha256, asset_id, asset_version_id,
 *                               derived_file_id, derivative_type, disposition }
 * @returns {Promise<{ status: number, bytes_sent: number, ranged: boolean, disposition: string }>}
 */
export async function sendMedia(req, res, descriptor) {
  const disposition = descriptor.disposition === DISPOSITION_ATTACHMENT ? DISPOSITION_ATTACHMENT : DISPOSITION_INLINE;
  const stat = await fs.promises.stat(descriptor.file_path).catch(() => null);
  if (!stat || !stat.isFile()) {
    return sendStreamError(res, 404, "MEDIA_OBJECT_MISSING", "the media object is missing");
  }

  const etag = descriptor.sha256 ? `"sha256:${descriptor.sha256}"` : null;
  const lastModified = stat.mtimeMs;
  const common = { ...descriptor, etag, last_modified: lastModified, headers: { ...descriptorHeaders(descriptor), "content-disposition": contentDisposition(disposition, descriptor.file_name) } };

  const ifRange = req.headers["if-range"];
  const rangeHeader = req.headers.range;
  // When If-Range does not match, the range is ignored entirely and the full representation is
  // returned - that is the RFC behaviour and it is what prevents a spliced response.
  const rangeUsable = !ifRange || ifRangeMatches(ifRange, { etag, lastModified });
  const parsed = rangeUsable ? parseRangeHeader(rangeHeader, stat.size) : { kind: "none", reason: "if-range-mismatch" };

  if (parsed.kind === "unsatisfiable") {
    applyCommonHeaders(res, common);
    res.statusCode = 416;
    res.setHeader("content-range", `bytes */${stat.size}`);
    res.setHeader("content-length", "0");
    res.end();
    return { status: 416, bytes_sent: 0, ranged: false, disposition, reason: parsed.reason };
  }

  if (parsed.kind === "range") {
    applyCommonHeaders(res, common);
    res.statusCode = 206;
    res.setHeader("content-range", `bytes ${parsed.start}-${parsed.end}/${stat.size}`);
    res.setHeader("content-length", String(parsed.length));
    if (req.method === "HEAD") {
      res.end();
      return { status: 206, bytes_sent: 0, ranged: true, disposition, start: parsed.start, end: parsed.end, total: stat.size };
    }
    await streamRange(res, descriptor.file_path, parsed.start, parsed.end);
    return { status: 206, bytes_sent: parsed.length, ranged: true, disposition, start: parsed.start, end: parsed.end, total: stat.size };
  }

  applyCommonHeaders(res, common);
  res.statusCode = 200;
  res.setHeader("content-length", String(stat.size));
  if (req.method === "HEAD") {
    res.end();
    return { status: 200, bytes_sent: 0, ranged: false, disposition, total: stat.size };
  }
  await pipeline(fs.createReadStream(descriptor.file_path), res);
  return { status: 200, bytes_sent: stat.size, ranged: false, disposition, total: stat.size };
}

/** Stream a closed byte window. The stream is bounded, so a range request can not read past `end`. */
async function streamRange(res, filePath, start, end) {
  await pipeline(fs.createReadStream(filePath, { start, end }), res);
}

/**
 * Error envelope for stream routes. The message is a fixed, route-level sentence: it deliberately
 * carries no filesystem path, so a caller can not use refusals to probe the store layout.
 */
export function sendStreamError(res, status, code, message) {
  if (res.headersSent) {
    res.end();
    return { status, code, bytes_sent: 0 };
  }
  const body = JSON.stringify({ ok: false, error: message, code });
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(Buffer.byteLength(body)));
  res.setHeader("cache-control", "no-store");
  res.end(body);
  return { status, code, bytes_sent: 0 };
}

/** Build the descriptor for a version or derived-file row resolved by the service. */
export function descriptorFromResolved(file, { disposition = DISPOSITION_INLINE } = {}) {
  return {
    file_path: file.file_path,
    mime_type: file.mime_type,
    file_name: file.file_name,
    sha256: file.sha256,
    asset_id: file.asset_id,
    asset_version_id: file.asset_version_id,
    derived_file_id: file.derived_file_id,
    derivative_type: file.derivative_type,
    disposition
  };
}
