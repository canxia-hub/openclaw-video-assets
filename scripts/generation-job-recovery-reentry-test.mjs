// REN-10 recovery re-entry fixture: a hard stop INSIDE the recovery itself.
//
// THE GAP THIS CLOSES (parent round-2 review, 45-ren10-recovery-reentry-review.md)
//   The public-entry fix made `reconcile` reconcile the phase before continuing, but the recovery
//   sequence had a window of its own. `reconcileSubmission` confirms the provider request and writes
//   `state='submitted', phase='poll'` while `failed_phase='ingest'` is still unresolved; startup
//   recovery then mapped `state='submitted'` back to `poll`, overwrote the recorded phase, and the
//   pipeline re-ran `ingest` - whose effect had already committed - before ever reconciling it.
//   The parent probe measured exactly that: exit(9) inside the phase reconcile after submission
//   confirmation, restart with `failed_recoverable/poll`, chain `reconcilePhase:poll > ingest >
//   writeback`, effect count 2.
//
// WHAT IS ASSERTED HERE
//   1. The pending-phase marker survives the submission confirmation: the row is inspected between
//      the two writes, and the marker - not the advanced `state` - names the phase in doubt.
//   2. Scenario A: real `process.exit(9)` inside the phase reconcile, after submission confirmation.
//      After restart the phase in doubt is still `ingest`, the gate reconciles `ingest` (not `poll`),
//      and the committed effect is never re-executed.
//   3. Scenario B: the same seeding and the same crash against the REVIEWED revision's own class, to
//      prove the fixture can actually see the gap (count 2, completed) - a fixture that passes against
//      both builds would prove nothing.
//   4. Scenario C: crash after a `found=true` checkpoint, entering the next phase. The consumed phase
//      must not be re-gated or re-run, and recovery must resume at the next unresolved phase.
//   5. Scenario D: crash after a `found=false` authorisation, on entry to the authorised retry. The
//      retry is not lost, and it still happens exactly once.
//   6. Scenario E: the recovery is interrupted a second time (exit(9) inside the gate again, on a row
//      that is already parked) and only then completed - recovery is re-entrant.
//
// Zero cost: local adapters, an isolated SQLite database, no provider, no network, no credits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REVIEWED_COMMIT = "fa94d04737a1789a0df8712f6872c6e3ab0afde2";
const CRASH_EXIT_CODE = 9;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scriptDir, "..");
const outIndex = process.argv.indexOf("--out-json");
const outJson = outIndex >= 0 ? process.argv[outIndex + 1] : null;

const context = { trusted: true, actor_id: "agent:reentry-fixture", actor_type: "agent", surface: "tool", scopes: ["operator.read", "operator.write"] };
const jobConfig = { enabled: true, maxCredits: 500, maxConcurrent: 1 };
const entryPolicy = { test: { provider: "local", reference_estimate_credits: 1 } };

// ------------------------------------------------------------------------------------------------
// Worker: performs one scenario's real work and dies with process.exit(9) inside the library's await.
// ------------------------------------------------------------------------------------------------
if (process.argv[2] === "worker") {
  const [, , , root, scenario, jobId = "", legacyPath = ""] = process.argv;
  const queueModule = legacyPath
    ? await import(pathToFileURL(legacyPath).href)
    : await import(pathToFileURL(path.join(repo, "src/generation-jobs.js")).href);
  const { GenerationJobQueue } = queueModule;
  const { VideoAssetService } = await import(pathToFileURL(path.join(repo, "src/service.js")).href);
  const service = new VideoAssetService({ pluginConfig: { repositoryRoot: root } }).init();
  service.db.exec("CREATE TABLE IF NOT EXISTS phase_effects (id INTEGER PRIMARY KEY, job_id TEXT, phase TEXT)");
  const effect = (id) => service.db.prepare("INSERT INTO phase_effects (job_id,phase) VALUES (?,?)").run(id, "ingest");

  const calls = [];
  const snapshot = (job, extra = {}) => {
    const row = service.db.prepare("SELECT state,phase,failed_phase,pending_phase,provider_submit_state,provider_request_id,result_json FROM generation_jobs WHERE job_id=?").get(job.job_id);
    fs.writeFileSync(path.join(root, "crash-snapshot.json"), `${JSON.stringify({ row, calls, ...extra }, null, 2)}\n`, "utf8");
  };
  const die = (job, extra) => { snapshot(job, extra); process.exit(CRASH_EXIT_CODE); };

  const knobs = {
    // A/B: the parent's window - submission confirmed, then death inside the phase reconcile.
    exitInGate: scenario === "A" || scenario === "B" || scenario === "E",
    // C: the phase reconcile succeeds (found=true, checkpoint written), then death entering the next phase.
    exitInWriteback: scenario === "C",
    // D: the phase reconcile authorises a retry (found=false), then death on entry to that retry.
    exitInIngestRetry: scenario === "D",
    // E: the row is already parked when this worker starts, so the recovery itself is interrupted again.
    seedManual: scenario === "A" || scenario === "B" || scenario === "E",
    preEffectFault: scenario === "D",
    postEffectFault: scenario === "C"
  };

  let ingestCalls = 0;
  const adapter = {
    async submit(job) { calls.push("submit"); return { provider_request_id: `local_request_${job.job_id}` }; },
    async poll() { calls.push("poll"); return { status: "completed", actual_credits: 1 }; },
    async download() { calls.push("download"); return { file_path: "local-only" }; },
    async validate() { calls.push("validate"); return { ok: true }; },
    async ingest(job) {
      ingestCalls += 1;
      calls.push("ingest");
      if (knobs.exitInIngestRetry && ingestCalls === 2) die(job, { died: "entering the authorised ingest retry, before its effect" });
      if (knobs.preEffectFault && ingestCalls === 1) { const error = new Error("synthetic response lost before any effect"); error.code = "SYNTHETIC_INGEST_PRE_FAULT"; throw error; }
      effect(job.job_id);
      if (knobs.postEffectFault && ingestCalls === 1) { const error = new Error("synthetic response lost after the effect committed"); error.code = "SYNTHETIC_INGEST_POST_FAULT"; throw error; }
      return { asset_id: "synthetic", asset_version_id: "synthetic_v1" };
    },
    async writeback(job) {
      calls.push("writeback");
      if (knobs.exitInWriteback) die(job, { died: "entering writeback, after the found=true checkpoint was durable" });
      return { ok: true };
    },
    async reconcile(job) { calls.push("reconcile_submission"); return { found: true, provider_request_id: `local_request_confirmed_${job.job_id}` }; }
  };
  // The phase reconciler is only installed where the scenario wants it. The base adapter has none, so
  // a setup run parks through the public entry instead of resolving the phase on the way past.
  const gate = (answer) => Object.assign(Object.create(Object.getPrototypeOf(adapter)), adapter, {
    reconcilePhase: async (job, phase) => {
      calls.push(`reconcilePhase:${phase}`);
      if (knobs.exitInGate) die(job, { died: `inside the phase reconcile for ${phase}`, gate_phase: phase });
      return answer(job, phase);
    }
  });

  const queue = new GenerationJobQueue({ db: service.db, config: jobConfig, entryPolicy, adapter: knobs.exitInGate ? gate(() => ({ found: true })) : adapter });
  let jobIdResolved = jobId;
  if (knobs.seedManual) {
    if (!jobIdResolved) {
      const created = queue.create({ idempotency_key: `reentry-${scenario}`, entry: "test", provider: "local", confirm_cost: true, estimate_credits: 1 }, context);
      jobIdResolved = created.job_id;
      // The documented starting point: submit credentials unproven, `poll/download/validate` already
      // committed their results, `ingest` already committed its effect, nothing recorded for it.
      effect(jobIdResolved);
      service.db.prepare("UPDATE generation_jobs SET state='manual_reconciliation',phase='reconcile',failed_phase='ingest',provider_submit_state='unknown',provider_request_id=NULL,result_json=? WHERE job_id=?")
        .run(JSON.stringify({ poll: { status: "completed" }, download: { file_path: "local-only" }, validate: { ok: true } }), jobIdResolved);
    }
    if (knobs.exitInGate) queue.setAdapter(gate(() => ({ found: true })));
    // The entry depends on where the row stands: an operator-parked row is served by `reconcile`,
    // while a row startup recovery has already parked as recoverable is served by `process`, which
    // routes it through `resume`. A repeated interruption therefore takes whatever entry is legal.
    const state = service.db.prepare("SELECT state FROM generation_jobs WHERE job_id=?").get(jobIdResolved).state;
    const entry = state === "failed_recoverable" ? "process" : "reconcile";
    fs.writeFileSync(path.join(root, "entry.txt"), entry, "utf8");
    await queue[entry](jobIdResolved, context);
  } else {
    const created = queue.create({ idempotency_key: `reentry-${scenario}`, entry: "test", provider: "local", confirm_cost: true, estimate_credits: 1 }, context);
    jobIdResolved = created.job_id;
    await queue.process(jobIdResolved, context);
    const parked = await queue.resume(jobIdResolved, context);
    if (parked.state !== "manual_reconciliation") throw new Error(`scenario ${scenario}: expected the run to park without a phase reconciler, got ${parked.state}`);
    if (scenario === "C") {
      // The provider resolves the interrupted phase (found=true), then the next phase dies on entry.
      queue.setAdapter(gate(() => ({ found: true, value: { asset_id: "synthetic", asset_version_id: "synthetic_v1" } })));
      await queue.resume(jobIdResolved, context);
    }
    if (scenario === "D") {
      // The provider proves no effect (found=false), then the authorised retry dies on entry.
      queue.setAdapter(gate(() => ({ found: false })));
      await queue.resume(jobIdResolved, context);
    }
  }
  throw new Error(`worker did not crash in scenario ${scenario}`);
}

// ------------------------------------------------------------------------------------------------
// Parent: drives the scenarios and inspects the durable rows between processes.
// ------------------------------------------------------------------------------------------------
const { VideoAssetService } = await import(pathToFileURL(path.join(repo, "src/service.js")).href);
const { GenerationJobQueue } = await import(pathToFileURL(path.join(repo, "src/generation-jobs.js")).href);

const checks = [];
function check(id, condition, detail) {
  checks.push({ id, ok: Boolean(condition), detail });
  if (!condition) throw new Error(`${id}: ${detail}`);
}
function eq(actual, expected, id) {
  check(id, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-ren10-reentry-"));
const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex >= 0 ? new Set(process.argv[onlyIndex + 1].split(",").map((name) => name.trim().toUpperCase())) : null;
const wanted = (name) => !only || only.has(name);
// Progress goes to stderr so a run that blocks can be located without reading the whole fixture.
const step = (message) => process.stderr.write(`[reentry] ${message}\n`);
// A hang in a fixture is worse than a failure: it hides which window broke. Every scenario block is
// guarded so a stalled step is reported as a failure with the step's name instead of blocking forever.
const withDeadline = async (label, promise, ms = 30000) => {
  let timer = null;
  const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`step timed out after ${ms} ms: ${label}`)), ms); });
  try { return await Promise.race([promise, guard]); } finally { clearTimeout(timer); }
};
const legacySource = execFileSync("git", ["-C", repo, "show", `${REVIEWED_COMMIT}:src/generation-jobs.js`], { encoding: "utf8" });
check("reviewed_revision_source_is_the_pre_reentry_build", !legacySource.includes("pending_phase") && !legacySource.includes("pendingPhaseOf"), `git show ${REVIEWED_COMMIT}:src/generation-jobs.js`);
const legacyPath = path.join(tmp, "reviewed-generation-jobs.mjs");
await fs.promises.writeFile(legacyPath, legacySource, "utf8");

const selfPath = fileURLToPath(import.meta.url);
const runWorker = (root, scenario, jobId = "", legacy = "") => {
  const args = [selfPath, "worker", root, scenario];
  if (jobId) args.push(jobId); else args.push("");
  args.push(legacy);
  const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60000 });
  return result;
};
const openRoot = (root, QueueClass = GenerationJobQueue) => {
  const service = track(new VideoAssetService({ pluginConfig: { repositoryRoot: root } }).init());
  const queue = new QueueClass({ db: service.db, config: jobConfig, entryPolicy, adapter: null });
  return { service, queue };
};
// A raw handle, so a control build can be given the row BEFORE the fixed class's constructor has run
// its own startup recovery over it. VideoAssetService builds a queue internally from the fixed module,
// which would otherwise recover the row first and hide what the reviewed build actually does.
const sqlitePath = (root) => path.join(root, "metadata", "video-assets.sqlite");
const firstJobIdIn = (db) => db.prepare("SELECT job_id FROM generation_jobs ORDER BY created_at LIMIT 1").get().job_id;
const rowOf = (service, jobId) => service.db.prepare("SELECT state,phase,failed_phase,pending_phase,provider_submit_state,provider_request_id,result_json FROM generation_jobs WHERE job_id=?").get(jobId);
const effectCount = (service, jobId) => service.db.prepare("SELECT COUNT(*) AS n FROM phase_effects WHERE job_id=?").get(jobId).n;
const snapshotOf = (root) => JSON.parse(fs.readFileSync(path.join(root, "crash-snapshot.json"), "utf8"));
const firstJobId = (service) => service.db.prepare("SELECT job_id FROM generation_jobs ORDER BY created_at LIMIT 1").get().job_id;

// A working recovery adapter: submission confirmed, phase reconciled by the provider's own answer.
// The database is passed in rather than read from the outer `service`, so a scenario that works over a
// raw handle cannot accidentally address a service that has already been closed.
const recoveryAdapter = (calls, phaseAnswer, db) => ({
  async submit() { calls.push("submit"); return { provider_request_id: "unused" }; },
  async poll() { calls.push("poll"); return { status: "completed", actual_credits: 1 }; },
  async download() { calls.push("download"); return { file_path: "local-only" }; },
  async validate() { calls.push("validate"); return { ok: true }; },
  async ingest(job) { calls.push("ingest"); db.prepare("INSERT INTO phase_effects (job_id,phase) VALUES (?,?)").run(job.job_id, "ingest"); return { asset_id: "synthetic", asset_version_id: "synthetic_v1" }; },
  async writeback() { calls.push("writeback"); return { ok: true }; },
  async reconcile(job) { calls.push("reconcile_submission"); return { found: true, provider_request_id: `local_request_confirmed_${job.job_id}` }; },
  async reconcilePhase(job, phase) { calls.push(`reconcilePhase:${phase}`); return phaseAnswer(job, phase); }
});
let service = null;
let queue = null;
// Every handle this fixture opens is tracked, so a failed assertion still closes them. Windows keeps a
// SQLite file locked while a handle is open, and a cleanup that blocks on that lock would hide the
// real failure behind a hang - the worst possible outcome for a fixture whose job is to report.
const openHandles = [];
const track = (handle) => { openHandles.push(handle); return handle; };
const closeAll = () => {
  while (openHandles.length) {
    const handle = openHandles.pop();
    try { handle.close(); } catch { /* already closed */ }
  }
};

try {
  const reports = {};

  // ------------------------------------------------------------------------------------------------
  // 1. Scenario A: the parent's window, on the fixed build.
  // ------------------------------------------------------------------------------------------------
  if (wanted("A")) {
    const root = path.join(tmp, "scenario-a");
    await fs.promises.mkdir(root, { recursive: true });
    step("A: spawning the crashing worker");
    const worker = runWorker(root, "A");
    eq(worker.status, CRASH_EXIT_CODE, "a_worker_died_with_exit_9");
    const snapshot = snapshotOf(root);
    // The marker - not the advanced `state` - is what names the phase in doubt.
    eq(snapshot.row.state, "submitted", "a_before_crash_state_is_submitted");
    eq(snapshot.row.phase, "ingest", "a_before_crash_phase_still_names_the_doubtful_phase");
    eq(snapshot.row.pending_phase, "ingest", "a_submission_confirmation_did_not_clear_the_pending_marker");
    eq(snapshot.row.failed_phase, "ingest", "a_submission_confirmation_did_not_overwrite_failed_phase");
    eq(snapshot.calls.join(" > "), "reconcile_submission > reconcilePhase:ingest", "a_crash_happened_inside_the_ingest_phase_reconcile");

    // Restart, exactly as the parent did.
    step("A: reopening after the crash");
    ({ service } = openRoot(root));
    const jobId = firstJobId(service);
    const afterStartup = rowOf(service, jobId);
    eq(afterStartup.state, "failed_recoverable", "a_restart_parks_the_job");
    eq(afterStartup.pending_phase, "ingest", "a_restart_keeps_the_pending_marker");
    eq(afterStartup.phase, "ingest", "a_restart_derives_ingest_not_poll_from_the_state");
    eq(afterStartup.failed_phase, "ingest", "a_restart_does_not_overwrite_the_recorded_phase");
    eq(effectCount(service, jobId), 1, "a_restart_replayed_no_phase");
    check("a_restart_ran_no_adapter_phase", !fs.existsSync(path.join(root, "restart-calls.json")), "no adapter was invoked by the constructor itself");

    const calls = [];
    queue = new GenerationJobQueue({ db: service.db, config: jobConfig, entryPolicy, adapter: recoveryAdapter(calls, (job, phase) => ({ found: true, value: phase === "poll" ? { status: "completed", actual_credits: 1 } : { asset_id: "synthetic", asset_version_id: "synthetic_v1" } }), service.db) });
    // `resume` is the operator entry for a parked row; the constructor already decided the job is
    // recoverable rather than operator-only, which is itself an assertion above.
    const finished = await queue.resume(jobId, context);
    eq(finished.state, "completed", "a_recovery_completes");
    eq(effectCount(service, jobId), 1, "a_the_committed_ingest_effect_was_never_re_executed");
    check("a_recovery_reconciled_ingest_not_poll", calls.join(" > ") === "reconcilePhase:ingest > writeback", calls.join(" > "));
    reports.scenario_a = { before_crash: { state: snapshot.row.state, phase: snapshot.row.phase, pending_phase: snapshot.row.pending_phase, failed_phase: snapshot.row.failed_phase }, after_startup: { state: afterStartup.state, phase: afterStartup.phase, pending_phase: afterStartup.pending_phase }, final_state: finished.state, effect_count: effectCount(service, jobId), call_chain: calls };
    service.close();
  }

  // ------------------------------------------------------------------------------------------------
  // 2. Scenario B: the reviewed build end to end, to prove the fixture sees the gap; then the same
  //    legacy-written row recovered by the fixed build, to prove the fix does not depend on the
  //    marker having been written by the same version (the real upgrade path).
  // ------------------------------------------------------------------------------------------------
  if (wanted("B")) {
    const ReviewedQueue = (await import(pathToFileURL(legacyPath).href)).GenerationJobQueue;
    const phaseAnswer = (job, phase) => ({ found: true, value: phase === "poll" ? { status: "completed", actual_credits: 1 } : { asset_id: "synthetic", asset_version_id: "synthetic_v1" } });

    // B1: the reviewed revision performs both the crash AND the recovery, as the parent ran it. The
    // row is handed to the reviewed class over a raw handle, before the fixed class can recover it.
    const root = path.join(tmp, "scenario-b1");
    await fs.promises.mkdir(root, { recursive: true });
    step("B1: spawning the reviewed-build worker");
    const worker = runWorker(root, "B", "", legacyPath);
    eq(worker.status, CRASH_EXIT_CODE, "b1_reviewed_build_died_with_exit_9");
    const snapshot = snapshotOf(root);
    check("b1_reviewed_build_has_no_pending_marker", !("pending_phase" in snapshot.row) || snapshot.row.pending_phase === null, JSON.stringify(snapshot.row.pending_phase));
    eq(snapshot.row.state, "submitted", "b1_reviewed_build_left_the_row_at_submitted");
    eq(snapshot.row.failed_phase, "ingest", "b1_reviewed_build_still_recorded_ingest_before_the_restart");
    const db1 = track(new DatabaseSync(sqlitePath(root)));
    const handle1 = { db: db1 };
    const jobId = firstJobIdIn(db1);
    const calls = [];
    step("B1: constructing the reviewed queue");
    const reviewedQueue = new ReviewedQueue({ db: db1, config: jobConfig, entryPolicy, adapter: recoveryAdapter(calls, phaseAnswer, db1) });
    step("B1: reviewed queue constructed");
    const afterStartup = rowOf(handle1, jobId);
    eq(afterStartup.state, "failed_recoverable", "b1_reviewed_build_parks_the_job");
    eq(afterStartup.phase, "poll", "b1_reviewed_build_loses_the_recorded_phase_to_poll");
    eq(afterStartup.failed_phase, "poll", "b1_reviewed_build_overwrites_failed_phase_with_poll");
    step("B1: driving the reviewed recovery");
    // The reviewed build's recovery left the row at `failed_recoverable`, and the reviewed `reconcile`
    // only serves the unknown-submission and operator-parked states - so its own `process` entry is
    // the one the parent's probe used to reach the pipeline from here.
    const finished = await withDeadline("B1 reviewed process", reviewedQueue.process(jobId, context));
    step("B1: reviewed recovery returned");
    const count = effectCount(handle1, jobId);
    eq(finished.state, "completed", "b1_reviewed_build_completes");
    eq(count, 2, "b1_reviewed_build_reproduces_the_duplicate_effect");
    check("b1_chain_matches_the_parent_chain", calls.join(" > ") === "reconcilePhase:poll > ingest > writeback", calls.join(" > "));
    db1.close();

    // B2: the same legacy-written crash, recovered by the fixed build.
    const root2 = path.join(tmp, "scenario-b2");
    await fs.promises.mkdir(root2, { recursive: true });
    step("B2: spawning the reviewed-build worker for the fixed-recovery control");
    const worker2 = runWorker(root2, "B", "", legacyPath);
    eq(worker2.status, CRASH_EXIT_CODE, "b2_reviewed_build_died_with_exit_9");
    ({ service } = openRoot(root2));
    const jobId2 = firstJobId(service);
    const fixedStartup = rowOf(service, jobId2);
    eq(fixedStartup.pending_phase, "ingest", "b2_fixed_recovery_recovers_the_phase_from_the_legacy_row");
    eq(fixedStartup.phase, "ingest", "b2_fixed_recovery_does_not_lose_the_phase_a_legacy_row_recorded");
    const fixedCalls = [];
    queue = new GenerationJobQueue({ db: service.db, config: jobConfig, entryPolicy, adapter: recoveryAdapter(fixedCalls, phaseAnswer, service.db) });
    const fixedFinished = await queue.resume(jobId2, context);
    eq(fixedFinished.state, "completed", "b2_fixed_recovery_completes");
    eq(effectCount(service, jobId2), 1, "b2_fixed_recovery_does_not_duplicate_a_legacy_row_effect");
    check("b2_fixed_recovery_gates_ingest", fixedCalls.join(" > ") === "reconcilePhase:ingest > writeback", fixedCalls.join(" > "));
    reports.scenario_b_reviewed_build = { reviewed_commit: REVIEWED_COMMIT, after_startup: { state: afterStartup.state, phase: afterStartup.phase, failed_phase: afterStartup.failed_phase }, final_state: finished.state, effect_count: count, call_chain: calls };
    reports.scenario_b2_legacy_row_recovered_by_fixed_build = { startup: { pending_phase: fixedStartup.pending_phase, phase: fixedStartup.phase }, final_state: fixedFinished.state, effect_count: effectCount(service, jobId2), call_chain: fixedCalls };
  }

  // ------------------------------------------------------------------------------------------------
  // 3. Scenario C: crash after the found=true checkpoint, entering the next phase.
  // ------------------------------------------------------------------------------------------------
  if (wanted("C")) {
    const root = path.join(tmp, "scenario-c");
    await fs.promises.mkdir(root, { recursive: true });
    step("C: spawning the worker that dies entering writeback");
    const worker = runWorker(root, "C");
    eq(worker.status, CRASH_EXIT_CODE, "c_worker_died_with_exit_9");
    const snapshot = snapshotOf(root);
    const beforeResults = JSON.parse(snapshot.row.result_json);
    check("c_checkpoint_for_ingest_was_durable_before_the_crash", beforeResults.ingest !== undefined, JSON.stringify(Object.keys(beforeResults)));
    eq(snapshot.row.pending_phase, null, "c_the_consumed_marker_is_gone");
    eq(snapshot.row.state, "writing_back", "c_crash_happened_entering_writeback");
    ({ service } = openRoot(root));
    const jobId = firstJobId(service);
    const afterStartup = rowOf(service, jobId);
    eq(afterStartup.pending_phase, "writeback", "c_no_stale_marker_routes_back_to_the_consumed_phase");
    eq(afterStartup.phase, "writeback", "c_recovery_resumes_at_the_next_unresolved_phase");
    eq(effectCount(service, jobId), 1, "c_the_consumed_phase_was_not_re_executed");
    const calls = [];
    queue = new GenerationJobQueue({ db: service.db, config: jobConfig, entryPolicy, adapter: recoveryAdapter(calls, () => ({ found: false }), service.db) });
    const finished = await queue.resume(jobId, context);
    eq(finished.state, "completed", "c_second_recovery_completes");
    eq(effectCount(service, jobId), 1, "c_ingest_still_ran_exactly_once");
    check("c_ingest_was_never_re_gated", !calls.some((call) => call === "reconcilePhase:ingest"), calls.join(" > "));
    eq(calls.join(" > "), "reconcilePhase:writeback > writeback", "c_only_the_unresolved_phase_was_gated");
    reports.scenario_c = { after_startup: { pending_phase: afterStartup.pending_phase, phase: afterStartup.phase }, final_state: finished.state, effect_count: effectCount(service, jobId), call_chain: calls };
    service.close();
  }

  // ------------------------------------------------------------------------------------------------
  // 4. Scenario D: crash after the found=false authorisation, on entry to the authorised retry.
  // ------------------------------------------------------------------------------------------------
  if (wanted("D")) {
    const root = path.join(tmp, "scenario-d");
    await fs.promises.mkdir(root, { recursive: true });
    step("D: spawning the worker that dies entering the authorised retry");
    const worker = runWorker(root, "D");
    eq(worker.status, CRASH_EXIT_CODE, "d_worker_died_with_exit_9");
    const snapshot = snapshotOf(root);
    eq(snapshot.row.pending_phase, null, "d_the_consumed_marker_is_gone");
    eq(snapshot.row.state, "ingesting", "d_crash_happened_entering_the_authorised_retry");
    ({ service } = openRoot(root));
    const jobId = firstJobId(service);
    eq(effectCount(service, jobId), 0, "d_no_effect_existed_before_the_retry");
    const afterStartup = rowOf(service, jobId);
    eq(afterStartup.pending_phase, "ingest", "d_the_authorised_retry_is_not_lost");
    eq(afterStartup.phase, "ingest", "d_recovery_resumes_at_the_authorised_phase");
    const calls = [];
    queue = new GenerationJobQueue({ db: service.db, config: jobConfig, entryPolicy, adapter: recoveryAdapter(calls, () => ({ found: false }), service.db) });
    const finished = await queue.resume(jobId, context);
    eq(finished.state, "completed", "d_second_recovery_completes");
    eq(effectCount(service, jobId), 1, "d_the_authorised_retry_ran_the_phase_exactly_once");
    check("d_chain_is_gate_then_retry", calls.join(" > ") === "reconcilePhase:ingest > ingest > writeback", calls.join(" > "));
    reports.scenario_d = { after_startup: { pending_phase: afterStartup.pending_phase, phase: afterStartup.phase }, final_state: finished.state, effect_count: effectCount(service, jobId), call_chain: calls };
    service.close();
  }

  // ------------------------------------------------------------------------------------------------
  // 5. Scenario E: the recovery itself is interrupted twice more before it completes.
  // ------------------------------------------------------------------------------------------------
  if (wanted("E")) {
    const root = path.join(tmp, "scenario-e");
    await fs.promises.mkdir(root, { recursive: true });
    step("E: first interrupted recovery");
    const first = runWorker(root, "E");
    eq(first.status, CRASH_EXIT_CODE, "e_first_attempt_died_with_exit_9");
    ({ service } = openRoot(root));
    const jobId = firstJobId(service);
    const afterFirst = rowOf(service, jobId);
    eq(afterFirst.pending_phase, "ingest", "e_marker_survived_the_first_interrupted_recovery");
    service.close();
    // Second attempt: the same real crash again, on a row that is already parked.
    const second = runWorker(root, "E", jobId);
    eq(second.status, CRASH_EXIT_CODE, "e_second_attempt_died_with_exit_9");
    const secondSnapshot = snapshotOf(root);
    eq(secondSnapshot.row.pending_phase, "ingest", "e_marker_survived_the_second_interrupted_recovery");
    eq(fs.readFileSync(path.join(root, "entry.txt"), "utf8"), "process", "e_the_second_attempt_used_the_entry_legal_for_a_recoverable_row");
    ({ service } = openRoot(root));
    eq(effectCount(service, jobId), 1, "e_no_phase_ran_during_the_interrupted_recoveries");
    const calls = [];
    queue = new GenerationJobQueue({ db: service.db, config: jobConfig, entryPolicy, adapter: recoveryAdapter(calls, () => ({ found: true, value: { asset_id: "synthetic", asset_version_id: "synthetic_v1" } }), service.db) });
    const afterStartup = rowOf(service, jobId);
    eq(afterStartup.pending_phase, "ingest", "e_marker_still_present_after_the_second_restart");
    const finished = await queue.resume(jobId, context);
    eq(finished.state, "completed", "e_third_attempt_completes");
    eq(effectCount(service, jobId), 1, "e_the_effect_still_ran_exactly_once");
    check("e_third_attempt_gated_the_doubtful_phase", calls.join(" > ") === "reconcilePhase:ingest > writeback", calls.join(" > "));
    reports.scenario_e = { interrupted_attempts: 2, marker_after_each: "ingest", final_state: finished.state, effect_count: effectCount(service, jobId), call_chain: calls };
    service.close();
  }

  const report = {
    ok: checks.every((item) => item.ok),
    fixture: "generation-job-recovery-reentry",
    zero_cost_mock: true,
    public_network_used: false,
    paid_provider_called: false,
    reviewed_commit: REVIEWED_COMMIT,
    checks: checks.length,
    gap_reproduced_against_reviewed_class: reports.scenario_b_reviewed_build.effect_count > 1,
    recovery_windows_covered: [
      "real process death inside the phase reconcile, after the submission was confirmed",
      "real process death entering the phase after a found=true checkpoint",
      "real process death entering the authorised retry after a found=false answer",
      "the recovery itself interrupted twice on an already-parked row, then completed"
    ],
    reports,
    limitations: [
      "Local adapters and an isolated SQLite database only: no real provider, no public network, no credits.",
      "The phases' side effects are synthetic rows in a fixture table, so the counts prove the queue's decisions rather than real asset or provider effects.",
      "The interrupted rows are seeded through SQL for the parent's scenario, and produced by real runs for the checkpoint and retry-authorisation scenarios; the process deaths themselves are real.",
      "The pre-fix comparison imports the reviewed revision's queue class from git history and runs it against the same database; it is a behaviour comparison, not a production rollback test.",
      "A real provider's own phase-reconciliation API remains unverified (REN-11/REN-13)."
    ]
  };
  if (outJson) {
    await fs.promises.mkdir(path.dirname(path.resolve(outJson)), { recursive: true });
    await fs.promises.writeFile(path.resolve(outJson), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(report, null, 2));
  console.log("generation job recovery re-entry test passed");
} finally {
  closeAll();
  try { service?.close(); } catch { /* already closed */ }
  // Bound and never fatal: a cleanup problem must not turn a reported failure into a hang.
  try { await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  catch (error) { process.stderr.write(`[reentry] cleanup left ${tmp}: ${error.code ?? error.message}\n`); }
}
