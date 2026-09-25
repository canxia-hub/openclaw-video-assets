// REN-10 phase-recovery test: the two requirements that are about the QUEUE's own decisions.
//
//   1. Startup must recognise every post-submit non-terminal state a hard stop can leave
//      (`submitted`, `running`, `downloading`, `validating`, `ingesting`, `writing_back`), persist it
//      as recoverable, keep `failed_phase`, and never touch `provider_submit_state`.
//   2. Resume must reconcile the phase FIRST. `found=true` writes a checkpoint and skips the phase;
//      `found=false` is the only answer that authorises a retry; anything else - a missing
//      reconciler, an indeterminate answer, or a reconciler that throws - must refuse to retry.
//
// HOW THE INTERRUPTED STATES ARE PRODUCED
//   The rows are real job rows created through the normal API; the phase-interrupt columns are then
//   written directly, because an in-process test cannot die mid-phase (any failure it raises is
//   caught and becomes `failed_recoverable`). Each case then closes the database and constructs a
//   NEW service, which is the real close/reopen path. A genuine process death is covered separately
//   by `generation-job-phase-crash-restart-test.mjs`.
//
// Zero cost: local adapters only. No provider, no network, no credits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";
import { call, crashFixtureConfig, downloadPathFor, jobMarker, sha256File, toolA } from "./lib-generation-job-crash-fixture.mjs";

const outIndex = process.argv.indexOf("--out-json");
const outJson = outIndex >= 0 ? process.argv[outIndex + 1] : null;

const checks = [];
function check(id, condition, detail) {
  checks.push({ id, ok: Boolean(condition), detail });
  if (!condition) throw new Error(`${id}: ${detail}`);
}
function eq(actual, expected, id, extra = "") {
  check(id, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${extra ? ` (${extra})` : ""}`);
}
async function rejectsCode(fn, code) {
  try { await fn(); } catch (error) {
    eq(error.code, code, `rejects_with_${code}`);
    return error;
  }
  throw new Error(`expected ${code}`);
}

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-ren10-phase-"));
const repositoryRoot = path.join(tmp, "repo");
const sourceFile = path.join(tmp, "mock-generated.mp4");
await fs.promises.writeFile(sourceFile, "REN-10 zero-cost provider fixture (phase recovery)\n", "utf8");
const config = crashFixtureConfig(repositoryRoot);

let service = null;
let counter = 0;
const nextKey = (prefix) => `${prefix}-${counter += 1}`;

function makeJob(key) {
  return service.createGenerationJob(call({
    idempotency_key: key,
    entry: "dreamina.video.generate",
    provider: "dreamina_cli",
    confirm_cost: true,
    estimate_credits: 2,
    request: { scenario: key, prompt: `phase recovery ${key}` },
    plan: { source: "REN-10-zero-cost-mock", paid_provider: false }
  }, toolA));
}

// A local adapter whose download phase materialises a real file, so "did the phase already happen?"
// is answered by durable state rather than by memory.
function makeAdapter(log, counters, { reconcile = null, faultAfterDownload = false, faultBeforeDownload = false } = {}) {
  const adapter = {
    async submit(job) { counters.submit += 1; log.push("submit"); return { provider_request_id: `local_${job.job_id}`, mock: true }; },
    async poll(job) { counters.poll += 1; log.push("poll"); return { status: "completed", actual_credits: 2, mock: true }; },
    async download(job) {
      counters.download += 1;
      log.push("download");
      if (faultBeforeDownload) { const error = new Error("mock provider send failed before any download"); error.code = "MOCK_DOWNLOAD_PRE_FAULT"; throw error; }
      const target = downloadPathFor(repositoryRoot, job.job_id);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(sourceFile, target);
      const value = { file_path: target, sha256: sha256File(target), bytes: fs.statSync(target).size, mock: true };
      if (faultAfterDownload) { const error = new Error("mock response lost after download completed"); error.code = "MOCK_DOWNLOAD_POST_FAULT"; throw error; }
      return value;
    },
    async validate(job) { counters.validate += 1; log.push("validate"); return { ok: fs.existsSync(job.result.download.file_path), mock: true }; },
    async ingest(job) {
      counters.ingest += 1;
      log.push("ingest");
      const asset = await service.ingestAsset(call({ file_path: job.result.download.file_path, title: jobMarker(job.job_id), kind: "working", tags: ["ren10", "phase-recovery-fixture"] }, toolA));
      return { asset_id: asset.asset_id, asset_version_id: asset.default_version_id, license_status: asset.license_status, mock: true };
    },
    async writeback(job) {
      counters.writeback += 1;
      log.push("writeback");
      const shapeId = `shape_job_${job.job_id}`;
      const edgeId = `edge_job_${job.job_id}`;
      service.upsertCanvasShape(call({ canvas_id: canvasId, shape_id: shapeId, shape_type: "asset_card", subject_type: "asset_version", subject_id: job.result.ingest.asset_version_id, title: `Phase recovery ${job.job_id}`, x: 420, y: 180, width: 260, height: 140, props: { role: "draft_output", generation_job_id: job.job_id } }, toolA));
      service.linkCanvasShapes(call({ canvas_id: canvasId, edge_id: edgeId, source_shape_id: anchorId, target_shape_id: shapeId, relation_type: "derived_from", props: { generation_job_id: job.job_id } }, toolA));
      return { canvas_id: canvasId, shape_id: shapeId, edge_id: edgeId, slot: "draft_output", mock: true };
    }
  };
  if (reconcile) adapter.reconcilePhase = async (job, phase) => { counters.reconcilePhase += 1; log.push(`reconcilePhase:${phase}`); return reconcile(job, phase); };
  return adapter;
}

// Answers "did the interrupted phase already take effect" from durable state: a file on disk for
// download, the asset row for ingest, the canvas document for writeback.
function durableReconcile(phase) {
  return (job) => {
    if (phase === "download") {
      const target = downloadPathFor(repositoryRoot, job.job_id);
      if (!fs.existsSync(target)) return { found: false };
      return { found: true, value: { file_path: target, sha256: sha256File(target), bytes: fs.statSync(target).size, replayed_from_durable_state: true } };
    }
    if (phase === "ingest") {
      const asset = service.db.prepare("SELECT asset_id, license_status FROM assets WHERE title=?").get(jobMarker(job.job_id));
      const version = asset ? service.db.prepare("SELECT asset_version_id FROM asset_versions WHERE asset_id=?").get(asset.asset_id) : null;
      if (!asset || !version) return { found: false };
      return { found: true, value: { asset_id: asset.asset_id, asset_version_id: version.asset_version_id, license_status: asset.license_status, replayed_from_durable_state: true } };
    }
    return { found: false };
  };
}

const countersOf = () => ({ submit: 0, poll: 0, download: 0, validate: 0, ingest: 0, writeback: 0, reconcilePhase: 0 });
const rowOf = (jobId) => service.db.prepare("SELECT state,phase,failed_phase,error_code,provider_submit_state,provider_request_id,submit_attempts FROM generation_jobs WHERE job_id=?").get(jobId);
const eventsOf = (jobId, type) => service.db.prepare("SELECT data_json FROM generation_job_events WHERE job_id=? AND event_type=?").all(jobId, type).map((item) => JSON.parse(item.data_json));
const edgeCount = (jobId) => service.getCanvas({ canvas_id: canvasId }).edges.filter((edge) => edge.props?.generation_job_id === jobId).length;

let canvasId = null;
let anchorId = null;
const startupReports = [];
const resumeReports = [];

try {
  // ---- Group A: startup recognises every interrupted post-submit state -------------------------
  const startupCases = [
    { state: "submitted", phase: "poll" },
    { state: "running", phase: "poll" },
    { state: "downloading", phase: "download" },
    { state: "validating", phase: "validate" },
    { state: "ingesting", phase: "ingest" },
    { state: "writing_back", phase: "writeback" }
  ];

  service = new VideoAssetService({ pluginConfig: config, generationJobAdapter: null }).init();
  const project = service.createProject({ title: "REN-10 phase recovery fixture" });
  const canvas = service.createCanvas({ project_id: project.project_id, title: "REN-10 phase recovery canvas" });
  canvasId = canvas.canvas_id;
  anchorId = service.upsertCanvasShape(call({ canvas_id: canvasId, shape_id: "shape_job_anchor", shape_type: "note", subject_type: "note", subject_id: "ren10-phase-anchor", title: "Generation input", x: 0, y: 0, width: 260, height: 140 }, toolA)).shape_id;
  const startupJobs = startupCases.map((item) => makeJob(nextKey(`startup-${item.state}`)));

  for (let index = 0; index < startupCases.length; index += 1) {
    const scenario = startupCases[index];
    const jobId = startupJobs[index].job_id;
    const tag = `startup_${scenario.state}`;
    const priorResult = scenario.phase === "poll" ? { submit: { provider_request_id: `fixture_${scenario.state}` } } : { submit: { provider_request_id: `fixture_${scenario.state}` }, poll: { status: "completed", actual_credits: 2 } };
    // The exact leftover a hard stop inside that phase leaves: the phase's own state, no `failed_phase`,
    // no result entry for the phase, and a confirmed provider submission.
    service.db.prepare("UPDATE generation_jobs SET state=?,phase=?,provider_submit_state='submitted',provider_request_id=?,submit_attempts=1,failed_phase=NULL,error_code=NULL,error_message=NULL,result_json=? WHERE job_id=?")
      .run(scenario.state, scenario.phase, `fixture_${scenario.state}`, JSON.stringify(priorResult), jobId);
    eq(rowOf(jobId).state, scenario.state, `${tag}_fixture_row_is_in_the_interrupted_state`);

    service.close();
    const log = [];
    const counters = countersOf();
    const retryAdapter = makeAdapter(log, counters, { reconcile: () => ({ found: false }) });
    service = new VideoAssetService({ pluginConfig: config, generationJobAdapter: retryAdapter }).init();

    const converted = service.getGenerationJob(call({ job_id: jobId }, toolA));
    eq(converted.state, "failed_recoverable", `${tag}_startup_persists_the_interrupt_as_recoverable`);
    eq(converted.failed_phase, scenario.phase, `${tag}_startup_keeps_the_interrupted_phase`);
    eq(converted.phase, scenario.phase, `${tag}_startup_keeps_the_phase_column`);
    eq(converted.error_code, "GENERATION_PHASE_INTERRUPTED", `${tag}_startup_records_the_interrupt_code`);
    eq(converted.provider_submit_state, "submitted", `${tag}_startup_never_rewrites_the_submission_state`);
    eq(converted.provider_request_id, `fixture_${scenario.state}`, `${tag}_startup_keeps_the_provider_request_id`);
    const interrupt = eventsOf(jobId, "phase_interrupted");
    check(`${tag}_startup_records_why_it_stopped`, interrupt.length === 1 && interrupt[0].phase === scenario.phase && interrupt[0].reason === "restart_during_phase" && interrupt[0].blind_retry === false && interrupt[0].provider_resubmit === false, JSON.stringify(interrupt));
    const compensation = service.db.prepare("SELECT stage,state FROM generation_compensations WHERE job_id=?").all(jobId);
    check(`${tag}_startup_opens_a_pending_compensation_for_the_phase`, compensation.length === 1 && compensation[0].stage === scenario.phase && compensation[0].state === "pending", JSON.stringify(compensation));

    const resumed = await service.processGenerationJob(call({ job_id: jobId }, toolA));
    eq(resumed.state, "completed", `${tag}_resume_completes_after_reconciling_first`, resumed.error_message ?? "");
    eq(log[0], `reconcilePhase:${scenario.phase}`, `${tag}_resume_reconciles_before_any_phase_call`, log.join(" > "));
    eq(counters.reconcilePhase, 1, `${tag}_reconcile_called_once`);
    eq(counters.submit, 0, `${tag}_resume_never_resubmits`);
    eq(counters[scenario.phase === "poll" ? "poll" : scenario.phase], 1, `${tag}_the_unproven_phase_runs_once_after_found_false`);
    eq(edgeCount(jobId), 1, `${tag}_exactly_one_canvas_edge`);
    eq(service.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE title=?").get(jobMarker(jobId)).n, 1, `${tag}_exactly_one_asset`);
    startupReports.push({ case: tag, interrupted_state: scenario.state, expected_phase: scenario.phase, converted_state: converted.state, converted_failed_phase: converted.failed_phase, final_state: resumed.state, call_log: log });

    service.close();
    service = new VideoAssetService({ pluginConfig: config, generationJobAdapter: null }).init();
  }

  // An interrupted phase with no confirmed submission must not be retried either: it goes to the
  // operator instead, because the provider may or may not have accepted the job.
  const unverified = makeJob(nextKey("startup-unverified"));
  service.db.prepare("UPDATE generation_jobs SET state='ingesting',phase='ingest',provider_submit_state='unknown',failed_phase=NULL,result_json='{}' WHERE job_id=?").run(unverified.job_id);
  service.close();
  {
    const log = [];
    const counters = countersOf();
    service = new VideoAssetService({ pluginConfig: config, generationJobAdapter: makeAdapter(log, counters, { reconcile: () => ({ found: false }) }) }).init();
    const converted = service.getGenerationJob(call({ job_id: unverified.job_id }, toolA));
    eq(converted.state, "manual_reconciliation", "startup_unverified_phase_goes_to_the_operator");
    eq(converted.error_code, "GENERATION_PHASE_INTERRUPTED_UNVERIFIED", "startup_unverified_phase_uses_its_own_code");
    const events = eventsOf(unverified.job_id, "manual_reconciliation");
    check("startup_unverified_phase_records_no_blind_retry", events.some((item) => item.blind_retry === false), JSON.stringify(events));
    service.close();
  }

  // Regression: a restart during `submitting` still means "submission unknown", not a phase interrupt.
  service = new VideoAssetService({ pluginConfig: config, generationJobAdapter: null }).init();
  const submitting = makeJob(nextKey("startup-submitting"));
  service.db.prepare("UPDATE generation_jobs SET state='submitting',phase='submit',provider_submit_state='submitting',failed_phase=NULL,result_json='{}' WHERE job_id=?").run(submitting.job_id);
  service.close();
  {
    service = new VideoAssetService({ pluginConfig: config, generationJobAdapter: null }).init();
    const converted = service.getGenerationJob(call({ job_id: submitting.job_id }, toolA));
    eq(converted.state, "unknown_submission", "startup_submitting_still_becomes_unknown_submission");
    eq(converted.failed_phase, null, "startup_submitting_is_not_turned_into_a_phase_interrupt");
    service.close();
  }

  // ---- Group B: resume reconciles first, and refuses to guess --------------------------------
  // B1: the phase already took effect -> checkpoint, skip, continue.
  service = new VideoAssetService({ pluginConfig: config, generationJobAdapter: null }).init();
  {
    const job = makeJob(nextKey("resume-found-true"));
    const jammed = makeAdapter([], countersOf(), { reconcile: () => ({ found: false }), faultAfterDownload: true });
    service.setGenerationJobAdapter(jammed);
    const failed = await service.processGenerationJob(call({ job_id: job.job_id }, toolA));
    eq(failed.state, "failed_recoverable", "found_true_case_starts_from_a_recoverable_failure");
    eq(failed.failed_phase, "download", "found_true_case_failed_in_download");
    const log = [];
    const counters = countersOf();
    const recovery = makeAdapter(log, counters, { reconcile: durableReconcile("download") });
    service.setGenerationJobAdapter(recovery);
    const resumed = await service.resumeGenerationJob(call({ job_id: job.job_id }, toolA));
    eq(resumed.state, "completed", "found_true_resume_completes", resumed.error_message ?? "");
    eq(log[0], "reconcilePhase:download", "found_true_reconcile_runs_first", log.join(" > "));
    eq(counters.download, 0, "found_true_phase_is_not_replayed");
    eq(counters.ingest, 1, "found_true_pipeline_continues_after_the_checkpoint");
    check("found_true_writeback_still_happens_once", counters.writeback === 1 && edgeCount(job.job_id) === 1, `writeback ${counters.writeback}, edges ${edgeCount(job.job_id)}`);
    const checkpoint = eventsOf(job.job_id, "phase_reconciled");
    check("found_true_records_a_checkpoint_event", checkpoint.length === 1 && checkpoint[0].checkpoint === true && checkpoint[0].replayed_operation === false, JSON.stringify(checkpoint));
    check("found_true_provenance_is_complete", Boolean(resumed.result.ingest?.asset_version_id && resumed.result.writeback?.edge_id && resumed.result.download?.file_path), JSON.stringify(resumed.result).slice(0, 300));
    resumeReports.push({ case: "found_true", phase: "download", final_state: resumed.state, call_log: log, replayed_phase_calls: counters.download, checkpoint: checkpoint[0] });
  }
  service.close();

  // B2: the provider proves the phase left no effect -> the retry is authorised.
  service = new VideoAssetService({ pluginConfig: config, generationJobAdapter: null }).init();
  {
    const job = makeJob(nextKey("resume-found-false"));
    service.setGenerationJobAdapter(makeAdapter([], countersOf(), { reconcile: () => ({ found: false }), faultBeforeDownload: true }));
    const failed = await service.processGenerationJob(call({ job_id: job.job_id }, toolA));
    eq(failed.state, "failed_recoverable", "found_false_case_starts_from_a_recoverable_failure");
    const log = [];
    const counters = countersOf();
    service.setGenerationJobAdapter(makeAdapter(log, counters, { reconcile: durableReconcile("download") }));
    const resumed = await service.resumeGenerationJob(call({ job_id: job.job_id }, toolA));
    eq(resumed.state, "completed", "found_false_resume_completes", resumed.error_message ?? "");
    eq(log[0], "reconcilePhase:download", "found_false_reconcile_runs_first", log.join(" > "));
    eq(counters.download, 1, "found_false_retries_the_phase_once");
    const authorized = eventsOf(job.job_id, "phase_retry_authorized");
    check("found_false_records_the_retry_authorisation", authorized.length === 1 && authorized[0].found === false, JSON.stringify(authorized));
    eq(service.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE title=?").get(jobMarker(job.job_id)).n, 1, "found_false_does_not_duplicate_the_asset");
    eq(edgeCount(job.job_id), 1, "found_false_does_not_duplicate_the_edge");
    resumeReports.push({ case: "found_false", phase: "download", final_state: resumed.state, call_log: log, retry_phase_calls: counters.download });
  }
  service.close();

  // B3/B4/B5: no reconciler, an indeterminate answer, and a throwing reconciler all refuse to retry.
  const unknownCases = [
    { id: "no_reconciler", build: () => null, expectCode: "GENERATION_PHASE_RECONCILIATION_REQUIRED" },
    { id: "indeterminate_answer", build: () => () => ({}), expectCode: "GENERATION_PHASE_RECONCILIATION_REQUIRED" },
    { id: "reconciler_throws", build: () => () => { const error = new Error("mock reconciliation transport timed out"); error.code = "PROVIDER_RECONCILE_TIMEOUT"; throw error; }, expectCode: "PROVIDER_RECONCILE_TIMEOUT" }
  ];
  for (const scenario of unknownCases) {
    service = new VideoAssetService({ pluginConfig: config, generationJobAdapter: null }).init();
    const job = makeJob(nextKey(`resume-${scenario.id}`));
    service.setGenerationJobAdapter(makeAdapter([], countersOf(), { faultBeforeDownload: true }));
    const failed = await service.processGenerationJob(call({ job_id: job.job_id }, toolA));
    eq(failed.state, "failed_recoverable", `${scenario.id}_starts_from_a_recoverable_failure`);
    const log = [];
    const counters = countersOf();
    const reconcile = scenario.build();
    service.setGenerationJobAdapter(makeAdapter(log, counters, { reconcile }));
    const resolved = await service.resumeGenerationJob(call({ job_id: job.job_id }, toolA));
    eq(resolved.state, "manual_reconciliation", `${scenario.id}_refuses_to_retry`);
    eq(resolved.error_code, scenario.expectCode, `${scenario.id}_reports_the_reason_code`);
    eq(counters.download, 0, `${scenario.id}_never_replays_the_phase`);
    eq(counters.ingest, 0, `${scenario.id}_never_continues_the_pipeline`);
    const events = eventsOf(job.job_id, "manual_reconciliation");
    check(`${scenario.id}_records_found_null_and_no_blind_retry`, events.length >= 1 && events.at(-1).found === null && events.at(-1).blind_retry === false && events.at(-1).phase === "download", JSON.stringify(events));
    const again = await service.processGenerationJob(call({ job_id: job.job_id }, toolA));
    eq(again.state, "manual_reconciliation", `${scenario.id}_a_later_process_call_still_refuses`);
    eq(counters.download, 0, `${scenario.id}_no_retry_after_repetition`);
    const resumedAgain = await service.resumeGenerationJob(call({ job_id: job.job_id }, toolA));
    eq(resumedAgain.state, "manual_reconciliation", `${scenario.id}_a_later_resume_does_nothing`);
    resumeReports.push({ case: scenario.id, phase: "download", final_state: resolved.state, error_code: resolved.error_code, call_log: log, replayed_phase_calls: counters.download });
    service.close();
  }

  // B6/B7: `submit` is still never retried, and an unresumable phase name goes to the operator.
  service = new VideoAssetService({ pluginConfig: config, generationJobAdapter: null }).init();
  {
    const submitJob = makeJob(nextKey("resume-submit"));
    service.db.prepare("UPDATE generation_jobs SET state='failed_recoverable',phase='submit',failed_phase='submit',error_code='GENERATION_SUBMIT_FAILED',result_json='{}' WHERE job_id=?").run(submitJob.job_id);
    const counters = countersOf();
    const log = [];
    service.setGenerationJobAdapter(makeAdapter(log, counters, { reconcile: () => ({ found: true, value: {} }) }));
    await rejectsCode(() => service.resumeGenerationJob(call({ job_id: submitJob.job_id }, toolA)), "GENERATION_RESUBMIT_FORBIDDEN");
    eq(counters.submit, 0, "submit_phase_is_never_resubmitted_by_resume");
    eq(rowOf(submitJob.job_id).state, "failed_recoverable", "forbidden_resubmit_leaves_the_job_untouched");

    const oddJob = makeJob(nextKey("resume-odd-phase"));
    service.db.prepare("UPDATE generation_jobs SET state='failed_recoverable',phase='reconcile',failed_phase='reconcile',result_json='{}' WHERE job_id=?").run(oddJob.job_id);
    const odd = await service.resumeGenerationJob(call({ job_id: oddJob.job_id }, toolA));
    eq(odd.state, "manual_reconciliation", "an_unresumable_phase_name_goes_to_the_operator");
    eq(counters.reconcilePhase, 0, "an_unresumable_phase_name_is_not_reconciled");
  }
  service.close();

  const report = {
    ok: checks.every((item) => item.ok),
    fixture: "generation-job-phase-recovery",
    zero_cost_mock: true,
    public_network_used: false,
    paid_provider_called: false,
    checks: checks.length,
    startup_state_coverage: startupReports,
    resume_coverage: resumeReports,
    fixture_method: {
      startup_interrupts: "rows created through the normal API, then written into the interrupted phase's own state; each case closes the database and constructs a NEW service, which is the real close/reopen path",
      real_process_death_covered_by: "scripts/generation-job-phase-crash-restart-test.mjs (child process exit(9) inside the phase)",
      in_process_fault_covered_by: "scripts/generation-job-lifecycle-test.mjs (post-effect throw, caught and persisted as failed_recoverable)"
    },
    limitations: [
      "Local zero-cost adapters only: no real provider and no public network were called, and no credits were spent.",
      "The phase-interrupt rows are fixture state, not the product of a real kill; the process-death path is proven by the crash-restart fixture.",
      "Durable reconciliation here reads local files and SQLite rows; a real provider's reconciliation API remains unverified (REN-11/REN-13)."
    ]
  };
  if (outJson) {
    await fs.promises.mkdir(path.dirname(path.resolve(outJson)), { recursive: true });
    await fs.promises.writeFile(path.resolve(outJson), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(report, null, 2));
  console.log("generation job phase recovery test passed");
} finally {
  try { service?.close(); } catch { /* already closed */ }
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
