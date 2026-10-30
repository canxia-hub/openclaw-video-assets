import { createHash, randomUUID } from "node:crypto";

export class GenerationJobError extends Error {
  constructor(code, message, { status = 400, details = {} } = {}) {
    super(message);
    this.name = "GenerationJobError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const ACTIVE_BUDGET = new Set(["reserved", "committed"]);
const TERMINAL = new Set(["completed", "cancelled_local", "blocked", "failed_permanent"]);
const PHASES = ["submit", "reconcile", "poll", "download", "validate", "ingest", "writeback"];
// Post-submit phases that own a named non-terminal state. A process that dies inside one of these
// leaves the row in that state with no result entry for the phase, which is indistinguishable from
// "the phase has not run" unless the phase is reconciled against the provider first.
const POST_SUBMIT_STATE_PHASE = Object.freeze({
  submitted: "poll",
  running: "poll",
  downloading: "download",
  validating: "validate",
  ingesting: "ingest",
  writing_back: "writeback"
});
// Phases that can be resumed after a recoverable failure. `submit` is excluded on purpose: a failed
// or unknown provider submission is never re-sent automatically. The order is the pipeline order.
const RESUMABLE_PHASES = Object.freeze(["poll", "download", "validate", "ingest", "writeback"]);
// Two reconciliation questions with two different authorities, and the whole point of keeping them
// apart:
//   adapter.reconcile      asks "did the provider accept this job?" - a SUBMISSION question. A yes
//                          authorises the post-submit phases only because a submission that was never
//                          confirmed means those phases provably never started.
//   adapter.reconcilePhase asks "did this phase already take effect?" - a PHASE question, and the
//                          only thing that may authorise replaying or skipping an interrupted phase.
// A provider request id is therefore never evidence that download/ingest/writeback did not already
// run: the side effect a hard stop or a lost response leaves behind is invisible to the submission
// question. Every public entry routes through `advanceThroughPhaseReconciliation` so that confirming
// a submission cannot silently redo a phase.

export function canonicalJobRequest(value) {
  return JSON.stringify(sortValue(value ?? {}));
}

/**
 * The durable ledger row that holds this job's budget reservation.
 *
 * Exported because it is the join between the two budget layers: the queue creates the row when a job
 * is created, and the gateway reuses the SAME row when it authorizes the provider calls of that job
 * (REN-12 finding F3). One row = one job = one paid estimate, whichever layer asks.
 */
export function budgetLedgerIdForJob(jobId) {
  return `budget_${jobId}`;
}

/**
 * The ACCEPTANCE evidence for one job budget scope, read from the queue's own row.
 *
 * Why this exists: a read-only authorization is the one grant that skips today's budget caps (so an
 * accepted result can still be collected after a cap was lowered). Skipping a cap may therefore only
 * be justified by a fact the CALLER cannot supply - the provider having accepted the submission. The
 * durable row is that fact and the only place it exists:
 *
 *   * `provider_submit_state === "submitted"` plus a non-empty `provider_request_id` means the provider
 *     answered the submission with an id, so there is a result to collect;
 *   * the row also carries the owning entry and actor, so a read-only grant is bound to the SAME
 *     authority that submitted - one job's recovery grant can never be pointed at another job;
 *   * a budget row (`generation_budget_ledger`) is deliberately NOT evidence: it only proves that
 *     credits were reserved, which happens before any provider call.
 *
 * Fail closed in every direction: no table, no row, a row for another entry/actor, or a row whose
 * submission was never accepted all answer `ok: false` with a reason, never an exception and never a
 * comfortable guess.
 *
 * @param {object} db open database handle (the queue's database)
 * @param {{key: string, entry?: string|null, actor_id?: string|null}} args the scope key plus the
 *        authority the caller claims, each compared with the durable row when supplied
 * @returns {{ok: boolean, reason?: string, job_id?: string, entry?: string, actor_id?: string,
 *            provider_request_id?: string, state?: string, provider_submit_state?: string}}
 */
export function acceptedSubmissionOfJobScope(db, { key = null, entry = null, actor_id = null } = {}) {
  const scopeKey = typeof key === "string" ? key.trim() : "";
  if (!/^budget_.+/.test(scopeKey)) {
    return { ok: false, reason: "a read-only grant must name a job budget scope (budget_<job_id>); a scope that names no durable job can prove no accepted submission" };
  }
  if (!db || typeof db.prepare !== "function") {
    return { ok: false, reason: "no database handle is available to read the durable job row" };
  }
  const jobId = scopeKey.replace(/^budget_/, "");
  let row = null;
  try {
    row = db.prepare("SELECT job_id, entry, actor_id, state, provider_submit_state, provider_request_id FROM generation_jobs WHERE job_id = ?").get(jobId) ?? null;
  } catch (error) {
    // A database that predates the queue (or a harness with only the budget tables) must REFUSE rather
    // than throw: an exception here would be an unaccounted read-only grant in disguise.
    return { ok: false, reason: `this database cannot answer the acceptance question (no generation_jobs row is readable: ${error?.message ?? error})` };
  }
  if (!row) return { ok: false, reason: "no durable job row exists for that budget scope, so no accepted submission can be proven" };
  if (entry && row.entry !== entry) {
    return { ok: false, reason: `the durable job row belongs to entry ${row.entry}, not ${entry}` };
  }
  if (actor_id !== null && actor_id !== undefined && row.actor_id !== actor_id) {
    return { ok: false, reason: `the durable job row belongs to actor ${row.actor_id}, not ${actor_id}` };
  }
  const requestId = row.provider_request_id === null || row.provider_request_id === undefined ? "" : String(row.provider_request_id).trim();
  const submitState = String(row.provider_submit_state ?? "");
  if (submitState !== "submitted" || !requestId || requestId === "null" || requestId === "undefined") {
    return {
      ok: false,
      reason: `the provider never accepted this job, so there is no accepted result to collect (provider_submit_state=${submitState || "null"}, provider_request_id=${requestId || "none"})`
    };
  }
  return { ok: true, job_id: row.job_id, entry: row.entry, actor_id: row.actor_id, state: row.state, provider_submit_state: submitState, provider_request_id: requestId };
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function hashRequest(value) {
  return createHash("sha256").update(canonicalJobRequest(value), "utf8").digest("hex");
}

function json(value) { return JSON.stringify(value ?? null); }
function parse(value, fallback = null) { try { return value === null || value === undefined ? fallback : JSON.parse(value); } catch { return fallback; } }
function nowIso(clock) { return new Date(clock()).toISOString(); }

export class GenerationJobQueue {
  constructor({ db, config = {}, adapter = null, entryPolicy = {}, clock = () => Date.now() } = {}) {
    if (!db) throw new Error("GenerationJobQueue requires db");
    this.db = db;
    this.clock = clock;
    this.adapter = adapter;
    this.entryPolicy = entryPolicy && typeof entryPolicy === "object" ? entryPolicy : {};
    this.inFlight = 0;
    this.activeJobs = new Set();
    const source = config && typeof config === "object" ? config : {};
    this.policy = {
      enabled: source.enabled === true,
      maxCredits: finiteNumber(source.maxCredits, 0),
      allowedActors: Array.isArray(source.allowedActors) ? source.allowedActors.map(String) : [],
      allowedSurfaces: Array.isArray(source.allowedSurfaces) && source.allowedSurfaces.length ? source.allowedSurfaces.map(String) : ["tool", "ui", "browser", "gateway"],
      maxConcurrent: Math.max(1, Math.min(8, Math.trunc(finiteNumber(source.maxConcurrent, 1))))
    };
    this.ensurePendingPhaseColumn();
    this.recoverInterruptedSubmissions();
    // REN-10 phase-interrupt recovery. `recoverInterruptedSubmissions` only sees `submitting`.
    // A hard stop inside poll/download/validate/ingest/writeback leaves the row in that phase's
    // named state instead, and `processUnlocked` would hand such a row straight to
    // `continuePostSubmit`, which re-runs the interrupted phase - a second provider download, a
    // second asset version or a second canvas edge for one job. Those rows are persisted as
    // recoverable, keeping the interrupted phase, so the only automatic way forward is
    // `resumeUnlocked` -> `reconcilePhase` before any retry.
    this.recoverInterruptedPhases();  }

  setAdapter(adapter) { this.adapter = adapter; return this; }

  create(input = {}, context = null) {
    const actor = this.requireAuthority(context, input.surface);
    const key = required(input.idempotency_key, "idempotency_key");
    const entry = required(input.entry, "entry");
    const provider = required(input.provider, "provider");
    const inputPlan = input.plan && typeof input.plan === "object" ? input.plan : {};
    const rawRequest = input.request && typeof input.request === "object" ? input.request : {};
    const request = {
      ...rawRequest,
      asset_policy: {
        license_status: "unknown",
        risk_level: "unknown",
        ...(rawRequest.asset_policy && typeof rawRequest.asset_policy === "object" ? rawRequest.asset_policy : {})
      }
    };
    const requestHash = hashRequest({ entry, provider, project_id: input.project_id ?? null, canvas_id: input.canvas_id ?? null, request, plan: inputPlan });
    // The canvas slot this job's output belongs to, when the caller declared one. Recorded on the row
    // as well as inside `request_json`, so operational queries do not have to parse JSON to answer
    // "which slot does this paid output belong to".
    const slotShapeId = String(input.slot_shape_id ?? request.slot_shape_id ?? "").trim() || null;
    const existing = this.db.prepare("SELECT * FROM generation_jobs WHERE actor_id = ? AND idempotency_key = ?").get(actor.actor_id, key);
    if (existing) {
      if (existing.request_hash !== requestHash) throw new GenerationJobError("GENERATION_JOB_IDEMPOTENCY_CONFLICT", "idempotency key already belongs to a different request", { status: 409, details: { job_id: existing.job_id, idempotency_key: key } });
      return { ...this.fromRow(existing), replayed: true };
    }
    if (!this.policy.enabled) throw new GenerationJobError("GENERATION_JOBS_DISABLED", "asynchronous generation jobs are disabled", { status: 403 });
    if (input.confirm_cost !== true) throw new GenerationJobError("GENERATION_COST_CONFIRMATION_REQUIRED", "confirm_cost=true is required before queueing", { status: 403 });
    const entryDefinition = this.entryPolicy[entry];
    if (!entryDefinition) throw new GenerationJobError("GENERATION_ENTRY_UNKNOWN", `generation entry is not registered: ${entry}`, { status: 400 });
    if (String(entryDefinition.provider) !== provider) throw new GenerationJobError("GENERATION_PROVIDER_MISMATCH", `entry ${entry} belongs to ${entryDefinition.provider}, not ${provider}`, { status: 400 });
    const callerEstimate = finiteNumber(input.estimate_credits, NaN);
    const registryEstimate = finiteNumber(entryDefinition.reference_estimate_credits, NaN);
    if (!Number.isFinite(callerEstimate) || callerEstimate < 0 || !Number.isFinite(registryEstimate) || registryEstimate < 0) throw new GenerationJobError("GENERATION_COST_UNKNOWN", "both the request and server registry need a non-negative cost estimate", { status: 400 });
    const estimate = Math.max(callerEstimate, registryEstimate);
    // Admission is bounded by BOTH durable authorities: the job reservations in this table and the
    // gateway-minted scope reservations (tool-surface authorizations) in `generation_budget_scopes`.
    // Counting only this table would let a scope reservation consume the same pool unseen.
    const spent = Number(this.db.prepare("SELECT COALESCE(SUM(estimated_credits),0) AS n FROM generation_budget_ledger WHERE state IN ('reserved','committed') AND job_id IS NOT NULL").get().n)
      + this.scopeReservedCredits();
    if (Number(spent) + estimate > this.policy.maxCredits) throw new GenerationJobError("GENERATION_BUDGET_EXCEEDED", "persistent generation budget would be exceeded", { status: 403, details: { limit: this.policy.maxCredits, used_or_reserved: Number(spent), caller_estimate: callerEstimate, registry_estimate: registryEstimate, reserved: estimate } });
    const jobId = input.job_id ? String(input.job_id) : `job_${randomUUID().replaceAll("-", "")}`;
    const at = nowIso(this.clock);
    const surface = String(input.surface ?? context?.surface ?? "ui");
    const plan = {
      ...inputPlan,
      preflight: { ok: true, entry, provider, checked_at: at }
    };
    this.transaction(() => {
      this.db.prepare(`INSERT INTO generation_jobs
        (job_id,idempotency_key,request_hash,entry,provider,surface,actor_id,actor_type,project_id,canvas_id,slot_shape_id,state,phase,request_json,plan_json,estimated_credits,reserved_credits,actual_credits,budget_state,provider_request_id,provider_submit_state,result_json,error_code,error_message,failed_phase,local_cancel_requested,remote_cancel_state,submit_attempts,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?, 'queued','queued',?,?,?,?,NULL,'reserved',NULL,'not_started','{}',NULL,NULL,NULL,0,'not_requested',0,?,?)`)
        .run(jobId,key,requestHash,entry,provider,surface,actor.actor_id,actor.actor_type,input.project_id ?? null,input.canvas_id ?? null,slotShapeId,json(request),json(plan),estimate,estimate,at,at);
      this.db.prepare("INSERT INTO generation_budget_ledger (ledger_id,job_id,entry,state,estimated_credits,actual_credits,created_at,updated_at) VALUES (?,?,?,?,?,NULL,?,?)")
        .run(budgetLedgerIdForJob(jobId),jobId,entry,"reserved",estimate,at,at);
      this.appendEvent(jobId,"queued",{ estimate_credits: estimate, surface, actor_id: actor.actor_id });
    });
    return { ...this.get(jobId), replayed: false };
  }

  get(jobId) {
    const row = this.db.prepare("SELECT * FROM generation_jobs WHERE job_id = ?").get(required(jobId, "job_id"));
    if (!row) throw new GenerationJobError("GENERATION_JOB_NOT_FOUND", `generation job not found: ${jobId}`, { status: 404 });
    return this.fromRow(row);
  }

  list(input = {}) {
    const limit = Math.max(1, Math.min(200, Math.trunc(finiteNumber(input.limit, 50))));
    const rows = input.state
      ? this.db.prepare("SELECT * FROM generation_jobs WHERE state = ? ORDER BY created_at DESC LIMIT ?").all(String(input.state),limit)
      : this.db.prepare("SELECT * FROM generation_jobs ORDER BY created_at DESC LIMIT ?").all(limit);
    return rows.map((row) => this.fromRow(row));
  }

  getForCaller(input = {}, context = null) {
    const job = this.get(input.job_id);
    this.requireJobAuthority(context, job, false);
    return job;
  }

  listForCaller(input = {}, context = null) {
    const actor = this.requireAuthority(context, context?.surface, "operator.read");
    const limit = Math.max(1, Math.min(200, Math.trunc(finiteNumber(input.limit, 50))));
    const admin = actor.scopes.includes("operator.admin");
    const clauses = [];
    const values = [];
    if (!admin) { clauses.push("actor_id = ?"); values.push(actor.actor_id); }
    if (input.state) { clauses.push("state = ?"); values.push(String(input.state)); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM generation_jobs${where} ORDER BY created_at DESC LIMIT ?`).all(...values, limit);
    return rows.map((row) => this.fromRow(row));
  }

  events(input = {}) {
    const job = this.get(input.job_id);
    const after = Math.max(0, Math.trunc(finiteNumber(input.after_seq, 0)));
    const events = this.db.prepare("SELECT * FROM generation_job_events WHERE job_id = ? AND seq > ? ORDER BY seq ASC LIMIT 500").all(job.job_id, after).map((row) => ({ ...row, data: parse(row.data_json, {}) }));
    return { job_id: job.job_id, state: job.state, cursor: events.at(-1)?.seq ?? after, events };
  }

  eventsForCaller(input = {}, context = null) {
    const job = this.get(input.job_id);
    this.requireJobAuthority(context, job, false);
    return this.events(input);
  }

  async process(jobId, context = null) {
    const job = this.get(jobId);
    this.requireJobAuthority(context, job, true);
    return this.withPermit(job.job_id, () => this.processUnlocked(job.job_id, context));
  }

  // REN-11: the trusted context travels with the call all the way to the adapter. Provider submits
  // happen long after the caller's request, so without this the adapter would either have to forge a
  // host context or call the provider outside the REN-02 gateway. It is the *same* context the
  // entry was authorised with, not a new one: a queue worker can never authorise more than the
  // caller who queued the job.
  async processUnlocked(jobId, context = null) {
    let job = this.get(jobId);
    if (TERMINAL.has(job.state)) return job;
    // `manual_reconciliation` is deliberately inert here: a job parked for the operator only moves
    // again through the explicit `resume` or `reconcile` entry, and only after phase reconciliation.
    if (job.state === "unknown_submission" || job.state === "manual_reconciliation") return job;
    if (job.state === "failed_recoverable") return this.resumeUnlocked(jobId, context);
    if (!this.adapter?.submit) throw new GenerationJobError("GENERATION_PROVIDER_UNAVAILABLE", "no async provider adapter is configured", { status: 503 });
    if (job.provider_submit_state === "not_started") {
      this.update(jobId,{state:"submitting",phase:"submit",provider_submit_state:"submitting",submit_attempts:job.submit_attempts+1});
      this.appendEvent(jobId,"submitting",{attempt:job.submit_attempts+1});
      try {
        const submitted = await this.adapter.submit(job, { context });
        if (!submitted?.provider_request_id) throw new GenerationJobError("GENERATION_PROVIDER_PROTOCOL", "provider submit returned no request id", { status: 502 });
        this.update(jobId,{state:"submitted",phase:"poll",provider_submit_state:"submitted",provider_request_id:String(submitted.provider_request_id),result:merge(job.result,{submit:submitted})});
        this.appendEvent(jobId,"submitted",{provider_request_id:String(submitted.provider_request_id)});
      } catch (error) {
        if (error?.submissionUnknown === true || error?.code === "GENERATION_SUBMISSION_UNKNOWN") {
          this.update(jobId,{state:"unknown_submission",phase:"reconcile",provider_submit_state:"unknown",error_code:"GENERATION_SUBMISSION_UNKNOWN",error_message:error.message});
          this.appendEvent(jobId,"unknown_submission",{message:error.message});
          return this.get(jobId);
        }
        this.fail(jobId,"submit",error,false);
        return this.get(jobId);
      }
    }
    return this.continuePostSubmit(jobId, context);
  }

  async reconcile(jobId, context = null) {
    const job = this.get(jobId);
    this.requireJobAuthority(context, job, true);
    return this.withPermit(job.job_id, () => this.reconcileUnlocked(job.job_id, context));
  }

  async reconcileUnlocked(jobId, context = null) {
    let job = this.get(jobId);
    if (!["unknown_submission","manual_reconciliation"].includes(job.state)) return job;
    // A phase whose effect is still unresolved makes this a PHASE question, no matter what the
    // submission question answers. Reusing the submission path here was the defect: it confirmed
    // the provider request and then handed the row to `continuePostSubmit`, which re-ran the
    // interrupted phase.
    const phase = this.pendingPhaseOf(job);
    if (phase) return this.advanceThroughPhaseReconciliation(jobId, phase, context);
    // No interrupted phase is recorded, so the only open question is whether the provider accepted
    // the submission. Confirming it authorises the post-submit phases precisely because an unproven
    // submission means those phases never started.
    const row = await this.reconcileSubmission(jobId, context);
    if (row.state !== "submitted") return row;
    return this.continuePostSubmit(jobId, context);
  }

  // A completed phase cannot still be awaiting reconciliation. The result and the cleared marker
  // are written in one transaction so the two can never disagree, even if the process dies
  // immediately after this point.
  commitPhaseResult(jobId, phase, value) {
    const latest = this.get(jobId);
    this.transaction(() => {
      this.update(jobId,{result:merge(latest.result,{[phase]:value})});
      // REN-11 fix round (D5): the writeback phase answers "which canvas slot did the output land in",
      // and that is a job-level fact. Persisting it here (not only inside result_json) keeps the row
      // readable for an operator who never opens the phase payload.
      if (phase === "writeback") {
        const slotShapeId = String(value?.slot_shape_id ?? "").trim() || null;
        if (slotShapeId) this.update(jobId,{slot_shape_id:slotShapeId});
      }
      if (this.get(jobId).pending_phase === phase) this.update(jobId,{pending_phase:null});
    });
    return this.get(jobId);
  }

  async continuePostSubmit(jobId, context = null) {
    let job = this.get(jobId);
    const phases = ["poll","download","validate","ingest","writeback"];
    for (const phase of phases) {
      job = this.get(jobId);
      if (job.local_cancel_requested) return job;
      if (job.result?.[phase] !== undefined) continue;
      const fn = this.adapter?.[phase];
      if (typeof fn !== "function") { this.fail(jobId,phase,new Error(`adapter does not implement ${phase}`),true); return this.get(jobId); }
      this.update(jobId,{state:phaseState(phase),phase});
      this.appendEvent(jobId,phase,{});
      try {
        // Invoked with the adapter as `this`: a class-based adapter keeps its own state (download
        // root, CLI runner, prober) and detaching the method silently strips all of it.
        const value = await fn.call(this.adapter, job, { context });
        this.commitPhaseResult(jobId,phase,value);
        this.appendEvent(jobId,`${phase}_completed`,summarize(value));
      } catch (error) {
        this.fail(jobId,phase,error,true);
        return this.get(jobId);
      }
    }
    job = this.get(jobId);
    // Credits: only a number the adapter can evidence becomes `actual_credits`. The old fallback to
    // `estimated_credits` wrote the ESTIMATE into the actual column, which made an unmeasured cost look
    // measured in every later report. An unmeasured cost now stays NULL (the ledger still accounts for it
    // via COALESCE(actual_credits, estimated_credits)) and the completion event says so explicitly.
    const poll = job.result?.poll ?? null;
    const numericOrNull = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
    const declaredMeasured = numericOrNull(poll?.credits?.value);
    const measured = (poll?.credits?.measured === true ? declaredMeasured : null) ?? numericOrNull(poll?.actual_credits);
    const creditsEvidence = measured === null
      ? "unmeasured"
      : (poll?.credits?.measured === true ? (poll.credits.evidence ?? "provider_reported") : "adapter_reported_actual");
    const at = nowIso(this.clock);
    this.transaction(() => {
      this.db.prepare("UPDATE generation_jobs SET state='completed',phase='completed',actual_credits=?,budget_state='committed',updated_at=?,completed_at=? WHERE job_id=?").run(measured,at,at,jobId);
      this.db.prepare("UPDATE generation_budget_ledger SET state='committed',actual_credits=?,updated_at=? WHERE job_id=?").run(measured,at,jobId);
      this.db.prepare("UPDATE generation_compensations SET state='resolved',updated_at=? WHERE job_id=? AND state='pending'").run(at,jobId);
      this.appendEvent(jobId,"completed",{
        actual_credits:measured,
        credits_evidence:creditsEvidence,
        estimated_credits:job.estimated_credits,
        estimate_is_not_actual:measured === null
      });
    });
    return this.get(jobId);
  }

  async resume(jobId, context = null) {
    const job = this.get(jobId);
    this.requireJobAuthority(context, job, true);
    return this.withPermit(job.job_id, () => this.resumeUnlocked(job.job_id, context));
  }

  async resumeUnlocked(jobId, context = null) {
    const job = this.get(jobId);
    const phase = this.pendingPhaseOf(job);
    if (job.state === "manual_reconciliation") {
      // Parked for the operator because the phase could not be reconciled at the time. It may still
      // advance later once a reliable phase reconciler exists - and only through reconciliation, so
      // the attempt is safe even when the reconciler is still missing.
      if (!phase) return job;
      return this.advanceThroughPhaseReconciliation(jobId, phase, context);
    }
    if (job.state !== "failed_recoverable") return job;
    if (job.failed_phase === "submit") throw new GenerationJobError("GENERATION_RESUBMIT_FORBIDDEN", "a failed or unknown provider submit is never retried automatically", { status: 409 });
    if (!phase) {
      return this.requireManualReconciliation(jobId, job.failed_phase, "the recorded failed phase is not a resumable post-submit phase");
    }
    return this.advanceThroughPhaseReconciliation(jobId, phase, context);
  }

  // Which post-submit phase still has an unresolved effect, if any.
  //
  // The question this answers is not "which phase has not run yet" - an `unknown_submission` row has
  // run no phases at all - but "which phase's effect is in doubt because the process died around it".
  // So it starts from deliberate hints, each of which is a lower bound on where the pipeline stood:
  //
  //   * `pending_phase`, the explicit marker, the only one that survives `state` being rewritten;
  //   * `failed_phase`, adopted only while the row is parked. A parked row's recorded failure really
  //     was never resolved, and this is how a row written before the marker column existed is read;
  //     outside that state it is a diagnostic that can outlive the phase it names, so it is not used;
  //   * the phase named by `state`, which `continuePostSubmit` writes as it enters each phase.
  //
  // No hint means no phase was ever in flight, and the caller takes the submission-only path. When
  // hints exist, the furthest one whose result is still missing is the phase in doubt: `state` alone
  // can understate it, because `reconcileSubmission` advances `state` to `submitted` while a phase is
  // still awaiting reconciliation. When every hint is already checkpointed the job has moved past
  // them, so the answer is simply the next phase without a result - no stale phase is re-gated.
  pendingPhaseOf(job) {
    const resolved = (phase) => job.result?.[phase] !== undefined;
    const hints = [];
    if (RESUMABLE_PHASES.includes(job.pending_phase)) hints.push(job.pending_phase);
    if (["failed_recoverable","manual_reconciliation"].includes(job.state) && RESUMABLE_PHASES.includes(job.failed_phase)) hints.push(job.failed_phase);
    if (POST_SUBMIT_STATE_PHASE[job.state]) hints.push(POST_SUBMIT_STATE_PHASE[job.state]);
    if (!hints.length) return null;
    const live = hints.filter((phase) => !resolved(phase));
    if (!live.length) return RESUMABLE_PHASES.find((phase) => !resolved(phase)) ?? null;
    return live.slice().sort((a,b) => RESUMABLE_PHASES.indexOf(a) - RESUMABLE_PHASES.indexOf(b)).at(-1);
  }

  // The single legal route by which an interrupted post-submit phase may move again. The order is
  // fixed: establish the provider submission when it is not already proven, reconcile the
  // interrupted phase, and only then let the pipeline continue. Every entry that can reach
  // `continuePostSubmit` for a phase-interrupted job goes through here, so no entry can skip the
  // phase question. Nothing is replayed unless the provider proved the phase left no effect.
  async advanceThroughPhaseReconciliation(jobId, phase, context = null) {
    const job = this.get(jobId);
    const submissionProven = job.provider_submit_state === "submitted" && job.provider_request_id !== null && job.provider_request_id !== undefined;
    if (!submissionProven) {
      if (typeof this.adapter?.reconcile !== "function") {
        return this.requireManualReconciliation(
          jobId,
          phase,
          "the job cannot prove the provider accepted its submission and the adapter cannot reconcile the submission, so no phase may be replayed",
          "GENERATION_RECONCILIATION_UNAVAILABLE"
        );
      }
      const submission = await this.reconcileSubmission(jobId, context);
      if (submission.state !== "submitted") return submission;
    }
    const gate = await this.reconcilePhaseGate(jobId, phase, context);
    if (gate.blocked) return gate.blocked;
    this.update(jobId,{state:"submitted",phase,error_code:null,error_message:null});
    this.appendEvent(jobId,"resumed",{phase,provider_resubmit:false});
    return this.continuePostSubmit(jobId, context);
  }

  // Asks the provider whether the interrupted phase already took effect. `found=true` writes the
  // checkpoint so the phase is skipped; `found=false` is the only answer that authorises a retry;
  // every other outcome - no reconciler, an indeterminate answer, a throwing reconciler - is an
  // unknown, and an unknown leaves the job parked with its phase still recorded.
  async reconcilePhaseGate(jobId, phase, context = null) {
    if (typeof this.adapter?.reconcilePhase !== "function") {
      return { blocked: this.requireManualReconciliation(jobId, phase, "the provider adapter cannot report whether the interrupted phase already took effect, so it must not be retried blindly") };
    }
    let reconciliation;
    try {
      reconciliation = await this.adapter.reconcilePhase(this.get(jobId), phase, { context });
    } catch (error) {
      return {
        blocked: this.requireManualReconciliation(
          jobId,
          phase,
          `phase reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
          error?.code ?? "GENERATION_PHASE_RECONCILIATION_FAILED"
        )
      };
    }
    if (reconciliation?.found === true && reconciliation.value !== undefined) {
      // Consume the marker in the SAME transaction as the checkpoint. Both facts - "this phase's
      // effect is accounted for" and "no phase is awaiting reconciliation" - then become durable
      // together, so a crash immediately after this write cannot leave one without the other.
      const latest = this.get(jobId);
      this.transaction(() => {
        this.update(jobId,{result:merge(latest.result,{[phase]:reconciliation.value})});
        if (this.get(jobId).pending_phase === phase) this.update(jobId,{pending_phase:null});
        this.appendEvent(jobId,"phase_reconciled",{phase,found:true,checkpoint:true,replayed_operation:false});
      });
      return { blocked: null };
    }
    if (reconciliation?.found === false) {
      // The other authorised outcome: the provider proved no effect, which buys exactly one replay.
      // The marker is consumed here too - a crash before the replay starts then resumes at this
      // same phase (it is still the first one with no result), and a crash after it succeeded
      // resumes at the next one.
      this.transaction(() => {
        if (this.get(jobId).pending_phase === phase) this.update(jobId,{pending_phase:null});
        this.appendEvent(jobId,"phase_retry_authorized",{phase,found:false,reason:"provider proved the interrupted phase left no effect"});
      });
      return { blocked: null };
    }
    return { blocked: this.requireManualReconciliation(jobId, phase, "phase reconciliation proved neither outcome, so the phase must not be retried blindly") };
  }

  // Submission-level reconciliation only. Proving the provider accepted the job says nothing about a
  // phase's side effect, so callers must still reconcile the phase separately before any replay.
  // This writes the SUBMISSION facts and nothing else: it does not clear or overwrite `pending_phase`
  // or `failed_phase`, and where it reports a position it reports the phase that is still awaiting
  // reconciliation rather than `poll`, so a restart immediately after this write cannot be misled
  // into believing the pipeline is sitting safely before `poll`.
  async reconcileSubmission(jobId, context = null) {
    const job = this.get(jobId);
    if (typeof this.adapter?.reconcile !== "function") throw new GenerationJobError("GENERATION_RECONCILIATION_UNAVAILABLE", "provider cannot reconcile an unknown submission", { status: 409 });
    this.appendEvent(jobId,"reconciling",{});
    const result = await this.adapter.reconcile(job, { context });
    if (!result?.found || !result.provider_request_id) {
      // `found: null` means the provider could not be asked (or could not answer), while `found: false`
      // would read as "proven not submitted". Both park the row, but the event keeps the distinction so a
      // later audit can tell "we do not know" from "we know it did not".
      const indeterminate = result?.found === null || result?.found === undefined;
      this.update(jobId,{state:"manual_reconciliation",phase:"reconcile",error_code:"GENERATION_MANUAL_RECONCILIATION_REQUIRED",error_message:result?.reason ?? "provider did not prove whether the unknown submission exists"});
      this.appendEvent(jobId,"manual_reconciliation",{found:result?.found ?? null,indeterminate,blind_retry:false});
      return this.get(jobId);
    }
    // The marker is persisted in the same write that advances `state`, so a crash between here and
    // the phase gate cannot leave a row whose `state` says "safely before poll" while a phase's
    // effect is still in doubt. This is the write the recovery path used to lose the phase through.
    const pending = this.pendingPhaseOf(job);
    const patch = {state:"submitted",phase:pending ?? "poll",provider_submit_state:"submitted",provider_request_id:String(result.provider_request_id),error_code:null,error_message:null,result:merge(job.result,{reconcile:result})};
    if (pending) patch.pending_phase = pending;
    this.update(jobId, patch);
    this.appendEvent(jobId,"reconciled",{provider_request_id:String(result.provider_request_id)});
    return this.get(jobId);
  }

  requireManualReconciliation(jobId, phase, reason, code = "GENERATION_PHASE_RECONCILIATION_REQUIRED") {
    const patch = {state:"manual_reconciliation",phase:"reconcile",error_code:code,error_message:reason};
    // Persist the interrupted phase, including for the branch that cannot even prove the provider
    // request. It is the only durable basis on which a later, reliable phase reconciler can legally
    // resume this job; recording it in the event stream alone would leave nothing to resume from.
    // `pending_phase` is set alongside it: that column, not `failed_phase`, is what the recovery
    // paths route on, because `failed_phase` is also a diagnostic that outlives a resolved phase.
    if (RESUMABLE_PHASES.includes(phase)) {
      patch.failed_phase = phase;
      patch.pending_phase = phase;
    } else if (typeof phase === "string" && phase) {
      patch.failed_phase = phase;
    }
    this.update(jobId, patch);
    this.appendEvent(jobId,"manual_reconciliation",{phase:phase ?? null,found:null,blind_retry:false,reason});
    return this.get(jobId);
  }

  ensurePendingPhaseColumn() {    // `CREATE TABLE IF NOT EXISTS` gives the column to a new database and does nothing to one that
    // already exists, so a job table written by an earlier build must be extended here. Attempting
    // recovery without it would lose the marker the recovery paths route on.
    const columns = new Set(this.db.prepare("PRAGMA table_info(generation_jobs)").all().map((column) => column.name));
    if (!columns.has("pending_phase")) this.db.prepare("ALTER TABLE generation_jobs ADD COLUMN pending_phase TEXT").run();
    this.ensureSlotColumn();
  }

  /**
   * REN-11 fix round (D5): the job table gains `slot_shape_id`, and rows written before the column
   * existed are backfilled from their own `request_json`.
   *
   * New rows are written with the slot at insert and again when the writeback phase commits (see
   * `commitPhaseResult`). The backfill exists because the value was already recorded - just inside a
   * JSON blob - and leaving it NULL only in history would keep the same "slot unknown" gap for exactly
   * the rows an operator is most likely to inspect.
   */
  ensureSlotColumn() {
    const columns = new Set(this.db.prepare("PRAGMA table_info(generation_jobs)").all().map((column) => column.name));
    if (!columns.has("slot_shape_id")) this.db.prepare("ALTER TABLE generation_jobs ADD COLUMN slot_shape_id TEXT").run();
    const rows = this.db.prepare("SELECT job_id, request_json, slot_shape_id FROM generation_jobs WHERE slot_shape_id IS NULL").all();
    let backfilled = 0;
    for (const row of rows) {
      const slotShapeId = slotShapeIdOfRequest(row.request_json);
      if (!slotShapeId) continue;
      this.db.prepare("UPDATE generation_jobs SET slot_shape_id = ? WHERE job_id = ?").run(slotShapeId, row.job_id);
      backfilled += 1;
    }
    if (backfilled > 0) this.logger?.log?.(`[video-assets] backfilled slot_shape_id for ${backfilled} generation job(s) from request_json`);
    return backfilled;
  }

  /**
   * Credits currently reserved by gateway-minted (non-job) scopes.
   *
   * The table is created by the schema on every init; a database that somehow predates it reports 0
   * rather than failing the admission check with an SQL error.
   */
  scopeReservedCredits() {
    try {
      return Number(this.db.prepare("SELECT COALESCE(SUM(reserved_credits),0) AS n FROM generation_budget_scopes WHERE state IN ('reserved','committed')").get().n);
    } catch {
      return 0;
    }
  }

  async cancel(jobId, context = null) {
    const job = this.get(jobId);
    this.requireJobAuthority(context, job, true);
    if (TERMINAL.has(job.state)) return job;
    const submitted = job.provider_submit_state === "submitted" || job.provider_submit_state === "unknown";
    if (!submitted) {
      const at = nowIso(this.clock);
      this.transaction(() => {
        this.db.prepare("UPDATE generation_jobs SET state='cancelled_local',phase='cancelled',local_cancel_requested=1,remote_cancel_state='not_submitted',budget_state='released',updated_at=? WHERE job_id=?").run(at,jobId);
        this.db.prepare("UPDATE generation_budget_ledger SET state='released',updated_at=? WHERE job_id=?").run(at,jobId);
        this.appendEvent(jobId,"cancelled_local",{remote_cancelled:false,refund_claimed:false});
      });
      return this.get(jobId);
    }
    let remote = "unsupported";
    if (typeof this.adapter?.cancel === "function" && job.provider_request_id) {
      try { const result = await this.adapter.cancel(job, { context }); remote = result?.cancelled === true ? "confirmed" : "not_confirmed"; } catch { remote = "unknown"; }
    }
    this.update(jobId,{state:"cancel_requested",phase:"cancel",local_cancel_requested:1,remote_cancel_state:remote});
    this.appendEvent(jobId,"cancel_requested",{remote_cancel_state:remote,refund_claimed:false,downstream_stopped:true});
    return this.get(jobId);
  }

  recoverInterruptedSubmissions() {
    const rows = this.db.prepare("SELECT job_id FROM generation_jobs WHERE state='submitting' OR provider_submit_state='submitting'").all();
    for (const row of rows) {
      this.update(row.job_id,{state:"unknown_submission",phase:"reconcile",provider_submit_state:"unknown",error_code:"GENERATION_SUBMISSION_UNKNOWN",error_message:"process restarted while provider submission was in flight"});
      this.appendEvent(row.job_id,"unknown_submission",{reason:"restart_during_submit",blind_retry:false});
    }
    return rows.length;
  }

  recoverInterruptedPhases() {
    const states = Object.keys(POST_SUBMIT_STATE_PHASE);
    const rows = this.db.prepare(`SELECT * FROM generation_jobs WHERE state IN (${states.map(() => "?").join(",")})`).all(...states);
    let converted = 0;
    for (const row of rows) {
      const job = this.fromRow(row);
      // The phase to reconcile is derived from the durable results and the explicit marker, never
      // from `state` alone. `state` is exactly what goes wrong here: `reconcileSubmission` advances
      // it to `submitted` while a phase is still awaiting reconciliation, and this method used to
      // map that state straight to `poll` - overwriting the phase that actually needed reconciling
      // and letting the doubtful phase be re-run unguarded.
      const phase = this.pendingPhaseOf(job) ?? POST_SUBMIT_STATE_PHASE[row.state];
      const confirmed = row.provider_submit_state === "submitted" && row.provider_request_id !== null && row.provider_request_id !== undefined;
      const reason = `process restarted while ${phase} was still in flight`;
      if (!confirmed) {
        // The row sits in a post-submit phase but cannot prove the provider ever accepted it.
        // Nothing may be retried automatically from here: this goes to the operator.
        this.requireManualReconciliation(row.job_id, phase, `${reason}, and no provider request id confirms the submission`, "GENERATION_PHASE_INTERRUPTED_UNVERIFIED");
        continue;
      }
      const at = nowIso(this.clock);
      this.transaction(() => {
        this.update(row.job_id,{state:"failed_recoverable",phase,error_code:"GENERATION_PHASE_INTERRUPTED",error_message:reason,failed_phase:phase,pending_phase:phase});
        this.db.prepare("INSERT OR IGNORE INTO generation_compensations (compensation_id,job_id,stage,state,attempts,payload_json,last_error,created_at,updated_at) VALUES (?,?,?,?,0,'{}',?,?,?)")
          .run(`comp_${row.job_id}_${phase}`,row.job_id,phase,"pending",reason,at,at);
        this.appendEvent(row.job_id,"phase_interrupted",{reason:"restart_during_phase",phase,blind_retry:false,provider_resubmit:false});
      });
      converted += 1;
    }
    return converted;
  }

  requireAuthority(context, requestedSurface, requiredScope = "operator.write") {
    if (!context || context.trusted !== true || !context.actor_id) throw new GenerationJobError("GENERATION_ACTOR_UNTRUSTED", "trusted caller identity is required", { status: 403 });
    const surface = String(requestedSurface ?? context.surface ?? "ui");
    if (!this.policy.allowedSurfaces.includes(surface)) throw new GenerationJobError("GENERATION_SURFACE_FORBIDDEN", `surface ${surface} is not allowed`, { status: 403 });
    if (this.policy.allowedActors.length && !this.policy.allowedActors.includes(String(context.actor_id))) throw new GenerationJobError("GENERATION_ACTOR_FORBIDDEN", "actor is not allowed to create generation jobs", { status: 403 });
    const scopes = Array.isArray(context.scopes) ? context.scopes : [];
    const readAllowed = scopes.includes("operator.read") || scopes.includes("operator.write") || scopes.includes("operator.admin");
    const writeAllowed = scopes.includes("operator.write") || scopes.includes("operator.admin");
    if (requiredScope === "operator.write" ? !writeAllowed : !readAllowed) throw new GenerationJobError("GENERATION_SCOPE_REQUIRED", `${requiredScope} scope is required`, { status: 403 });
    return { actor_id:String(context.actor_id),actor_type:String(context.actor_type ?? "agent"),surface,scopes };
  }

  requireJobAuthority(context, job, write) {
    const actor = this.requireAuthority(context, context?.surface, write ? "operator.write" : "operator.read");
    if (!actor.scopes.includes("operator.admin") && actor.actor_id !== job.actor_id) {
      throw new GenerationJobError("GENERATION_JOB_FORBIDDEN", "generation job belongs to another actor", { status: 403, details: { job_id: job.job_id } });
    }
    return actor;
  }

  async withPermit(jobId, fn) {
    if (this.activeJobs.has(jobId)) throw new GenerationJobError("GENERATION_JOB_BUSY", "generation job is already being processed", { status: 409, details: { job_id: jobId } });
    if (this.inFlight >= this.policy.maxConcurrent) throw new GenerationJobError("GENERATION_QUEUE_BUSY", "generation worker concurrency limit reached", { status: 429, details: { max_concurrent: this.policy.maxConcurrent } });
    this.activeJobs.add(jobId);
    this.inFlight += 1;
    try { return await fn(); }
    finally { this.inFlight -= 1; this.activeJobs.delete(jobId); }
  }

  fail(jobId, phase, error, recoverable) {
    const code = String(error?.code ?? `GENERATION_${phase.toUpperCase()}_FAILED`);
    const message = error instanceof Error ? error.message : String(error);
    const at = nowIso(this.clock);
    this.transaction(() => {
      this.db.prepare("UPDATE generation_jobs SET state=?,phase=?,error_code=?,error_message=?,failed_phase=?,pending_phase=?,updated_at=? WHERE job_id=?").run(recoverable?"failed_recoverable":"failed_permanent",phase,code,message,phase,recoverable?phase:null,at,jobId);
      if (recoverable) this.db.prepare("INSERT OR IGNORE INTO generation_compensations (compensation_id,job_id,stage,state,attempts,payload_json,last_error,created_at,updated_at) VALUES (?,?,?,?,0,'{}',?,?,?)").run(`comp_${jobId}_${phase}`,jobId,phase,"pending",message,at,at);
      this.appendEvent(jobId,recoverable?"compensation_pending":"failed",{phase,code,message});
    });
  }

  appendEvent(jobId, type, data = {}) {
    const seq = Number(this.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS n FROM generation_job_events WHERE job_id=?").get(jobId).n);
    this.db.prepare("INSERT INTO generation_job_events (event_id,job_id,seq,event_type,state,phase,data_json,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(`evt_${jobId}_${seq}`,jobId,seq,type,this.db.prepare("SELECT state FROM generation_jobs WHERE job_id=?").get(jobId)?.state ?? "unknown",this.db.prepare("SELECT phase FROM generation_jobs WHERE job_id=?").get(jobId)?.phase ?? "unknown",json(data),nowIso(this.clock));
  }

  update(jobId, patch) {
    const map = {state:"state",phase:"phase",provider_submit_state:"provider_submit_state",provider_request_id:"provider_request_id",slot_shape_id:"slot_shape_id",error_code:"error_code",error_message:"error_message",failed_phase:"failed_phase",pending_phase:"pending_phase",local_cancel_requested:"local_cancel_requested",remote_cancel_state:"remote_cancel_state",submit_attempts:"submit_attempts",result:"result_json"};
    const entries = Object.entries(patch).filter(([key]) => map[key]);
    if (!entries.length) return;
    const sql = entries.map(([key]) => `${map[key]}=?`).concat("updated_at=?").join(",");
    const values = entries.map(([key,value]) => key === "result" ? json(value) : value).concat(nowIso(this.clock),jobId);
    this.db.prepare(`UPDATE generation_jobs SET ${sql} WHERE job_id=?`).run(...values);
  }

  fromRow(row) {
    return {...row,budget_ledger_id:budgetLedgerIdForJob(row.job_id),request:parse(row.request_json,{}),plan:parse(row.plan_json,{}),result:parse(row.result_json,{}),local_cancel_requested:Boolean(row.local_cancel_requested)};
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

function required(value, name) { const text = String(value ?? "").trim(); if (!text) throw new GenerationJobError("GENERATION_JOB_INVALID", `${name} is required`); return text; }

/** A slot id taken from a stored `request_json`; tolerant because the blob may predate the column. */
function slotShapeIdOfRequest(requestJson) {
  try {
    const parsed = JSON.parse(String(requestJson ?? ""));
    return String(parsed?.slot_shape_id ?? "").trim() || null;
  } catch {
    return null;
  }
}
function finiteNumber(value, fallback) { const number=Number(value); return Number.isFinite(number)?number:fallback; }
function merge(left, right) { return {...(left??{}),...(right??{})}; }
function summarize(value) { if (!value || typeof value!=="object") return {value}; return Object.fromEntries(Object.entries(value).filter(([key]) => !/content|secret|token|prompt/i.test(key)).slice(0,12)); }
function phaseState(phase) { return ({poll:"running",download:"downloading",validate:"validating",ingest:"ingesting",writeback:"writing_back"})[phase] ?? phase; }
