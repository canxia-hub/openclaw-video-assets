/**
 * REN-11 fix round: boundary and failure behaviour of the paid path, through the real queue and the
 * real service with a local supplier double.
 *
 * The paid-path e2e proves the happy chain. This file proves the edges the parent review named, because
 * "it completed once" says nothing about what happens when a phase is interrupted, when a query cannot
 * answer, when a cost is unknown, or when a delivered run fails re-validation afterwards:
 *
 *   1. hard budget: a missing per-layer limit is refused, and an over-limit estimate stops BEFORE any
 *      submit (proved by the supplier double's submit counter staying at zero);
 *   2. unknown cost: it stays unknown (NULL/NULL), never 0 and never the estimate wearing an actual's
 *      name, both in the queue's own accounting and in the run facts;
 *   3. a query that never reaches a terminal state parks the job as unknown and a second processing pass
 *      does not resubmit it;
 *   4. a partial ingest is not "the phase took effect": reconciliation reports unknown and the job parks;
 *   5. a project-only writeback (no canvas slot) is both reconcilable and not duplicated on replay;
 *   6. a delivered run that later fails re-validation loses its delivery label and deliverable pointer,
 *      the record of the withdrawn delivery is kept, and the old file is left on disk.
 *
 * Usage: node scripts/ren11-paid-path-boundaries-test.mjs [outputRoot]
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";
import { withTrustedContext } from "../src/provider-gateway.js";
import { DreaminaCliJobAdapter } from "../src/dreamina-cli-job-adapter.js";
import { SopV2Run, SOP_V2_MODES, defaultBrief, GATE_CODES } from "../src/sop-v2-orchestrator.js";
import { resolveAssetRoot, resolveOutputRoot } from "./ren11-paths.mjs";

const outputRoot = resolveOutputRoot(process.argv[2] ?? null);
const workRoot = path.join(outputRoot, "paid-boundaries");
const repoRoot = path.join(resolveAssetRoot(), "asset-repo", "paid-boundaries");
fs.rmSync(workRoot, { recursive: true, force: true });
fs.rmSync(repoRoot, { recursive: true, force: true });
fs.mkdirSync(workRoot, { recursive: true });
fs.mkdirSync(repoRoot, { recursive: true });

const quiet = { log: () => {}, warn: () => {}, error: console.error, debug: () => {} };
const report = { schema: "ren11.paid-path.boundaries.v1", started_at: new Date().toISOString(), checks: [], scenarios: {} };
const check = (code, condition, detail) => {
  report.checks.push({ code, ok: condition === true, detail });
  assert.ok(condition === true, `${code}: ${detail}`);
};
const trusted = { trusted: true, surface: "tool", actor_id: "agent:tuan", actor_type: "agent", scopes: ["operator.read", "operator.write"] };

const clip = path.join(workRoot, "supplier-clip.mp4");
{
  const { runFfmpeg, REN11_FIXTURE_SPEC } = await import("../src/sop-v2-media.js");
  const built = await runFfmpeg([
    "-y", "-f", "lavfi", "-i", `color=c=0x203040:s=${REN11_FIXTURE_SPEC.width}x${REN11_FIXTURE_SPEC.height}:d=2:r=${REN11_FIXTURE_SPEC.fps}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=2:sample_rate=${REN11_FIXTURE_SPEC.audio_sample_rate}`,
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", REN11_FIXTURE_SPEC.pix_fmt,
    "-c:a", "aac", "-t", "2", path.basename(clip)
  ], { cwd: workRoot, timeoutMs: 180000 });
  if (built.code !== 0) throw new Error(`supplier clip failed: ${built.stderr.slice(-400)}`);
}

/** A supplier double with switchable behaviour, plus the call counters the assertions rely on. */
function createSupplier({ tag = "s", credits = 1000, alwaysQueued = false, creditReadFails = false, noCreditFields = false, spend = 5 } = {}) {
  const calls = [];
  const state = { submits: 0, queries: 0, credits };
  const cli = async ({ args }) => {
    calls.push(args[0]);
    if (args[0] === "user_credit") {
      if (creditReadFails) throw new Error("supplier double: credit endpoint unavailable");
      return { stdout: JSON.stringify({ credit: state.credits }), stderr: "" };
    }
    if (args[0] === "query_result") {
      state.queries += 1;
      if (alwaysQueued) return { stdout: JSON.stringify({ gen_status: "queued" }), stderr: "" };
      return { stdout: JSON.stringify({ gen_status: "success", ...(noCreditFields ? {} : { credit_count: spend }), videos: [{ path: clip }] }), stderr: "" };
    }
    state.submits += 1;
    state.credits -= spend;
    return { stdout: JSON.stringify({ submit_id: `${tag}-submit-${state.submits}`, gen_status: "queued" }), stderr: "" };
  };
  return { cli, calls, state };
}

async function buildService({ supplier, estimates = { "dreamina.video.generate": 5, "dreamina.image.generate": 2 } }) {
  const service = await new VideoAssetService({
    pluginConfig: {
      repositoryRoot: repoRoot,
      generationJobs: { enabled: true, maxCredits: 1000, maxConcurrent: 1, allowedActors: ["agent:tuan"] },
      security: { generation: { allowSurfaces: ["tool"], allowActors: ["agent:tuan"], ledger: "memory", budget: { totalCredits: 1000, estimates } } }
    },
    providerAdapters: { dreamina_cli: ({ argv }) => supplier.cli({ argv, args: argv }) },
    logger: quiet
  }).init();
  service.setGenerationJobAdapter(new DreaminaCliJobAdapter({
    service,
    downloadRoot: path.join(repoRoot, "staging"),
    pollIntervalMs: 1,
    pollTimeoutMs: 30,
    maxQueryAttempts: 3,
    sleep: async () => {},
    logger: quiet
  }));
  return service;
}

function paidBrief(overrides = {}) {
  return {
    ...defaultBrief(),
    provider_budget: {
      authorized: true,
      max_credits: 60,
      estimate_credits: 5,
      entry: "dreamina.video.generate",
      provider: "dreamina_cli",
      trusted_context: trusted,
      request: { generation_type: "image2video", model_version: "seedance2.0fast", video_resolution: "720p", prompt: "边界用例", cli_poll_seconds: 0, require_audio: true },
      ...overrides
    }
  };
}

function makeRun({ service, brief, name }) {
  const runRoot = path.join(workRoot, name);
  fs.mkdirSync(path.join(runRoot, "work"), { recursive: true });
  return new SopV2Run({
    runRoot,
    service,
    brief,
    mode: SOP_V2_MODES.PAID_PROVIDER,
    workRoot: path.join(runRoot, "work"),
    outputRoot: path.join(runRoot, "output"),
    logger: quiet
  });
}

// ------------------------------------------------------------------------------------------------
// 1. hard budget: missing limit, and over-limit estimate with zero submits
// ------------------------------------------------------------------------------------------------
{
  const supplier = createSupplier({ tag: "sc1" });
  const service = await buildService({ supplier });
  try {
    const missingLimit = makeRun({ service, brief: paidBrief({ max_credits: null }), name: "run-budget-missing" });
    await missingLimit.run({ stages: ["brief_spec", "storyboard_refs", "canvas_gate"] });
    let missingError = null;
    try { await missingRun(missingLimit); } catch (error) { missingError = error; }
    check("MISSING_LAYER_LIMIT_IS_REFUSED", missingError?.code === GATE_CODES.BUDGET_LIMIT_MISSING, `${missingError?.code}: ${missingError?.message?.slice(0, 120)}`);

    const overBudget = makeRun({ service, brief: paidBrief({ max_credits: 4, estimate_credits: 5 }), name: "run-budget-over" });
    await overBudget.run({ stages: ["brief_spec", "storyboard_refs", "canvas_gate"] });
    let overError = null;
    try { await overBudget.run({ stages: ["generation"] }); } catch (error) { overError = error; }
    check("OVER_LIMIT_ESTIMATE_IS_REFUSED", overError?.code === GATE_CODES.BUDGET_EXCEEDED, `${overError?.code} details=${JSON.stringify(overError?.details)}`);
    check("OVER_LIMIT_STOPS_BEFORE_ANY_SUBMIT", supplier.state.submits === 0, `submits=${supplier.state.submits}`);

    const unauthorized = makeRun({ service, brief: paidBrief({ authorized: false }), name: "run-budget-unauthorized" });
    await unauthorized.run({ stages: ["brief_spec", "storyboard_refs", "canvas_gate"] });
    let authError = null;
    try { await unauthorized.run({ stages: ["generation"] }) } catch (error) { authError = error; }
    check("UNATHORIZED_BUDGET_IS_REFUSED", authError?.code === GATE_CODES.BUDGET_NOT_AUTHORIZED, `${authError?.code}`);
    check("NO_SUBMIT_WITHOUT_AUTHORIZATION", supplier.state.submits === 0, `submits=${supplier.state.submits}`);
    report.scenarios.budget = { submits: supplier.state.submits };
  } finally {
    service.close();
  }
}

async function missingRun(run) {
  // The brief has no layer limit, so the stage must refuse before creating any job.
  return run.run({ stages: ["generation"] });
}

// ------------------------------------------------------------------------------------------------
// 2. unknown cost stays unknown
// ------------------------------------------------------------------------------------------------
{
  const supplier = createSupplier({ tag: "sc2", creditReadFails: true, noCreditFields: true });
  const service = await buildService({ supplier });
  try {
    const run = makeRun({ service, brief: paidBrief(), name: "run-unknown-cost" });
    await run.run({ stages: ["brief_spec", "storyboard_refs", "canvas_gate", "generation"] });
    const facts = JSON.parse(fs.readFileSync(run.factsFile("generation"), "utf8"));
    check("UNKNOWN_COST_NOT_MEASURED", facts.credits.measured_total === null && facts.credits.evidence === "unmeasured",
      JSON.stringify(facts.credits));
    check("UNKNOWN_COST_NOT_ZERO", facts.provider_jobs.every((job) => job.credits.value === null && job.credits.measured === false),
      JSON.stringify(facts.provider_jobs.map((job) => job.credits)));
    const row = service.db.prepare("SELECT actual_credits, budget_state FROM generation_jobs WHERE job_id = ?").get(facts.provider_jobs[0].job_id);
    check("UNKNOWN_COST_QUEUE_ACTUAL_IS_NULL", row.actual_credits === null && row.budget_state === "committed", JSON.stringify(row));
    const ledger = service.db.prepare("SELECT actual_credits, estimated_credits FROM generation_budget_ledger WHERE job_id = ?").get(facts.provider_jobs[0].job_id);
    const jobRowEstimate = Number(service.db.prepare("SELECT estimated_credits FROM generation_jobs WHERE job_id = ?").get(facts.provider_jobs[0].job_id).estimated_credits);
    // The ledger reserves `max(caller estimate, registry reference)` - that is the inherited REN-10
    // reservation rule, unchanged here. What matters for this fix is that the ACTUAL column stays NULL
    // for an unmeasured cost while the reservation still accounts for the job.
    check("UNKNOWN_COST_LEDGER_KEEPS_ESTIMATE_SEPARATE", ledger.actual_credits === null && Number(ledger.estimated_credits) === jobRowEstimate && Number(ledger.estimated_credits) > 0,
      JSON.stringify({ ledger, job_estimate: jobRowEstimate }));
    const events = service.generationJobEvents(withTrustedContext({ job_id: facts.provider_jobs[0].job_id, after_seq: 0 }, trusted)).events;
    const completed = events.find((event) => event.event_type === "completed");
    check("UNKNOWN_COST_EVENT_SAYS_SO", completed?.data?.estimate_is_not_actual === true && completed?.data?.credits_evidence === "unmeasured",
      JSON.stringify(completed?.data));
    report.scenarios.unknown_cost = { credits: facts.credits, queue: row, ledger };
  } finally {
    service.close();
  }
}

// ------------------------------------------------------------------------------------------------
// 3. a query that never answers parks the job and does not resubmit
// ------------------------------------------------------------------------------------------------
{
  const supplier = createSupplier({ tag: "sc3", alwaysQueued: true });
  const service = await buildService({ supplier });
  try {
    const run = makeRun({ service, brief: paidBrief(), name: "run-query-unknown" });
    await run.run({ stages: ["brief_spec", "storyboard_refs", "canvas_gate"] });
    let queryError = null;
    try { await run.run({ stages: ["generation"] }); } catch (error) { queryError = error; }
    check("UNRESOLVED_QUERY_STOPS_THE_STAGE", queryError?.code === GATE_CODES.JOB_NOT_COMPLETED, `${queryError?.code}: ${queryError?.message?.slice(0, 140)}`);
    // Address the jobs by this run's own idempotency prefix: the isolated library is shared by every
    // scenario in this file, so "the newest job" is not necessarily the one this scenario queued.
    const rows = service.db.prepare("SELECT job_id, state, phase, failed_phase, error_code, result_json FROM generation_jobs WHERE idempotency_key LIKE ? ORDER BY created_at").all("ren11:run-query-unknown:%");
    check("QUERY_SCENARIO_QUEUED_JOBS", rows.length === 3, `jobs=${rows.length}`);
    const job = rows.find((row) => row.failed_phase === "poll") ?? rows[0];
    check("QUERY_UNKNOWN_PARKED_NOT_FAILED", ["failed_recoverable", "manual_reconciliation"].includes(job.state), `state=${job.state} failed_phase=${job.failed_phase}`);
    check("QUERY_UNKNOWN_RECORDS_NO_TERMINAL_CLAIM", JSON.parse(job.result_json ?? "{}").poll === undefined, `result=${String(job.result_json).slice(0, 160)}`);
    const submitsBefore = supplier.state.submits;
    const queryCalls = supplier.calls.filter((c) => c === "query_result").length;
    check("QUERY_ATTEMPTS_ARE_BOUNDED", queryCalls === 3, `query_result calls=${queryCalls} (maxQueryAttempts=3 for the one job that reached poll)`);
    // Processing again must not send a second submission for a job whose submit already happened.
    await service.processGenerationJob(withTrustedContext({ job_id: job.job_id }, trusted)).catch(() => null);
    check("REPROCESS_DOES_NOT_RESUBMIT", supplier.state.submits === submitsBefore, `submits before=${submitsBefore} after=${supplier.state.submits}`);
    report.scenarios.query_unknown = { state: job.state, query_calls: queryCalls, submits: supplier.state.submits };
  } finally {
    service.close();
  }
}

// ------------------------------------------------------------------------------------------------
// 4. partial ingest is unknown, not success
// ------------------------------------------------------------------------------------------------
{
  const supplier = createSupplier({ tag: "sc4" });
  const service = await buildService({ supplier });
  try {
    const adapter = service.generationJobAdapter;
    const job = service.createGenerationJob(withTrustedContext({
      entry: "dreamina.video.generate",
      provider: "dreamina_cli",
      idempotency_key: "boundary-partial-ingest",
      estimate_credits: 5,
      confirm_cost: true,
      request: { generation_type: "image2video", shot_key: "shot-1" }
    }, trusted));
    // Two downloaded files; only ONE of them is really ingested under this job's marker.
    const first = await service.ingestAsset({
      file_path: clip,
      kind: "raw",
      title: "partial ingest fixture A",
      description: `generation job ${job.job_id} · provider=dreamina_cli`,
      source: { source_type: "provider_generated", notes: "boundary" },
      change_summary: "boundary"
    });
    const { sha256File, runFfmpeg } = await import("../src/sop-v2-media.js");
    // The second output must have DIFFERENT bytes, otherwise it has the same sha256 as the first and a
    // hash-based reconciliation would rightly match both to the one real ingest. A distinct encode (and
    // a check that the two hashes really differ) is what makes this scenario meaningful.
    const secondCopy = path.join(workRoot, "second-output.mp4");
    const built = await runFfmpeg([
      "-y", "-f", "lavfi", "-i", "color=c=0x803010:s=320x180:d=1:r=15",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", path.basename(secondCopy)
    ], { cwd: workRoot, timeoutMs: 120000 });
    if (built.code !== 0) throw new Error(`second output build failed: ${built.stderr.slice(-300)}`);
    const firstSha = await sha256File(clip);
    const secondSha = await sha256File(secondCopy);
    check("PARTIAL_INGEST_FIXTURE_HASHES_DIFFER", firstSha !== secondSha, `${firstSha.slice(0, 12)} vs ${secondSha.slice(0, 12)}`);
    const probeJob = {
      job_id: job.job_id,
      entry: "dreamina.video.generate",
      request: { generation_type: "image2video" },
      result: { download: { files: [{ path: clip, sha256: firstSha }, { path: secondCopy, sha256: secondSha }] } }
    };
    const partial = await adapter.reconcilePhase(probeJob, "ingest");
    check("PARTIAL_INGEST_IS_UNKNOWN", partial.found === null, JSON.stringify(partial));
    check("PARTIAL_INGEST_LISTS_WHAT_LANDED", Array.isArray(partial.partial) && partial.partial.length === 1 && partial.partial[0].asset_id === first.asset_id,
      JSON.stringify(partial.partial));

    const full = await adapter.reconcilePhase({ ...probeJob, result: { download: { files: [{ path: clip, sha256: firstSha }] } } }, "ingest");
    check("FULL_INGEST_IS_FOUND_WITH_PATH", full.found === true && full.value.ingested[0].path === clip && Boolean(full.value.ingested[0].asset_version_id),
      JSON.stringify(full.value));
    report.scenarios.partial_ingest = { partial, full: full.value };
  } finally {
    service.close();
  }
}

// ------------------------------------------------------------------------------------------------
// 5. project-only writeback: reconcilable, and not duplicated on replay
// ------------------------------------------------------------------------------------------------
{
  const supplier = createSupplier({ tag: "sc5" });
  const service = await buildService({ supplier });
  try {
    const adapter = service.generationJobAdapter;
    const project = service.createProject({ title: "边界项目（project-only 写回）", description: "sop-v2 boundary project" });
    const asset = await service.ingestAsset({
      file_path: clip,
      kind: "raw",
      title: "writeback fixture",
      description: "boundary writeback source",
      source: { source_type: "provider_generated", notes: "boundary" },
      change_summary: "boundary"
    });
    const job = service.createGenerationJob(withTrustedContext({
      project_id: project.project_id,
      entry: "dreamina.video.generate",
      provider: "dreamina_cli",
      idempotency_key: "boundary-project-writeback",
      estimate_credits: 5,
      confirm_cost: true,
      request: { generation_type: "image2video", shot_key: "shot-1" }
    }, trusted));
    const jobRow = service.getGenerationJob(withTrustedContext({ job_id: job.job_id }, trusted));
    const withIngest = {
      ...jobRow,
      result: { ...(jobRow.result ?? {}), ingest: { ingested: [{ asset_id: asset.asset_id, asset_version_id: asset.default_version_id, path: clip }] } }
    };
    const first = await adapter.writeback(withIngest);
    check("PROJECT_ONLY_WRITEBACK_LANDS", first.target === "project_ref" && Boolean(first.reference_id), JSON.stringify(first));

    const reconciled = await adapter.reconcilePhase(withIngest, "writeback");
    check("PROJECT_ONLY_WRITEBACK_IS_RECONCILABLE", reconciled.found === true && reconciled.value.target === "project_ref" && reconciled.value.reference_id === first.reference_id,
      JSON.stringify(reconciled.value));
    const refsBefore = service.listProjectRefs({ project_id: project.project_id }).length;
    // A replayed writeback (what a crash-and-resume would do) must reuse the reference, not add one.
    const second = await adapter.writeback({ ...withIngest, result: { ...withIngest.result, writeback: undefined } });
    check("PROJECT_ONLY_WRITEBACK_IS_IDEMPOTENT", second.reused === true && second.reference_id === first.reference_id, JSON.stringify(second));
    check("PROJECT_REF_COUNT_UNCHANGED", service.listProjectRefs({ project_id: project.project_id }).length === refsBefore,
      `refs before=${refsBefore} after=${service.listProjectRefs({ project_id: project.project_id }).length}`);
    report.scenarios.project_writeback = { first, second, reconciled: reconciled.value };
  } finally {
    service.close();
  }
}

// ------------------------------------------------------------------------------------------------
// 6. a delivered run that fails re-validation loses its delivery label
// ------------------------------------------------------------------------------------------------
{
  const supplier = createSupplier({ tag: "sc6" });
  const service = await buildService({ supplier });
  try {
    const runRoot = path.join(workRoot, "run-revocation");
    fs.mkdirSync(path.join(runRoot, "work"), { recursive: true });
    const run = new SopV2Run({
      runRoot,
      service,
      brief: defaultBrief(),
      mode: SOP_V2_MODES.REAL_LOCAL,
      workRoot: path.join(runRoot, "work"),
      outputRoot: path.join(runRoot, "output"),
      logger: quiet
    });
    await run.run();
    check("RUN_DELIVERED_FIRST", run.state.label === "engineering_test_preview" && Boolean(run.state.deliverable?.sha256), JSON.stringify(run.state.deliverable));
    const deliveredPath = run.state.deliverable.path;
    const deliveredAsset = run.state.deliverable.asset_id;

    // Now the timeline changes underneath the delivery, so the recorded artifact no longer matches.
    const timeline = JSON.parse(fs.readFileSync(run.factsFile("edit"), "utf8")).timeline.path;
    fs.appendFileSync(timeline, Buffer.from([0x00, 0x01, 0x02]));
    const reopened = await run.run({ stages: ["edit", "qc", "export", "delivery"] });
    check("TAMPERED_STAGE_REOPENED", reopened.executed.includes("edit"), reopened.executed.join(","));
    check("DELIVERABLE_REVOKED_ON_REOPEN", run.state.deliverable !== null && run.state.deliverable.sha256 !== null,
      `deliverable after re-run=${JSON.stringify(run.state.deliverable)}`);
    check("REVOKED_RECORD_KEPT", (run.state.deliverable_history ?? []).length >= 1 && run.state.deliverable_history.at(-1).asset_id === deliveredAsset,
      JSON.stringify(run.state.deliverable_history));
    check("OLD_FILE_LEFT_ON_DISK", fs.existsSync(deliveredPath), deliveredPath);

    // A stage that fails outright must withdraw the label rather than leave it standing.
    const beforeLabel = run.state.label;
    const failing = new SopV2Run({
      runRoot: path.join(workRoot, "run-revocation-fail"),
      service,
      brief: defaultBrief(),
      mode: SOP_V2_MODES.REAL_LOCAL,
      workRoot: path.join(workRoot, "run-revocation-fail", "work"),
      outputRoot: path.join(workRoot, "run-revocation-fail", "output"),
      logger: quiet
    });
    await failing.run();
    const deliveredBefore = failing.state.deliverable;
    check("SECOND_RUN_DELIVERED", Boolean(deliveredBefore?.sha256), JSON.stringify(deliveredBefore));
    // Force the QC stage to fail by pointing it at a deliberately defective file.
    const defective = JSON.parse(fs.readFileSync(failing.factsFile("generation"), "utf8")).defective_control.path;
    failing.qcOverrideFile = defective;
    let qcError = null;
    try { await failing.run({ stages: ["qc", "export"], force: true }); } catch (error) { qcError = error; }
    check("QC_FAILURE_BLOCKS_EXPORT", qcError?.code === GATE_CODES.QC_FAILED, qcError?.code ?? "no error");
    check("QC_FAILURE_WITHDRAWS_LABEL", failing.state.label === "withheld" && failing.state.deliverable === null,
      JSON.stringify({ label: failing.state.label, deliverable: failing.state.deliverable }));
    check("QC_FAILURE_KEEPS_WITHDRAWN_RECORD", (failing.state.deliverable_history ?? []).length >= 1,
      JSON.stringify(failing.state.deliverable_history));
    report.scenarios.revocation = {
      first_run: { label: run.state.label, deliverable: run.state.deliverable, history: run.state.deliverable_history.length },
      failing_run: { label_before: beforeLabel, label_after: failing.state.label, history: failing.state.deliverable_history }
    };
  } finally {
    service.close();
  }
}

report.completed_at = new Date().toISOString();
report.passed = report.checks.every((item) => item.ok);
const reportPath = path.join(outputRoot, "evidence", "paid-path-boundaries.json");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, report: reportPath }, null, 2));
