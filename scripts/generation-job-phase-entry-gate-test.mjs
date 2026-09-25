// REN-10 public-entry phase gate fixture.
//
// THE GAP THIS CLOSES (proved independently by the parent review's own probe, 44-ren10-reconcile-entry-review.md)
//   The public `reconcile` entry accepted a `manual_reconciliation` row, asked the provider the
//   SUBMISSION question (adapter.reconcile -> "the request exists"), and then called
//   `continuePostSubmit` - which re-ran the interrupted phase. Asking whether the request exists is
//   not asking whether the phase's side effect already happened, so a job whose ingest had already
//   committed its effect got a second ingest. The parent's probe measured 2 synthetic effects and
//   the call chain `submit, ingest, reconcile_submit_only, ingest, writeback`.
//
// WHAT IS ASSERTED HERE
//   1. The gap is reproduced against the reviewed revision's own class (`git show <reviewed>:src/generation-jobs.js`)
//      so this fixture measures the fix against the exact artifact that was reviewed, not against memory.
//   2. Negative control: with a submission-only reconciler, the whole public sequence
//      process -> resume -> reconcile must leave the job parked and the phase effect count at 1.
//      Every entry is then called again and must stay inert.
//   3. Positive controls: once a reliable `reconcilePhase` exists, `found=true` skips the phase
//      (checkpoint) and `found=false` authorises exactly one retry. Both are exercised through the
//      public `resume` entry and the public `reconcile` entry.
//   4. Restart coverage: a `manual_reconciliation` row survives a close/reopen with its
//      `failed_phase` intact, including the branch that cannot prove the provider request at all.
//   5. Regressions: a genuine `unknown_submission` (no interrupted phase) still resolves through
//      submission reconciliation alone, and `failed_phase=submit` is still never auto-retried.
//
// Zero cost: local adapters, an isolated SQLite database, no provider, no network, no credits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VideoAssetService } from "../src/service.js";
import { GenerationJobQueue } from "../src/generation-jobs.js";

// The revision the parent review measured. Its class is the pre-fix behaviour for this fixture.
const REVIEWED_COMMIT = "27af98fc38299a5c8dd04d51bc01eefc190ddea6";

const outIndex = process.argv.indexOf("--out-json");
const outJson = outIndex >= 0 ? process.argv[outIndex + 1] : null;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scriptDir, "..");

const checks = [];
function check(id, condition, detail) {
  checks.push({ id, ok: Boolean(condition), detail });
  if (!condition) throw new Error(`${id}: ${detail}`);
}
function eq(actual, expected, id, extra = "") {
  check(id, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${extra ? ` (${extra})` : ""}`);
}
async function rejectsCode(fn, code, id) {
  try { await fn(); } catch (error) { eq(error.code, code, id); return error; }
  throw new Error(`${id}: expected ${code}`);
}

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-ren10-gate-"));
const repositoryRoot = path.join(tmp, "repo");
const context = { trusted: true, actor_id: "agent:gate-fixture", actor_type: "agent", surface: "tool", scopes: ["operator.read", "operator.write"] };
const jobConfig = { enabled: true, maxCredits: 500, maxConcurrent: 1 };
const entryPolicy = { test: { provider: "local", reference_estimate_credits: 1 } };

let service = null;
let queue = null;
let sequence = 0;

// The side effect is a ROW, not a value in memory: a duplicate phase execution is then a counted
// fact in the database rather than something the process merely remembers.
const effectCount = (jobId, phase) => service.db.prepare("SELECT COUNT(*) AS n FROM phase_effects WHERE job_id=? AND phase=?").get(jobId, phase).n;
const recordEffect = (jobId, phase) => service.db.prepare("INSERT INTO phase_effects (job_id,phase) VALUES (?,?)").run(jobId, phase);
const countersOf = () => ({ submit: 0, poll: 0, download: 0, validate: 0, ingest: 0, writeback: 0, reconcile: 0, reconcilePhase: 0 });
const rowOf = (jobId) => service.db.prepare("SELECT state,phase,failed_phase,error_code,provider_submit_state,provider_request_id,submit_attempts FROM generation_jobs WHERE job_id=?").get(jobId);
const eventsOf = (jobId, type) => service.db.prepare("SELECT data_json FROM generation_job_events WHERE job_id=? AND event_type=?").all(jobId, type).map((item) => JSON.parse(item.data_json));

function makeAdapter({ log, counters, fault = null, reconcilePhase = null }) {
  const adapter = {
    async submit(job) { counters.submit += 1; log.push("submit"); return { provider_request_id: `local_request_${job.job_id}` }; },
    async poll() { counters.poll += 1; log.push("poll"); return { status: "completed", actual_credits: 1 }; },
    async download() { counters.download += 1; log.push("download"); return { file_path: "local-only" }; },
    async validate() { counters.validate += 1; log.push("validate"); return { ok: true }; },
    async ingest(job) {
      counters.ingest += 1;
      log.push("ingest");
      if (fault === "ingest_before_effect") { const error = new Error("synthetic provider response lost before any effect"); error.code = "SYNTHETIC_INGEST_PRE_FAULT"; throw error; }
      recordEffect(job.job_id, "ingest");
      if (fault === "ingest_after_effect" && counters.ingest === 1) { const error = new Error("synthetic provider response lost after the effect committed"); error.code = "SYNTHETIC_INGEST_POST_FAULT"; throw error; }
      return { asset_id: "synthetic", asset_version_id: "synthetic_v1" };
    },
    async writeback() { counters.writeback += 1; log.push("writeback"); return { ok: true }; },
    async reconcile(job) { counters.reconcile += 1; log.push("reconcile_submit_only"); return { found: true, provider_request_id: `local_request_confirmed_${job.job_id}` }; }
  };
  if (reconcilePhase) {
    adapter.reconcilePhase = async (job, phase) => { counters.reconcilePhase += 1; log.push(`reconcilePhase:${phase}`); return reconcilePhase(job, phase); };
  }
  return adapter;
}

const newJob = (tag) => queue.create({ idempotency_key: `gate-${sequence += 1}-${tag}`, entry: "test", provider: "local", confirm_cost: true, estimate_credits: 1, request: { scenario: tag } }, context);

const reports = { negative_control: null, positive_found_true: null, positive_found_false: null, restart_manual: null, regressions: null, pre_fix: null };

try {
  service = new VideoAssetService({ pluginConfig: { repositoryRoot } }).init();
  service.db.exec("CREATE TABLE phase_effects (id INTEGER PRIMARY KEY, job_id TEXT, phase TEXT)");
  queue = new GenerationJobQueue({ db: service.db, config: jobConfig, entryPolicy, adapter: null });

  // -------------------------------------------------------------------------------------------------
  // 1. Pre-fix reproduction, against the reviewed revision's own class.
  // -------------------------------------------------------------------------------------------------
  const legacySource = execFileSync("git", ["-C", repo, "show", `${REVIEWED_COMMIT}:src/generation-jobs.js`], { encoding: "utf8" });
  check("reviewed_revision_source_resolves", legacySource.includes("recoverInterruptedPhases") && !legacySource.includes("advanceThroughPhaseReconciliation"), `git show ${REVIEWED_COMMIT}:src/generation-jobs.js`);
  const legacyPath = path.join(tmp, "reviewed-generation-jobs.mjs");
  await fs.promises.writeFile(legacyPath, legacySource, "utf8");
  const ReviewedQueue = (await import(pathToFileURL(legacyPath).href)).GenerationJobQueue;

  const preFixLog = [];
  const preFixCounters = countersOf();
  const preFixJob = newJob("pre_fix");
  const preFixQueue = new ReviewedQueue({ db: service.db, config: jobConfig, entryPolicy, adapter: makeAdapter({ log: preFixLog, counters: preFixCounters, fault: "ingest_after_effect" }) });
  const preFixFirst = await preFixQueue.process(preFixJob.job_id, context);
  eq(preFixFirst.state, "failed_recoverable", "pre_fix_first_state");
  eq(preFixFirst.failed_phase, "ingest", "pre_fix_failed_phase");
  const preFixManual = await preFixQueue.resume(preFixJob.job_id, context);
  eq(preFixManual.state, "manual_reconciliation", "pre_fix_resume_parks_the_job");
  eq(preFixManual.failed_phase, "ingest", "pre_fix_manual_keeps_the_phase");
  const preFixAfterReconcile = await preFixQueue.reconcile(preFixJob.job_id, context);
  const preFixEffects = effectCount(preFixJob.job_id, "ingest");
  eq(preFixAfterReconcile.state, "completed", "pre_fix_reconcile_completes");
  eq(preFixEffects, 2, "pre_fix_gap_is_reproduced_against_the_reviewed_class", "the submission answer alone re-ran the committed phase");
  // The parent's probe recorded only submit/ingest/writeback/reconcile in its call list, so its chain
  // reads `submit > ingest > reconcile_submit_only > ingest > writeback`. This fixture records every
  // phase, which is why poll/download/validate appear here. The decisive part is identical: the
  // interrupted ingest runs a second time after the submission answer.
  eq(preFixLog.join(" > "), "submit > poll > download > validate > ingest > reconcile_submit_only > ingest > writeback", "pre_fix_call_chain_matches_the_parent_probe");
  eq(preFixCounters.ingest, 2, "pre_fix_ingest_ran_twice");
  reports.pre_fix = { reviewed_commit: REVIEWED_COMMIT, first_state: preFixFirst.state, manual_state: preFixManual.state, manual_failed_phase: preFixManual.failed_phase, after_reconcile: preFixAfterReconcile.state, phase_effect_count: preFixEffects, call_chain: preFixLog, gap_reproduced: preFixEffects > 1 };

  // -------------------------------------------------------------------------------------------------
  // 2. Negative control: the same public sequence on the fixed class.
  // -------------------------------------------------------------------------------------------------
  {
    const log = [];
    const counters = countersOf();
    const job = newJob("negative_control");
    queue.setAdapter(makeAdapter({ log, counters, fault: "ingest_after_effect" }));
    const first = await queue.process(job.job_id, context);
    eq(first.state, "failed_recoverable", "negative_first_state");
    eq(first.failed_phase, "ingest", "negative_failed_phase");
    eq(effectCount(job.job_id, "ingest"), 1, "negative_effect_committed_once_before_the_fault");

    const manual = await queue.resume(job.job_id, context);
    eq(manual.state, "manual_reconciliation", "negative_resume_parks_the_job");
    eq(manual.failed_phase, "ingest", "negative_resume_keeps_the_interrupted_phase");
    eq(effectCount(job.job_id, "ingest"), 1, "negative_resume_did_not_replay");

    // The parent's exact step: the public reconcile entry, with a reconciler that can prove the
    // submission but knows nothing about the phase.
    queue.setAdapter(makeAdapter({ log, counters }));
    const afterReconcile = await queue.reconcile(job.job_id, context);
    eq(afterReconcile.state, "manual_reconciliation", "negative_reconcile_does_not_complete");
    eq(afterReconcile.failed_phase, "ingest", "negative_reconcile_keeps_the_interrupted_phase");
    eq(afterReconcile.error_code, "GENERATION_PHASE_RECONCILIATION_REQUIRED", "negative_reconcile_reports_the_phase_reason");
    eq(effectCount(job.job_id, "ingest"), 1, "negative_submission_proof_does_not_authorise_a_replay");
    eq(counters.ingest, 1, "negative_ingest_ran_once_in_total");
    eq(counters.submit, 1, "negative_provider_was_submitted_once");
    eq(rowOf(job.job_id).provider_request_id, `local_request_${job.job_id}`, "negative_provider_request_id_untouched");
    const manualEvents = eventsOf(job.job_id, "manual_reconciliation");
    check("negative_manual_events_claim_no_blind_retry", manualEvents.length >= 2 && manualEvents.every((item) => item.blind_retry === false && item.phase === "ingest"), JSON.stringify(manualEvents));

    // Every public entry, called again, must stay inert.
    const before = { effects: effectCount(job.job_id, "ingest"), ingest: counters.ingest, submit: counters.submit };
    const processAgain = await queue.process(job.job_id, context);
    eq(processAgain.state, "manual_reconciliation", "negative_process_stays_parked");
    const resumeAgain = await queue.resume(job.job_id, context);
    eq(resumeAgain.state, "manual_reconciliation", "negative_resume_stays_parked");
    const reconcileAgain = await queue.reconcile(job.job_id, context);
    eq(reconcileAgain.state, "manual_reconciliation", "negative_reconcile_stays_parked");
    eq(effectCount(job.job_id, "ingest"), before.effects, "negative_no_entry_replayed_the_phase");
    eq(counters.ingest, before.ingest, "negative_no_entry_reached_ingest");
    eq(counters.submit, before.submit, "negative_no_entry_resubmitted");
    eq(counters.writeback, 0, "negative_writeback_never_ran");
    reports.negative_control = { final_state: reconcileAgain.state, failed_phase: reconcileAgain.failed_phase, phase_effect_count: effectCount(job.job_id, "ingest"), call_chain: log, counters: { ...counters } };
  }

  // -------------------------------------------------------------------------------------------------
  // 3. Positive controls: a reliable reconciler makes recovery legal again.
  // -------------------------------------------------------------------------------------------------
  {
    // 3a. found=true through the public `resume` entry: the committed phase is checkpointed, not re-run.
    const log = [];
    const counters = countersOf();
    const job = newJob("found_true_resume");
    queue.setAdapter(makeAdapter({ log, counters, fault: "ingest_after_effect" }));
    await queue.process(job.job_id, context);
    queue.setAdapter(makeAdapter({ log, counters }));
    const parked = await queue.resume(job.job_id, context);
    eq(parked.state, "manual_reconciliation", "found_true_resume_parks_first");
    queue.setAdapter(makeAdapter({ log, counters, reconcilePhase: (j, phase) => (phase === "ingest" ? { found: true, value: { asset_id: "synthetic", asset_version_id: "synthetic_v1", replayed_from_durable_state: true } } : { found: false }) }));
    const resumed = await queue.resume(job.job_id, context);
    eq(resumed.state, "completed", "found_true_resume_completes", resumed.error_message ?? "");
    eq(effectCount(job.job_id, "ingest"), 1, "found_true_resume_did_not_replay_the_phase");
    eq(counters.ingest, 1, "found_true_resume_ingest_ran_once");
    eq(counters.writeback, 1, "found_true_resume_continued_after_the_checkpoint");
    check("found_true_resume_logs_the_reconcile_first", log.includes("reconcilePhase:ingest"), log.join(" > "));
    const checkpoint = eventsOf(job.job_id, "phase_reconciled");
    check("found_true_resume_writes_a_checkpoint", checkpoint.length === 1 && checkpoint[0].checkpoint === true && checkpoint[0].replayed_operation === false, JSON.stringify(checkpoint));
    reports.positive_found_true = { entry: "resume", final_state: resumed.state, phase_effect_count: effectCount(job.job_id, "ingest"), call_chain: log, checkpoint: checkpoint[0] };
  }
  {
    // 3b. found=true through the public `reconcile` entry - the entry the parent proved was broken.
    const log = [];
    const counters = countersOf();
    const job = newJob("found_true_reconcile");
    queue.setAdapter(makeAdapter({ log, counters, fault: "ingest_after_effect" }));
    await queue.process(job.job_id, context);
    queue.setAdapter(makeAdapter({ log, counters }));
    await queue.resume(job.job_id, context);
    queue.setAdapter(makeAdapter({ log, counters, reconcilePhase: () => ({ found: true, value: { asset_id: "synthetic", asset_version_id: "synthetic_v1" } }) }));
    const reconciled = await queue.reconcile(job.job_id, context);
    eq(reconciled.state, "completed", "found_true_reconcile_completes", reconciled.error_message ?? "");
    eq(effectCount(job.job_id, "ingest"), 1, "found_true_reconcile_did_not_replay_the_phase");
    eq(counters.ingest, 1, "found_true_reconcile_ingest_ran_once");
    eq(counters.writeback, 1, "found_true_reconcile_continued_after_the_checkpoint");
    eq(counters.submit, 1, "found_true_reconcile_never_resubmitted");
    reports.positive_found_true_reconcile_entry = { entry: "reconcile", final_state: reconciled.state, phase_effect_count: effectCount(job.job_id, "ingest"), call_chain: log };
  }
  {
    // 3c. found=false: the provider proved the phase left no effect, which is the only answer that
    // authorises exactly one retry.
    const log = [];
    const counters = countersOf();
    const job = newJob("found_false");
    queue.setAdapter(makeAdapter({ log, counters, fault: "ingest_before_effect" }));
    const first = await queue.process(job.job_id, context);
    eq(first.state, "failed_recoverable", "found_false_first_state");
    eq(effectCount(job.job_id, "ingest"), 0, "found_false_started_with_no_effect");
    queue.setAdapter(makeAdapter({ log, counters }));
    const parked = await queue.resume(job.job_id, context);
    eq(parked.state, "manual_reconciliation", "found_false_parks_first");
    queue.setAdapter(makeAdapter({ log, counters, reconcilePhase: () => ({ found: false }) }));
    const resumed = await queue.resume(job.job_id, context);
    eq(resumed.state, "completed", "found_false_resume_completes", resumed.error_message ?? "");
    eq(effectCount(job.job_id, "ingest"), 1, "found_false_ran_the_phase_exactly_once");
    eq(counters.ingest, 2, "found_false_attempted_once_before_and_once_after_authorisation");
    eq(counters.reconcilePhase, 1, "found_false_reconciled_once");
    const authorized = eventsOf(job.job_id, "phase_retry_authorized");
    check("found_false_records_the_retry_authorisation", authorized.length === 1 && authorized[0].found === false, JSON.stringify(authorized));
    reports.positive_found_false = { final_state: resumed.state, phase_effect_count: effectCount(job.job_id, "ingest"), call_chain: log };
  }
  {
    // 3d. A throwing reconciler is an unknown, not an authorisation.
    const log = [];
    const counters = countersOf();
    const job = newJob("throwing_reconciler");
    queue.setAdapter(makeAdapter({ log, counters, fault: "ingest_after_effect" }));
    await queue.process(job.job_id, context);
    queue.setAdapter(makeAdapter({ log, counters }));
    await queue.resume(job.job_id, context);
    queue.setAdapter(makeAdapter({ log, counters, reconcilePhase: () => { const error = new Error("synthetic reconcile transport timeout"); error.code = "SYNTHETIC_RECONCILE_TIMEOUT"; throw error; } }));
    const afterThrow = await queue.reconcile(job.job_id, context);
    eq(afterThrow.state, "manual_reconciliation", "throwing_reconciler_stays_parked");
    eq(afterThrow.error_code, "SYNTHETIC_RECONCILE_TIMEOUT", "throwing_reconciler_reports_its_own_code");
    eq(afterThrow.failed_phase, "ingest", "throwing_reconciler_keeps_the_phase");
    eq(effectCount(job.job_id, "ingest"), 1, "throwing_reconciler_did_not_replay");
    // And an indeterminate answer behaves the same way.
    queue.setAdapter(makeAdapter({ log, counters, reconcilePhase: () => ({}) }));
    const afterIndeterminate = await queue.reconcile(job.job_id, context);
    eq(afterIndeterminate.state, "manual_reconciliation", "indeterminate_reconciler_stays_parked");
    eq(afterIndeterminate.error_code, "GENERATION_PHASE_RECONCILIATION_REQUIRED", "indeterminate_reconciler_reports_the_phase_reason");
    eq(effectCount(job.job_id, "ingest"), 1, "indeterminate_reconciler_did_not_replay");
  }

  // -------------------------------------------------------------------------------------------------
  // 4. Restart coverage: the park survives a close/reopen, with its durable recovery basis.
  // -------------------------------------------------------------------------------------------------
  {
    // 4a. A phase-manual row (submission already proven).
    const log = [];
    const counters = countersOf();
    const job = newJob("restart_manual");
    queue.setAdapter(makeAdapter({ log, counters, fault: "ingest_after_effect" }));
    await queue.process(job.job_id, context);
    queue.setAdapter(makeAdapter({ log, counters }));
    await queue.resume(job.job_id, context);
    const beforeRestart = rowOf(job.job_id);
    eq(beforeRestart.state, "manual_reconciliation", "restart_manual_row_is_parked_before_the_restart");

    service.close();
    const restartLog = [];
    const restartCounters = countersOf();
    service = new VideoAssetService({ pluginConfig: { repositoryRoot } }).init();
    queue = new GenerationJobQueue({ db: service.db, config: jobConfig, entryPolicy, adapter: makeAdapter({ log: restartLog, counters: restartCounters, reconcilePhase: () => ({ found: true, value: { asset_id: "synthetic", asset_version_id: "synthetic_v1" } }) }) });
    const afterRestart = rowOf(job.job_id);
    eq(afterRestart.state, "manual_reconciliation", "restart_manual_row_stays_parked_across_the_restart");
    eq(afterRestart.failed_phase, "ingest", "restart_manual_row_keeps_its_durable_recovery_basis");
    eq(afterRestart.error_code, beforeRestart.error_code, "restart_manual_row_keeps_its_reason_code");
    eq(effectCount(job.job_id, "ingest"), 1, "restart_construction_did_not_replay_the_phase");
    eq(restartLog.length, 0, "restart_construction_called_no_adapter_phase", restartLog.join(" > "));
    // A second restart must not lose it either.
    service.close();
    service = new VideoAssetService({ pluginConfig: { repositoryRoot } }).init();
    queue = new GenerationJobQueue({ db: service.db, config: jobConfig, entryPolicy, adapter: makeAdapter({ log: [], counters: countersOf() }) });
    const afterSecondRestart = rowOf(job.job_id);
    eq(afterSecondRestart.state, "manual_reconciliation", "restart_manual_row_survives_a_second_restart");
    eq(afterSecondRestart.failed_phase, "ingest", "restart_manual_phase_survives_a_second_restart");
    // With a reliable reconciler it must still be legally recoverable.
    const recoveryLog = [];
    const recoveryCounters = countersOf();
    queue.setAdapter(makeAdapter({ log: recoveryLog, counters: recoveryCounters, reconcilePhase: () => ({ found: true, value: { asset_id: "synthetic", asset_version_id: "synthetic_v1" } }) }));
    const recovered = await queue.resume(job.job_id, context);
    eq(recovered.state, "completed", "restart_manual_row_recovers_legally_after_the_restart", recovered.error_message ?? "");
    eq(effectCount(job.job_id, "ingest"), 1, "restart_recovery_skipped_the_committed_phase");

    // 4b. The branch that cannot prove the provider request at all keeps its phase too. The row is
    // built from a real partial run (poll/download/validate committed their results, ingest failed
    // before committing anything) and only the submission confirmation is absent, which is what a
    // crash that loses the request id actually looks like. The committed results are kept, exactly
    // as a real interrupted row keeps them.
    const unprovenLog = [];
    const unprovenCounters = countersOf();
    const unproven = newJob("restart_unproven");
    queue.setAdapter(makeAdapter({ log: unprovenLog, counters: unprovenCounters, fault: "ingest_before_effect" }));
    const unprovenFirst = await queue.process(unproven.job_id, context);
    eq(unprovenFirst.state, "failed_recoverable", "restart_unproven_partial_run_failed_in_ingest");
    eq(effectCount(unproven.job_id, "ingest"), 0, "restart_unproven_committed_no_effect");
    const keptResults = Object.keys(JSON.parse(service.db.prepare("SELECT result_json FROM generation_jobs WHERE job_id=?").get(unproven.job_id).result_json));
    eq(keptResults.sort().join(","), "download,poll,submit,validate", "restart_unproven_row_keeps_its_committed_phase_results");
    service.db.prepare("UPDATE generation_jobs SET state='ingesting',phase='ingest',failed_phase=NULL,error_code=NULL,error_message=NULL,provider_submit_state='unknown',provider_request_id=NULL WHERE job_id=?").run(unproven.job_id);
    service.close();
    const unprovenRestartLog = [];
    const unprovenRestartCounters = countersOf();
    service = new VideoAssetService({ pluginConfig: { repositoryRoot } }).init();
    queue = new GenerationJobQueue({ db: service.db, config: jobConfig, entryPolicy, adapter: makeAdapter({ log: unprovenRestartLog, counters: unprovenRestartCounters, reconcilePhase: () => ({ found: false }) }) });
    const unprovenParked = rowOf(unproven.job_id);
    eq(unprovenParked.state, "manual_reconciliation", "restart_unproven_goes_to_the_operator");
    eq(unprovenParked.error_code, "GENERATION_PHASE_INTERRUPTED_UNVERIFIED", "restart_unproven_uses_its_own_code");
    eq(unprovenParked.failed_phase, "ingest", "restart_unproven_persists_the_interrupted_phase");
    eq(unprovenRestartLog.length, 0, "restart_unproven_ran_no_phase");
    // And after another restart the basis is still there, so it can be reconciled later.
    service.close();
    const lateLog = [];
    const lateCounters = countersOf();
    service = new VideoAssetService({ pluginConfig: { repositoryRoot } }).init();
    queue = new GenerationJobQueue({ db: service.db, config: jobConfig, entryPolicy, adapter: makeAdapter({ log: lateLog, counters: lateCounters, reconcilePhase: () => ({ found: false }) }) });
    eq(rowOf(unproven.job_id).failed_phase, "ingest", "restart_unproven_phase_survives_the_second_restart");
    const late = await queue.reconcile(unproven.job_id, context);
    eq(late.state, "completed", "restart_unproven_recovers_once_a_reconciler_exists", late.error_message ?? "");
    eq(effectCount(unproven.job_id, "ingest"), 1, "restart_unproven_ran_the_phase_exactly_once_after_authorisation");
    eq(lateCounters.submit, 0, "restart_unproven_never_resubmitted");
    eq(lateCounters.poll + lateCounters.download + lateCounters.validate, 0, "restart_unproven_never_reran_the_phases_that_had_already_committed");
    check("restart_unproven_logs_submission_then_phase_reconciliation", lateLog.join(" > ") === "reconcile_submit_only > reconcilePhase:ingest > ingest > writeback", lateLog.join(" > "));
    reports.restart_manual = { parked_state: afterRestart.state, parked_failed_phase: afterRestart.failed_phase, recovered_state: recovered.state, unproven_parked_state: unprovenParked.state, unproven_error_code: unprovenParked.error_code, unproven_failed_phase: unprovenParked.failed_phase, unproven_call_chain: lateLog };
  }

  // -------------------------------------------------------------------------------------------------
  // 5. Regressions.
  // -------------------------------------------------------------------------------------------------
  {
    // 5a. A genuine unknown submission has no interrupted phase, so submission reconciliation alone
    // is still the correct and sufficient answer.
    const log = [];
    const counters = countersOf();
    const job = newJob("unknown_submission");
    service.db.prepare("UPDATE generation_jobs SET state='submitting',phase='submit',provider_submit_state='submitting' WHERE job_id=?").run(job.job_id);
    queue.setAdapter(makeAdapter({ log, counters }));
    queue.recoverInterruptedSubmissions();
    eq(rowOf(job.job_id).state, "unknown_submission", "regression_unknown_submission_is_recognised");
    const reconciled = await queue.reconcile(job.job_id, context);
    eq(reconciled.state, "completed", "regression_unknown_submission_reconciles_to_completion", reconciled.error_message ?? "");
    eq(counters.submit, 0, "regression_unknown_submission_never_resubmitted");
    eq(effectCount(job.job_id, "ingest"), 1, "regression_unknown_submission_ran_the_pipeline_once");
    check("regression_unknown_submission_used_submission_reconciliation", log.join(" > ") === "reconcile_submit_only > poll > download > validate > ingest > writeback", log.join(" > "));

    // 5b. A failed submit is still never auto-retried, on any entry.
    const submitJob = newJob("submit_phase");
    service.db.prepare("UPDATE generation_jobs SET state='failed_recoverable',phase='submit',failed_phase='submit',error_code='SYNTHETIC_SUBMIT_FAILED',result_json='{}' WHERE job_id=?").run(submitJob.job_id);
    const submitLog = [];
    const submitCounters = countersOf();
    queue.setAdapter(makeAdapter({ log: submitLog, counters: submitCounters }));
    await rejectsCode(() => queue.resume(submitJob.job_id, context), "GENERATION_RESUBMIT_FORBIDDEN", "regression_submit_resume_is_forbidden");
    eq(submitCounters.submit, 0, "regression_submit_never_resent");
    eq(rowOf(submitJob.job_id).state, "failed_recoverable", "regression_submit_row_untouched");

    // 5c. A phase-interrupted job with no usable reconciler at all stays parked and reports why.
    const bareLog = [];
    const bareCounters = countersOf();
    const bare = newJob("bare_adapter");
    service.db.prepare("UPDATE generation_jobs SET state='ingesting',phase='ingest',failed_phase=NULL,provider_submit_state='submitted',provider_request_id='local_request_x',result_json='{}' WHERE job_id=?").run(bare.job_id);
    service.close();
    service = new VideoAssetService({ pluginConfig: { repositoryRoot } }).init();
    queue = new GenerationJobQueue({ db: service.db, config: jobConfig, entryPolicy, adapter: makeAdapter({ log: bareLog, counters: bareCounters }) });
    const bareParked = rowOf(bare.job_id);
    eq(bareParked.state, "failed_recoverable", "regression_bare_adapter_starts_recoverable");
    eq(bareParked.failed_phase, "ingest", "regression_bare_adapter_keeps_the_phase");
    const bareResumed = await queue.resume(bare.job_id, context);
    eq(bareResumed.state, "manual_reconciliation", "regression_bare_adapter_parks_on_resume");
    eq(effectCount(bare.job_id, "ingest"), 0, "regression_bare_adapter_did_not_replay");
    reports.regressions = { unknown_submission_final_state: reconciled.state, unknown_submission_chain: log.join(" > "), submit_phase_forbidden: true, bare_adapter_final_state: bareResumed.state };
  }

  const report = {
    ok: checks.every((item) => item.ok),
    fixture: "generation-job-phase-entry-gate",
    zero_cost_mock: true,
    public_network_used: false,
    paid_provider_called: false,
    reviewed_commit: REVIEWED_COMMIT,
    checks: checks.length,
    gap_reproduced_against_reviewed_class: reports.pre_fix.gap_reproduced,
    reports,
    limitations: [
      "Local adapters and an isolated SQLite database only: no real provider, no public network, no credits.",
      "The phases' side effects are synthetic rows in a fixture table, so the counts prove the queue's decisions rather than real asset or provider effects.",
      "The pre-fix comparison imports the reviewed revision's queue class from git history and runs it against the same database; it is a behaviour comparison, not a production rollback test.",
      "A real provider's own phase-reconciliation API remains unverified (REN-11/REN-13)."
    ]
  };
  if (outJson) {
    await fs.promises.mkdir(path.dirname(path.resolve(outJson)), { recursive: true });
    await fs.promises.writeFile(path.resolve(outJson), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(report, null, 2));
  console.log("generation job phase entry gate test passed");
} finally {
  try { service?.close(); } catch { /* already closed */ }
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
