/**
 * REN-06: upload sessions and staging lifecycle.
 *
 * The upload path is a state machine, persisted, because an upload that spans several requests (and
 * possibly a server restart) has to be answerable afterwards: who started it, how many bytes arrived,
 * what it turned out to be, which asset it became - or why it never became one.
 *
 * States
 * ------
 *   pending      session created, no bytes yet
 *   uploading    bytes are arriving
 *   staged       all declared bytes are on disk and the hash matches
 *   completed    ingested as an asset; the staged copy keeps its binding to that asset
 *   quarantined  the bytes are known-to-be-wrong or unrecognisable; KEPT for inspection, never ingested
 *   failed       refused or broken (over quota, low disk, missing file, hash mismatch)
 *   cancelled    the client cancelled it
 *   expired      the session aged out while still incomplete
 *
 * Three rules that are deliberately not negotiable here:
 *
 *   1. NO AGE-BASED DELETION. Nothing in this module deletes a file because it is old. Historical
 *      staging files get an ownership manifest; a human decides what happens to them. `expired` marks
 *      a session, it does not destroy bytes.
 *   2. NO PHANTOM ASSETS. An asset row is created only after the bytes are complete, hashed and
 *      classified. Every failure path leaves the session row explaining itself and creates no asset.
 *   3. EVERY STAGED BYTE HAS AN OWNER. A temporary file always belongs to a session row that names its
 *      actor, or it is surfaced by the orphan scan as unattributed - which is a finding, not a
 *      cleanup instruction.
 *
 * The hash is computed by STREAMING the temporary file at completion rather than accumulating bytes
 * in memory or keeping incremental hash state across requests. That costs one extra read pass and buys
 * two things: completion is safe after a restart, and peak memory does not depend on file size.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { UploadError } from "./upload-policy.js";
import { classifyContent } from "./content-identity.js";

const SAMPLE_BYTES = 64 * 1024; // enough for every signature in content-identity.js
// The repository layout owns these paths (see the ROOT_KEYS table in service.js): staging is
// `asset-repo/staging`, NOT `<root>/asset-staging`. Getting this wrong staged files outside the root key the
// service is allowed to read, so `ingestAsset` would refuse them and the ownership manifest would scan a
// directory nothing writes to. The layout strings are repeated here because this module is given only the
// root; the acceptance run asserts the staged file is inside the service's own staging root.
const STAGING_ROOT_RELATIVE = "asset-repo/staging";
const UPLOAD_TEMP_DIR = "asset-repo/staging/.uploads";
const QUARANTINE_DIR = "asset-repo/staging/.quarantine";

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** Keep the client's name, but never let it escape the directory it is written into. */
export function sanitizeUploadName(fileName) {
  const base = path.basename(String(fileName ?? "").replace(/\\/g, "/"));
  const cleaned = base.replace(/[^\w.\-() ]+/g, "_").replace(/^\.+/, "_").slice(0, 180);
  return cleaned === "" ? "upload.bin" : cleaned;
}

async function freeBytesAt(targetPath) {
  const stats = await fs.promises.statfs(targetPath);
  return Number(stats.bavail) * Number(stats.bsize);
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  let size = 0;
  // Streaming: this is the whole point - a 200 MiB file must not need 200 MiB of RSS.
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    stream.on("data", (chunk) => { size += chunk.length; hash.update(chunk); });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { sha256: hash.digest("hex"), size_bytes: size };
}

async function readSample(filePath, length = SAMPLE_BYTES) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function directorySize(rootDir) {
  let total = 0;
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        try { total += (await fs.promises.stat(full)).size; } catch { /* raced away; not our concern */ }
      }
    }
  };
  await walk(rootDir);
  return total;
}

export class UploadStore {
  /**
   * @param {object} options
   * @param {import("node:sqlite").DatabaseSync} options.db
   * @param {string} options.root repository root
   * @param {object} options.policy resolved upload policy
   * @param {object} options.service the asset service (used for ingest and audit commits)
   */
  constructor({ db, root, policy, service }) {
    this.db = db;
    this.root = root;
    this.policy = policy;
    this.service = service;
    this.tempRoot = path.join(root, UPLOAD_TEMP_DIR);
    this.quarantineRoot = path.join(root, QUARANTINE_DIR);
    this.stagingRoot = path.join(root, STAGING_ROOT_RELATIVE);
  }

  /**
   * Directory creation is idempotent and called before any write, so the store never depends on an
   * async init having completed first (a request that arrives during startup must not fail because of
   * a race with the initialiser).
   */
  async ensureDirs() {
    await fs.promises.mkdir(this.tempRoot, { recursive: true });
    await fs.promises.mkdir(this.quarantineRoot, { recursive: true });
    await fs.promises.mkdir(this.stagingRoot, { recursive: true });
  }

  async init() {
    await this.ensureDirs();
  }

  // ---------------------------------------------------------------------------------------------
  // Quota
  // ---------------------------------------------------------------------------------------------

  /** Current staging footprint, including in-flight temporary files: the quota is about disk used. */
  async stagingFootprint() {
    const staged = await directorySize(this.stagingRoot);
    const temporary = await directorySize(this.tempRoot);
    const quarantined = await directorySize(this.quarantineRoot);
    return { staged_bytes: staged, temp_bytes: temporary, quarantine_bytes: quarantined, total_bytes: staged + temporary + quarantined };
  }

  /**
   * Check the disk floor and staging total BEFORE writing.
   *
   * `incoming` is the number of bytes this request is about to add, so a single 300 MiB file is
   * rejected before it consumes 300 MiB rather than after.
   */
  async assertCapacity({ incoming, stage = "create" }) {
    // The directories are created first: `statfs` on a path that does not exist throws ENOENT, which would
    // surface as an internal error instead of the quota answer the caller needs.
    await this.ensureDirs();
    const footprint = await this.stagingFootprint();
    if (footprint.total_bytes + incoming > this.policy.stagingTotalBytes) {
      throw new UploadError("UPLOAD_QUOTA_EXCEEDED", `staging total would exceed the configured cap (${footprint.total_bytes + incoming} > ${this.policy.stagingTotalBytes})`, {
        status: 507,
        details: { stage, current_bytes: footprint.total_bytes, incoming_bytes: incoming, staging_total_bytes: this.policy.stagingTotalBytes }
      });
    }
    const free = await freeBytesAt(this.stagingRoot);
    if (free - incoming < this.policy.minFreeBytes) {
      throw new UploadError("UPLOAD_DISK_LOW", `writing ${incoming} bytes would leave less than the ${this.policy.minFreeBytes}-byte free-space floor`, {
        status: 507,
        details: { stage, free_bytes: free, incoming_bytes: incoming, min_free_bytes: this.policy.minFreeBytes }
      });
    }
    return { footprint, free_bytes: free };
  }

  // ---------------------------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------------------------

  getSession(upload_id) {
    return this.db.prepare("SELECT * FROM upload_sessions WHERE upload_id = ?").get(upload_id) ?? null;
  }

  listSessions({ owner_actor_id = null, state = null, limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (owner_actor_id) { clauses.push("owner_actor_id = ?"); params.push(owner_actor_id); }
    if (state) { clauses.push("state = ?"); params.push(state); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM upload_sessions${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit);
  }

  /** Refuse a session that does not belong to the caller, and say so in a structured way. */
  requireOwnedSession(upload_id, actor) {
    const session = this.getSession(upload_id);
    if (!session) {
      throw new UploadError("UPLOAD_NOT_FOUND", "no such upload session", { status: 404, details: { upload_id } });
    }
    if (session.owner_actor_id !== actor.actor_id) {
      // Deliberately a 403 rather than a 404: the caller is authenticated, the resource exists, and the
      // reason is ownership. Hiding that would make a genuine mis-routing bug look like a missing file.
      throw new UploadError("UPLOAD_NOT_OWNER", "this upload session belongs to a different identity", {
        status: 403,
        details: { upload_id, owner_actor_id: session.owner_actor_id, caller_actor_id: actor.actor_id }
      });
    }
    return session;
  }

  async createSession({ actor, file_name, declared_mime = null, total_bytes, declared_sha256 = null, session_source = null }) {
    if (!this.policy.enabled) {
      throw new UploadError("UPLOAD_DISABLED", "uploads are disabled by policy", { status: 503 });
    }
    if (!file_name) throw new UploadError("UPLOAD_FILE_NAME_REQUIRED", "file_name is required", { status: 400 });
    const total = Number(total_bytes);
    if (!Number.isFinite(total) || total <= 0) {
      throw new UploadError("UPLOAD_SIZE_REQUIRED", "total_bytes must be a positive number", { status: 400, details: { total_bytes } });
    }
    if (total > this.policy.maxFileBytes) {
      throw new UploadError("UPLOAD_FILE_TOO_LARGE", `file exceeds the ${this.policy.maxFileBytes}-byte per-file limit`, {
        status: 413,
        details: { total_bytes: total, max_file_bytes: this.policy.maxFileBytes }
      });
    }
    const safeName = sanitizeUploadName(file_name);
    const extension = path.extname(safeName).toLowerCase();
    if (!extension) throw new UploadError("UPLOAD_EXTENSION_MISSING", "the file name must carry an extension", { status: 415 });
    if (!this.policy.allowedExtensions.includes(extension)) {
      throw new UploadError("UPLOAD_EXTENSION_NOT_ALLOWED", `extension ${extension} is not allowed`, {
        status: 415,
        details: { extension, allowed_extension_count: this.policy.allowedExtensions.length }
      });
    }

    await this.assertCapacity({ incoming: total, stage: "create" });
    await this.ensureDirs();

    const upload_id = newId("upl");
    const timestamp = nowIso();
    const tempPath = path.join(this.tempRoot, `${upload_id}.part`);
    this.db.prepare(`INSERT INTO upload_sessions (
        upload_id, owner_actor_id, owner_actor_type, owner_session_source, file_name, extension, declared_mime,
        declared_bytes, declared_sha256, received_bytes, state, quarantine, temp_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', 0, ?, ?, ?)`)
      .run(upload_id, actor.actor_id, actor.actor_type, session_source, safeName, extension, declared_mime ?? null, total, declared_sha256 ?? null, tempPath, timestamp, timestamp);
    // Create the placeholder immediately so the session always has a file to point at, and so a crash
    // between "session row" and "first byte" leaves no ambiguity about what the row refers to.
    await fs.promises.writeFile(tempPath, Buffer.alloc(0), { flag: "wx" });
    this.service?.commit?.({
      scope: "system",
      target_id: upload_id,
      action: "upload.create",
      message: `已创建上传会话：${safeName}`,
      actor_id: actor.actor_id,
      changes: { upload_id, file_name: safeName, declared_bytes: total, declared_mime: declared_mime ?? null }
    });
    return {
      upload_id,
      state: "pending",
      file_name: safeName,
      declared_bytes: total,
      received_bytes: 0,
      max_chunk_bytes: this.policy.maxChunkBytes,
      next_offset: 0,
      policy: { max_file_bytes: this.policy.maxFileBytes, max_chunk_bytes: this.policy.maxChunkBytes }
    };
  }

  /**
   * Append one chunk.
   *
   * The offset must equal the current `received_bytes`. That single rule gives resume for free (the
   * client asks for status, sees the offset, and continues) and makes an out-of-order or duplicated
   * chunk a REFUSAL rather than silent corruption.
   */
  async appendChunk({ upload_id, actor, offset, chunk, declared_total = null }) {
    const session = this.requireOwnedSession(upload_id, actor);
    if (["completed", "cancelled", "quarantined"].includes(session.state)) {
      throw new UploadError("UPLOAD_SESSION_CLOSED", `this upload session is ${session.state} and accepts no more bytes`, {
        status: 409,
        details: { upload_id, state: session.state, received_bytes: session.received_bytes }
      });
    }
    if (session.state === "failed") {
      throw new UploadError("UPLOAD_SESSION_FAILED", `this upload session failed: ${session.failure_code ?? "unknown"}`, {
        status: 409,
        details: { upload_id, failure_code: session.failure_code ?? null, failure_message: session.failure_message ?? null }
      });
    }
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) {
      throw new UploadError("UPLOAD_CHUNK_EMPTY", "the request body contained no bytes", { status: 400, details: { upload_id } });
    }
    if (chunk.length > this.policy.maxChunkBytes) {
      throw new UploadError("UPLOAD_CHUNK_TOO_LARGE", `chunk of ${chunk.length} bytes exceeds the ${this.policy.maxChunkBytes}-byte limit`, {
        status: 413,
        details: { chunk_bytes: chunk.length, max_chunk_bytes: this.policy.maxChunkBytes }
      });
    }
    const expected = Number(offset);
    if (!Number.isFinite(expected) || expected < 0) {
      throw new UploadError("UPLOAD_OFFSET_REQUIRED", "offset must be a non-negative number", { status: 400, details: { offset } });
    }
    if (expected !== session.received_bytes) {
      // 409 with the authoritative offset: the client can resume rather than restart.
      throw new UploadError("UPLOAD_OFFSET_MISMATCH", `expected offset ${session.received_bytes} but received ${expected}`, {
        status: 409,
        details: { upload_id, expected_offset: session.received_bytes, received_offset: expected, received_bytes: session.received_bytes, declared_bytes: session.declared_bytes }
      });
    }
    if (session.received_bytes + chunk.length > session.declared_bytes) {
      throw new UploadError("UPLOAD_OVERFLOW", "this chunk would push the upload past its declared size", {
        status: 413,
        details: { upload_id, received_bytes: session.received_bytes, chunk_bytes: chunk.length, declared_bytes: session.declared_bytes }
      });
    }
    if (declared_total !== null && Number(declared_total) !== session.declared_bytes) {
      throw new UploadError("UPLOAD_TOTAL_MISMATCH", "this chunk declares a different total than the session", {
        status: 409,
        details: { upload_id, session_declared_bytes: session.declared_bytes, chunk_declared_bytes: Number(declared_total) }
      });
    }

    // Capacity is re-checked per chunk: another upload may have filled the staging area since this
    // session was created, and the disk can also shrink under a shared mount.
    await this.assertCapacity({ incoming: chunk.length, stage: "append" });

    await fs.promises.appendFile(session.temp_path, chunk);
    const received = session.received_bytes + chunk.length;
    const state = received >= session.declared_bytes ? "uploading" : "uploading";
    this.db.prepare("UPDATE upload_sessions SET received_bytes = ?, state = ?, updated_at = ? WHERE upload_id = ?")
      .run(received, state, nowIso(), upload_id);
    return {
      upload_id,
      state,
      received_bytes: received,
      declared_bytes: session.declared_bytes,
      next_offset: received,
      complete: received >= session.declared_bytes
    };
  }

  /**
   * Append one chunk that arrives as a STREAM.
   *
   * This is the path the HTTP route uses, and it is why a 200 MiB upload does not need 200 MiB of
   * memory: bytes go straight from the socket to the file, in buffer-sized pieces, and the accounting
   * (`received_bytes`) is updated as they land. Three things make it safe rather than merely streaming:
   *
   *   1. The offset is validated BEFORE the first byte is written, so an out-of-order chunk can not
   *      corrupt the file - it is refused and the client is told the authoritative offset.
   *   2. The byte budget is enforced WHILE writing, so a client that lies about `content-length` (or
   *      omits it and streams forever) is cut off at the cap instead of filling the disk first.
   *   3. A disconnect KEEPS what actually landed and attributes it to the session. The upload is then
   *      resumable from the real offset, and the partial file is never an orphan: this is what makes
   *      "临时文件可归属/恢复" true rather than aspirational.
   */
  async appendStream({ upload_id, actor, offset, stream, declared_chunk_bytes = null }) {
    const session = this.requireOwnedSession(upload_id, actor);
    if (["completed", "cancelled", "quarantined"].includes(session.state)) {
      throw new UploadError("UPLOAD_SESSION_CLOSED", `this upload session is ${session.state} and accepts no more bytes`, {
        status: 409,
        details: { upload_id, state: session.state, received_bytes: session.received_bytes }
      });
    }
    if (session.state === "failed") {
      throw new UploadError("UPLOAD_SESSION_FAILED", `this upload session failed: ${session.failure_code ?? "unknown"}`, {
        status: 409,
        details: { upload_id, failure_code: session.failure_code ?? null, failure_message: session.failure_message ?? null }
      });
    }
    const expected = Number(offset);
    if (!Number.isFinite(expected) || expected < 0) {
      throw new UploadError("UPLOAD_OFFSET_REQUIRED", "offset must be a non-negative number", { status: 400, details: { offset } });
    }
    if (expected !== session.received_bytes) {
      throw new UploadError("UPLOAD_OFFSET_MISMATCH", `expected offset ${session.received_bytes} but received ${expected}`, {
        status: 409,
        details: { upload_id, expected_offset: session.received_bytes, received_offset: expected, received_bytes: session.received_bytes, declared_bytes: session.declared_bytes }
      });
    }
    const remaining = session.declared_bytes - session.received_bytes;
    const budget = Math.min(this.policy.maxChunkBytes, remaining);
    if (declared_chunk_bytes !== null) {
      const declaredChunk = Number(declared_chunk_bytes);
      if (!Number.isFinite(declaredChunk) || declaredChunk <= 0) {
        throw new UploadError("UPLOAD_CHUNK_LENGTH_INVALID", "content-length must be a positive number", { status: 400, details: { declared_chunk_bytes } });
      }
      if (declaredChunk > budget) {
        throw new UploadError("UPLOAD_CHUNK_TOO_LARGE", `a chunk of ${declaredChunk} bytes exceeds the ${budget}-byte budget for this request`, {
          status: 413,
          details: { upload_id, chunk_bytes: declaredChunk, max_chunk_bytes: this.policy.maxChunkBytes, remaining_bytes: remaining }
        });
      }
    }

    await this.assertCapacity({ incoming: declared_chunk_bytes === null ? budget : Number(declared_chunk_bytes), stage: "append" });

    const handle = await fs.promises.open(session.temp_path, "a");
    let written = 0;
    let capacityCheckedAt = 0;
    let aborted = null;
    try {
      for await (const piece of stream) {
        const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
        if (written + chunk.length > budget) {
          aborted = new UploadError("UPLOAD_CHUNK_TOO_LARGE", `the request body exceeded the ${budget}-byte budget for this chunk`, {
            status: 413,
            details: { upload_id, written_bytes: written, attempted_bytes: written + chunk.length, budget_bytes: budget }
          });
          break;
        }
        await handle.write(chunk);
        written += chunk.length;
        // Re-check the disk floor periodically: on a shared mount, free space can shrink underneath a
        // long upload, and discovering that at completion would mean having written the whole file first.
        if (written - capacityCheckedAt >= 8 * 1024 * 1024) {
          capacityCheckedAt = written;
          await this.assertCapacity({ incoming: 0, stage: "append-midstream" });
        }
      }
    } catch (error) {
      // A socket error is not a server fault: keep the bytes that DID land so the client can resume.
      aborted = error;
    } finally {
      await handle.close().catch(() => {});
    }

    const received = session.received_bytes + written;
    if (aborted) {
      this.db.prepare("UPDATE upload_sessions SET received_bytes = ?, state = 'uploading', failure_code = ?, failure_message = ?, updated_at = ? WHERE upload_id = ?")
        .run(received, "UPLOAD_INTERRUPTED", String(aborted.message ?? aborted), nowIso(), upload_id);
      if (aborted instanceof UploadError) throw aborted;
      throw new UploadError("UPLOAD_INTERRUPTED", "the connection dropped before this chunk completed", {
        status: 499,
        details: { upload_id, received_bytes: received, declared_bytes: session.declared_bytes, next_offset: received, resumable: true }
      });
    }

    this.db.prepare("UPDATE upload_sessions SET received_bytes = ?, state = 'uploading', failure_code = NULL, failure_message = NULL, updated_at = ? WHERE upload_id = ?")
      .run(received, nowIso(), upload_id);

    // Early content check: if the leading bytes are a KNOWN type that contradicts the name, stop now
    // instead of accepting another few hundred megabytes from a client that will fail at completion.
    // Only a definite contradiction triggers this; an inconclusive sample does not, because a first
    // chunk can legitimately be too short to identify.
    if (written > 0) {
      const sample = await readSample(session.temp_path);
      const early = classifyContent({ file_name: session.file_name, declared_mime: session.declared_mime, sample, policy: this.policy });
      if (early.decision === "mismatch") {
        await this.quarantine({ ...session, received_bytes: received }, { code: early.code, reason: early.reason, classification: early });
        throw new UploadError(early.code, early.reason, {
          status: 415,
          details: { upload_id, quarantined: true, detected_mime: early.detected_mime ?? null, detected_format: early.detected_format ?? null }
        });
      }
    }

    return {
      upload_id,
      state: "uploading",
      received_bytes: received,
      declared_bytes: session.declared_bytes,
      chunk_bytes: written,
      next_offset: received,
      complete: received >= session.declared_bytes
    };
  }

  /** Status is also the resume endpoint: it names the exact offset to continue from. */
  describeSession(session) {
    return {
      upload_id: session.upload_id,
      state: session.state,
      file_name: session.file_name,
      extension: session.extension,
      declared_mime: session.declared_mime,
      declared_bytes: session.declared_bytes,
      received_bytes: session.received_bytes,
      next_offset: session.received_bytes,
      remaining_bytes: Math.max(0, session.declared_bytes - session.received_bytes),
      sha256: session.sha256,
      asset_id: session.asset_id,
      asset_version_id: session.asset_version_id,
      quarantine: session.quarantine === 1,
      failure_code: session.failure_code,
      failure_message: session.failure_message,
      created_at: session.created_at,
      updated_at: session.updated_at,
      owner_actor_id: session.owner_actor_id
    };
  }

  async status({ upload_id, actor }) {
    return this.describeSession(this.requireOwnedSession(upload_id, actor));
  }

  /**
   * Complete: verify, classify, then ingest - in that order, and only once.
   *
   * Idempotency comes from the session state: a session already `completed` returns the SAME asset
   * rather than ingesting a second one. That is what makes a retried completion safe, and it is also
   * why the state is written inside the same step as the ingest.
   */
  async complete({ upload_id, actor, declared_sha256 = null }) {
    const session = this.requireOwnedSession(upload_id, actor);
    if (session.state === "completed") {
      return { ...this.describeSession(session), idempotent_replay: true, asset: null, message: "this upload was already completed; the existing asset is returned" };
    }
    if (session.state === "cancelled") {
      throw new UploadError("UPLOAD_CANCELLED", "this upload was cancelled", { status: 409, details: { upload_id } });
    }
    if (session.state === "quarantined") {
      throw new UploadError("UPLOAD_QUARANTINED", "this upload is quarantined and was never ingested", {
        status: 409,
        details: { upload_id, failure_code: session.failure_code, quarantine_path: session.staging_path }
      });
    }
    if (session.received_bytes !== session.declared_bytes) {
      throw new UploadError("UPLOAD_INCOMPLETE", `only ${session.received_bytes} of ${session.declared_bytes} bytes arrived`, {
        status: 409,
        details: { upload_id, received_bytes: session.received_bytes, declared_bytes: session.declared_bytes, next_offset: session.received_bytes }
      });
    }
    if (!fs.existsSync(session.temp_path)) {
      // The bytes are gone (mount lost, or an operator moved them). Fail the session with a reason
      // rather than "succeeding" with nothing.
      this.markFailed(upload_id, "UPLOAD_TEMP_MISSING", `the temporary file for this upload is missing: ${session.temp_path}`);
      throw new UploadError("UPLOAD_TEMP_MISSING", "the upload's temporary file is missing", { status: 409, details: { upload_id } });
    }

    const hashStart = Date.now();
    const { sha256, size_bytes } = await sha256File(session.temp_path);
    if (size_bytes !== session.declared_bytes) {
      this.markFailed(upload_id, "UPLOAD_SIZE_MISMATCH", `the temporary file holds ${size_bytes} bytes but ${session.declared_bytes} were declared`);
      throw new UploadError("UPLOAD_SIZE_MISMATCH", "the received size does not match the declared size", {
        status: 409,
        details: { upload_id, size_bytes, declared_bytes: session.declared_bytes }
      });
    }
    const expectedSha = declared_sha256 ?? session.declared_sha256;
    if (expectedSha && String(expectedSha).toLowerCase() !== sha256) {
      this.markFailed(upload_id, "UPLOAD_HASH_MISMATCH", `sha256 ${sha256} does not match the client-declared ${expectedSha}`);
      throw new UploadError("UPLOAD_HASH_MISMATCH", "the uploaded bytes do not match the hash the client declared", {
        status: 409,
        details: { upload_id, computed_sha256: sha256, declared_sha256: String(expectedSha).toLowerCase() }
      });
    }

    // Classification uses the bytes that actually arrived, not the name in the create call.
    const sample = await readSample(session.temp_path);
    const classification = classifyContent({ file_name: session.file_name, declared_mime: session.declared_mime, sample, policy: this.policy });
    if (classification.decision !== "accept") {
      await this.quarantine(session, { code: classification.code, reason: classification.reason, classification, sha256 });
      throw new UploadError(classification.code, classification.reason, {
        status: 415,
        details: { upload_id, quarantined: true, quarantine_path: path.relative(this.root, this.quarantinePathFor(upload_id)), detected_mime: classification.detected_mime ?? null }
      });
    }

    // Move into staging under the service's own allowed root, so `ingestAsset` sees a file inside the
    // repository rather than an arbitrary path.
    const stagedName = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}-${sanitizeUploadName(session.file_name)}`;
    const stagedPath = path.join(this.stagingRoot, stagedName);
    await fs.promises.rename(session.temp_path, stagedPath);
    const relativePath = path.posix.join(STAGING_ROOT_RELATIVE, stagedName);
    const staging_id = newId("stg");
    const timestamp = nowIso();
    this.db.prepare(`INSERT INTO staging_objects (
        staging_id, relative_path, upload_id, owner_actor_id, size_bytes, sha256, state, created_at, updated_at, notes
      ) VALUES (?, ?, ?, ?, ?, ?, 'staged', ?, ?, ?)`)
      .run(staging_id, relativePath, upload_id, actor.actor_id, size_bytes, sha256, timestamp, timestamp, classification.reason ?? null);

    this.db.prepare("UPDATE upload_sessions SET state = 'staged', sha256 = ?, staging_path = ?, staging_relative_path = ?, updated_at = ? WHERE upload_id = ?")
      .run(sha256, stagedPath, relativePath, timestamp, upload_id);

    const ingestStart = Date.now();
    const asset = await this.service.ingestAsset({
      file_path: stagedPath,
      title: session.file_name,
      description: `Uploaded via streaming upload ${upload_id}`,
      tags: ["upload", "staging"],
      kind: "raw",
      actor_id: actor.actor_id,
      actor_type: actor.actor_type,
      change_summary: `流式上传入库（${size_bytes} 字节）`,
      lifecycle: { isAbandoned: () => false, isCancelled: () => false, checkpoint: () => {} }
    });

    const completedAt = nowIso();
    this.db.prepare(`UPDATE upload_sessions SET state = 'completed', asset_id = ?, asset_version_id = ?, completed_at = ?, updated_at = ? WHERE upload_id = ?`)
      .run(asset.asset_id, asset.default_version_id, completedAt, completedAt, upload_id);
    // The staged copy is NOT deleted: it is attributed to the asset it became. That is what "新入库不留
    // 无主暂存" means - the file has an owner, not that the file has to disappear.
    this.db.prepare("UPDATE staging_objects SET state = 'ingested', asset_id = ?, updated_at = ? WHERE staging_id = ?")
      .run(asset.asset_id, completedAt, staging_id);
    this.service?.commit?.({
      scope: "system",
      target_id: upload_id,
      action: "upload.complete",
      message: `上传完成并入库：${session.file_name}`,
      actor_id: actor.actor_id,
      changes: {
        upload_id, staging_id, relative_path: relativePath, sha256, size_bytes,
        asset_id: asset.asset_id, asset_version_id: asset.default_version_id,
        hash_ms: Date.now() - hashStart, ingest_ms: Date.now() - ingestStart
      }
    });

    return {
      ...this.describeSession(this.getSession(upload_id)),
      idempotent_replay: false,
      staging: { staging_id, relative_path: relativePath, size_bytes, sha256, state: "ingested" },
      classification,
      scan: require_scan_stub(upload_id, relativePath, session.declared_mime),
      asset: { asset_id: asset.asset_id, default_version_id: asset.default_version_id, media_type: asset.media_type ?? null }
    };
  }

  quarantinePathFor(upload_id) {
    return path.join(this.quarantineRoot, `${upload_id}.quarantined`);
  }

  /**
   * Move the bytes aside and record WHY, keeping them for inspection.
   *
   * Quarantine is where "unknown" and "contradicts its own name" content goes. Refusing without
   * keeping the bytes would destroy the only evidence of what the client actually sent.
   */
  async quarantine(session, { code, reason, classification, sha256 = null }) {
    await this.ensureDirs();
    const target = this.quarantinePathFor(session.upload_id);
    try {
      await fs.promises.rename(session.temp_path, target);
    } catch {
      // If the move fails the bytes stay in the temp area; the session row still explains them.
    }
    const timestamp = nowIso();
    this.db.prepare(`UPDATE upload_sessions SET state = 'quarantined', quarantine = 1, failure_code = ?, failure_message = ?, sha256 = ?, staging_path = ?, updated_at = ? WHERE upload_id = ?`)
      .run(code, reason, sha256, target, timestamp, session.upload_id);
    this.service?.commit?.({
      scope: "system",
      target_id: session.upload_id,
      action: "upload.quarantine",
      message: `上传内容被隔离：${session.file_name}`,
      actor_id: session.owner_actor_id,
      changes: { upload_id: session.upload_id, code, reason, quarantine_path: target, classification }
    });
    return { quarantine_path: target, code, reason };
  }

  markFailed(upload_id, code, message) {
    const timestamp = nowIso();
    this.db.prepare("UPDATE upload_sessions SET state = 'failed', failure_code = ?, failure_message = ?, updated_at = ? WHERE upload_id = ?")
      .run(code, message, timestamp, upload_id);
    return this.getSession(upload_id);
  }

  /**
   * Cancel: remove the partial bytes, keep the row.
   *
   * The row survives on purpose. "This upload was cancelled" is a fact worth keeping, and a deleted row
   * would make the next orphan scan report the same upload as unattributed.
   */
  async cancel({ upload_id, actor, reason = null }) {
    const session = this.requireOwnedSession(upload_id, actor);
    if (session.state === "completed") {
      throw new UploadError("UPLOAD_ALREADY_COMPLETED", "this upload is already completed; cancel a completed upload would orphan its asset", {
        status: 409,
        details: { upload_id, asset_id: session.asset_id }
      });
    }
    await fs.promises.rm(session.temp_path, { force: true });
    const timestamp = nowIso();
    this.db.prepare("UPDATE upload_sessions SET state = 'cancelled', cancelled_at = ?, failure_code = ?, failure_message = ?, received_bytes = 0, updated_at = ? WHERE upload_id = ?")
      .run(timestamp, "UPLOAD_CANCELLED", reason ?? "cancelled by client", timestamp, upload_id);
    this.service?.commit?.({
      scope: "system",
      target_id: upload_id,
      action: "upload.cancel",
      message: `上传已取消：${session.file_name}`,
      actor_id: actor.actor_id,
      changes: { upload_id, discarded_bytes: session.received_bytes, reason }
    });
    return this.describeSession(this.getSession(upload_id));
  }

  // ---------------------------------------------------------------------------------------------
  // Staging lifecycle, ownership and recovery
  // ---------------------------------------------------------------------------------------------

  /** Every staged/temporary/quarantined file the store knows about, with its owner. */
  inventory() {
    return {
      sessions: this.listSessions({ limit: 500 }),
      staging: this.db.prepare("SELECT * FROM staging_objects ORDER BY created_at DESC LIMIT 1000").all()
    };
  }

  /**
   * Find bytes on disk that no row owns, and rows whose bytes are gone.
   *
   * This is an ACCOUNTING operation. It does not delete anything: an unattributed file is reported so a
   * human can decide, because "clean up files I do not recognise" is how evidence disappears.
   */
  async scanOrphans() {
    const rows = this.db.prepare("SELECT * FROM upload_sessions").all();
    const knownTemps = new Set(rows.filter((row) => ["pending", "uploading", "staged"].includes(row.state)).map((row) => path.resolve(row.temp_path)));

    const unattributed = [];
    for (const dir of [this.tempRoot, this.quarantineRoot]) {
      let entries = [];
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const full = path.resolve(path.join(dir, entry.name));
        if (directoryOwnedBySession(rows, full)) continue;
        const stat = await fs.promises.stat(full);
        unattributed.push({ path: full, size_bytes: stat.size, directory: dir, reason: full.endsWith(".quarantined") ? "quarantined-bytes-with-no-live-session" : "temporary-file-with-no-live-session" });
      }
    }

    const missing = [];
    for (const row of rows) {
      if (!["pending", "uploading", "staged"].includes(row.state)) continue;
      if (!knownTemps.has(path.resolve(row.temp_path))) continue;
      if (!fs.existsSync(row.temp_path)) {
        missing.push({ upload_id: row.upload_id, expected_path: row.temp_path, received_bytes: row.received_bytes, state: row.state, owner_actor_id: row.owner_actor_id });
      }
    }
    return { unattributed, missing_bytes: missing, scanned_at: nowIso() };
  }

  /**
   * Ownership manifest for staging files, including historical ones.
   *
   * Historical files predate this table, so they have no owner recorded. The manifest states that
   * plainly and NEVER proposes deletion: the age of a file is not a reason to destroy it, and these
   * may be the only copies of material someone still wants.
   */
  async ownershipManifest({ includeHistorical = true } = {}) {
    const tracked = this.db.prepare("SELECT * FROM staging_objects").all();
    const trackedPaths = new Set(tracked.map((row) => path.resolve(this.root, row.relative_path)));
    const entries = tracked.map((row) => ({
      relative_path: row.relative_path,
      staging_id: row.staging_id,
      upload_id: row.upload_id,
      owner_actor_id: row.owner_actor_id,
      state: row.state,
      asset_id: row.asset_id,
      size_bytes: row.size_bytes,
      sha256: row.sha256,
      created_at: row.created_at,
      attributed: true,
      deletion_eligible: false
    }));

    if (includeHistorical) {
      let entriesOnDisk = [];
      try { entriesOnDisk = await fs.promises.readdir(this.stagingRoot, { withFileTypes: true }); } catch { /* nothing staged yet */ }
      for (const entry of entriesOnDisk) {
        if (!entry.isFile()) continue;
        const full = path.resolve(path.join(this.stagingRoot, entry.name));
        if (trackedPaths.has(full)) continue;
        const stat = await fs.promises.stat(full);
        entries.push({
          relative_path: path.posix.join(STAGING_ROOT_RELATIVE, entry.name),
          staging_id: null,
          upload_id: null,
          owner_actor_id: null,
          state: "untracked-historical",
          asset_id: null,
          size_bytes: stat.size,
          sha256: null,
          created_at: stat.mtime.toISOString(),
          attributed: false,
          deletion_eligible: false,
          note: "Predates upload-session tracking. No owner is recorded and NOTHING is inferred from file age; deletion requires an explicit human decision."
        });
      }
    }

    const unattributed = entries.filter((entry) => !entry.attributed);
    return {
      generated_at: nowIso(),
      total_entries: entries.length,
      attributed_entries: entries.length - unattributed.length,
      untracked_historical_entries: unattributed.length,
      deletion_policy: "none-by-age: this manifest proposes no deletions, and no code path deletes staging files based on age",
      entries
    };
  }

  /**
   * Record ownership for a file that was staged without an upload session.
   *
   * The legacy base64 entry point has no session, so this row is the only thing tying the bytes to a
   * person. Without it the file would be indistinguishable from a historical orphan the moment it landed,
   * and the ownership manifest would report a file we had just written ourselves as unattributed.
   */
  recordStagedObject({ relativePath, ownerActorId, sizeBytes, sha256, state = "staged", assetId = null, notes = null }) {
    const staging_id = newId("stg");
    const timestamp = nowIso();
    this.db.prepare(`INSERT INTO staging_objects (
        staging_id, relative_path, upload_id, owner_actor_id, size_bytes, sha256, state, asset_id, created_at, updated_at, notes
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(staging_id, relativePath, ownerActorId, sizeBytes, sha256, state, assetId, timestamp, timestamp, notes);
    return { staging_id, relative_path: relativePath, state, owner_actor_id: ownerActorId };
  }

  /** Which staging rows still reference an object that no longer exists. */
  async reconcileStaging() {
    const rows = this.db.prepare("SELECT * FROM staging_objects WHERE state IN ('staged','ingested')").all();
    const missing = [];
    for (const row of rows) {
      const full = path.join(this.root, row.relative_path);
      if (!fs.existsSync(full)) missing.push({ staging_id: row.staging_id, relative_path: row.relative_path, state: row.state, asset_id: row.asset_id });
    }
    return { checked: rows.length, missing, checked_at: nowIso() };
  }
}

/** Is this path referenced by any session row (temp or quarantined)? */
function directoryOwnedBySession(rows, resolvedPath) {
  for (const row of rows) {
    if (row.temp_path && path.resolve(row.temp_path) === resolvedPath) return true;
    if (row.staging_path && path.resolve(row.staging_path) === resolvedPath) return true;
  }
  return false;
}

/** Indirection so the route layer can attach the scan stub without importing content-identity twice. */
function require_scan_stub(upload_id, relativePath, declaredMime) {
  return {
    upload_id,
    staging_path: relativePath,
    scanner_available: false,
    scanner: null,
    verdict: "not-scanned",
    declared_mime: declaredMime ?? null,
    note: "No malware scanner is installed. The upload was NOT scanned."
  };
}
