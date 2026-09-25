import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";
import { withTrustedContext } from "../src/provider-gateway.js";

const outIndex = process.argv.indexOf("--out-json");
const outJson = outIndex >= 0 ? process.argv[outIndex + 1] : null;
const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-ren10-jobs-"));
const repositoryRoot = path.join(tmp, "repo");
const generatedFile = path.join(tmp, "mock-generated.mp4");
await fs.promises.writeFile(generatedFile, "REN-10 zero-cost provider fixture\n", "utf8");

const checks = [];
function check(id, condition, detail) {
  checks.push({ id, ok: Boolean(condition), detail });
  if (!condition) throw new Error(`${id}: ${detail}`);
}

async function rejectsCode(fn, code, status) {
  try { await fn(); }
  catch (error) {
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return error;
  }
  assert.fail(`expected ${code}`);
}

const toolA = { trusted: true, actor_id: "agent:a", actor_type: "agent", surface: "tool", scopes: ["operator.read", "operator.write"] };
const uiA = { trusted: true, actor_id: "agent:a", actor_type: "agent", surface: "ui", scopes: ["operator.read", "operator.write"] };
const toolB = { trusted: true, actor_id: "agent:b", actor_type: "agent", surface: "tool", scopes: ["operator.read", "operator.write"] };
const call = (input, context) => withTrustedContext(input, context);
const config = {
  repositoryRoot,
  generationJobs: {
    enabled: true,
    maxCredits: 2000,
    maxConcurrent: 1,
    allowedActors: ["agent:a", "agent:b"],
    allowedSurfaces: ["tool", "ui", "browser", "gateway"]
  }
};

const external = {
  submits: new Map(),
  phaseCalls: new Map(),
  providerRequests: new Map(),
  effects: new Map(),
  failAfterEffect: new Set(["download", "ingest", "writeback"]),
  failedOnce: new Set(),
  cancelCalls: 0,
  slowRelease: null,
  slowStarted: null
};
let slowStartedResolve;
let slowReleaseResolve;
external.slowStarted = new Promise((resolve) => { slowStartedResolve = resolve; });
external.slowRelease = new Promise((resolve) => { slowReleaseResolve = resolve; });
let service;
let canvasId;
let anchorId;

function increment(map, key) { map.set(key, (map.get(key) ?? 0) + 1); return map.get(key); }
function scenario(job) { return String(job.request.scenario ?? "normal"); }
function effectKey(job, phase) { return `${job.job_id}:${phase}`; }
function shouldFailAfter(job, phase) { return scenario(job) === `fail_${phase}` && external.failAfterEffect.has(phase) && !external.failedOnce.has(effectKey(job, phase)); }

const adapter = {
  async submit(job) {
    increment(external.submits, job.job_id);
    const provider_request_id = `mock_${job.job_id}`;
    external.providerRequests.set(job.job_id, provider_request_id);
    if (scenario(job) === "unknown_submit" && !external.failedOnce.has(effectKey(job, "submit"))) {
      external.failedOnce.add(effectKey(job, "submit"));
      const error = new Error("mock transport closed after provider accepted the request");
      error.submissionUnknown = true;
      throw error;
    }
    return { provider_request_id, mock: true };
  },
  async reconcile(job) {
    const provider_request_id = external.providerRequests.get(job.job_id);
    return provider_request_id ? { found: true, provider_request_id, mock: true } : { found: false };
  },
  async poll(job) {
    increment(external.phaseCalls, effectKey(job, "poll"));
    if (scenario(job) === "slow") { slowStartedResolve(); await external.slowRelease; }
    if (scenario(job) === "cancel_after_submit") throw new Error("mock provider is still running");
    return { status: "completed", actual_credits: 2, mock: true };
  },
  async download(job) {
    increment(external.phaseCalls, effectKey(job, "download"));
    const value = { file_path: generatedFile, sha256_fixture: "mock", mock: true };
    external.effects.set(effectKey(job, "download"), value);
    if (shouldFailAfter(job, "download")) {
      external.failedOnce.add(effectKey(job, "download"));
      throw new Error("mock response lost after download completed");
    }
    return value;
  },
  async validate(job) {
    increment(external.phaseCalls, effectKey(job, "validate"));
    return { ok: fs.existsSync(job.result.download.file_path), mock: true };
  },
  async ingest(job) {
    increment(external.phaseCalls, effectKey(job, "ingest"));
    const asset = await service.ingestAsset(call({
      file_path: job.result.download.file_path,
      title: `REN-10 mock ${job.job_id}`,
      kind: "working"
    }, toolA));
    const value = { asset_id: asset.asset_id, asset_version_id: asset.default_version_id, license_status: asset.license_status, mock: true };
    external.effects.set(effectKey(job, "ingest"), value);
    if (shouldFailAfter(job, "ingest")) {
      external.failedOnce.add(effectKey(job, "ingest"));
      throw new Error("mock response lost after ingest committed");
    }
    return value;
  },
  async writeback(job) {
    increment(external.phaseCalls, effectKey(job, "writeback"));
    const shapeId = `shape_job_${job.job_id}`;
    const edgeId = `edge_job_${job.job_id}`;
    service.upsertCanvasShape(call({
      canvas_id: canvasId,
      shape_id: shapeId,
      shape_type: "asset_card",
      subject_type: "asset_version",
      subject_id: job.result.ingest.asset_version_id,
      title: `Mock output ${job.job_id}`,
      x: 420,
      y: 180,
      width: 260,
      height: 140,
      props: { role: "draft_output", generation_job_id: job.job_id }
    }, toolA));
    service.linkCanvasShapes(call({
      canvas_id: canvasId,
      edge_id: edgeId,
      source_shape_id: anchorId,
      target_shape_id: shapeId,
      relation_type: "derived_from",
      props: { generation_job_id: job.job_id }
    }, toolA));
    const value = { canvas_id: canvasId, shape_id: shapeId, edge_id: edgeId, slot: "draft_output", mock: true };
    external.effects.set(effectKey(job, "writeback"), value);
    if (shouldFailAfter(job, "writeback")) {
      external.failedOnce.add(effectKey(job, "writeback"));
      throw new Error("mock response lost after canvas writeback committed");
    }
    return value;
  },
  async reconcilePhase(job, phase) {
    const value = external.effects.get(effectKey(job, phase));
    return value ? { found: true, value, mock: true } : { found: false };
  }
};

function openService() {
  service = new VideoAssetService({ pluginConfig: config, generationJobAdapter: adapter }).init();
  return service;
}

function createJob(key, scenarioName = "normal", context = toolA, estimate = 2) {
  return service.createGenerationJob(call({
    idempotency_key: key,
    entry: "dreamina.video.generate",
    provider: "dreamina_cli",
    confirm_cost: true,
    estimate_credits: estimate,
    canvas_id: canvasId,
    request: { scenario: scenarioName, prompt: `fixture ${scenarioName}` },
    plan: { source: "REN-10-zero-cost-mock", paid_provider: false }
  }, context));
}

try {
  openService();
  const project = service.createProject({ title: "REN-10 zero-cost fixture" });
  const canvas = service.createCanvas({ project_id: project.project_id, title: "REN-10 queue fixture" });
  canvasId = canvas.canvas_id;
  anchorId = service.upsertCanvasShape(call({ canvas_id: canvasId, shape_id: "shape_job_anchor", shape_type: "note", subject_type: "note", subject_id: "ren10-anchor", title: "Generation input", x: 0, y: 0, width: 260, height: 140 }, toolA)).shape_id;

  // Gate 3: authorization, cost, entry/provider and shared tool/UI server gate.
  await rejectsCode(() => Promise.resolve(service.createGenerationJob({ idempotency_key: "unauthorized", entry: "dreamina.video.generate", provider: "dreamina_cli", confirm_cost: true, estimate_credits: 1, request: {} })), "GENERATION_ACTOR_UNTRUSTED", 403);
  check("unauthorized_is_rejected_before_submit", external.submits.size === 0, `provider submit map size ${external.submits.size}`);
  await rejectsCode(() => Promise.resolve(createJob("budget-over", "normal", toolA, 2001)), "GENERATION_BUDGET_EXCEEDED", 403);
  const serverCost = createJob("server-cost-floor", "normal", toolA, 0);
  check("server_registry_cost_cannot_be_understated_by_the_client", serverCost.estimated_credits === 100, `client requested 0; server reserved ${serverCost.estimated_credits}`);
  await rejectsCode(() => Promise.resolve(service.createGenerationJob(call({ idempotency_key: "provider-mismatch", entry: "dreamina.video.generate", provider: "kie_suno", confirm_cost: true, estimate_credits: 1, request: {} }, toolA))), "GENERATION_PROVIDER_MISMATCH", 400);
  const toolJob = createJob("shared-tool", "normal", toolA);
  const uiJob = createJob("shared-ui", "normal", uiA);
  check("tool_and_ui_share_the_same_persistent_gate", toolJob.actor_id === uiJob.actor_id && toolJob.surface === "tool" && uiJob.surface === "ui", `${toolJob.surface}/${uiJob.surface}, actor ${toolJob.actor_id}`);
  await rejectsCode(() => service.processGenerationJob(call({ job_id: toolJob.job_id }, toolB)), "GENERATION_JOB_FORBIDDEN", 403);
  check("wrong_actor_is_rejected_before_submit", !external.submits.has(toolJob.job_id), `submit count ${external.submits.get(toolJob.job_id) ?? 0}`);

  // Gate 1: idempotency, restart, at-most-one submit and unknown reconciliation.
  const first = createJob("stable-replay", "normal", toolA);
  const replay = createJob("stable-replay", "normal", toolA);
  check("same_key_same_request_replays_one_job", replay.replayed === true && replay.job_id === first.job_id, `${first.job_id}/${replay.job_id}`);
  await rejectsCode(() => Promise.resolve(createJob("stable-replay", "different", toolA)), "GENERATION_JOB_IDEMPOTENCY_CONFLICT", 409);
  await service.processGenerationJob(call({ job_id: first.job_id }, toolA));
  check("normal_job_submits_exactly_once", external.submits.get(first.job_id) === 1, `submit count ${external.submits.get(first.job_id)}`);
  service.close();
  openService();
  const afterRestartReplay = createJob("stable-replay", "normal", toolA);
  await service.processGenerationJob(call({ job_id: first.job_id }, toolA));
  check("completed_job_restart_does_not_resubmit", afterRestartReplay.replayed === true && external.submits.get(first.job_id) === 1, `submit count ${external.submits.get(first.job_id)}`);

  const unknown = createJob("unknown-submit", "unknown_submit", toolA);
  const unknownResult = await service.processGenerationJob(call({ job_id: unknown.job_id }, toolA));
  check("unknown_submit_stops_for_reconciliation", unknownResult.state === "unknown_submission" && external.submits.get(unknown.job_id) === 1, `${unknownResult.state}, submits ${external.submits.get(unknown.job_id)}`);
  service.close();
  openService();
  const blindRetry = await service.processGenerationJob(call({ job_id: unknown.job_id }, toolA));
  check("restart_does_not_blindly_retry_unknown_submit", blindRetry.state === "unknown_submission" && external.submits.get(unknown.job_id) === 1, `${blindRetry.state}, submits ${external.submits.get(unknown.job_id)}`);
  const reconciled = await service.reconcileGenerationJob(call({ job_id: unknown.job_id }, toolA));
  check("unknown_submit_reconciles_without_second_charge", reconciled.state === "completed" && external.submits.get(unknown.job_id) === 1, `${reconciled.state}, submits ${external.submits.get(unknown.job_id)}`);

  // Gate 2: failures after side effects are reconciled; no duplicate artifact/cost/canvas edge.
  for (const phase of ["download", "ingest", "writeback"]) {
    const job = createJob(`fault-${phase}`, `fail_${phase}`, toolA);
    const failed = await service.processGenerationJob(call({ job_id: job.job_id }, toolA));
    check(`${phase}_post_commit_fault_is_recoverable`, failed.state === "failed_recoverable" && failed.failed_phase === phase, `${failed.state}/${failed.failed_phase}`);
    const resumed = await service.resumeGenerationJob(call({ job_id: job.job_id }, toolA));
    check(`${phase}_recovery_completes`, resumed.state === "completed", resumed.state);
    check(`${phase}_recovery_never_resubmits_provider`, external.submits.get(job.job_id) === 1, `submit count ${external.submits.get(job.job_id)}`);
    check(`${phase}_side_effect_is_not_repeated`, external.phaseCalls.get(effectKey(job, phase)) === 1, `${phase} calls ${external.phaseCalls.get(effectKey(job, phase))}`);
    check(`${phase}_provenance_is_complete`, Boolean(resumed.result.ingest?.asset_version_id && resumed.result.writeback?.edge_id), JSON.stringify({ ingest: resumed.result.ingest, writeback: resumed.result.writeback }));
    const document = service.getCanvas({ canvas_id: canvasId });
    check(`${phase}_canvas_edge_is_unique`, document.edges.filter((edge) => edge.edge_id === resumed.result.writeback.edge_id).length === 1, resumed.result.writeback.edge_id);
    check(`${phase}_rights_default_unknown`, resumed.request.asset_policy.license_status === "unknown" && resumed.result.ingest.license_status === "unknown", `${resumed.request.asset_policy.license_status}/${resumed.result.ingest.license_status}`);
  }

  // Bounded concurrency is enforced by the same persistent worker surface.
  const slow = createJob("slow-one", "slow", toolA);
  const queuedBehind = createJob("slow-two", "normal", toolA);
  const slowPromise = service.processGenerationJob(call({ job_id: slow.job_id }, toolA));
  await external.slowStarted;
  await rejectsCode(() => service.processGenerationJob(call({ job_id: queuedBehind.job_id }, toolA)), "GENERATION_QUEUE_BUSY", 429);
  slowReleaseResolve();
  await slowPromise;
  check("max_concurrent_is_enforced", !external.submits.has(queuedBehind.job_id), `second submit count ${external.submits.get(queuedBehind.job_id) ?? 0}`);

  // Gate 4: cursor resume and truthful cancellation.
  const cursorJob = createJob("event-cursor", "normal", toolA);
  const beforeEvents = service.generationJobEvents(call({ job_id: cursorJob.job_id, after_seq: 0 }, toolA));
  await service.processGenerationJob(call({ job_id: cursorJob.job_id }, toolA));
  const resumedEvents = service.generationJobEvents(call({ job_id: cursorJob.job_id, after_seq: beforeEvents.cursor }, toolA));
  check("event_cursor_resumes_without_replaying_old_events", resumedEvents.events.length > 0 && resumedEvents.events.every((event) => event.seq > beforeEvents.cursor), `cursor ${beforeEvents.cursor}, returned ${resumedEvents.events.map((event) => event.seq).join(",")}`);

  const localCancel = createJob("cancel-local", "normal", toolA);
  const cancelledLocal = await service.cancelGenerationJob(call({ job_id: localCancel.job_id }, toolA));
  check("pre_submit_cancel_releases_only_local_reservation", cancelledLocal.state === "cancelled_local" && cancelledLocal.remote_cancel_state === "not_submitted" && cancelledLocal.budget_state === "released", `${cancelledLocal.state}/${cancelledLocal.remote_cancel_state}/${cancelledLocal.budget_state}`);

  const remoteCancel = createJob("cancel-remote", "cancel_after_submit", toolA);
  const remoteRunning = await service.processGenerationJob(call({ job_id: remoteCancel.job_id }, toolA));
  check("submitted_job_is_known_before_cancel", remoteRunning.provider_submit_state === "submitted", remoteRunning.provider_submit_state);
  const cancelRequested = await service.cancelGenerationJob(call({ job_id: remoteCancel.job_id }, toolA));
  const cancelEvents = service.generationJobEvents(call({ job_id: remoteCancel.job_id, after_seq: 0 }, toolA));
  const cancelEvent = cancelEvents.events.find((event) => event.event_type === "cancel_requested");
  check("local_cancel_does_not_claim_remote_success_or_refund", cancelRequested.state === "cancel_requested" && cancelRequested.remote_cancel_state === "unsupported" && cancelRequested.budget_state === "reserved" && cancelEvent?.data?.refund_claimed === false, JSON.stringify({ state: cancelRequested.state, remote: cancelRequested.remote_cancel_state, budget: cancelRequested.budget_state, event: cancelEvent?.data }));

  const ledger = service.db.prepare("SELECT state,COUNT(*) AS count,SUM(COALESCE(actual_credits,estimated_credits)) AS credits FROM generation_budget_ledger GROUP BY state ORDER BY state").all();
  const pendingCompensations = service.db.prepare("SELECT COUNT(*) AS n FROM generation_compensations WHERE state='pending'").get().n;
  check("successful_recovery_resolves_compensations", Number(pendingCompensations) === 1, `pending compensations ${pendingCompensations}; the one remaining belongs to the intentionally running remote job`);

  const report = {
    ok: checks.every((item) => item.ok),
    zero_cost_mock: true,
    paid_provider_called: false,
    checks: checks.length,
    gates: {
      at_most_once_and_restart: true,
      fault_recovery_without_duplicate: true,
      shared_server_gate: true,
      event_resume_and_truthful_cancel: true
    },
    ledger,
    provider_submit_counts: Object.fromEntries(external.submits),
    limitations: ["No real provider or public network was called.", "Provider reconciliation and phase reconciliation use a deterministic local mock adapter."]
  };
  if (outJson) { await fs.promises.mkdir(path.dirname(path.resolve(outJson)), { recursive: true }); await fs.promises.writeFile(path.resolve(outJson), `${JSON.stringify(report, null, 2)}\n`, "utf8"); }
  console.log(JSON.stringify(report, null, 2));
  console.log("generation job lifecycle test passed");
} finally {
  service?.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
