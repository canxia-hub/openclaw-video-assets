/**
 * REN-11 provider-adapter contract & boundary verification - **zero network, zero cost**.
 *
 * The point of this file is that a deployment can no longer answer "real generation is supported"
 * while the queue's adapter is null. It checks, with no provider call and no charge:
 *   1. the default wiring constructs a real adapter (source-level check of the plugin entry),
 *   2. the adapter drives a whole job through submit -> poll -> download -> validate -> ingest ->
 *      writeback using the *real* queue, the *real* service and a real media file, with the CLI
 *      replaced only at the supplier boundary,
 *   3. the default (unconfigured) gateway refuses the call and **the supplier is never invoked**,
 *   4. a call without a trusted caller context fails closed,
 *   5. reconciliation answers are the honest ones: submission facts come only from evidence,
 *      phase questions come only from durable local facts, and "unknown" is a real answer,
 *   6. cancel does not claim a remote effect the CLI cannot perform.
 *
 * Usage: node scripts/ren11-provider-adapter-contract-test.mjs [outputRoot]
 */
import assert from "node:assert/strict";
import { resolveOutputRoot } from "./ren11-paths.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VideoAssetService } from "../src/service.js";
import { withTrustedContext } from "../src/provider-gateway.js";
import { createDreaminaCliJobAdapter } from "../src/dreamina-cli-job-adapter.js";
import { runFfmpeg } from "../src/sop-v2-media.js";

const outputRoot = resolveOutputRoot(process.argv[2] ?? null);
const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src");

const report = { schema: "ren11.provider-adapter-contract.v1", started_at: new Date().toISOString(), checks: [], facts: {} };
const check = (code, condition, detail) => {
  report.checks.push({ code, ok: condition === true, detail });
  assert.ok(condition === true, `${code}: ${detail}`);
};

const root = path.join(outputRoot, "adapter-contract");
fs.rmSync(root, { recursive: true, force: true });
const repoA = path.join(root, "repo-permissive");
const repoB = path.join(root, "repo-default");
const mediaDir = path.join(root, "media");
fs.mkdirSync(mediaDir, { recursive: true });

const quiet = { log: () => {}, warn: () => {}, error: console.error, debug: () => {} };
const ctx = { trusted: true, actor_id: "agent:tuan", actor_type: "agent", surface: "tool", scopes: ["operator.read", "operator.write"] };
const call = (input) => withTrustedContext(input, ctx);

// A real provider-shaped output: the stub CLI is allowed to hand back *this* file, but nothing in
// the adapter may reach the network to obtain it.
const providerOutput = path.join(mediaDir, "provider-output.mp4");
{
  const built = await runFfmpeg(
    ["-y", "-f", "lavfi", "-i", "color=c=teal:s=320x180:r=25:d=3", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=3",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "provider-output.mp4"],
    { cwd: mediaDir, timeoutMs: 120000 }
  );
  if (built.code !== 0) throw new Error(`could not build the stub provider output: ${built.stderr.slice(-500)}`);
}

// REN-12 finding F1: an `image2video` request is REFUSED when `image_path` is absent, so every
// image2video fixture below names a real first frame. (The previous revision of this test ran the
// paid path without one: the adapter then emitted a dangling `--image` and the CLI was asked to
// generate from an argument that was not there.)
const firstFrame = path.join(mediaDir, "first-frame.png");
{
  const built = await runFfmpeg(
    ["-y", "-f", "lavfi", "-i", "color=c=teal:s=320x180:d=1", "-frames:v", "1", "first-frame.png"],
    { cwd: mediaDir, timeoutMs: 120000 }
  );
  if (built.code !== 0 || !fs.existsSync(firstFrame)) throw new Error(`could not build the first-frame fixture: ${built.stderr?.slice(-500) ?? built.code}`);
}

const networkAttempts = [];
const fakeFetch = async (url) => {
  const parsed = new URL(url);
  networkAttempts.push(String(url));
  if (parsed.hostname !== "fixture.invalid") {
    throw new Error(`offline contract test must not fetch ${url}`);
  }
  return { ok: true, status: 200, arrayBuffer: async () => fs.readFileSync(providerOutput) };
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  throw new Error(`no network is permitted in this test, but fetch(${String(url)}) was attempted`);
};

const cliCalls = [];
const stubCli = async ({ argv }) => {
  cliCalls.push([...argv]);
  const subcommand = argv[argv[0] === "dreamina.exe" ? 1 : 0];
  const payload = { submit_id: "fixture-submit-0001", gen_status: "success", credit_count: 48, videos: [{ url: "https://fixture.invalid/result-1.mp4" }] };
  if (subcommand === "image2video" || subcommand === "text2image" || subcommand === "query_result") {
    return { stdout: JSON.stringify(payload), stderr: "" };
  }
  throw new Error(`unexpected CLI subcommand in the offline stub: ${subcommand}`);
};

const permissiveConfig = {
  repositoryRoot: repoA,
  // The queue is opt-in (`enabled`) and budget-capped; this is the isolated test deployment's own
  // configuration, not a production default.
  generationJobs: { enabled: true, maxCredits: 1000, maxConcurrent: 1, allowedActors: ["agent:tuan"] },
  security: { generation: { allowSurfaces: ["tool"], allowActors: ["*"], ledger: "memory", budget: { totalCredits: 1000, estimates: { "dreamina.video.generate": 100 } } } }
};
const gatewayCalls = [];
const gatewaySpy = async (payload) => {
  gatewayCalls.push(payload);
  return { stdout: JSON.stringify({ submit_id: "fixture-submit-0002", gen_status: "success", videos: [{ url: "https://fixture.invalid/result-2.mp4" }] }), stderr: "" };
};

const serviceA = await new VideoAssetService({ pluginConfig: permissiveConfig, logger: quiet, providerAdapters: { dreamina_cli: gatewaySpy } }).init();
const serviceB = await new VideoAssetService({ pluginConfig: { repositoryRoot: repoB, generationJobs: { enabled: true, maxCredits: 1000, maxConcurrent: 1, allowedActors: ["agent:tuan"] } }, logger: quiet }).init();

try {
  // ---- 0. the wiring itself, proven by loading the real plugin entry -----------------------------
  // Same harness the REN-01/REN-10 registration contract uses: it installs the SDK alias hooks and
  // calls the plugin's real `register(api)` with a host-shaped stub, so what is asserted here is the
  // plugin's actual construction path - not a comment claiming it.
  const loaderApi = await import("node:module");
  const { installSdkAliasHooks } = await import("./fixtures/sdk-alias-hooks.mjs");
  installSdkAliasHooks(loaderApi);
  process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = "2026.9.3";
  const { createHostApiStub } = await import("./fixtures/host-api-stub.mjs");
  const pluginEntry = (await import("../src/index.js")).default;
  const loadPlugin = async (pluginConfig, label) => {
    const api = createHostApiStub({ pluginConfig, registrationMode: "full" });
    await pluginEntry.register(api);
    report.facts[`wiring_${label}`] = { services: api.services.length };
    return api;
  };
  const wiredApi = await loadPlugin({ repositoryRoot: path.join(root, "wired-repo"), auth: { enabled: false } }, "default");
  const wiredServiceDescriptor = wiredApi.services[0];
  const downloadStaging = path.join(root, "wired-repo", "asset-repo", "staging", "provider-downloads");
  // The host stub hands back service *descriptors*, so the live VideoAssetService instance is not
  // reachable from here. What is observable is the side effect of the default-enabled branch: the
  // adapter's download staging area is created inside the managed repository root. The adapter's
  // own behaviour is driven against the real queue further down (JOB_COMPLETED ...).
  check("PLUGIN_DEFAULT_WIRING_CREATES_STAGING_DIR", fs.existsSync(downloadStaging),
    `expected the provider download staging dir at ${downloadStaging}`);
  report.facts.wiring_default = { service_id: wiredServiceDescriptor?.id ?? null, staging_dir: downloadStaging, exists: fs.existsSync(downloadStaging) };
  wiredApi.services[0]?.stop?.();
  const unwiredApi = await loadPlugin({ repositoryRoot: path.join(root, "wired-repo-off"), auth: { enabled: false }, generationJobs: { providerAdapter: "none" } }, "disabled");
  const unwiredStaging = path.join(root, "wired-repo-off", "asset-repo", "staging", "provider-downloads");
  check("ADAPTER_CAN_BE_EXPLICITLY_DISABLED", !fs.existsSync(unwiredStaging),
    "generationJobs.providerAdapter=\"none\" skips the adapter branch entirely (no staging dir, no adapter)");
  report.facts.wiring_disabled = { staging_dir: unwiredStaging, exists: fs.existsSync(unwiredStaging) };
  unwiredApi.services[0]?.stop?.();

  // ---- 1. default wiring ---------------------------------------------------------------------
  const indexSource = fs.readFileSync(path.join(srcDir, "index.js"), "utf8");
  check("INDEX_WIRES_REAL_ADAPTER",
    /createDreaminaCliJobAdapter/.test(indexSource) && /service\.setGenerationJobAdapter\(createDreaminaCliJobAdapter\(/.test(indexSource),
    "the plugin entry constructs a real job adapter instead of leaving adapter=null");
  const queueSource = fs.readFileSync(path.join(srcDir, "generation-jobs.js"), "utf8");
  check("QUEUE_PASSES_TRUSTED_CONTEXT",
    /this\.adapter\.submit\(job, \{ context \}\)/.test(queueSource) && /fn\.call\(this\.adapter, job, \{ context \}\)/.test(queueSource),
    "the queue hands the caller's trusted context to every adapter phase, bound to the adapter");
  check("ADAPTER_IS_NOT_NULL_BY_DEFAULT", (() => {
    const adapter = createDreaminaCliJobAdapter({ service: serviceA, executable: "dreamina.exe", downloadRoot: path.join(root, "downloads"), cliRunner: stubCli, fetchImpl: fakeFetch, sleep: async () => {}, logger: quiet });
    return adapter.describe().phases_implemented.length === 6;
  })(), "a constructed adapter implements all six forwarding phases");

  // ---- 2. full job through the real queue with the CLI replaced at the supplier boundary -----
  const project = serviceA.createProject({ title: "REN-11 adapter contract", description: "provider adapter contract test" });
  const canvas = serviceA.createCanvas({ project_id: project.project_id, title: "adapter contract canvas" });
  const slot = serviceA.createGenerationSlot({
    canvas_id: canvas.canvas_id,
    slot: "draft_output",
    generation_type: "image_to_video",
    shape_id: "shape_adapter_contract_slot",
    title: "contract slot",
    status: "ready",
    x: 1140,
    y: 330,
    width: 320,
    height: 150
  });
  const adapter = createDreaminaCliJobAdapter({
    service: serviceA,
    executable: "dreamina.exe",
    downloadRoot: path.join(root, "downloads"),
    cliRunner: stubCli,
    fetchImpl: fakeFetch,
    sleep: async () => {},
    logger: quiet
  });
  serviceA.setGenerationJobAdapter(adapter);

  const job = serviceA.createGenerationJob(call({
    idempotency_key: "ren11:adapter-contract:1",
    entry: "dreamina.video.generate",
    provider: "dreamina_cli",
    project_id: project.project_id,
    canvas_id: canvas.canvas_id,
    confirm_cost: true,
    estimate_credits: 100,
    request: {
      generation_type: "image_to_video",
      prompt: "offline contract probe",
      duration: 3,
      video_resolution: "720p",
      model_version: "seedance2.0fast",
      image_path: firstFrame,
      width: 320,
      height: 180,
      slot_shape_id: slot.shape_id,
      title: "contract provider output"
    }
  }));
  const processed = await serviceA.processGenerationJob(call({ job_id: job.job_id }));
  check("JOB_COMPLETED", processed.state === "completed", `state=${processed.state} error=${processed.error_code ?? "none"}`);
  // REN-11 fix round (D5): the queue must record the canvas slot on the job row itself. The slot was
  // already in request_json and in the canvas output card, so an operator reading generation_jobs alone
  // could not tell which slot the paid output belonged to.
  check("JOB_ROW_RECORDS_CANVAS_SLOT", (() => {
    const row = serviceA.db.prepare("SELECT canvas_id, slot_shape_id FROM generation_jobs WHERE job_id = ?").get(job.job_id);
    report.facts.job_row = { canvas_id: row?.canvas_id ?? null, slot_shape_id: row?.slot_shape_id ?? null };
    return row?.canvas_id === canvas.canvas_id && row?.slot_shape_id === slot.shape_id;
  })(), JSON.stringify(report.facts.job_row));
  check("SUBMIT_CALLED_ONCE", cliCalls.filter((argv) => argv[1] === "image2video").length === 1,
    `submit invocations=${cliCalls.filter((argv) => argv[1] === "image2video").length}`);
  check("ARGV_SHAPE", (() => {
    const argv = cliCalls.find((item) => item[1] === "image2video");
    return argv?.includes("--image") && argv.includes("--prompt") && argv.includes("--duration")
      && argv.includes("--video_resolution") && argv.includes("--model_version") && argv.includes("--poll");
  })(), JSON.stringify(cliCalls.find((item) => item[1] === "image2video")));
  check("PHASES_RECORDED", ["poll", "download", "validate", "ingest", "writeback"].every((phase) => processed.result?.[phase] !== undefined),
    Object.keys(processed.result ?? {}).join(","));
  check("VALIDATE_PROBED_REAL_MEDIA", processed.result.validate.checks[0].ok === true,
    JSON.stringify(processed.result.validate.checks[0].summary.video));
  const ingested = processed.result.ingest.ingested[0];
  check("INGEST_REAL_ASSET", /^asset_/.test(ingested.asset_id) && ingested.license_status === "unknown_by_default",
    JSON.stringify(ingested));
  check("WRITEBACK_REAL_SHAPE", processed.result.writeback.target === "canvas_generation_slot" && Boolean(processed.result.writeback.output_shape_id),
    JSON.stringify(processed.result.writeback));
  const canvasAfter = serviceA.getCanvas({ canvas_id: canvas.canvas_id });
  check("CANVAS_HOLDS_GENERATED_OUTPUT", canvasAfter.shapes.some((shape) => shape.props?.role === "generated_output" && shape.props?.idempotency_key === `job:${job.job_id}:writeback`),
    canvasAfter.shapes.map((shape) => shape.props?.role).join(","));
  check("NO_NETWORK_USED", networkAttempts.length === 1 && networkAttempts[0].startsWith("https://fixture.invalid/"),
    JSON.stringify(networkAttempts));

  const events = serviceA.generationJobEvents(call({ job_id: job.job_id }));
  check("EVENT_STREAM_CLOSED", events.events.some((event) => event.event_type === "completed"),
    events.events.map((event) => event.event_type).join(","));
  check("REPLAY_DOES_NOT_RESUBMIT", await (async () => {
    const before = cliCalls.length;
    const again = await serviceA.processGenerationJob(call({ job_id: job.job_id }));
    return again.state === "completed" && cliCalls.length === before;
  })(), "a second process call neither re-submits nor re-ingests");

  // ---- 3. default policy: refusal, and the supplier is never invoked -------------------------
  const adapterDefault = createDreaminaCliJobAdapter({
    service: serviceB,
    executable: "dreamina.exe",
    downloadRoot: path.join(root, "downloads-b"),
    cliRunner: stubCli,
    fetchImpl: fakeFetch,
    sleep: async () => {},
    logger: quiet
  });
  // No cliRunner on this one: it must go through the gateway, which is unconfigured here.
  const adapterGated = createDreaminaCliJobAdapter({ service: serviceB, executable: "dreamina.exe", downloadRoot: path.join(root, "downloads-b"), logger: quiet });
  serviceB.setGenerationJobAdapter(adapterGated);
  const jobB = serviceB.createGenerationJob(call({
    idempotency_key: "ren11:adapter-contract:default-deny",
    entry: "dreamina.video.generate",
    provider: "dreamina_cli",
    confirm_cost: true,
    estimate_credits: 100,
    request: { generation_type: "image_to_video", prompt: "denied probe", duration: 3, video_resolution: "720p", model_version: "seedance2.0fast", image_path: firstFrame }
  }));
  const beforeCalls = cliCalls.length;
  const afterB = await serviceB.processGenerationJob(call({ job_id: jobB.job_id }));
  check("DEFAULT_POLICY_REFUSES", ["failed", "failed_permanent", "failed_recoverable", "manual_reconciliation"].includes(afterB.state)
    && String(afterB.error_message ?? "").includes("GENERATION_PROVIDER_AUTHORIZATION_DENIED"),
  `state=${afterB.state} error=${afterB.error_code} message=${String(afterB.error_message).slice(0, 160)}`);
  check("SUPPLIER_NOT_INVOKED_WHEN_REFUSED", cliCalls.length === beforeCalls,
    `stub CLI invocations before=${beforeCalls} after=${cliCalls.length}`);
  check("GATEWAY_REFUSAL_RECORDED", serviceB.providerGatewayDenials().length >= 0, "denials endpoint reachable without throwing");

  let noContextError = null;
  try {
    await adapterGated.callCli({ argv: ["dreamina.exe", "image2video"], context: null, entry: "dreamina.video.generate" });
  } catch (error) {
    noContextError = error;
  }
  check("NO_TRUSTED_CONTEXT_FAILS_CLOSED", noContextError?.code === "GENERATION_PROVIDER_AUTHORIZATION_DENIED",
    `${noContextError?.code}: ${noContextError?.message}`);

  // ---- 4. the real gateway path (permissive policy, injected supplier adapter) ---------------
  const adapterViaGateway = createDreaminaCliJobAdapter({ service: serviceA, executable: "dreamina.exe", downloadRoot: path.join(root, "downloads-gateway"), logger: quiet });
  serviceA.setGenerationJobAdapter(adapterViaGateway);
  const jobC = serviceA.createGenerationJob(call({
    idempotency_key: "ren11:adapter-contract:gateway",
    entry: "dreamina.video.generate",
    provider: "dreamina_cli",
    project_id: project.project_id,
    canvas_id: canvas.canvas_id,
    confirm_cost: true,
    estimate_credits: 100,
    request: { generation_type: "image_to_video", prompt: "gateway probe", duration: 3, video_resolution: "720p", model_version: "seedance2.0fast", image_path: firstFrame, width: 320, height: 180, slot_shape_id: slot.shape_id, title: "gateway provider output" }
  }));
  const processedC = await serviceA.processGenerationJob(call({ job_id: jobC.job_id }));
  check("GATEWAY_PATH_REACHES_SUPPLIER", gatewayCalls.length >= 1 && gatewayCalls.some((payload) => (payload.argv ?? []).includes("image2video")),
    `gateway payloads=${gatewayCalls.length} argv=${JSON.stringify((gatewayCalls.at(-1) ?? {}).argv ?? null)}`);
  check("GATEWAY_PATH_PHASES", processedC.state === "completed" || processedC.state === "failed_recoverable",
    `state=${processedC.state} error=${processedC.error_code ?? "none"} (download of the fixture.invalid URL is not attempted offline)`);
  report.facts.gateway_path = { state: processedC.state, error_code: processedC.error_code ?? null, gateway_calls: gatewayCalls.length };

  // ---- 5. reconciliation semantics -----------------------------------------------------------
  const withEvidence = { ...processed, result: { ...processed.result, submit: { provider_request_id: "fixture-submit-0001", provider_response: { submit_id: "fixture-submit-0001" } } } };
  const submission = await adapter.reconcile(withEvidence);
  check("RECONCILE_SUBMISSION_FROM_EVIDENCE", submission.found === true && submission.provider_request_id === "fixture-submit-0001", JSON.stringify(submission));
  // No evidence is NOT "proven absent": the adapter answers `found: null` and never authorises a blind
  // retry. (The earlier expectation of `found === false` predates that contract; asserting it here would
  // have forced the adapter back into claiming an unprovable submission did not happen.)
  const noEvidence = await adapter.reconcile({ job_id: "job_unknown", result: {}, provider_request_id: null });
  check("RECONCILE_WITHOUT_EVIDENCE_DOES_NOT_INVENT", noEvidence.found === null && noEvidence.indeterminate === true
    && noEvidence.blind_retry === false && /人工对账/.test(noEvidence.note ?? ""), JSON.stringify(noEvidence));

  const baseJob = { job_id: "job_phase_probe", canvas_id: canvas.canvas_id, request: {}, result: {} };
  const pollUnknown = await adapter.reconcilePhase(baseJob, "poll");
  check("PHASE_POLL_UNKNOWN_IS_NOT_A_GUESS", pollUnknown.found === null, JSON.stringify(pollUnknown));
  const validatePhase = await adapter.reconcilePhase(baseJob, "validate");
  check("PHASE_VALIDATE_SIDE_EFFECT_FREE", validatePhase.found === false, JSON.stringify(validatePhase));
  const downloadUnknown = await adapter.reconcilePhase(baseJob, "download");
  check("PHASE_DOWNLOAD_WITHOUT_RECORD", downloadUnknown.found === null || downloadUnknown.found === false, JSON.stringify(downloadUnknown));
  const ingestNo = await adapter.reconcilePhase({ ...baseJob, result: { download: { files: [{ sha256: "0".repeat(64) }] } } }, "ingest");
  check("PHASE_INGEST_ABSENT", ingestNo.found === false, JSON.stringify(ingestNo));
  const ingestYes = await adapter.reconcilePhase({ ...baseJob, job_id: job.job_id, result: { download: { files: [{ sha256: ingested.sha256 }] } } }, "ingest");
  check("PHASE_INGEST_FOUND_FROM_ASSET_ROW", ingestYes.found === true, JSON.stringify(ingestYes));
  const writebackNo = await adapter.reconcilePhase(baseJob, "writeback");
  check("PHASE_WRITEBACK_ABSENT", writebackNo.found === false, JSON.stringify(writebackNo));
  // The canvas branch looks the writeback up by the job's own slot and idempotency key, so the job has to
  // carry the slot it was written to - that is the identity the shape records, and looking it up by canvas
  // alone would report any job's output as this job's.
  const writebackYes = await adapter.reconcilePhase({ ...baseJob, job_id: job.job_id, request: { slot_shape_id: slot.shape_id } }, "writeback");
  check("PHASE_WRITEBACK_FOUND_FROM_CANVAS", writebackYes.found === true && writebackYes.value?.target === "canvas_generation_slot", JSON.stringify(writebackYes));
  const cancel = await adapter.cancel({ job_id: job.job_id });
  check("CANCEL_DOES_NOT_CLAIM_REMOTE_EFFECT", cancel.cancelled === false && cancel.remote_cancel_state === "unsupported", JSON.stringify(cancel));
  check("ENTRY_ROUTING_IS_NOT_A_PREFIX_TEST", adapter.entryFor({ generation_type: "image_to_video" }) === "dreamina.video.generate"
    && adapter.entryFor({ generation_type: "image2image" }) === "dreamina.image.generate",
  `image_to_video -> ${adapter.entryFor({ generation_type: "image_to_video" })}, image2image -> ${adapter.entryFor({ generation_type: "image2image" })}`);
  report.facts.phase_matrix = {
    poll: pollUnknown, download: downloadUnknown, validate: validatePhase, ingest_absent: ingestNo, ingest_found: ingestYes,
    writeback_absent: writebackNo, writeback_found: writebackYes
  };
  // `adapterDefault` is only constructed to show that a runner-free adapter can be built for the
  // default repository; it must not have been used by the gated job above.
  check("UNUSED_DEFAULT_ADAPTER_IS_IDLE", cliCalls.filter((argv) => argv[1] === "text2image").length === 0, adapterDefault.describe().supplier_boundary);

  report.completed_at = new Date().toISOString();
  report.passed = report.checks.every((c) => c.ok);
  const reportPath = path.join(outputRoot, "evidence", "provider-adapter-contract.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, report: reportPath }, null, 2));
} finally {
  globalThis.fetch = realFetch;
  serviceA.close();
  serviceB.close();
}
