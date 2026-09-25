// REN-10 acceptance fixture: a REAL restart across a hard process death, not an in-process catch.
//
// WHAT THIS PROVES, AND HOW IT DIFFERS FROM THE LIFECYCLE TEST
//   `generation-job-lifecycle-test.mjs` simulates "the side effect committed but the response was
//   lost" by throwing from the adapter after the effect. The running process catches that, persists
//   `failed_recoverable`, and the job advances through `resume`. The state this fixture produces is
//   different and was the actual defect: the process DIES inside a post-submit phase, so the row is
//   left in that phase's named state (`downloading` / `ingesting` / `writing_back`) with no result
//   entry for it and no failure handler involved at all.
//
//   Per cycle the driver:
//     1. spawns a child that performs the phase's real side effect and then `process.exit(9)`;
//     2. reads the leftover row through a raw SQLite connection and asserts it is the interrupted
//        phase state - and that no `compensation_pending` event exists, which is what a caught
//        failure would have left;
//     3. builds the PRE-FIX queue class from the last reviewed commit (`git show`) against that same
//        database and asserts it does NOT recover the row - the gap, reproduced on the real artifact;
//     4. closes the database and constructs a NEW service, whose constructor must persist the row as
//        recoverable while keeping `failed_phase`;
//     5. resumes through `processGenerationJob`, whose first act must be `reconcilePhase`;
//     6. asserts the provider was submitted exactly once, and that asset versions, canvas edges and
//        the budget ledger contain exactly one entry for the job.
//
//   Zero cost: the crashed child uses a local adapter. No provider, no network, no credits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { VideoAssetService } from "../src/service.js";
import {
  CRASH_EXIT_CODE,
  call,
  crashFixtureConfig,
  downloadPathFor,
  interruptedStateForPhase,
  jobMarker,
  sha256File,
  sqlitePath,
  toolA
} from "./lib-generation-job-crash-fixture.mjs";

// The last reviewed revision: the pre-fix behaviour is read from history rather than assumed.
const PRE_FIX_COMMIT = "fb999d755bcb12087c26bbfbdcc40089972c084d";

const outIndex = process.argv.indexOf("--out-json");
const outJson = outIndex >= 0 ? process.argv[outIndex + 1] : null;
// Raw child-produced evidence is kept next to the report so the crash proof does not live only
// inside a temporary directory that this run deletes.
const evidenceDirIndex = process.argv.indexOf("--evidence-dir");
const evidenceDirArg = evidenceDirIndex >= 0 ? process.argv[evidenceDirIndex + 1] : (outJson ? path.dirname(path.resolve(outJson)) : null);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scriptDir, "..");
const workerPath = path.join(scriptDir, "generation-job-crash-worker.mjs");

const checks = [];
function check(id, condition, detail) {
  checks.push({ id, ok: Boolean(condition), detail });
  if (!condition) throw new Error(`${id}: ${detail}`);
}
function eq(actual, expected, id, extra = "") {
  check(id, actual === expected, `${id}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${extra ? ` (${extra})` : ""}`);
}

const cycles = [
  {
    id: "crash_at_download",
    phase: "download",
    withReconciler: true,
    expectFinalState: "completed",
    expectPhaseCalls: { poll: 0, download: 0, validate: 1, ingest: 1, writeback: 1 },
    expectEdges: 1,
    expectCompensation: "resolved"
  },
  {
    id: "crash_at_ingest",
    phase: "ingest",
    withReconciler: true,
    expectFinalState: "completed",
    expectPhaseCalls: { poll: 0, download: 0, validate: 0, ingest: 0, writeback: 1 },
    expectEdges: 1,
    expectCompensation: "resolved"
  },
  {
    id: "crash_at_writeback",
    phase: "writeback",
    withReconciler: true,
    expectFinalState: "completed",
    expectPhaseCalls: { poll: 0, download: 0, validate: 0, ingest: 0, writeback: 0 },
    expectEdges: 1,
    expectCompensation: "resolved"
  },
  {
    // The honest negative control for requirement 2: with no way to reconcile, the restart must NOT
    // retry the phase. The asset the dead worker created has to stay the only copy.
    id: "crash_at_ingest_without_reconciler",
    phase: "ingest",
    withReconciler: false,
    expectFinalState: "manual_reconciliation",
    expectPhaseCalls: { poll: 0, download: 0, validate: 0, ingest: 0, writeback: 0 },
    expectEdges: 0,
    expectCompensation: "pending"
  }
];

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-ren10-crash-"));
const repositoryRoot = path.join(tmp, "repo");
const workerEvidenceDir = evidenceDirArg ?? tmp;
if (evidenceDirArg) await fs.promises.mkdir(workerEvidenceDir, { recursive: true });
const sourceFile = path.join(tmp, "mock-generated.mp4");
await fs.promises.writeFile(sourceFile, "REN-10 zero-cost provider fixture (crash restart)\n", "utf8");

const readRow = (db, jobId) => db.prepare("SELECT state,phase,failed_phase,error_code,error_message,provider_submit_state,provider_request_id,submit_attempts,result_json FROM generation_jobs WHERE job_id=?").get(jobId);
const resultKeys = (row) => Object.keys(JSON.parse(row.result_json ?? "{}"));

let LegacyQueue = null;
let legacyProbeNote = null;

const setupAdapter = {
  async submit(job) { return { provider_request_id: `setup_${job.job_id}`, mock: true }; },
  async poll() { return { status: "completed", actual_credits: 2, mock: true }; },
  async download(job) {
    const target = downloadPathFor(repositoryRoot, job.job_id);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(sourceFile, target);
    return { file_path: target, sha256: sha256File(target), mock: true };
  },
  async validate(job) { return { ok: fs.existsSync(job.result.download.file_path), mock: true }; },
  async ingest(job) {
    const asset = await service.ingestAsset(call({ file_path: job.result.download.file_path, title: jobMarker(job.job_id), kind: "working", tags: ["ren10", "phase-crash-fixture"] }, toolA));
    return { asset_id: asset.asset_id, asset_version_id: asset.default_version_id, license_status: asset.license_status, mock: true };
  },
  async writeback(job) {
    const shapeId = `shape_job_${job.job_id}`;
    const edgeId = `edge_job_${job.job_id}`;
    service.upsertCanvasShape(call({ canvas_id: canvasId, shape_id: shapeId, shape_type: "asset_card", subject_type: "asset_version", subject_id: job.result.ingest.asset_version_id, title: `Crash fixture ${job.job_id}`, x: 420, y: 180, width: 260, height: 140, props: { role: "draft_output", generation_job_id: job.job_id } }, toolA));
    service.linkCanvasShapes(call({ canvas_id: canvasId, edge_id: edgeId, source_shape_id: anchorId, target_shape_id: shapeId, relation_type: "derived_from", props: { generation_job_id: job.job_id } }, toolA));
    return { canvas_id: canvasId, shape_id: shapeId, edge_id: edgeId, slot: "draft_output", mock: true };
  }
};

let service = null;
let canvasId = null;
let anchorId = null;
const cycleReports = [];
const workerExitCodes = {};

try {
  // A: create the jobs with a real service, then CLOSE ITS DATABASE before anything crashes.
  service = new VideoAssetService({ pluginConfig: crashFixtureConfig(repositoryRoot), generationJobAdapter: setupAdapter }).init();
  const project = service.createProject({ title: "REN-10 crash restart fixture" });
  const canvas = service.createCanvas({ project_id: project.project_id, title: "REN-10 crash restart canvas" });
  canvasId = canvas.canvas_id;
  anchorId = service.upsertCanvasShape(call({ canvas_id: canvasId, shape_id: "shape_job_anchor", shape_type: "note", subject_type: "note", subject_id: "ren10-crash-anchor", title: "Generation input", x: 0, y: 0, width: 260, height: 140 }, toolA)).shape_id;
  const jobs = cycles.map((cycle, index) => service.createGenerationJob(call({
    idempotency_key: `crash-fixture-${index}-${cycle.phase}`,
    entry: "dreamina.video.generate",
    provider: "dreamina_cli",
    confirm_cost: true,
    estimate_credits: 2,
    canvas_id: canvasId,
    request: { scenario: `crash_${cycle.phase}`, prompt: `crash fixture ${index}` },
    plan: { source: "REN-10-zero-cost-mock", paid_provider: false }
  }, toolA)));
  service.close();
  service = null;
  check("database_was_closed_before_the_crash", true, "the setup service was closed before the first child was spawned");

  // B: the pre-fix class, kept for step 3, read out of git history.
  try {
    const legacySource = execFileSync("git", ["-C", repo, "show", `${PRE_FIX_COMMIT}:src/generation-jobs.js`], { encoding: "utf8" });
    check("pre_fix_source_resolves_to_the_reviewed_revision", legacySource.includes("recoverInterruptedSubmissions") && !legacySource.includes("recoverInterruptedPhases"), `git show ${PRE_FIX_COMMIT}:src/generation-jobs.js`);
    const legacyPath = path.join(tmp, "legacy-generation-jobs.mjs");
    await fs.promises.writeFile(legacyPath, legacySource, "utf8");
    LegacyQueue = (await import(pathToFileURL(legacyPath).href)).GenerationJobQueue;
  } catch (error) {
    legacyProbeNote = `the pre-fix source could not be read from git history: ${error.message}`;
  }

  for (let index = 0; index < cycles.length; index += 1) {
    const cycle = cycles[index];
    const jobId = jobs[index].job_id;
    const tag = cycle.id;
    const workerEvidencePath = path.join(workerEvidenceDir, `worker-evidence-${tag}.json`);

    // 1. The crash.
    const worker = spawnSync(process.execPath, [
      workerPath,
      "--repo", repositoryRoot,
      "--job", jobId,
      "--phase", cycle.phase,
      "--canvas", canvasId,
      "--anchor", anchorId,
      "--source", sourceFile,
      "--evidence", workerEvidencePath
    ], { cwd: repo, encoding: "utf8" });
    workerExitCodes[tag] = worker.status;
    eq(worker.status, CRASH_EXIT_CODE, `${tag}_worker_dies_with_a_hard_exit`, (worker.stderr ?? "").trim().slice(0, 200));
    const workerEvidence = JSON.parse(await fs.promises.readFile(workerEvidencePath, "utf8"));
    eq(workerEvidence.crash_phase, cycle.phase, `${tag}_worker_crashed_in_the_requested_phase`);
    eq(workerEvidence.counters.submit, 1, `${tag}_child_submitted_the_provider_exactly_once`);
    eq(workerEvidence.counters[cycle.phase], 1, `${tag}_child_reached_the_interrupted_phase`);
    check(`${tag}_side_effect_committed_before_the_crash`, Boolean(workerEvidence.side_effect), JSON.stringify(workerEvidence.side_effect)?.slice(0, 200));

    // 2. What the dead process left behind, read through a raw connection.
    const raw = new DatabaseSync(sqlitePath(repositoryRoot));
    const leftover = readRow(raw, jobId);
    const expectedState = interruptedStateForPhase(cycle.phase);
    eq(leftover.state, expectedState, `${tag}_leftover_row_is_the_interrupted_phase_state`);
    eq(leftover.failed_phase, null, `${tag}_leftover_row_has_no_recorded_failure`);
    check(`${tag}_leftover_row_has_no_result_for_the_interrupted_phase`, !resultKeys(leftover).includes(cycle.phase), `result keys ${resultKeys(leftover).join(",")}`);
    const caughtEvents = raw.prepare("SELECT COUNT(*) AS n FROM generation_job_events WHERE job_id=? AND event_type IN ('compensation_pending','failed')").get(jobId).n;
    eq(caughtEvents, 0, `${tag}_no_in_process_failure_handler_ran`, "a caught failure would have written compensation_pending");

    // 3. The gap, reproduced against the same database with the pre-fix class.
    if (LegacyQueue) {
      new LegacyQueue({ db: raw, config: crashFixtureConfig(repositoryRoot).generationJobs, adapter: null, entryPolicy: {}, clock: () => Date.now() });
      const afterLegacy = readRow(raw, jobId);
      eq(afterLegacy.state, expectedState, `${tag}_pre_fix_constructor_does_not_recover_the_interrupted_phase`);
      eq(afterLegacy.failed_phase, null, `${tag}_pre_fix_constructor_records_no_failed_phase`);
    }
    raw.close();

    // 4. A new database connection and a new service: the constructor must persist the row as
    //    recoverable while keeping the interrupted phase.
    const phaseCalls = { poll: 0, download: 0, validate: 0, ingest: 0, writeback: 0 };
    const callLog = [];
    let reconcileAttempts = 0;
    const recoveryAdapter = {
      async submit() { phaseCalls.submit = (phaseCalls.submit ?? 0) + 1; callLog.push("submit"); return { provider_request_id: `recovery_${jobId}`, mock: true }; },
      async poll() { phaseCalls.poll += 1; callLog.push("poll"); return { status: "completed", actual_credits: 2, mock: true }; },
      async download(job) {
        phaseCalls.download += 1;
        callLog.push("download");
        const target = downloadPathFor(repositoryRoot, job.job_id);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(sourceFile, target);
        return { file_path: target, sha256: sha256File(target), mock: true };
      },
      async validate(job) { phaseCalls.validate += 1; callLog.push("validate"); return { ok: fs.existsSync(job.result.download.file_path), mock: true }; },
      async ingest(job) {
        phaseCalls.ingest += 1;
        callLog.push("ingest");
        const asset = await service.ingestAsset(call({ file_path: job.result.download.file_path, title: jobMarker(job.job_id), kind: "working", tags: ["ren10", "phase-crash-fixture"] }, toolA));
        return { asset_id: asset.asset_id, asset_version_id: asset.default_version_id, license_status: asset.license_status, mock: true };
      },
      async writeback(job) {
        phaseCalls.writeback += 1;
        callLog.push("writeback");
        const shapeId = `shape_job_${job.job_id}`;
        const edgeId = `edge_job_${job.job_id}`;
        service.upsertCanvasShape(call({ canvas_id: canvasId, shape_id: shapeId, shape_type: "asset_card", subject_type: "asset_version", subject_id: job.result.ingest.asset_version_id, title: `Crash fixture ${job.job_id}`, x: 420, y: 180, width: 260, height: 140, props: { role: "draft_output", generation_job_id: job.job_id } }, toolA));
        service.linkCanvasShapes(call({ canvas_id: canvasId, edge_id: edgeId, source_shape_id: anchorId, target_shape_id: shapeId, relation_type: "derived_from", props: { generation_job_id: job.job_id } }, toolA));
        return { canvas_id: canvasId, shape_id: shapeId, edge_id: edgeId, slot: "draft_output", mock: true };
      }
    };
    if (cycle.withReconciler) {
      // Every branch reads DURABLE state: the file on disk, the row in SQLite, the canvas document.
      // A value remembered by the process that died would not survive the restart and would prove
      // nothing about real recovery.
      recoveryAdapter.reconcilePhase = async (job, phase) => {
        reconcileAttempts += 1;
        callLog.push(`reconcilePhase:${phase}`);
        if (phase === "download") {
          const target = downloadPathFor(repositoryRoot, job.job_id);
          if (!fs.existsSync(target)) return { found: false };
          return { found: true, value: { file_path: target, sha256: sha256File(target), bytes: fs.statSync(target).size, replayed_from_durable_state: true } };
        }
        if (phase === "ingest") {
          const version = service.db.prepare("SELECT asset_version_id, asset_id FROM asset_versions WHERE asset_version_id=?").get(workerEvidence.side_effect.asset_version_id);
          const asset = version ? service.db.prepare("SELECT asset_id, license_status FROM assets WHERE asset_id=?").get(version.asset_id) : null;
          if (!version || !asset) return { found: false };
          return { found: true, value: { asset_id: asset.asset_id, asset_version_id: version.asset_version_id, license_status: asset.license_status, replayed_from_durable_state: true } };
        }
        if (phase === "writeback") {
          const document = service.getCanvas({ canvas_id: canvasId });
          const shape = document.shapes.find((item) => item.shape_id === workerEvidence.side_effect.shape_id);
          const edge = document.edges.find((item) => item.edge_id === workerEvidence.side_effect.edge_id);
          if (!shape || !edge) return { found: false };
          return { found: true, value: { canvas_id: canvasId, shape_id: shape.shape_id, edge_id: edge.edge_id, slot: "draft_output", replayed_from_durable_state: true } };
        }
        return { found: false };
      };
    }

    service = new VideoAssetService({ pluginConfig: crashFixtureConfig(repositoryRoot), generationJobAdapter: recoveryAdapter }).init();
    const converted = service.getGenerationJob(call({ job_id: jobId }, toolA));
    eq(converted.state, "failed_recoverable", `${tag}_restart_persists_the_interrupt_as_recoverable`);
    eq(converted.failed_phase, cycle.phase, `${tag}_restart_keeps_the_interrupted_phase`);
    eq(converted.error_code, "GENERATION_PHASE_INTERRUPTED", `${tag}_restart_records_a_phase_interrupt_code`);
    eq(converted.provider_submit_state, "submitted", `${tag}_restart_keeps_the_confirmed_submission`);
    eq(converted.provider_request_id, workerEvidence.job_row_at_crash.provider_request_id, `${tag}_restart_keeps_the_provider_request_id`);
    const interruptEvents = service.db.prepare("SELECT event_type,data_json FROM generation_job_events WHERE job_id=? AND event_type='phase_interrupted'").all(jobId).map((row) => JSON.parse(row.data_json));
    check(`${tag}_restart_records_why_it_stopped`, interruptEvents.length === 1 && interruptEvents[0].reason === "restart_during_phase" && interruptEvents[0].blind_retry === false && interruptEvents[0].provider_resubmit === false, JSON.stringify(interruptEvents));

    // 5. Resume: reconcile first, then only the phases that provably did not happen.
    const final = await service.processGenerationJob(call({ job_id: jobId }, toolA));
    eq(final.state, cycle.expectFinalState, `${tag}_resume_reaches_the_expected_state`, final.error_message ?? "");
    if (cycle.withReconciler) {
      eq(reconcileAttempts, 1, `${tag}_resume_reconciled_once`);
      eq(callLog[0], `reconcilePhase:${cycle.phase}`, `${tag}_reconcile_happens_before_any_phase_retry`, callLog.join(" > "));
    } else {
      eq(reconcileAttempts, 0, `${tag}_resume_had_no_reconciler_to_call`);
      eq(final.error_code, "GENERATION_PHASE_RECONCILIATION_REQUIRED", `${tag}_resume_refuses_to_guess`);
      const manualEvents = service.db.prepare("SELECT data_json FROM generation_job_events WHERE job_id=? AND event_type='manual_reconciliation'").all(jobId).map((row) => JSON.parse(row.data_json));
      check(`${tag}_manual_reconciliation_records_no_blind_retry`, manualEvents.some((item) => item.blind_retry === false && item.found === null), JSON.stringify(manualEvents));
      const again = await service.processGenerationJob(call({ job_id: jobId }, toolA));
      eq(again.state, "manual_reconciliation", `${tag}_a_second_process_call_still_does_not_retry`);
    }

    for (const [phase, expected] of Object.entries(cycle.expectPhaseCalls)) {
      eq(phaseCalls[phase], expected, `${tag}_recovery_${phase}_call_count`);
    }

    // 6. At-most-once and no duplicate artifacts, read back from the database.
    const rowAfter = readRow(service.db, jobId);
    eq(rowAfter.submit_attempts, 1, `${tag}_provider_was_submitted_once`);
    eq(rowAfter.provider_submit_state, "submitted", `${tag}_provider_submission_state_is_unchanged`);
    eq(rowAfter.provider_request_id, `crash_${jobId}`, `${tag}_provider_request_id_is_the_childs_own`);
    eq(phaseCalls.submit ?? 0, 0, `${tag}_recovery_never_resubmitted_the_provider`);
    eq(service.db.prepare("SELECT COUNT(*) AS n FROM generation_jobs WHERE job_id=?").get(jobId).n, 1, `${tag}_exactly_one_job_row`);
    eq(service.db.prepare("SELECT COUNT(*) AS n FROM generation_budget_ledger WHERE job_id=?").get(jobId).n, 1, `${tag}_exactly_one_budget_row`);
    const ledgerState = service.db.prepare("SELECT state FROM generation_budget_ledger WHERE job_id=?").get(jobId).state;
    eq(ledgerState, cycle.expectFinalState === "completed" ? "committed" : "reserved", `${tag}_budget_state`);
    const assetId = final.result?.ingest?.asset_id ?? workerEvidence.side_effect.asset_id;
    eq(service.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE title=?").get(jobMarker(jobId)).n, 1, `${tag}_exactly_one_asset_for_the_job`);
    eq(service.db.prepare("SELECT COUNT(*) AS n FROM asset_versions WHERE asset_id=?").get(assetId).n, 1, `${tag}_exactly_one_asset_version`);
    const document = service.getCanvas({ canvas_id: canvasId });
    const edgesForJob = document.edges.filter((edge) => edge.props?.generation_job_id === jobId).length;
    const shapesForJob = document.shapes.filter((shape) => shape.props?.generation_job_id === jobId).length;
    eq(edgesForJob, cycle.expectEdges, `${tag}_canvas_edge_count`);
    eq(shapesForJob, cycle.expectEdges, `${tag}_canvas_shape_count`);
    const downloadDir = path.dirname(downloadPathFor(repositoryRoot, jobId));
    const downloaded = fs.existsSync(downloadDir) ? fs.readdirSync(downloadDir).filter((name) => name === `${jobId}.mp4`).length : 0;
    eq(downloaded, 1, `${tag}_exactly_one_downloaded_file`);
    const compensations = service.db.prepare("SELECT stage,state FROM generation_compensations WHERE job_id=?").all(jobId);
    check(`${tag}_compensation_row_is_${cycle.expectCompensation}`, compensations.length === 1 && compensations[0].stage === cycle.phase && compensations[0].state === cycle.expectCompensation, JSON.stringify(compensations));

    cycleReports.push({
      cycle: tag,
      phase: cycle.phase,
      reconciler_available: cycle.withReconciler,
      worker_exit_code: worker.status,
      leftover_state: leftover.state,
      pre_fix_state_after_construction: LegacyQueue ? expectedState : null,
      converted_state: converted.state,
      converted_failed_phase: converted.failed_phase,
      final_state: final.state,
      call_log: callLog,
      recovery_phase_calls: phaseCalls,
      asset_version_count: 1,
      canvas_edge_count: edgesForJob,
      canvas_shape_count: shapesForJob,
      provider_submit_attempts: rowAfter.submit_attempts,
      budget_state: ledgerState,
      compensation: compensations[0]
    });

    service.close();
    service = null;
  }

  check("all_requested_restart_cycles_were_exercised", cycleReports.length === cycles.length, `${cycleReports.length}/${cycles.length}`);

  const report = {
    ok: checks.every((item) => item.ok),
    fixture: "generation-job-phase-crash-restart",
    zero_cost_mock: true,
    public_network_used: false,
    paid_provider_called: false,
    pre_fix_commit: PRE_FIX_COMMIT,
    pre_fix_gap_reproduced: Boolean(LegacyQueue),
    pre_fix_probe_note: legacyProbeNote,
    restart_fidelity: {
      method: "a separate child process performs the interrupted phase's real side effect and then calls process.exit(9); the parent never sees a caught failure",
      database_closed_before_restart: true,
      worker_exit_codes: workerExitCodes,
      catch_path_absent: "each leftover row is still in the interrupted phase's own state, has no failed_phase, has no result entry for the interrupted phase, and has zero compensation_pending/failed events",
      in_process_simulation_covered_elsewhere: "generation-job-lifecycle-test.mjs (post-effect throw, caught by the running process)"
    },
    checks: checks.length,
    cycles: cycleReports,
    limitations: [
      "The provider adapter is a local fixture: no real provider and no public network were called, and no credits were spent.",
      "Reconciliation reads durable local state (file on disk, SQLite row, canvas document); a real provider's own reconciliation API is still unverified and belongs to REN-11/REN-13.",
      "The pre-fix comparison constructs the reviewed revision's queue class against the fixture database; it is a behaviour comparison, not a production rollback test."
    ]
  };
  if (outJson) {
    await fs.promises.mkdir(path.dirname(path.resolve(outJson)), { recursive: true });
    await fs.promises.writeFile(path.resolve(outJson), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(report, null, 2));
  console.log("generation job phase crash restart test passed");
} finally {
  try { service?.close(); } catch { /* already closed */ }
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
