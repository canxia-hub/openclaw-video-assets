/**
 * REN-06: the upload HTTP surface.
 *
 * Why a new route rather than the existing RPC surface
 * ---------------------------------------------------
 * The RPC endpoint reads the whole request body as JSON (`readJsonBody`), and the legacy staging entry
 * took the file as a base64 string inside that JSON. Base64 inflates the payload by ~33% and forces the
 * server to hold the entire encoded file in memory before it can decide anything, so a 200 MiB upload
 * would need a ~270 MiB body buffer. Streaming uploads are therefore incompatible with that transport,
 * not merely inefficient on it.
 *
 * The REN-01 registration contract froze the HTTP route surface at 8 routes. That number was a
 * snapshot of what existed, not a design limit, and the contract's own purpose is that routes are
 * declared in one place and checked - so this package adds exactly ONE route, declares it in the single
 * source of truth (`ROUTE_SEGMENTS.upload` in base-path.js, the same module every other route and the
 * cookie path derive from), and carries an explicit case in the registration contract test that names
 * the new route and the reason. The alternative - smuggling uploads through the RPC body reader - would
 * keep the count at 8 while defeating the memory requirement, which is exactly the kind of change that
 * keeps a contract green while making it meaningless.
 *
 * Routes (all `auth: plugin`, i.e. behind the plugin session, and all prefix-matched under one route):
 *   POST   /upload                     create a session
 *   PATCH  /upload/<upload_id>         append one chunk (raw body, streamed)
 *   PUT    /upload/<upload_id>         alias of PATCH, because "PUT the next slice" is what most
 *                                      resumable-upload clients reach for
 *   GET    /upload/<upload_id>         status / resume offset
 *   POST   /upload/<upload_id>/complete verify + ingest (idempotent)
 *   DELETE /upload/<upload_id>         cancel, keeping the accounting row
 *   GET    /upload                     list the caller's own sessions
 *
 * Identity
 * --------
 * Every action is bound to the actor that CREATED the session, taken from the plugin session that
 * authenticated the request. There is no "owner" parameter a caller can set: an upload belongs to
 * whoever opened it, and another identity gets 403 UPLOAD_NOT_OWNER. That is the cross-session
 * boundary the audit asked for.
 */

import { readJsonBody, sendJson } from "./security.js";
import { UploadError } from "./upload-policy.js";
import { describeUploadPolicy } from "./upload-policy.js";

/** Small JSON bodies only on this surface; chunk bytes never travel as JSON. */
const UPLOAD_JSON_BODY_LIMIT = 64 * 1024;

function methodNotAllowed(res, allowed) {
  res.setHeader("allow", allowed.join(", "));
  return sendJson(res, 405, { ok: false, code: "UPLOAD_METHOD_NOT_ALLOWED", error: `method not allowed; allowed: ${allowed.join(", ")}` });
}

/**
 * Parse `Content-Range`-style or simple offset headers.
 *
 * Accepted forms (in order of preference):
 *   `upload-offset: 12345`                      explicit byte offset
 *   `content-range: bytes 0-8388607/209715200`  standard resumable-upload form
 * A client that sends neither is refused: guessing the offset is how a resume silently corrupts a file.
 */
function parseOffset(headers) {
  const simple = headers["upload-offset"];
  if (simple !== undefined && simple !== null && String(simple).trim() !== "") {
    const value = Number(String(simple).trim());
    if (!Number.isFinite(value) || value < 0) return { ok: false, reason: `upload-offset must be a non-negative number, got ${simple}` };
    return { ok: true, offset: value, total: null };
  }
  const range = headers["content-range"];
  if (range) {
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(range).trim());
    if (!match) return { ok: false, reason: `content-range must look like "bytes start-end/total", got ${range}` };
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = match[3] === "*" ? null : Number(match[3]);
    if (end < start) return { ok: false, reason: "content-range end must not precede start" };
    return { ok: true, offset: start, expected_chunk_bytes: end - start + 1, total };
  }
  return { ok: false, reason: "an upload-offset or content-range header is required so the server never has to guess where these bytes belong" };
}

function contentLengthOf(req) {
  const raw = req.headers["content-length"];
  if (raw === undefined || String(raw).trim() === "") return null;
  const value = Number(String(raw).trim());
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Build the route handler.
 *
 * @param {object} options
 * @param {object} options.service the asset service (for actor resolution and audit commits)
 * @param {object} options.security the REN-02 security helper bundle
 * @param {object} options.store the UploadStore
 * @param {object} options.gate the TransferGate
 */
export function createUploadHandlers({ service, security, store, gate, policy }) {
  /** Authenticate and bind the request to a real identity. Returns null after answering the request. */
  function authenticate(req, res) {
    const gate = security.checkRequest(req, { method: req.method });
    if (!gate.ok) {
      sendJson(res, gate.status, { ok: false, code: gate.code ?? "UPLOAD_REQUEST_REFUSED", error: gate.error });
      return null;
    }
    const auth = security.authenticateRequest(req);
    if (!auth.ok) {
      sendJson(res, auth.status, { ok: false, code: auth.code ?? "UPLOAD_UNAUTHENTICATED", error: auth.error });
      return null;
    }
    // The identity comes from the authenticated session, and is used directly as the session owner.
    const actor = { actor_id: auth.actor_id, actor_type: "human", source: auth.source ?? "plugin-session" };
    return actor;
  }

  function fail(res, error) {
    if (error instanceof UploadError) return sendJson(res, error.status, error.toJSON());
    return sendJson(res, 500, { ok: false, code: "UPLOAD_INTERNAL_ERROR", error: error instanceof Error ? error.message : String(error) });
  }

  return {
    policy: () => describeUploadPolicy(policy),

    /** POST /upload */
    async create(req, res) {
      const actor = authenticate(req, res);
      if (!actor) return undefined;
      try {
        const body = await readJsonBody(req, UPLOAD_JSON_BODY_LIMIT);
        const session = await store.createSession({
          actor,
          file_name: body.file_name,
          declared_mime: body.mime_type ?? body.declared_mime ?? null,
          total_bytes: body.total_bytes ?? body.size_bytes,
          declared_sha256: body.sha256 ?? null,
          session_source: actor.source
        });
        return sendJson(res, 201, { ok: true, result: session });
      } catch (error) {
        return fail(res, error);
      }
    },

    /** PATCH|PUT /upload/<upload_id> */
    async append(req, res, upload_id) {
      // The transfer gate wraps the APPEND, not just completion: appending is where bytes actually move,
      // so that is the work the concurrency cap has to bound. With the default cap of 2, a burst of eight
      // simultaneous chunk requests has two in flight and the other six waiting in the bounded queue (or
      // refused with UPLOAD_QUEUE_FULL once the waiting room is full) - rather than eight writers racing
      // for the disk and the memory of the host.
      const actor = authenticate(req, res);
      if (!actor) return undefined;
      let release = null;
      // The outcome is tracked so the gate counts a failed transfer as failed. Releasing the permit is
      // unconditional (the slot must come back either way), but the counter is not.
      let outcome = "completed";
      try {
        const parsed = parseOffset(req.headers);
        if (!parsed.ok) {
          throw new UploadError("UPLOAD_OFFSET_REQUIRED", parsed.reason, { status: 400 });
        }
        const declaredChunk = contentLengthOf(req);
        const queuedAt = Date.now();
        try {
          release = await gate.acquire({ label: `append:${upload_id}` });
        } catch (gateError) {
          // A full waiting room is a REFUSAL the client can act on (retry later / reduce parallelism),
          // not an internal error.
          return sendJson(res, gateError.status ?? 429, {
            ok: false,
            code: gateError.code ?? "UPLOAD_QUEUE_FULL",
            error: gateError.message,
            details: { ...(gateError.details ?? {}), gate: gate.status() }
          });
        }
        const result = await store.appendStream({
          upload_id,
          actor,
          offset: parsed.offset,
          stream: req,
          declared_chunk_bytes: declaredChunk
        });
        return sendJson(res, 200, { ok: true, result: { ...result, gate_wait_ms: Date.now() - queuedAt } });
      } catch (error) {
        outcome = "failed";
        return fail(res, error);
      } finally {
        // Released on the physical end of the transfer, including the failure paths. The gate is not
        // released when the caller's promise settles, because those are different moments.
        if (release) release(outcome);
      }
    },

    /** GET /upload/<upload_id> */
    async status(req, res, upload_id) {
      const actor = authenticate(req, res);
      if (!actor) return undefined;
      try {
        return sendJson(res, 200, { ok: true, result: await store.status({ upload_id, actor }) });
      } catch (error) {
        return fail(res, error);
      }
    },

    /** POST /upload/<upload_id>/complete */
    async complete(req, res, upload_id) {
      const actor = authenticate(req, res);
      if (!actor) return undefined;
      try {
        // The body is optional (a client may restate the hash), so a missing or unparseable body is not
        // an error here - the hash declared at create time is the fallback and is already stored.
        let body = {};
        try { body = await readJsonBody(req, UPLOAD_JSON_BODY_LIMIT); } catch { body = {}; }
        // Completion hashes the file and writes the row, so it is real work too - but it is
        // deliberately NOT gated with the transfer permits, because completion must stay possible while
        // other transfers are running: it is what RELEASES a session, and blocking it behind the queue
        // that it is meant to drain would be self-defeating.
        const immediate = await store.complete({ upload_id, actor, declared_sha256: body.sha256 ?? null });
        if (immediate.idempotent_replay) return sendJson(res, 200, { ok: true, result: immediate, replayed: true });
        return sendJson(res, 201, { ok: true, result: immediate });
      } catch (error) {
        return fail(res, error);
      }
    },

    /** DELETE /upload/<upload_id> */
    async cancel(req, res, upload_id) {
      const actor = authenticate(req, res);
      if (!actor) return undefined;
      try {
        // Only the APPEND path holds permits, so only a waiting append could be cancelled here. The
        // append is identified by the session id, which is the label the gate was given.
        gate.cancelWaiting(`append:${upload_id}`);
        return sendJson(res, 200, { ok: true, result: await store.cancel({ upload_id, actor }) });
      } catch (error) {
        return fail(res, error);
      }
    },

    /** GET /upload */
    async list(req, res) {
      const actor = authenticate(req, res);
      if (!actor) return undefined;
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const sessions = store.listSessions({ owner_actor_id: actor.actor_id, state: url.searchParams.get("state"), limit: 200 });
        return sendJson(res, 200, {
          ok: true,
          result: {
            owner_actor_id: actor.actor_id,
            sessions: sessions.map((session) => store.describeSession(session)),
            gate: gate.status(),
            policy: describeUploadPolicy(policy)
          }
        });
      } catch (error) {
        return fail(res, error);
      }
    },

    /** Dispatch one request. Kept here so the route registration stays a one-liner in index.js. */
    async handle(req, res, relativePath) {
      const segments = String(relativePath ?? "").split("/").filter((segment) => segment !== "");
      const method = (req.method ?? "GET").toUpperCase();

      if (segments.length === 0) {
        if (method === "POST") return this.create(req, res);
        if (method === "GET") return this.list(req, res);
        return methodNotAllowed(res, ["GET", "POST"]);
      }

      const upload_id = segments[0];
      if (segments.length === 1) {
        if (method === "PATCH" || method === "PUT") return this.append(req, res, upload_id);
        if (method === "GET") return this.status(req, res, upload_id);
        if (method === "DELETE") return this.cancel(req, res, upload_id);
        return methodNotAllowed(res, ["GET", "PATCH", "PUT", "DELETE"]);
      }

      if (segments.length === 2 && segments[1] === "complete") {
        if (method === "POST") return this.complete(req, res, upload_id);
        return methodNotAllowed(res, ["POST"]);
      }

      return sendJson(res, 404, { ok: false, code: "UPLOAD_ROUTE_UNKNOWN", error: `unknown upload endpoint: ${relativePath}` });
    }
  };
}
