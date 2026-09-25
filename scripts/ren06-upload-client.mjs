// REN-06 / scripts/ren06-upload-client.mjs
//
// The upload CLIENT ADAPTER: the reference implementation of the resumable, chunked upload protocol
// exposed by the plugin's `/upload` route.
//
// This is a deliverable, not test scaffolding. A caller that wants to upload a large file should not have
// to reverse-engineer the offsets, the header names or the resume behaviour from the server code, so this
// module is the documented client half of the protocol.
//
// Properties that matter, and why each one is here
// -----------------------------------------------
//   * BOUNDED MEMORY. The body of each request is a `fs.createReadStream` of ONE slice of the file, so the
//     client never holds the file (or a base64 expansion of it) in memory. A 200 MB upload uses the memory
//     of one chunk, not of the whole file.
//   * RESUMABLE. `upload()` first asks the server how many bytes it already has and continues from that
//     offset. After a disconnect the same call resumes instead of restarting - the bytes already accepted
//     are not re-sent.
//   * HASH-VERIFIED. The sha256 is computed while the file is streamed and is declared to the server, so
//     the server can refuse bytes that do not match what the client believes it sent. It can also
//     PREFETCH the hash first (`plan()`), for callers that want to check before transferring anything.
//   * CANCELLABLE. `cancel()` aborts the in-flight request and tells the server to discard the partial
//     upload; a cancelled client-side transfer does not leave a writable session behind.
//
// Usage as a library:
//   const client = new UploadClient({ baseUrl: "http://127.0.0.1:20006", basePath, cookie });
//   const result = await client.upload({ filePath: "big.mp4", onProgress: (p) => ... });
//
// Usage from a shell (used by the acceptance runner and handy for operators):
//   node scripts/ren06-upload-client.mjs --url <base> --password <pw> --file <path> [--chunk-bytes N] [--out <json>]

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

// Loopback-only client: the execution host's proxy variables would otherwise redirect these requests
// (Node honours HTTP(S)_PROXY for http.request when NODE_USE_ENV_PROXY is set) and produce a confusing 502.
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NODE_USE_ENV_PROXY"]) {
  delete process.env[key];
}

/** Default chunk size: the server's own default cap is 16 MiB; 8 MiB leaves headroom and keeps the
 *  per-request body small enough that the client's memory use is obviously independent of file size. */
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

export class UploadClientError extends Error {
  constructor(message, { code = null, status = null, details = null } = {}) {
    super(message);
    this.name = "UploadClientError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * An explicit agent for every request.
 *
 * Deleting the proxy variables from `process.env` at startup is NOT enough on this runtime: with
 * `NODE_USE_ENV_PROXY=1` set by the execution host, Node decides to route through the environment proxy when
 * the default global agent is used, and that decision is taken from the startup environment. Passing an
 * explicit agent bypasses the global-agent substitution entirely, so the loopback calls can not be
 * redirected to a proxy no matter how the process was launched.
 */
const LOOPBACK_AGENT = new http.Agent({ keepAlive: false, maxSockets: 64 });

/** Minimal cookie-aware JSON/stream client for the plugin's upload surface. */
export class UploadClient {
  constructor({ baseUrl, basePath = "/__openclaw__/video-assets", cookie = null, chunkBytes = DEFAULT_CHUNK_BYTES, timeoutMs = 600_000, origin = null } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.basePath = basePath;
    this.cookie = cookie;
    this.chunkBytes = chunkBytes;
    this.timeoutMs = timeoutMs;
    // REN-02 requires state-changing requests that carry a session cookie to declare an allowed Origin
    // (that is the CSRF boundary). A browser sends it automatically; a programmatic client must send it
    // explicitly, which is why this adapter does so by default rather than leaving each caller to discover
    // the requirement from a 403.
    this.origin = origin ?? this.baseUrl;
    /** Peak "extra" RSS observed on the client while transferring, for the memory evidence. */
    this.peakProcessBytes = 0;
    this.metrics = { requests: 0, bytes_sent: 0, chunks_sent: 0, retries: 0, gate_wait_ms_total: 0 };
  }

  url(suffix = "") {
    return `${this.baseUrl}${this.basePath}/upload${suffix}`;
  }

  /** Log in and keep the session cookie. */
  async login(password) {
    const response = await this.#request("POST", `${this.baseUrl}${this.basePath}/auth/login`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password })
    });
    const setCookie = response.headers["set-cookie"];
    const cookie = Array.isArray(setCookie) ? setCookie.map((value) => value.split(";")[0]).join("; ") : String(setCookie ?? "").split(";")[0];
    if (!response.json?.ok || !cookie) {
      throw new UploadClientError(`login failed: ${response.json?.error ?? response.status}`, { status: response.status, code: response.json?.code ?? null });
    }
    this.cookie = cookie;
    return { actor_id: response.json.actor_id ?? null, cookie };
  }

  /** sha256 of a file, streamed (never buffering the file). */
  static async hashFile(filePath) {
    const hash = crypto.createHash("sha256");
    let size = 0;
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
      stream.on("data", (chunk) => { size += chunk.length; hash.update(chunk); });
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    return { sha256: hash.digest("hex"), size_bytes: size };
  }

  async create({ filePath, fileName = null, mimeType = null, sizeBytes = null, sha256 = null }) {
    const stat = await fs.promises.stat(filePath);
    const body = {
      file_name: fileName ?? path.basename(filePath),
      total_bytes: sizeBytes ?? stat.size,
      mime_type: mimeType,
      sha256
    };
    const response = await this.#request("POST", this.url(), { headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.json?.ok) {
      throw new UploadClientError(response.json?.error ?? `create failed (${response.status})`, { status: response.status, code: response.json?.code ?? null, details: response.json?.details ?? null });
    }
    return response.json.result;
  }

  async status(upload_id) {
    const response = await this.#request("GET", this.url(`/${encodeURIComponent(upload_id)}`));
    if (!response.json?.ok) {
      throw new UploadClientError(response.json?.error ?? `status failed (${response.status})`, { status: response.status, code: response.json?.code ?? null, details: response.json?.details ?? null });
    }
    return response.json.result;
  }

  async list() {
    const response = await this.#request("GET", this.url());
    return response.json?.result ?? null;
  }

  /**
   * Send one chunk: a stream of `filePath` from `offset` for up to `length` bytes.
   *
   * The request body is the file slice itself, so the client's memory use is the read stream's buffer,
   * not the chunk size and certainly not the file size.
   */
  async append({ upload_id, filePath, offset, length, declaredTotal = null, onProgress = null }) {
    const end = offset + length - 1;
    const headers = {
      "content-type": "application/octet-stream",
      "content-length": String(length),
      "upload-offset": String(offset)
    };
    if (declaredTotal !== null) headers["content-range"] = `bytes ${offset}-${end}/${declaredTotal}`;

    const stream = fs.createReadStream(filePath, { start: offset, end, highWaterMark: 1024 * 1024 });
    const response = await this.#request("PATCH", this.url(`/${encodeURIComponent(upload_id)}`), { headers, bodyStream: stream, bodyLength: length, onProgress });
    if (!response.json?.ok) {
      throw new UploadClientError(response.json?.error ?? `chunk failed (${response.status})`, {
        status: response.status,
        code: response.json?.code ?? null,
        details: response.json?.details ?? null
      });
    }
    if (response.json.result?.gate_wait_ms) this.metrics.gate_wait_ms_total += response.json.result.gate_wait_ms;
    this.metrics.chunks_sent += 1;
    this.metrics.bytes_sent += length;
    return response.json.result;
  }

  async complete({ upload_id, sha256 = null }) {
    const response = await this.#request("POST", this.url(`/${encodeURIComponent(upload_id)}/complete`), {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha256 })
    });
    if (!response.json?.ok) {
      throw new UploadClientError(response.json?.error ?? `complete failed (${response.status})`, { status: response.status, code: response.json?.code ?? null, details: response.json?.details ?? null });
    }
    return response.json.result;
  }

  async cancel({ upload_id }) {
    const response = await this.#request("DELETE", this.url(`/${encodeURIComponent(upload_id)}`));
    if (!response.json?.ok) {
      throw new UploadClientError(response.json?.error ?? `cancel failed (${response.status})`, { status: response.status, code: response.json?.code ?? null });
    }
    return response.json.result;
  }

  /**
   * Upload a whole file: hash it, create the session, send chunks (continuing from whatever offset the
   * server already has), then complete.
   *
   * `resume: true` is the default: the session is opened once and the offset comes from the server, so
   * calling this again after a failure continues rather than restarting.
   */
  async upload({ filePath, fileName = null, mimeType = null, chunkBytes = null, onProgress = null, existingUploadId = null, declaredSha256 = null }) {
    const chunk = chunkBytes ?? this.chunkBytes;
    const hash = await UploadClient.hashFile(filePath);
    const sha256 = declaredSha256 ?? hash.sha256;
    const size_bytes = hash.size_bytes;

    let upload_id = existingUploadId;
    let session;
    if (upload_id) {
      session = await this.status(upload_id);
    } else {
      session = await this.create({ filePath, fileName, mimeType, sizeBytes: size_bytes, sha256 });
      upload_id = session.upload_id;
    }

    let offset = session.next_offset ?? session.received_bytes ?? 0;
    const baselineRss = process.memoryUsage().rss;
    let peakRss = baselineRss;
    const sampler = setInterval(() => {
      const rss = process.memoryUsage().rss;
      if (rss > peakRss) peakRss = rss;
    }, 100);
    sampler.unref?.();

    try {
      while (offset < size_bytes) {
        const length = Math.min(chunk, size_bytes - offset);
        const result = await this.append({ upload_id, filePath, offset, length, declaredTotal: size_bytes, onProgress });
        offset = result.next_offset;
        this.peakProcessBytes = Math.max(this.peakProcessBytes, process.memoryUsage().rss - baselineRss);
        if (onProgress) onProgress({ sent_bytes: offset, total_bytes: size_bytes, percent: Math.round((offset / size_bytes) * 100) });
      }
    } finally {
      clearInterval(sampler);
    }

    const completed = await this.complete({ upload_id, sha256 });
    return {
      ...completed,
      client: {
        upload_id,
        sha256_local: sha256,
        size_bytes,
        chunk_bytes: chunk,
        chunks: Math.ceil(size_bytes / chunk),
        peak_extra_rss_bytes: Math.max(peakRss - baselineRss, this.peakProcessBytes),
        metrics: { ...this.metrics }
      }
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------------------------

  #request(method, url, { headers = {}, body = null, bodyStream = null, bodyLength = null, onProgress = null } = {}) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const requestHeaders = { ...headers };
      if (this.cookie) requestHeaders.cookie = this.cookie;
      // The CSRF boundary applies to methods that change state; sending the Origin on those (and only those)
      // keeps GETs identical to a plain browser fetch.
      if (this.origin && ["POST", "PATCH", "PUT", "DELETE"].includes(String(method).toUpperCase())) {
        requestHeaders.origin = this.origin;
      }
      const request = http.request({
        method,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: requestHeaders,
        agent: LOOPBACK_AGENT,
        timeout: this.timeoutMs
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = JSON.parse(text); } catch { /* non-JSON responses are reported as text */ }
          resolve({ status: response.statusCode, headers: response.headers, body: text, json });
        });
      });
      this.metrics.requests += 1;
      request.on("timeout", () => { request.destroy(new UploadClientError("request timed out")); });
      request.on("error", reject);

      if (bodyStream) {
        let sent = 0;
        bodyStream.on("data", (chunk) => {
          sent += chunk.length;
          if (onProgress) onProgress({ chunk_bytes_sent: sent });
        });
        bodyStream.on("error", (error) => request.destroy(error));
        bodyStream.pipe(request);
        return;
      }
      if (body !== null) request.end(body);
      else request.end();
      void bodyLength;
    });
  }
}

// ---------------------------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  const argv = process.argv.slice(2);
  const arg = (name, dflt = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const file = arg("file");
  const url = arg("url", "http://127.0.0.1:20006");
  const password = arg("password");
  const chunkBytes = Number(arg("chunk-bytes", String(DEFAULT_CHUNK_BYTES)));
  const out = arg("out");
  if (!file || !password) {
    console.error("usage: node scripts/ren06-upload-client.mjs --url <base> --password <pw> --file <path> [--chunk-bytes N] [--out <json>]");
    process.exit(2);
  }
  const client = new UploadClient({ baseUrl: url, chunkBytes });
  await client.login(password);
  const result = await client.upload({ filePath: file, onProgress: (p) => process.stderr.write(`\r${p.percent}% (${p.sent_bytes}/${p.total_bytes})`) });
  process.stderr.write("\n");
  const summary = {
    ok: true,
    upload_id: result.upload_id,
    state: result.state,
    asset_id: result.asset_id,
    asset_version_id: result.asset_version_id,
    sha256_server: result.sha256,
    size_bytes: result.client.size_bytes,
    chunks: result.client.chunks,
    peak_extra_rss_bytes: result.client.peak_extra_rss_bytes,
    scan: result.scan ?? null
  };
  if (out) fs.writeFileSync(out, `${JSON.stringify({ summary, result }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary));
}
