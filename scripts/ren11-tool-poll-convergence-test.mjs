/**
 * REN-11 fix round regression fixture: the Dreamina tool surface must not lose a paid submission (D3),
 * and provider media downloads must survive a transport hiccup (D4).
 *
 * Why these specific assertions, from the real-machine record of 2026-09-25:
 *   * a blocking `--poll 600` returned `get_history_by_ids failed: ret=1015` with EMPTY stdout while the
 *     provider had already accepted and charged the job: the submit id was lost, and "parameters were
 *     refused" was indistinguishable from "there was no answer". So the fixture asserts that the submit
 *     is issued asynchronously (`--poll 0`), that the id survives, that convergence is read-only and
 *     never re-submits, and that the two failure classes are reported apart.
 *   * one hung signed-object GET (undici BodyTimeoutError) ended an already-paid tool call. So the
 *     fixture asserts a download that fails once still completes, and that one which really cannot be
 *     materialised fails with its bounded attempt list instead of hanging.
 *
 * Everything runs offline and without credits: the provider is a stub adapter (the documented seam) and
 * the media CDN is an injected fetch implementation (the seam the live run itself had to use).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";
import { createDreaminaCliJobAdapter } from "../src/dreamina-cli-job-adapter.js";
import { withTrustedContext } from "../src/provider-gateway.js";

const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const png = Buffer.from(png1x1, "base64");
const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ren11-tool-poll-"));
const referenceSource = path.join(tmp, "main-reference.png");
await fs.promises.writeFile(referenceSource, png);

const quiet = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
const ctx = { trusted: true, actor_id: "agent:tuan", actor_type: "agent", surface: "tool", scopes: ["operator.read", "operator.write"] };
/** The tool surface is only reachable with a trusted caller context (the gate refuses unattributed paid calls). */
const call = (input) => withTrustedContext(input, ctx);
const argvValue = (argv, flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : null;
};
const okResponse = () => ({ ok: true, status: 200, arrayBuffer: async () => png });

/** A downloader that drops the first request, like the signed-object stall the live run hit. */
function flakyFetch() {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, has_signal: Boolean(options.signal) });
    if (calls.length === 1) throw new Error("BodyTimeoutError: request body timed out");
    return okResponse();
  };
  return { impl, calls };
}

/** A downloader that never answers; it only settles when the caller's own timeout signal aborts. */
function hangingFetch() {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, has_signal: Boolean(options.signal) });
    const signal = options.signal;
    // `AbortSignal.timeout()` unrefs its own timer (verified on this runtime: a process with nothing else
    // pending exits instead of firing the abort), so the fixture holds one ref'd handle until the signal
    // arrives. In a deployment the download always has other live handles (the socket, the CLI child).
    const keepAlive = setInterval(() => {}, 1000);
    try {
      await new Promise((resolve, reject) => {
        if (!signal) { setTimeout(resolve, 30000); return; }
        if (signal.aborted) { reject(new Error("This operation was aborted")); return; }
        signal.addEventListener("abort", () => reject(new Error("This operation was aborted")), { once: true });
      });
      return okResponse();
    } finally {
      clearInterval(keepAlive);
    }
  };
  return { impl, calls };
}

const healthyFetch = () => {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, has_signal: Boolean(options.signal) });
    return okResponse();
  };
  return { impl, calls };
};

/** Stub provider: the tool surface's real command vocabulary, with a scripted answer per case. */
function makeCli(script) {
  const calls = [];
  const run = async ({ argv }) => {
    calls.push([...argv]);
    const subcommand = argv[0];
    if (subcommand === "user_credit") return { stdout: JSON.stringify({ credit: 100, vip_level: "maestro" }), stderr: "" };
    if (["text2image", "image2image", "image_upscale"].includes(subcommand)) return script.submit(argv, calls);
    if (subcommand === "query_result") return script.query(argv, calls);
    throw new Error(`unexpected CLI subcommand in the offline stub: ${subcommand}`);
  };
  return { run, calls };
}

async function makeService({ repoName, adapter, downloadFetchImpl = null }) {
  const svc = await new VideoAssetService({
    pluginConfig: {
      repositoryRoot: path.join(tmp, repoName),
      security: { generation: { allowSurfaces: ["tool"], allowActors: ["*"], ledger: "memory", budget: { totalCredits: 1000, estimates: { "dreamina.image.generate": 8, "dreamina.image.upscale": 8 } } } }
    },
    logger: quiet,
    downloadFetchImpl,
    providerAdapters: { dreamina_cli: adapter }
  }).init();
  const project = svc.createProject({ title: `REN-11 tool poll ${repoName}` });
  svc.updateProjectSpec({ project_id: project.project_id, target_platforms: ["internal_engineering_review"], aspect_ratio: "16:9", resolution: "1280x720", fps: 30 });
  const asset = await svc.ingestAsset({ file_path: referenceSource, title: "main reference", kind: "working" });
  svc.updateAssetRights({ asset_id: asset.asset_id, license_status: "cleared", risk_level: "low", source: { source_type: "internal_fixture", license_hint: "test fixture" } });
  svc.classifyAsset({ asset_id: asset.asset_id, asset_version_id: asset.default_version_id, domain: "reference", type: "main_reference", confidence: "confirmed", source: "agent" });
  const ref = svc.addProjectRef({
    project_id: project.project_id,
    asset_id: asset.asset_id,
    asset_version_id: asset.default_version_id,
    role: "reference",
    usage_scope: "tool surface regression fixture",
    pin_mode: "pinned",
    required: true
  });
  const canvas = svc.createCanvas({ project_id: project.project_id, title: `canvas ${repoName}` });
  svc.upsertCanvasShape({
    canvas_id: canvas.canvas_id,
    shape_type: "reference_card",
    subject_type: "project_ref",
    subject_id: ref.reference_id,
    title: "bound reference",
    x: 0,
    y: 0,
    width: 260,
    height: 140,
    props: { generation_slot: "main_reference", stage: "shots", role: "project_ref" }
  });
  return { svc, canvas, outputDir: path.join(tmp, `${repoName}-outputs`) };
}

const started = [];

try {
  // =================================================================================================
  // 1. async submit + read-only convergence, ending in a downloaded, ingested, written-back output
  // =================================================================================================
  {
    const media = healthyFetch();
    const script = {
      submit: () => ({ stdout: JSON.stringify({ submit_id: "sub-async-0001", gen_status: "querying" }), stderr: "" }),
      query: (argv, calls) => {
        const queries = calls.filter((item) => item[0] === "query_result").length;
        return queries <= 1
          ? { stdout: JSON.stringify({ submit_id: "sub-async-0001", gen_status: "querying" }), stderr: "" }
          : { stdout: JSON.stringify({ submit_id: "sub-async-0001", gen_status: "success", credit_count: 8, result_json: { images: [{ image_url: "https://provider.invalid/out.png", width: 2560, height: 1440 }] } }), stderr: "" };
      }
    };
    const cli = makeCli(script);
    const { svc, canvas, outputDir } = await makeService({ repoName: "repo-async", adapter: cli.run, downloadFetchImpl: media.impl });
    started.push(svc);
    const result = await svc.canvasDreaminaCliGenerateImage(call({
      canvas_id: canvas.canvas_id,
      generation_type: "image",
      prompt: "regression fixture: async submit and read-only convergence",
      model_version: "5.0Pro",
      resolution_type: "2k",
      execute: true,
      accept_credit_spend: true,
      output_dir: outputDir,
      converge_interval_ms: 1
    }));
    const submitCalls = cli.calls.filter((argv) => argv[0] === "text2image");
    const queryCalls = cli.calls.filter((argv) => argv[0] === "query_result");
    assert.equal(submitCalls.length, 1, "the fixture must submit exactly once");
    assert.equal(argvValue(submitCalls[0], "--poll"), "0", "the tool surface must submit asynchronously (--poll 0)");
    assert.equal(queryCalls.length >= 2, true, `convergence must use read-only queries (got ${queryCalls.length})`);
    assert.equal(result.status, "success", `expected success, failure_class=${result.submission?.failure_class}`);
    assert.equal(result.submission.submit_id, "sub-async-0001");
    assert.equal(result.submission.accepted, true);
    assert.equal(result.submission.reconcile_required, false);
    assert.equal(result.convergence.read_only, true);
    assert.equal(result.convergence.resubmitted, false);
    assert.equal(result.downloads.length, 1, "the provider image must be downloaded");
    assert.equal(fs.readFileSync(result.downloads[0].file_path).equals(png), true, "downloaded bytes must match the served object");
    assert.equal(media.calls[0].has_signal, true, "downloads must be issued with an abort signal (the per-attempt timeout)");
    assert.equal(result.registered_assets.length, 1);
    assert.equal(result.canvas_writeback?.shapes?.length ?? 0, 1, "the generated image must be written back to the canvas");
    console.log(JSON.stringify({
      case: "async_submit_convergence",
      poll_arg: argvValue(submitCalls[0], "--poll"),
      submit_calls: submitCalls.length,
      query_calls: queryCalls.length,
      status: result.status,
      submit_id: result.submission.submit_id,
      convergence: { terminal: result.convergence.terminal, queries: result.convergence.queries, read_only: result.convergence.read_only },
      writeback_shapes: result.canvas_writeback?.shapes?.length ?? 0
    }));
  }

  // =================================================================================================
  // 2. a submission that never settles keeps its id and points at read-only reconciliation
  // =================================================================================================
  {
    const script = {
      submit: () => ({ stdout: JSON.stringify({ submit_id: "sub-stuck-0002", gen_status: "querying" }), stderr: "" }),
      query: () => ({ stdout: JSON.stringify({ submit_id: "sub-stuck-0002", gen_status: "querying" }), stderr: "" })
    };
    const cli = makeCli(script);
    const { svc, canvas, outputDir } = await makeService({ repoName: "repo-stuck", adapter: cli.run });
    started.push(svc);
    const result = await svc.canvasDreaminaCliGenerateImage(call({
      canvas_id: canvas.canvas_id,
      generation_type: "image",
      prompt: "regression fixture: unresolved submission",
      model_version: "5.0Pro",
      resolution_type: "2k",
      execute: true,
      accept_credit_spend: true,
      output_dir: outputDir,
      max_queries: 2,
      converge_interval_ms: 1
    }));
    assert.equal(["querying", "submitted"].includes(result.status), true, `an in-flight submission must report its provider state, got ${result.status}`);
    assert.equal(result.submission.submit_id, "sub-stuck-0002", "an unresolved submission must keep its id");
    assert.equal(result.submission.reconcile_required, true);
    assert.equal(result.submission.converged, false);
    const steps = result.submission.reconciliation?.steps ?? [];
    assert.equal(steps.length >= 1, true);
    assert.equal(argvValue(steps[0].argv, "--submit_id"), "sub-stuck-0002");
    assert.equal(result.next_actions.some((line) => line.includes("sub-stuck-0002")), true, JSON.stringify(result.next_actions));
    assert.equal(result.next_actions.some((line) => line.includes("不要重复提交") || line.includes("不要重新提交")), true, JSON.stringify(result.next_actions));
    assert.equal(cli.calls.filter((argv) => argv[0] === "text2image").length, 1, "an unresolved submission must not be re-submitted");
    assert.equal(result.submission.reconciliation.read_only, true);
    console.log(JSON.stringify({
      case: "unresolved_submission",
      status: result.status,
      submit_id: result.submission.submit_id,
      reconcile_required: result.submission.reconcile_required,
      reconcile_argv: steps[0]?.argv ?? null,
      submit_calls: cli.calls.filter((argv) => argv[0] === "text2image").length
    }));
  }

  // =================================================================================================
  // 3. local parameter rejection is NOT a transport failure (and needs no reconciliation)
  // =================================================================================================
  {
    const script = {
      submit: () => ({
        stdout: JSON.stringify({ submit_id: "", gen_status: "fail", fail_reason: "video_resolution 480p requires model_version seedance2.5" }),
        stderr: ""
      }),
      query: () => ({ stdout: JSON.stringify({ submit_id: "sub-unexpected", gen_status: "success" }), stderr: "" })
    };
    const cli = makeCli(script);
    const { svc, canvas, outputDir } = await makeService({ repoName: "repo-reject", adapter: cli.run });
    started.push(svc);
    const result = await svc.canvasDreaminaCliGenerateImage(call({
      canvas_id: canvas.canvas_id,
      generation_type: "image",
      prompt: "regression fixture: local parameter rejection",
      model_version: "5.0Pro",
      resolution_type: "2k",
      execute: true,
      accept_credit_spend: true,
      output_dir: outputDir,
      converge_interval_ms: 1
    }));
    assert.equal(result.status, "fail");
    assert.equal(result.submission.failure_class, "local_rejection");
    assert.equal(result.submission.accepted, false);
    assert.equal(result.submission.reconcile_required, false, "nothing was submitted, so there is nothing to reconcile");
    assert.equal(result.submission.diagnosis.submission_may_have_been_accepted, false);
    assert.equal(cli.calls.filter((argv) => argv[0] === "query_result").length, 0, "a refused submit must not be queried");
    assert.equal(result.next_actions.some((line) => line.includes("不要重新提交")), false);
    console.log(JSON.stringify({
      case: "local_rejection",
      status: result.status,
      failure_class: result.submission.failure_class,
      fail_reason: result.submission.provider_response?.fail_reason ?? null,
      query_calls: cli.calls.filter((argv) => argv[0] === "query_result").length
    }));
  }

  // =================================================================================================
  // 4. transport failure: classified, no submit id invented, read-only reconciliation offered
  // =================================================================================================
  {
    const script = {
      submit: () => {
        const error = new Error("Command failed: dreamina.exe text2image --poll 0");
        error.code = 1;
        error.provider_cli = {
          executable: "dreamina.exe",
          argv: ["text2image", "--poll", "0"],
          exit_code: 1,
          killed: false,
          signal: null,
          timed_out: false,
          stdout: "",
          stderr: "get_history_by_ids failed: ret=1015, msg="
        };
        throw error;
      },
      query: () => ({ stdout: JSON.stringify({ submit_id: "sub-never", gen_status: "success" }), stderr: "" })
    };
    const cli = makeCli(script);
    const { svc, canvas, outputDir } = await makeService({ repoName: "repo-transport", adapter: cli.run });
    started.push(svc);
    let failure = null;
    try {
      await svc.canvasDreaminaCliGenerateImage(call({
        canvas_id: canvas.canvas_id,
        generation_type: "image",
        prompt: "regression fixture: transport failure",
        model_version: "5.0Pro",
        resolution_type: "2k",
        execute: true,
        accept_credit_spend: true,
        output_dir: outputDir,
        converge_interval_ms: 1
      }));
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, "a provider call that fails must still fail");
    assert.equal(failure.code, "GENERATION_CLI_TRANSPORT_FAILURE", `unexpected code: ${failure.code}`);
    assert.equal(failure.details.failure_class, "transport_failure");
    assert.equal(failure.details.reconcile_required, true);
    assert.equal(failure.details.submission_may_have_been_accepted, true);
    assert.equal(failure.details.submit_id, null, "no id may be invented when stdout carried none");
    assert.equal(failure.details.stderr_excerpt.includes("ret=1015"), true);
    const reconcile = failure.details.reconciliation;
    assert.equal(reconcile.read_only, true);
    assert.equal(reconcile.steps.some((step) => step.argv.includes("list_task")), true);
    assert.equal(reconcile.steps.some((step) => step.argv.includes("user_credit")), true);
    assert.equal(reconcile.note.includes("绝不自动重提"), true);
    assert.equal(cli.calls.filter((argv) => argv[0] === "text2image").length, 1);
    console.log(JSON.stringify({
      case: "transport_failure",
      code: failure.code,
      failure_class: failure.details.failure_class,
      submit_id: failure.details.submit_id,
      reconcile_required: failure.details.reconcile_required,
      reconcile_steps: reconcile.steps.map((step) => step.argv.join(" "))
    }));
  }

  // =================================================================================================
  // 5. download hardening (D4): one dropped connection is retried, a hung object is bounded
  // =================================================================================================
  {
    const flaky = flakyFetch();
    const flakyScript = {
      submit: () => ({ stdout: JSON.stringify({ submit_id: "sub-flaky-0003", gen_status: "success", result_json: { images: [{ image_url: "https://provider.invalid/flaky.png" }] } }), stderr: "" }),
      query: () => ({ stdout: JSON.stringify({ submit_id: "sub-flaky-0003", gen_status: "success" }), stderr: "" })
    };
    const flakyCli = makeCli(flakyScript);
    const { svc, canvas, outputDir } = await makeService({ repoName: "repo-flaky", adapter: flakyCli.run, downloadFetchImpl: flaky.impl });
    started.push(svc);
    const recovered = await svc.canvasDreaminaCliGenerateImage(call({
      canvas_id: canvas.canvas_id,
      generation_type: "image",
      prompt: "regression fixture: one dropped download connection",
      model_version: "5.0Pro",
      resolution_type: "2k",
      execute: true,
      accept_credit_spend: true,
      output_dir: outputDir,
      download_timeout_ms: 5000,
      download_attempts: 3,
      converge_interval_ms: 1
    }));
    assert.equal(recovered.status, "success", "a retried download must still deliver the output");
    assert.equal(recovered.downloads.length, 1);
    assert.equal(fs.readFileSync(recovered.downloads[0].file_path).equals(png), true, "the retried download must produce the real bytes");
    assert.equal(flaky.calls.length, 2, `a dropped connection must be retried exactly once (attempts=${flaky.calls.length})`);

    const hungFetch = hangingFetch();
    const hungScript = {
      submit: () => ({ stdout: JSON.stringify({ submit_id: "sub-hung-0004", gen_status: "success", result_json: { images: [{ image_url: "https://provider.invalid/hang.png" }] } }), stderr: "" }),
      query: () => ({ stdout: JSON.stringify({ submit_id: "sub-hung-0004", gen_status: "success" }), stderr: "" })
    };
    const hungCli = makeCli(hungScript);
    const hung = await makeService({ repoName: "repo-hung", adapter: hungCli.run, downloadFetchImpl: hungFetch.impl });
    started.push(hung.svc);
    let downloadFailure = null;
    try {
      await hung.svc.canvasDreaminaCliGenerateImage(call({
        canvas_id: hung.canvas.canvas_id,
        generation_type: "image",
        prompt: "regression fixture: hung object response",
        model_version: "5.0Pro",
        resolution_type: "2k",
        execute: true,
        accept_credit_spend: true,
        output_dir: hung.outputDir,
        download_timeout_ms: 700,
        download_attempts: 2,
        converge_interval_ms: 1
      }));
    } catch (error) {
      downloadFailure = error;
    }
    assert.ok(downloadFailure, "a download that never answers must fail instead of hanging");
    assert.equal(downloadFailure.code, "DREAMINA_DOWNLOAD_FAILED");
    assert.equal(downloadFailure.details.attempts.length, 2, "the attempt list must be bounded and complete");
    assert.equal(downloadFailure.details.timeout_ms, 700);
    assert.equal(downloadFailure.details.attempts.every((item) => String(item.error).includes("aborted") || String(item.error).includes("timeout")), true,
      JSON.stringify(downloadFailure.details.attempts));
    assert.equal(hungFetch.calls.length, 2, "each attempt must be a real request that the timeout had to end");
    assert.equal(hungFetch.calls.every((item) => item.has_signal), true, "the per-attempt timeout must be wired to the request");
    const leftovers = fs.existsSync(hung.outputDir) ? fs.readdirSync(hung.outputDir).filter((name) => name.includes(".part-")) : [];
    assert.deepEqual(leftovers, [], "a partial download must never be left behind as a file that looks usable");

    // ---- adapter download path (queue): the same guarantee through the adapter's own fetch seam ----
    const adapterFlaky = flakyFetch();
    const adapter = createDreaminaCliJobAdapter({
      service: hung.svc,
      executable: "dreamina.exe",
      downloadRoot: path.join(tmp, "adapter-downloads"),
      fetchImpl: adapterFlaky.impl,
      sleep: async () => {},
      logger: quiet,
      fetchAttempts: 3
    });
    const adapterDownload = await adapter.download({
      job_id: "job_fixture_adapter",
      result: { poll: { response: { result_json: { images: [{ image_url: "https://provider.invalid/adapter.png" }] } } } }
    });
    assert.equal(adapterDownload.files.length, 1);
    assert.equal(adapterFlaky.calls.length, 2, "the adapter must retry exactly once after a dropped connection");

    const deadAdapter = createDreaminaCliJobAdapter({
      service: hung.svc,
      executable: "dreamina.exe",
      downloadRoot: path.join(tmp, "adapter-downloads-dead"),
      fetchImpl: async () => ({ ok: false, status: 502, arrayBuffer: async () => Buffer.alloc(0) }),
      sleep: async () => {},
      logger: quiet,
      fetchAttempts: 2
    });
    let adapterFailure = null;
    try {
      await deadAdapter.download({
        job_id: "job_fixture_dead",
        result: { poll: { response: { result_json: { images: [{ image_url: "https://provider.invalid/dead.png" }] } } } }
      });
    } catch (error) {
      adapterFailure = error;
    }
    assert.ok(adapterFailure, "an unreachable provider object must fail the download phase");
    assert.equal(adapterFailure.code, "GENERATION_DOWNLOAD_UNPROVEN");
    assert.equal(adapterFailure.attempts.length, 2);
    assert.equal(String(adapterFailure.message).includes("after 2 attempt(s)"), true, adapterFailure.message);
    console.log(JSON.stringify({
      case: "download_hardening",
      flaky_tool_fetch_calls: flaky.calls.length,
      hung_tool_failure: { code: downloadFailure.code, attempts: downloadFailure.details.attempts.length, timeout_ms: downloadFailure.details.timeout_ms, fetch_calls: hungFetch.calls.length },
      flaky_adapter_fetch_calls: adapterFlaky.calls.length,
      adapter_failure: { code: adapterFailure.code, attempts: adapterFailure.attempts.length }
    }));
  }

  console.log("ren11 tool poll convergence test passed");
} finally {
  for (const svc of started) {
    try { svc.close(); } catch { /* already closed */ }
  }
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
