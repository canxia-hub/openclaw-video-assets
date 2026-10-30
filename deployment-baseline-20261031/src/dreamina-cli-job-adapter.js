/**
 * REN-11: the real provider adapter for the durable generation queue.
 *
 * Before this module the queue had `adapter = null` in every deployment path, so
 * `processGenerationJob` could only ever answer `GENERATION_PROVIDER_UNAVAILABLE`. Claiming "real
 * generation is supported" while nothing implements `submit` is exactly the over-claim this work
 * package has to remove, so the adapter below implements the full contract the queue calls:
 *
 *   submit · poll · download · validate · ingest · writeback · reconcile · reconcilePhase · cancel
 *
 * Boundaries this module keeps deliberately visible:
 *   * Every provider call goes through the REN-02 gateway (`service.callProvider`) using the trusted
 *     context carried from the queue entry. No trusted context means *no call* - the adapter fails
 *     closed rather than invoking the CLI un-gated. The CLI runner is injectable so the contract can
 *     be exercised with zero network, and that injection point is the *supplier boundary only*.
 *   * Anything the CLI cannot answer is reported as unknown and handed to manual reconciliation
 *     instead of being guessed: the CLI exposes no documented status/cancel API for an accepted
 *     submission beyond `query_result`, so `reconcile` never invents a submission fact.
 *   * `reconcilePhase` answers phase questions from durable local facts (recorded files, asset rows,
 *     canvas writebacks). A phase whose effect cannot be proven is answered with "unknown", which
 *     parks the job for an operator; it is never answered with a comfortable guess.
 */
import fs from "node:fs";
import path from "node:path";
import { sha256File, ffprobeJson, probeSummary } from "./sop-v2-media.js";
import { isGenerationRefusal, withTrustedContext } from "./provider-gateway.js";
import { budgetLedgerIdForJob } from "./generation-jobs.js";

export const DREAMINA_JOB_ENTRY = Object.freeze({
  video: "dreamina.video.generate",
  image: "dreamina.image.generate"
});

export const ADAPTER_ERROR = Object.freeze({
  AUTHORIZATION_DENIED: "GENERATION_PROVIDER_AUTHORIZATION_DENIED",
  INVALID_REQUEST: "GENERATION_PROVIDER_INVALID_REQUEST",
  CLI_UNAVAILABLE: "GENERATION_PROVIDER_CLI_UNAVAILABLE",
  CLI_FAILED: "GENERATION_PROVIDER_CLI_FAILED",
  PROTOCOL: "GENERATION_PROVIDER_PROTOCOL",
  POLL_TIMEOUT: "GENERATION_POLL_TIMEOUT",
  POLL_REFUSED: "GENERATION_POLL_REFUSED",
  POLL_UNRESOLVED: "GENERATION_POLL_UNRESOLVED",
  NO_OUTPUTS: "GENERATION_PROVIDER_NO_OUTPUTS",
  MEDIA_INVALID: "GENERATION_MEDIA_VALIDATION_FAILED",
  DOWNLOAD_UNPROVEN: "GENERATION_DOWNLOAD_UNPROVEN"
});

/**
 * Interval floor used when the query-attempt budget is DERIVED from the polling window.
 *
 * The old derivation divided by the raw interval, so a 5ms interval turned a 5s window into roughly a
 * thousand provider queries (REN-12 finding F4). One second is the fastest cadence at which polling a
 * paid provider for a long-running generation is defensible.
 */
export const MIN_QUERY_INTERVAL_MS = 1000;
export const MIN_QUERY_ATTEMPTS = 3;
export const MAX_QUERY_ATTEMPTS = 60;

/**
 * Request fields each generation type cannot run without.
 *
 * Checked by `assertRequestComplete` BEFORE the adapter builds argv, so a missing field is a
 * parameter-level refusal in this process instead of a dangling CLI flag, an argparse error at the
 * provider, or a silently different paid operation (REN-12 finding F1).
 */
export const REQUIRED_REQUEST_FIELDS = Object.freeze({
  image2video: Object.freeze(["image_path", "prompt", "duration", "video_resolution", "model_version"]),
  text2video: Object.freeze(["prompt", "duration", "ratio", "video_resolution", "model_version"]),
  multimodal2video: Object.freeze(["prompt", "duration", "ratio", "video_resolution", "model_version"]),
  image: Object.freeze(["prompt", "ratio", "resolution_type", "model_version"]),
  image2image: Object.freeze(["image_path", "prompt", "ratio", "resolution_type", "model_version"]),
  cover: Object.freeze(["prompt", "ratio", "resolution_type", "model_version"]),
  edit: Object.freeze(["image_path", "prompt", "ratio", "resolution_type", "model_version"])
});

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

/**
 * Parameter-level completeness check for one request.
 *
 * `buildArgv` calls it first and turns a negative verdict into the refusal, so a missing field never
 * becomes a dangling CLI flag; the structured verdict is returned rather than thrown so a caller (or a
 * report) can name the fields that were missing.
 */
export function requestCompleteness({ kind, request = {} } = {}) {
  const required = REQUIRED_REQUEST_FIELDS[kind];
  if (!required) return { ok: false, kind, missing: [], unsupported: true, reason: `unsupported generation_type for the Dreamina CLI adapter: ${kind}` };
  const missing = required.filter((field) => isBlank(request[field]));
  // A multimodal request needs at least one reference of some kind; without it the CLI would be asked
  // to generate from nothing.
  const noReferences = kind === "multimodal2video"
    && [request.images, request.videos, request.audios].every((list) => !Array.isArray(list) || list.filter((item) => !isBlank(item)).length === 0);
  return {
    ok: missing.length === 0 && !noReferences,
    kind,
    missing,
    requires_one_reference: noReferences,
    unsupported: false
  };
}

/** Strict argv pair: a flag without a value is a bug here, never a dangling argument for the CLI. */
function pushPair(argv, flag, value, context) {
  if (isBlank(value)) throw fail(ADAPTER_ERROR.INVALID_REQUEST, `${flag} needs a value (${context})`);
  argv.push(flag, String(value));
}

function pushList(argv, flag, values, context) {
  const list = Array.isArray(values) ? values.filter((item) => !isBlank(item)) : [];
  if (list.length === 0) throw fail(ADAPTER_ERROR.INVALID_REQUEST, `${flag} needs at least one value (${context})`);
  for (const item of list) argv.push(flag, String(item));
}

/**
 * Still-image codecs. FFprobe reports a PNG/JPEG under `codec_type: video`, so "has a video stream"
 * is not the same question as "is a moving picture" - conflating them is what made the adapter reject
 * a perfectly valid image result for having no audio track.
 */
export const IMAGE_CODECS = Object.freeze(new Set([
  "png", "mjpeg", "jpeg", "ljpeg", "webp", "bmp", "gif", "tiff", "heif", "avif", "jpegls", "jp2k", "jpeg2000", "dpx", "targa"
]));

/**
 * Canonical generation type.
 *
 * The CLI's own subcommands are `image2video` / `text2video` / `multimodal2video` / `image2image`,
 * while several call sites spell the same thing with underscores (`image_to_video`). Accepting only one
 * spelling made a perfectly valid video request fail with "unsupported generation_type", so both are
 * folded into one canonical form here.
 */
export function normalizeGenerationType(value) {
  const compact = String(value ?? "").toLowerCase().replace(/[_\s-]/g, "");
  if (compact === "image2video" || compact === "imagetovideo" || compact === "i2v") return "image2video";
  if (compact === "text2video" || compact === "texttovideo" || compact === "t2v") return "text2video";
  if (compact === "multimodal2video" || compact === "multimodaltovideo") return "multimodal2video";
  if (compact === "image2image" || compact === "imagetoimage" || compact === "i2i") return "image2image";
  if (compact === "upscale" || compact === "imageupscale") return "imageupscale";
  if (compact === "text2image" || compact === "texttoimage") return "image";
  return compact;
}

const IMAGE_GENERATION_TYPES = Object.freeze(new Set(["image", "image2image", "cover", "edit", "imageupscale"]));

/** Which kind of media this job is expected to produce. Derived from the entry, then the request. */
export function expectedMediaKind({ entry = null, request = null } = {}) {
  if (entry === DREAMINA_JOB_ENTRY.image) return "image";
  if (entry === DREAMINA_JOB_ENTRY.video) return "video";
  const kind = normalizeGenerationType(request?.generation_type ?? "");
  if (IMAGE_GENERATION_TYPES.has(kind)) return "image";
  if (kind === "image2video" || kind === "text2video" || kind === "multimodal2video") return "video";
  // An unrecognised request still defaults to video: the paid video entry is the only one that reaches
  // here without a request, and refusing to validate would be worse than validating against the stricter
  // expectation.
  return "video";
}

function fail(code, message, extra = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/** The provider-call allowance the gateway published for one authorization (1 when it said nothing). */
function callAllowanceOf(audit) {
  const raw = audit?.audit?.calls_max ?? audit?.audit?.provider_calls_max ?? null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 1;
}

/**
 * The most specific refusal code inside an error chain.
 *
 * A gateway refusal reaches the adapter in one of two shapes: the gateway's own denial code (from
 * `authorize`) or the adapter's wrapper (`GENERATION_PROVIDER_AUTHORIZATION_DENIED`) carrying the
 * gateway's verdict in `gateway.code`. Callers want the VERDICT - `GENERATION_BUDGET_EXCEEDED`,
 * `GENERATION_ACTOR_NOT_ALLOWED`, `GENERATION_AUTHORIZATION_EXPIRED` - so it is what gets reported.
 */
function refusalCodeOf(error) {
  return error?.gateway?.code ?? error?.refusal_code ?? error?.code ?? null;
}

/** Keep an error/diagnostic payload readable without letting it dominate the record. */
function clipText(value, limit = 300) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]` : text;
}

function parseCliJson(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Collect media URLs and local paths out of an arbitrary CLI result shape. */
function collectMediaRefs(value, acc = { urls: [], paths: [] }) {
  if (value === null || value === undefined) return acc;
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) acc.urls.push(value);
    else if (/\.(mp4|mov|webm|png|jpg|jpeg|webp)$/i.test(value)) acc.paths.push(value);
    return acc;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMediaRefs(item, acc);
    return acc;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) collectMediaRefs(item, acc);
  }
  return acc;
}

export class DreaminaCliJobAdapter {
  /**
   * @param {object} options
   * @param {object} options.service      VideoAssetService (used for the gateway, ingest and writeback)
   * @param {string} [options.executable] CLI executable; the gateway owns the real invocation
   * @param {string} options.downloadRoot where provider outputs land
   * @param {Function} [options.cliRunner] supplier-boundary injection for zero-network contract tests
   * @param {Function} [options.prober]   ffprobe replacement for tests
   * @param {Function} [options.sleep]    waiting primitive, injectable so tests do not really wait
   */
  constructor({
    service,
    executable = null,
    downloadRoot,
    cliRunner = null,
    fetchImpl = globalThis.fetch,
    fetchTimeoutMs = 60000,
    fetchAttempts = 3,
    prober = null,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollIntervalMs = 5000,
    pollTimeoutMs = 300000,
    maxQueryAttempts = null,
    logger = console,
    ffprobePath = null
  } = {}) {
    if (!service) throw new Error("service is required");
    if (!downloadRoot) throw new Error("downloadRoot is required");
    this.service = service;
    this.executable = executable;
    this.downloadRoot = downloadRoot;
    this.cliRunner = cliRunner;
    this.fetchImpl = fetchImpl;
    // REN-11 fix round (D4): the download used a bare `fetch(url)`, so one hung signed-object response
    // (observed: undici BodyTimeoutError) ended an already-paid run with no retry. Each attempt now has a
    // hard timeout; attempts are bounded and spaced. `fetchImpl` stays the injection seam (a deployment
    // may still supply its own retrying/curl-fallback implementation).
    this.fetchTimeoutMs = Number.isFinite(Number(fetchTimeoutMs)) && Number(fetchTimeoutMs) > 0 ? Number(fetchTimeoutMs) : 60000;
    this.fetchAttempts = Number.isFinite(Number(fetchAttempts)) && Number(fetchAttempts) > 0 ? Math.trunc(Number(fetchAttempts)) : 3;
    this.prober = prober ?? ((file) => ffprobeJson(file, { ffprobePath }));
    this.sleep = sleep;
    this.pollIntervalMs = pollIntervalMs;
    this.pollTimeoutMs = pollTimeoutMs;
    this.logger = logger;
    this.executable = executable ?? process.env.REN11_DREAMINA_CLI ?? null;
    this.codec = executable ?? "dreamina (gateway default)";
    // One paid authorization per job PHASE (submit / poll), not per CLI call. The gateway reserves the
    // entry's estimate once for the job's trusted budget scope (`budgetScopeFor`), so the preflight,
    // the generate call, the recheck and the read-only queries share one reservation; and the calls a
    // phase is allowed to make are exactly the ones the entry's `provider_calls_max` was sized for
    // (credit preflight + generate + credit recheck).
    this.authorizations = new Map();
    // Provider calls made under the CURRENT authorization of a job (reset by every rotation) and the
    // cumulative count for the job. Keeping them apart is what makes the rotation trigger comparable
    // with the gateway's own allowance: the old single counter was reset on every rotation, so it could
    // never exceed 1 and the rotation condition was unreachable.
    this.authorizationCalls = new Map();
    this.providerCalls = new Map();
    // Async submit is the default (`--poll 0` = submit and return). `poll` handles BOTH provider
    // behaviours: if the CLI blocks anyway and its submit response already carries a terminal status,
    // poll uses it without issuing a query; otherwise it queries by the returned request id.
    this.defaultCliPollSeconds = 0;
    // Bound on read-only query attempts, so a never-finishing job cannot turn polling into an
    // unbounded sequence of provider calls. Derived from the polling window with a FLOOR on the
    // interval used in the derivation and a hard ceiling: dividing by the raw interval let a 5ms
    // interval turn a 5s window into ~1000 provider queries (finding F4).
    const derivedAttempts = Math.ceil(pollTimeoutMs / Math.max(MIN_QUERY_INTERVAL_MS, this.pollIntervalMs));
    this.maxQueryAttempts = Number.isFinite(Number(maxQueryAttempts)) && Number(maxQueryAttempts) > 0
      ? Math.trunc(Number(maxQueryAttempts))
      : Math.max(MIN_QUERY_ATTEMPTS, Math.min(MAX_QUERY_ATTEMPTS, derivedAttempts));
  }

  describe() {
    return {
      adapter: "dreamina_cli_job_adapter",
      provider: "dreamina_cli",
      cli_callsign: this.codec,
      supplier_boundary: this.cliRunner ? "injected_runner" : "service_provider_gateway",
      argv_contract: this.cliRunner
        ? "runner receives [executable, ...args]"
        : "gateway receives args only; the service owns the executable",
      authorization_model: "one authorization per job phase (submit / poll), released when the phase ends; the paid estimate is reserved once per JOB through the trusted budget scope, not once per provider call",
      provider_calls_per_job_phase_max: "entry policy provider_calls_max, published on the authorization record; the adapter rotates to a fresh bounded authorization instead of exceeding it",
      provider_call_classes: "read_only (user_credit / query_result) vs paid (every generation subcommand), classified from the argv against the server-side list",
      poll_behavior: "async submit id + bounded read-only query_result polling; a never-terminal job stays unknown for reconciliation",
      media_validation: "per media kind (image vs video) and per declared audio requirement",
      phases_implemented: ["submit", "poll", "download", "validate", "ingest", "writeback"],
      reconciliation: { submission: "local evidence only; otherwise indeterminate", phase: "durable local facts, all files, park when unprovable" },
      cancel: "unsupported_by_provider_cli"
    };
  }

  entryFor(request) {
    // Explicit allowlist, never a prefix test: `image_to_video` starts with "image" but belongs to
    // the video entry, and picking the wrong entry changes which cost estimate and which policy the
    // gateway applies (it was denied as an unknown-cost image entry before this was fixed).
    return IMAGE_GENERATION_TYPES.has(normalizeGenerationType(request?.generation_type ?? ""))
      ? DREAMINA_JOB_ENTRY.image
      : DREAMINA_JOB_ENTRY.video;
  }

  /**
   * One provider invocation, under the job's single authorization.
   *
   * Two interface facts are fixed here because they were wrong before:
   *   * the gateway path sends **args only**. The service's Dreamina adapter owns the executable
   *     (`execFile(executable, args)`), so an executable placed in argv would be handed to the CLI as
   *     its first argument - `dreamina <path-to-dreamina.exe> image2video ...`.
   *   * the injected runner (the zero-network test seam) receives `[executable, ...args]`, which is the
   *     argv shape a process runner needs.
   */
  async callCli({ argv, context, timeoutMs = 300000, entry = null, job_id = null, budget_scope = null, intent = "paid" }) {
    if (typeof this.cliRunner === "function") {
      const runnerArgv = this.executable ? [this.executable, ...argv] : [...argv];
      const result = await this.cliRunner({ argv: runnerArgv, args: argv, context, timeoutMs, job_id });
      const calls = (this.providerCalls.get(job_id) ?? 0) + 1;
      this.providerCalls.set(job_id, calls);
      return { stdout: String(result?.stdout ?? ""), stderr: String(result?.stderr ?? ""), via: "injected_runner", argv_mode: "runner_received_executable", provider_calls: calls };
    }
    if (!context || context.trusted !== true) {
      throw fail(ADAPTER_ERROR.AUTHORIZATION_DENIED,
        "the generation queue handed over no trusted caller context, so the provider gateway cannot authorise a paid call");
    }
    const scope = budget_scope ?? null;
    let audit = this.beginJobAuthorization({ entry, context, job_id, budget_scope: scope, intent });
    // Rotate when the allowance the gateway PUBLISHED on the record is used up (the gateway consumes an
    // authorization after `provider_calls_max` calls), so a long polling phase keeps a live but strictly
    // bounded grant. Before the contract fix `calls_max` was absent and this fell back to 1, which
    // force-rotated every call into a fresh authorization - and a fresh budget reservation with it.
    const callsMax = callAllowanceOf(audit);
    if ((this.authorizationCalls.get(job_id) ?? 0) >= callsMax) {
      audit = this.beginJobAuthorization({ entry, context, job_id, force: true, budget_scope: scope, intent });
    }
    const calls = (this.providerCalls.get(job_id) ?? 0) + 1;
    this.providerCalls.set(job_id, calls);
    this.authorizationCalls.set(job_id, (this.authorizationCalls.get(job_id) ?? 0) + 1);
    const outcome = await this.service.callProvider({ audit, payload: { argv, timeoutMs } });
    return {
      stdout: String(outcome?.stdout ?? ""),
      stderr: String(outcome?.stderr ?? ""),
      via: "provider_gateway",
      argv_mode: "args_only_gateway_owns_binary",
      provider_calls: calls,
      audit_id: audit?.audit_id ?? null,
      calls_max: callsMax
    };
  }

  /**
   * The trusted budget scope of one job.
   *
   * The key is the DURABLE ledger row the queue created when the job was created
   * (`budgetLedgerIdForJob`), which is what makes the gateway's reservation and the queue's reservation
   * the same row: one paid estimate per job, and a restarted process reuses it instead of reserving
   * again. It comes from the queue's own row, never from a request field.
   */
  budgetScopeFor(job, intent = "paid") {
    const jobId = job?.job_id ?? null;
    if (!jobId) return null;
    const key = typeof job?.budget_ledger_id === "string" && job.budget_ledger_id.trim()
      ? job.budget_ledger_id.trim()
      : budgetLedgerIdForJob(jobId);
    return { key, kind: "job", intent };
  }

  /**
   * Hold a live authorization for this job's current phase.
   *
   * `force` closes whatever is live first. Rotation exists because the gateway consumes an
   * authorization after `provider_calls_max` calls: a polling phase that issues more read-only queries
   * than one authorization allows must start a new one rather than fail midway. Each authorization is
   * still a bounded, audited, single-phase grant - never an open-ended one.
   */
  beginJobAuthorization({ entry, context, job_id, force = false, budget_scope = null, intent = "paid" }) {
    if (force && this.authorizations.has(job_id)) this.closeJobAuthorization(job_id, "calls-consumed");
    const existing = this.authorizations.get(job_id);
    if (existing) return existing;
    if (!entry) throw fail(ADAPTER_ERROR.PROTOCOL, "a paid provider call needs an entry id");
    const audit = this.service.beginGeneration({
      entry,
      input: withTrustedContext({}, context),
      // The queue already refused to create this job without `confirm_cost: true`, so carrying that
      // confirmation into the gateway is a restatement of the caller's decision, not a new consent.
      params: { confirm_cost: true },
      // Trusted, plugin-supplied reservation scope: the job's durable ledger row, plus what this
      // authorization is FOR - a new paid submission, or read-only collection of a result the provider
      // already accepted (whose reservation must not be re-charged against a lowered budget).
      budget_scope: budget_scope ?? this.budgetScopeFor({ job_id }, intent)
    });
    if (!audit.allowed) {
      throw fail(ADAPTER_ERROR.AUTHORIZATION_DENIED,
        `provider gateway refused the call: ${audit.code} ${audit.error ?? ""}`.trim(),
        { gateway: audit.public, refusal_code: audit.code ?? null });
    }
    this.authorizations.set(job_id, audit);
    this.authorizationCalls.set(job_id, 0);
    return audit;
  }

  /** Close this job's authorization. An audit id that stays live is a replay window. */
  closeJobAuthorization(job_id, outcome = "job-phase-complete") {
    const audit = this.authorizations.get(job_id);
    this.authorizationCalls.set(job_id, 0);
    if (!audit) return { closed: false, reason: "no live authorization" };
    this.authorizations.delete(job_id);
    return this.service.finishGeneration(audit, outcome);
  }

  liveAuthorizations() {
    return [...this.authorizations.keys()];
  }

  /** CLI args (no executable: the gateway owns the binary, the runner prepends it). */
  buildArgv(job) {
    const request = job?.request ?? {};
    const kind = normalizeGenerationType(request.generation_type ?? "image_to_video");
    // Parameter-level refusal BEFORE anything else happens: no authorization is requested, the CLI is
    // never invoked, and the caller gets a structured reason naming the missing fields (finding F1).
    const completeness = requestCompleteness({ kind, request });
    if (completeness.unsupported) throw fail(ADAPTER_ERROR.PROTOCOL, completeness.reason);
    if (!completeness.ok) {
      throw fail(ADAPTER_ERROR.INVALID_REQUEST,
        `the ${kind} request is incomplete: ${completeness.missing.length ? `missing ${completeness.missing.join(", ")}` : "at least one reference (images/videos/audios) is required"}`,
        { generation_type: kind, missing: completeness.missing, requires_one_reference: completeness.requires_one_reference === true });
    }
    const argv = [];
    // Async submit by default: the CLI returns a request id and the poll phase queries it. A blocking
    // `--poll` is still reachable per request when a caller wants it; `poll` copes with both.
    const poll = String(request.cli_poll_seconds ?? this.defaultCliPollSeconds);
    if (kind === "image2video") {
      argv.push("image2video");
      pushPair(argv, "--image", request.image_path, "image2video first frame");
      pushPair(argv, "--prompt", request.prompt, "image2video prompt");
      pushPair(argv, "--duration", request.duration, "image2video duration");
      pushPair(argv, "--video_resolution", request.video_resolution, "image2video resolution");
      pushPair(argv, "--model_version", request.model_version, "image2video model");
      pushPair(argv, "--poll", poll, "image2video poll");
    } else if (kind === "text2video") {
      argv.push("text2video");
      pushPair(argv, "--prompt", request.prompt, "text2video prompt");
      pushPair(argv, "--duration", request.duration, "text2video duration");
      pushPair(argv, "--ratio", request.ratio, "text2video ratio");
      pushPair(argv, "--video_resolution", request.video_resolution, "text2video resolution");
      pushPair(argv, "--model_version", request.model_version, "text2video model");
      pushPair(argv, "--poll", poll, "text2video poll");
    } else if (kind === "multimodal2video") {
      argv.push("multimodal2video");
      if (Array.isArray(request.images) && request.images.some((item) => !isBlank(item))) pushList(argv, "--image", request.images, "multimodal2video images");
      if (Array.isArray(request.videos) && request.videos.some((item) => !isBlank(item))) pushList(argv, "--video", request.videos, "multimodal2video videos");
      if (Array.isArray(request.audios) && request.audios.some((item) => !isBlank(item))) pushList(argv, "--audio", request.audios, "multimodal2video audios");
      pushPair(argv, "--prompt", request.prompt, "multimodal2video prompt");
      pushPair(argv, "--duration", request.duration, "multimodal2video duration");
      pushPair(argv, "--ratio", request.ratio, "multimodal2video ratio");
      pushPair(argv, "--video_resolution", request.video_resolution, "multimodal2video resolution");
      pushPair(argv, "--model_version", request.model_version, "multimodal2video model");
      pushPair(argv, "--poll", poll, "multimodal2video poll");
    } else if (kind === "image" || kind === "image2image" || kind === "cover" || kind === "edit") {
      // An image-to-image / edit request without a source image used to fall through to a text2image
      // submission: a different PAID operation than the one that was requested. The completeness check
      // above requires `image_path` for exactly these two kinds, so that fallback is unreachable now.
      if (kind === "image2image" || kind === "edit") {
        argv.push("image2image");
        pushPair(argv, "--images", request.image_path, `${kind} source image`);
        pushPair(argv, "--prompt", request.prompt, `${kind} prompt`);
        pushPair(argv, "--resolution_type", request.resolution_type, `${kind} resolution`);
        pushPair(argv, "--model_version", request.model_version, `${kind} model`);
        pushPair(argv, "--ratio", request.ratio, `${kind} ratio`);
        pushPair(argv, "--poll", poll, `${kind} poll`);
      } else {
        argv.push("text2image");
        pushPair(argv, "--prompt", request.prompt, "text2image prompt");
        pushPair(argv, "--ratio", request.ratio, "text2image ratio");
        pushPair(argv, "--resolution_type", request.resolution_type, "text2image resolution");
        pushPair(argv, "--model_version", request.model_version, "text2image model");
        pushPair(argv, "--generate_num", request.generate_num ?? 1, "text2image image count");
        pushPair(argv, "--poll", poll, "text2image poll");
      }
    } else {
      throw fail(ADAPTER_ERROR.PROTOCOL, `unsupported generation_type for the Dreamina CLI adapter: ${request.generation_type}`);
    }
    // No element filtering: every flag is pushed with a validated value, so a dangling flag cannot be
    // constructed in the first place (the old `.filter()` removed the value and kept the flag).
    return argv;
  }

  // ---- queue contract -------------------------------------------------------------------------

  /**
   * Submit: credit preflight → generate → credit recheck, all under this phase's authorization.
   *
   * The three calls are exactly what the entry's `provider_calls_max` sizes for, and they are what
   * makes the cost figure *measured*: the delta between the two credit reads is provider evidence, while
   * the response's own credit field is only accepted when the provider actually reports one. When
   * neither exists the fact is `unmeasured` - never 0, never the estimate relabelled as actual.
   */
  async submit(job, { context = null } = {}) {
    const entry = job.entry ?? this.entryFor(job.request);
    const argv = this.buildArgv(job);
    const timeoutMs = job.request?.timeout_ms ?? 300000;
    const runPreflight = job.request?.credit_preflight !== false;
    try {
      const preflight = runPreflight ? await this.readCredits({ context, job, entry }) : null;
      const result = await this.callCli({ argv, context, job_id: job.job_id, entry, timeoutMs, budget_scope: this.budgetScopeFor(job) });
      const parsed = parseCliJson(result.stdout);
      if (!parsed) {
        throw fail(ADAPTER_ERROR.PROTOCOL, `provider returned no parsable JSON for job ${job.job_id}`, { stderr: result.stderr.slice(-500) });
      }
      const submitId = parsed.submit_id ?? parsed.submitId ?? parsed.id ?? null;
      if (!submitId) {
        throw fail(ADAPTER_ERROR.PROTOCOL, `provider response carried no submit id for job ${job.job_id}`, { parsed_keys: Object.keys(parsed) });
      }
      const recheck = runPreflight ? await this.readCredits({ context, job, entry }) : null;
      return {
        provider_request_id: String(submitId),
        provider_response: parsed,
        argv,
        argv_mode: result.argv_mode,
        via: result.via,
        provider_calls: result.provider_calls ?? null,
        provider_status: parsed.gen_status ?? null,
        credits: creditEvidence({ preflight, recheck, parsed })
      };
    } finally {
      // The submit phase owns the generate call, so its authorization ends with the phase.
      this.closeJobAuthorization(job.job_id, "submit-phase-complete");
    }
  }

  /** Read the account credit balance; null (not a guess) when it cannot be read. */
  async readCredits({ context, job, entry }) {
    try {
      const result = await this.callCli({ argv: ["user_credit"], context, job_id: job.job_id, entry, budget_scope: this.budgetScopeFor(job), timeoutMs: 90000 });
      const parsed = parseCliJson(result.stdout);
      const value = firstFinite(parsed, ["credit", "total_credit", "credits", "remaining_credit", "balance"]);
      if (value === null) return { value: null, keys: parsed ? Object.keys(parsed) : [], unavailable_reason: "the provider response carried no recognised credit field" };
      return { value, keys: parsed ? Object.keys(parsed) : [] };
    } catch (error) {
      // A refusal is a DECISION, not a failed read: reporting `null` here is exactly what let a budget
      // or identity denial ride through the preflight and surface later as an unknown poll outcome
      // (finding F4). Only a genuinely transient read failure returns an explicit "unavailable" fact.
      if (isGenerationRefusal(error)) {
        throw fail(ADAPTER_ERROR.AUTHORIZATION_DENIED,
          `the credit read was refused by the generation gate (${refusalCodeOf(error) ?? "unknown"}): ${error?.message ?? error}`,
          { refusal_code: refusalCodeOf(error), refusal_message: error?.message ?? String(error), phase: "credit_preflight" });
      }
      const cause = { code: error?.code ?? null, message: error?.message ?? String(error) };
      this.logger?.warn?.(`[ren11] credit read unavailable for job ${job.job_id}: ${cause.code ?? "no code"} ${cause.message}`);
      return { value: null, keys: [], unavailable_reason: "the credit read failed with a transient error", error: cause };
    }
  }

  /**
   * Poll by request id using read-only `query_result` calls.
   *
   * The asynchronous request id is preserved on purpose: dropping it in favour of a blocking submit
   * would remove the only way to recover a job whose submit call returned before the provider finished.
   * What is bounded here instead is the *querying*: a finite attempt budget, a wall-clock deadline, and
   * each call made under a live, single-phase authorization (rotated when its call allowance is used
   * up) rather than as an un-authorized side call.
   */
  async poll(job, { context = null } = {}) {
    const submit = job.result?.submit ?? {};
    const submitted = submit.provider_response ?? null;
    const submitStatus = submitted?.gen_status ?? null;
    // A blocking CLI (or a provider that finishes fast) already answered: no query is needed.
    if (submitStatus === "success") {
      return { status: "succeeded", gen_status: submitStatus, source: "submit_response", attempts: 0, credits: submit.credits ?? unmeasuredCredits(), actual_credits: measuredCreditValue(submit.credits) };
    }
    if (submitStatus && TERMINAL_FAILURE_STATUSES.has(String(submitStatus))) {
      throw fail(ADAPTER_ERROR.CLI_FAILED, `provider reported terminal status ${submitStatus} for job ${job.job_id}`, { response: submitted });
    }
    const requestId = job.provider_request_id ?? submitted?.submit_id ?? null;
    if (!requestId) throw fail(ADAPTER_ERROR.PROTOCOL, "poll called without a provider request id");
    const entry = job.entry ?? this.entryFor(job.request);
    const scope = this.budgetScopeFor(job, "read_only");
    const deadline = Date.now() + this.pollTimeoutMs;
    let attempts = 0;
    let last = null;
    let lastError = null;
    try {
      while (attempts < this.maxQueryAttempts && Date.now() < deadline) {
        attempts += 1;
        try {
          const result = await this.callCli({
            argv: ["query_result", `--submit_id=${requestId}`],
            context,
            job_id: job.job_id,
            entry,
            budget_scope: scope,
            // Collection of an accepted submission, not a new paid operation.
            intent: "read_only",
            timeoutMs: Math.min(120000, Math.max(5000, deadline - Date.now()))
          });
          last = parseCliJson(result.stdout);
        } catch (error) {
          // Two different kinds of failure, two different answers (finding F4): a REFUSAL is a decision
          // that will not change by asking again, so it stops the loop and is reported as itself (with
          // the underlying refusal code) instead of being buried at the end of the attempt budget; only
          // a transient read failure is retried, and only inside the bounded budget.
          if (isGenerationRefusal(error)) {
            const refusalCode = refusalCodeOf(error);
            throw fail(ADAPTER_ERROR.POLL_REFUSED,
              `the poll phase was refused by the generation gate (${refusalCode ?? "unknown"}), so the job must not keep querying: ${error?.message ?? error}`,
              {
                refusal_code: refusalCode,
                refusal_message: error?.message ?? String(error),
                query_attempts: attempts - 1,
                last_response: last,
                query_calls_are_read_only: true,
                blind_retry: false
              });
          }
          lastError = { code: error?.code ?? null, message: error?.message ?? String(error) };
          if (attempts < this.maxQueryAttempts && Date.now() < deadline) await this.sleep(this.pollIntervalMs);
          continue;
        }
        const status = last?.gen_status ?? null;
        if (status === "success") {
          const credits = creditEvidenceFromResponse(last);
          return { status: "succeeded", gen_status: status, attempts, source: "query_result", credits, actual_credits: measuredCreditValue(credits), response: last };
        }
        if (status && TERMINAL_FAILURE_STATUSES.has(String(status))) {
          throw fail(ADAPTER_ERROR.CLI_FAILED, `provider reported terminal status ${status} for job ${job.job_id}`, { response: last });
        }
        if (attempts < this.maxQueryAttempts && Date.now() < deadline) await this.sleep(this.pollIntervalMs);
      }
    } finally {
      // The poll phase owns its own authorization: leaving it live until the TTL would leave the audit id
      // the caller already holds replayable for 15 minutes.
      this.closeJobAuthorization(job.job_id, "poll-phase-complete");
    }
    // Not knowing is not success and not failure: the queue parks this row for reconciliation rather
    // than retrying the submission (which could pay twice) or inventing an outcome.
    throw fail(ADAPTER_ERROR.POLL_UNRESOLVED,
      `provider did not report a terminal status after ${attempts} read-only queries within ${this.pollTimeoutMs}ms; the outcome stays unknown and must be reconciled`, {
        attempts,
        max_attempts: this.maxQueryAttempts,
        last_response: last,
        last_error: lastError,
        query_calls_are_read_only: true,
        blind_retry: false
      });
  }

  async download(job, { context = null } = {}) {
    const references = collectMediaRefs(job.result?.poll?.response ?? job.result?.submit?.provider_response ?? null);
    const targetDir = path.join(this.downloadRoot, job.job_id);
    fs.mkdirSync(targetDir, { recursive: true });
    const files = [];
    for (const [index, url] of references.urls.entries()) {
      const parsedUrl = new URL(url);
      const extension = path.extname(parsedUrl.pathname) || ".mp4";
      const target = path.join(targetDir, `provider-${index + 1}${extension}`);
      if (typeof this.fetchImpl !== "function") {
        throw fail(ADAPTER_ERROR.DOWNLOAD_UNPROVEN, "no fetch implementation is available to materialise provider output URLs");
      }
      const buffer = await this.#fetchWithRetry(url, target, job.job_id);
      fs.writeFileSync(target, buffer);
      files.push({ path: target, bytes: buffer.length, sha256: await sha256File(target), source_url: url });
    }
    for (const localPath of references.paths) {
      if (fs.existsSync(localPath)) {
        files.push({ path: localPath, bytes: fs.statSync(localPath).size, sha256: await sha256File(localPath), source: "cli_local_path" });
      }
    }
    if (files.length === 0) throw fail(ADAPTER_ERROR.NO_OUTPUTS, `provider reported success but exposed no downloadable output for job ${job.job_id}`);
    return { files, downloaded_at: new Date().toISOString() };
  }

  /**
   * Bounded, timed download of one provider output.
   *
   * "Unknown" is never turned into "failed" here: a download that never answered is reported as
   * DOWNLOAD_UNPROVEN with every attempt listed, because the queue may still be able to reconcile it -
   * and because a paid submission must not be discarded on a transport hiccup.
   */
  async #fetchWithRetry(url, target, jobId) {
    const attempts = [];
    for (let attempt = 1; attempt <= this.fetchAttempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.fetchTimeoutMs), redirect: "follow" });
        if (!response?.ok) throw new Error(`status ${response?.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length) throw new Error("empty body");
        attempts.push({ attempt, bytes: buffer.length });
        return buffer;
      } catch (error) {
        attempts.push({ attempt, timeout_ms: this.fetchTimeoutMs, error: clipText(String(error?.message ?? error), 300) });
        if (attempt < this.fetchAttempts) await this.sleep(500 * attempt);
      }
    }
    throw fail(ADAPTER_ERROR.DOWNLOAD_UNPROVEN, `provider output could not be materialised after ${attempts.length} attempt(s) for job ${jobId}`, {
      url,
      target,
      timeout_ms: this.fetchTimeoutMs,
      attempts_bounded: this.fetchAttempts,
      attempts,
      note: "供应商已受理该任务；下载未完成不等于任务失败，推荐使用 reconcile 核对后重试下载阶段。"
    });
  }

  /**
   * Media-kind aware validation, plus the honest non-answer for submission reconciliation.
   *
   * The defect this replaces: "has a video stream" and "has an audio stream" were demanded of *every*
   * output, so a PNG (which ffprobe reports under `codec_type: video`) was rejected for having no
   * audio track. Media kind and audio requirement are now derived from the entry/request, and each
   * file's observed streams are reported so the decision is auditable.
   */
  async validate(job) {
    const files = job.result?.download?.files ?? [];
    if (files.length === 0) throw fail(ADAPTER_ERROR.MEDIA_INVALID, "no downloaded file to validate");
    const mediaKind = expectedMediaKind({ entry: job.entry, request: job.request });
    // Audio is required only when declared: images never carry one, and a video request may set
    // `require_audio: false` instead of being failed for a legitimately silent output.
    const audioRequired = mediaKind === "video" && job.request?.require_audio !== false;
    const checks = [];
    for (const file of files) {
      const probe = await this.prober(file.path);
      const summary = probeSummary(probe);
      const streams = (probe?.streams ?? []).filter((stream) => stream.codec_type === "video");
      // A still image is reported as a video stream by ffprobe; classify by codec and frame count.
      const stills = streams.filter((stream) => IMAGE_CODECS.has(String(stream.codec_name ?? "").toLowerCase())
        || Number(stream.nb_frames) === 1);
      const moving = streams.filter((stream) => !stills.includes(stream));
      const problems = [];
      if (mediaKind === "image") {
        if (streams.length === 0) problems.push("no image stream");
        else if (stills.length === 0) problems.push("expected a still image but the output carries only a moving-picture stream");
      } else {
        if (streams.length === 0) problems.push("no video stream");
        else if (moving.length === 0) problems.push("expected a moving-picture stream but the output is a still image");
      }
      if (audioRequired && !summary.audio) problems.push("no audio stream while the request declares an audio track");
      if (summary.video && job.request?.width && summary.video.width !== job.request.width) problems.push(`width ${summary.video.width} != ${job.request.width}`);
      if (summary.video && job.request?.height && summary.video.height !== job.request.height) problems.push(`height ${summary.video.height} != ${job.request.height}`);
      checks.push({
        path: file.path,
        media_kind: mediaKind,
        audio_required: audioRequired,
        streams: { video: streams.length, still: stills.length, moving: moving.length, audio: summary.audio ? 1 : 0 },
        summary,
        problems,
        ok: problems.length === 0
      });
    }
    const failed = checks.filter((check) => !check.ok);
    if (failed.length) {
      throw fail(ADAPTER_ERROR.MEDIA_INVALID, `provider output failed media validation: ${failed[0].problems.join(", ")}`, { checks, media_kind: mediaKind, audio_required: audioRequired });
    }
    return { checks, media_kind: mediaKind, audio_required: audioRequired, validated_at: new Date().toISOString() };
  }

  async ingest(job) {
    const files = job.result?.download?.files ?? [];
    const ingested = [];
    for (const file of files) {
      const asset = await this.service.ingestAsset({
        file_path: file.path,
        kind: "raw",
        title: job.request?.title ?? `provider output ${job.job_id}`,
        description: `generation job ${job.job_id} · provider=${job.provider} · request_id=${job.provider_request_id}`,
        tags: ["provider_generated", job.provider, job.entry].filter(Boolean),
        source: {
          source_type: "provider_generated",
          url: file.source_url ?? null,
          notes: `sop generation job ${job.job_id}; 供应商产物授权状态默认 unknown`
        },
        change_summary: `generation job ${job.job_id}`
      });
      // Rights are deliberately left at the service default (unknown): a generated asset from a
      // third-party provider is not automatically cleared for delivery, and this adapter does not
      // have the evidence to say otherwise.
      ingested.push({
        asset_id: asset.asset_id,
        asset_version_id: asset.default_version_id,
        sha256: file.sha256,
        license_status: "unknown_by_default",
        path: file.path
      });
    }
    return { ingested, ingested_at: new Date().toISOString() };
  }

  async writeback(job) {
    const canvasId = job.canvas_id;
    const slotShapeId = job.request?.slot_shape_id ?? null;
    const asset = job.result?.ingest?.ingested?.[0] ?? null;
    if (!asset) throw fail(ADAPTER_ERROR.PROTOCOL, "writeback called without an ingested asset");
    if (canvasId && slotShapeId) {
      const written = await this.service.insertGeneratedAsset({
        canvas_id: canvasId,
        slot_shape_id: slotShapeId,
        file_path: asset.path,
        idempotency_key: `job:${job.job_id}:writeback`,
        title: job.request?.title ?? `provider output ${job.job_id}`,
        kind: "raw"
      });
      return {
        target: "canvas_generation_slot",
        canvas_id: canvasId,
        slot_shape_id: slotShapeId,
        output_shape_id: written?.shape?.shape_id ?? null,
        output_asset_id: written?.asset?.asset_id ?? null,
        // `insertGeneratedAsset` reports a replay as `idempotent.reused`; reading a field it never
        // returns (`idempotent_replay`) made every replay look like a fresh write. Both spellings are
        // accepted so the flag cannot go silently false again if the older name reappears.
        idempotent_replay: written?.idempotent?.reused === true || written?.idempotent_replay === true
      };
    }
    if (job.project_id) {
      const marker = `generation job ${job.job_id}`;
      // Idempotent by marker: a replayed writeback (crash, resume, or a second pass) must reuse the
      // reference it already made instead of attaching the same output to the project twice.
      const existing = (this.service.listProjectRefs({ project_id: job.project_id }) ?? [])
        .find((item) => `${item.notes ?? ""} ${item.usage_scope ?? ""}`.includes(marker));
      if (existing) {
        return {
          target: "project_ref",
          project_id: job.project_id,
          reference_id: existing.reference_id,
          asset_id: existing.asset_id,
          asset_version_id: existing.asset_version_id,
          reused: true
        };
      }
      const ref = this.service.addProjectRef({
        project_id: job.project_id,
        asset_id: asset.asset_id,
        asset_version_id: asset.asset_version_id,
        role: "generated_video",
        usage_scope: marker,
        notes: `${marker}: provider output attached to project (no canvas slot was requested)`
      });
      return { target: "project_ref", project_id: job.project_id, reference_id: ref.reference_id, reused: false };
    }
    return { target: "none", reason: "job has neither canvas_id+slot_shape_id nor project_id; the asset stays in the library" };
  }

  /**
   * Submission reconciliation. Answers "did the provider accept this job?" and nothing else.
   *
   * `found: null` - not `false` - when there is no evidence: "not submitted" and "cannot prove" are
   * different answers, and returning `false` would let a caller read an unprovable submission as a
   * proven absence. The queue parks a null answer for manual reconciliation and never blind-retries.
   * A yes here is still NOT evidence that a post-submit phase left no effect (that is `reconcilePhase`).
   */
  async reconcile(job) {
    const submitted = job.result?.submit?.provider_response ?? null;
    if (submitted?.submit_id || job.provider_request_id) {
      return {
        found: true,
        provider_request_id: String(submitted?.submit_id ?? job.provider_request_id),
        source: submitted ? "local_submit_evidence" : "persisted_request_id"
      };
    }
    return {
      found: null,
      indeterminate: true,
      source: "no_reconcilable_submission_api",
      blind_retry: false,
      note: "即梦 CLI 没有按客户端键查询提交的接口；既不能证明提交存在，也不能证明提交不存在，因此返回 unknown 并交人工对账。"
    };
  }

  /**
   * Phase reconciliation: "did this phase already take effect?" answered from durable local facts.
   * `undefined` (rather than a boolean) means the question could not be answered.
   */
  async reconcilePhase(job, phase) {
    const result = job.result ?? {};
    if (result[phase] !== undefined) return { found: true, value: result[phase] };
    if (phase === "poll") {
      // Without a recorded poll result the outcome is simply unknown: the provider may or may not
      // have finished. Do not guess either way.
      return { found: null, reason: "no recorded poll result; provider finish state is unknown" };
    }
    if (phase === "download") {
      const dir = path.join(this.downloadRoot, job.job_id);
      if (!fs.existsSync(dir)) return { found: false, reason: "no download directory was ever created for this job" };
      const entries = fs.readdirSync(dir);
      if (entries.length === 0) return { found: false, reason: "download directory exists but holds no file" };
      return { found: null, reason: `files exist on disk but no completed download record was committed: ${entries.join(", ")}` };
    }
    if (phase === "validate") {
      // Probing writes nothing, so an interrupted validation left no effect to protect: replaying it
      // is provably safe.
      return { found: false, reason: "validation is side-effect free (probe only); the phase can be re-run safely" };
    }
    if (phase === "ingest") {
      const files = job.result?.download?.files ?? [];
      const targets = files.map((file) => ({ sha256: file.sha256, path: file.path })).filter((target) => target.sha256);
      if (targets.length === 0) return { found: null, reason: "no recorded download hashes, so an ingest cannot be ruled in or out" };
      const statement = this.service.db.prepare(
        "SELECT av.asset_id, av.asset_version_id FROM asset_versions av JOIN assets a ON a.asset_id = av.asset_id WHERE av.sha256 = ? AND instr(lower(COALESCE(a.description,'')), ?) > 0 LIMIT 1"
      );
      const marker = `generation job ${job.job_id}`.toLowerCase();
      const ingested = [];
      for (const target of targets) {
        const row = statement.get(target.sha256, marker);
        // `path` rides along because the writeback phase needs a materialised file to insert, and a
        // reconciliation answer without it hands the caller an asset id it cannot use.
        if (row) ingested.push({ asset_id: row.asset_id, asset_version_id: row.asset_version_id, sha256: target.sha256, path: target.path });
      }
      // EVERY file must be accounted for. "One of two landed" is a partial ingest, which is neither
      // "the phase took effect" nor "it did not": replaying it would duplicate, ignoring it would lose
      // half the job's output, so the honest answer is unknown and a human decides.
      if (ingested.length === targets.length) return { found: true, value: { ingested, reconciled: true } };
      if (ingested.length === 0) return { found: false, reason: `no asset version references any of this job's ${targets.length} download hash(es), so the ingest never landed` };
      return {
        found: null,
        reason: `partial ingest: ${ingested.length} of ${targets.length} download files are referenced by an asset version; the phase cannot be replayed as a whole`,
        partial: ingested
      };
    }
    if (phase === "writeback") {
      const canvasId = job.canvas_id;
      const slotShapeId = job.request?.slot_shape_id ?? null;
      if (canvasId && slotShapeId) {
        const canvas = this.service.getCanvas({ canvas_id: canvasId });
        const existing = this.service.findGeneratedAssetWritebackByIdempotencyKey(canvas, `job:${job.job_id}:writeback`);
        if (existing) return { found: true, value: { target: "canvas_generation_slot", canvas_id: canvasId, slot_shape_id: slotShapeId, reconciled: true, shape_id: existing?.shape?.shape_id ?? null } };
        return { found: false, reason: "no writeback shape carries this job's idempotency key" };
      }
      if (job.project_id) {
        // The writeback phase falls back to a project reference when no canvas slot was requested, so
        // reconciliation has to look there too: answering "could not have landed" just because there is
        // no canvas would declare a write that DID land as absent, and the queue would replay it.
        const refs = this.service.listProjectRefs({ project_id: job.project_id });
        const marker = `generation job ${job.job_id}`;
        const ref = refs.find((item) => `${item.notes ?? ""} ${item.usage_scope ?? ""}`.includes(marker)) ?? null;
        if (ref) {
          return {
            found: true,
            value: { target: "project_ref", project_id: job.project_id, reference_id: ref.reference_id, asset_id: ref.asset_id, asset_version_id: ref.asset_version_id, reconciled: true }
          };
        }
        return { found: false, reason: "no project reference carries this job's marker, and no canvas slot was requested" };
      }
      // Neither target exists, so this phase's own result is the recorded no-op: it has no durable
      // effect to protect and re-running it changes nothing.
      return { found: false, reason: "the job has neither a canvas slot nor a project, so this phase has no durable effect; replaying it is a no-op" };
    }
    return { found: null, reason: `no reconciliation rule for phase ${phase}` };
  }

  async cancel() {
    // Verified against the CLI's own help output for 1.4.18: it exposes list_task/query_result/
    // session/user_credit and no cancel subcommand. Reporting `unsupported` is the honest answer;
    // inventing a local "cancelled" would claim a remote effect that never happened.
    return { cancelled: false, remote_cancel_state: "unsupported", reason: "即梦 CLI 1.4.18 未提供取消子命令（help 实测），无法确认远端取消或退款。" };
  }
}

/** Provider statuses that mean the job will not change on its own. */
const TERMINAL_FAILURE_STATUSES = Object.freeze(new Set(["failed", "error", "cancelled", "canceled"]));

/** The explicit "we did not measure it" cost fact. Never 0, never the estimate. */
export function unmeasuredCredits() {
  return { value: null, measured: false, evidence: "unmeasured", basis: "no provider credit report was available" };
}

/** Only a measured cost yields a number; everything else is null so it cannot pass as actual. */
export function measuredCreditValue(credits) {
  if (!credits || credits.measured !== true) return null;
  return Number.isFinite(Number(credits.value)) ? Number(credits.value) : null;
}

function firstFinite(source, keys) {
  if (!source || typeof source !== "object") return null;
  for (const key of keys) {
    const raw = source[key];
    const value = typeof raw === "number" ? raw : Number.NaN;
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Cost evidence for one submit.
 *
 * Precedence: the measured credit delta (preflight → recheck) is the strongest evidence; a provider
 * -reported credit field in the response is next; otherwise the cost is `unmeasured` and the caller
 * must keep the estimate labelled as an estimate.
 */
export function creditEvidence({ preflight = null, recheck = null, parsed = null } = {}) {
  if (preflight?.value !== null && preflight?.value !== undefined && recheck?.value !== null && recheck?.value !== undefined) {
    const delta = Number(preflight.value) - Number(recheck.value);
    if (Number.isFinite(delta) && delta >= 0) {
      return { value: delta, measured: true, evidence: "credit_delta", basis: "user_credit before/after the generate call", preflight: preflight.value, recheck: recheck.value };
    }
  }
  const reported = firstFinite(parsed, ["credit_count", "credits", "credit", "cost_credits"]);
  if (reported !== null && !parsed?.gen_status) return { value: reported, measured: true, evidence: "provider_reported", basis: "credit field in the provider response" };
  if (reported !== null) return { value: reported, measured: true, evidence: "provider_reported", basis: "credit field in the provider response" };
  return unmeasuredCredits();
}

/** Same evidence rules applied to a poll response. */
export function creditEvidenceFromResponse(parsed) {
  const reported = firstFinite(parsed, ["credit_count", "credits", "credit", "cost_credits"]);
  if (reported !== null) return { value: reported, measured: true, evidence: "provider_reported", basis: "credit field in the query_result response" };
  return unmeasuredCredits();
}

export function createDreaminaCliJobAdapter(options) {
  return new DreaminaCliJobAdapter(options);
}
