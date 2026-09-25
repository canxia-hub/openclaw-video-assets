/**
 * REN-11 fix round: the paid path end-to-end through the REAL queue and REAL service, with a local
 * supplier double at the supplier boundary.
 *
 * Scope note, stated up front because it is the whole point of this file: the previous acceptance run
 * could only show that a synthetic `cliRunner` produced bytes. This test drives the actual
 * `GenerationJobQueue` and the actual `VideoAssetService` (trusted context included) against a local
 * stand-in for the Dreamina CLI, and then measures what the *post-production chain* did with the
 * supplier's media: ingest, canvas writeback, project reference, audio, subtitle, edit, QC, export and
 * delivery. No network, no provider account, no credits.
 *
 * The supplier double is a process-level fake binary invocation: it receives the argv the adapter
 * would send to `dreamina` and answers with fixture JSON/files. It sits at the *supplier* boundary, so
 * everything above it - argv construction, authorization, phases, reconciliation, resume - is real code.
 *
 * Usage: node scripts/ren11-paid-path-e2e-test.mjs [outputRoot]
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";
import { SopV2Run, SOP_V2_MODES, defaultBrief, GATE_CODES } from "../src/sop-v2-orchestrator.js";
import { REN11_FIXTURE_SPEC, REN11_SHOTS, runFfmpeg } from "../src/sop-v2-media.js";
import { resolveAssetRoot, resolveOutputRoot } from "./ren11-paths.mjs";

const outputRoot = resolveOutputRoot(process.argv[2] ?? null);
const workRoot = path.join(outputRoot, "paid-path");
const repoRoot = path.join(resolveAssetRoot(), "asset-repo", "paid-path");
const supplierRoot = path.join(workRoot, "supplier");
fs.rmSync(workRoot, { recursive: true, force: true });
fs.rmSync(repoRoot, { recursive: true, force: true });
fs.mkdirSync(supplierRoot, { recursive: true });
fs.mkdirSync(repoRoot, { recursive: true });

const quiet = { log: () => {}, warn: () => {}, error: console.error, debug: () => {} };
const report = { schema: "ren11.paid-path.e2e.v1", started_at: new Date().toISOString(), checks: [], scenarios: {} };
const check = (code, condition, detail) => {
  report.checks.push({ code, ok: condition === true, detail });
  assert.ok(condition === true, `${code}: ${detail}`);
};

const FFMPEG = process.env.REN11_FFMPEG ?? "ffmpeg";

// ------------------------------------------------------------------------------------------------
// The supplier double
// ------------------------------------------------------------------------------------------------
/**
 * Build the media the "supplier" returns. Shot clips are real encodes made locally with FFmpeg, so the
 * download/validate/conform steps in the real code operate on genuine container files rather than
 * hand-written stubs. One shot is deliberately *shorter* than its declared duration and one is
 * deliberately a different aspect ratio, so the conform step is exercised rather than assumed.
 */
async function buildSupplierMedia() {
  const dir = path.join(supplierRoot, "media");
  fs.mkdirSync(dir, { recursive: true });
  const spec = { ...REN11_FIXTURE_SPEC };
  const clips = [];
  // Three deliberately different supplier outputs:
  //   #1 spec-conform video WITH audio,
  //   #2 short (3s of a 5s shot) AND wrong aspect (640x360),
  //   #3 correct size but SILENT (no audio stream at all).
  const variants = [
    { seconds: 5, size: `${spec.width}x${spec.height}`, audio: true },
    { seconds: 3, size: "640x360", audio: true },
    { seconds: 5, size: `${spec.width}x${spec.height}`, audio: false }
  ];
  for (const [index, shot] of REN11_SHOTS.entries()) {
    const variant = variants[index];
    const target = path.join(dir, `${shot.key}-provider.mp4`);
    const colour = String(shot.background).replace("0x", "");
    const args = ["-y", "-f", "lavfi", "-i", `color=c=0x${colour}:s=${variant.size}:d=${variant.seconds}:r=${spec.fps}`];
    if (variant.audio) args.push("-f", "lavfi", "-i", `sine=frequency=${shot.tone_hz}:duration=${variant.seconds}:sample_rate=${spec.audio_sample_rate}`);
    const result = await runFfmpeg([
      ...args,
      "-map", "0:v:0", ...(variant.audio ? ["-map", "1:a:0", "-c:a", "aac", "-b:a", "128k"] : []),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", spec.pix_fmt, "-t", String(variant.seconds),
      path.basename(target)
    ], { cwd: dir, ffmpegPath: FFMPEG, timeoutMs: 300000 });
    if (result.code !== 0) throw new Error(`supplier clip build failed: ${result.stderr.slice(-600)}`);
    clips.push({ shot_key: shot.key, path: target, seconds: variant.seconds, size: variant.size, audio: variant.audio });
  }
  // An image result for the media-kind validation scenario (a PNG has no audio stream by nature).
  const imagePath = path.join(dir, "provider-still.png");
  const imageResult = await runFfmpeg(["-y", "-f", "lavfi", "-i", `color=c=0x203040:s=512x512:d=1`, "-frames:v", "1", path.basename(imagePath)], { cwd: dir, ffmpegPath: FFMPEG });
  if (imageResult.code !== 0) throw new Error(`supplier image build failed: ${imageResult.stderr.slice(-600)}`);
  // A silent video for the "declared no audio" scenario.
  const silentPath = path.join(dir, "provider-silent.mp4");
  const silentResult = await runFfmpeg(["-y", "-f", "lavfi", "-i", `color=c=0x303030:s=${spec.width}x${spec.height}:d=2:r=${spec.fps}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", spec.pix_fmt, "-an", path.basename(silentPath)], { cwd: dir, ffmpegPath: FFMPEG });
  if (silentResult.code !== 0) throw new Error(`supplier silent clip build failed: ${silentResult.stderr.slice(-600)}`);
  return { clips, imagePath, silentPath };
}

/**
 * The supplier double itself: a CLI-shaped function that answers the argv the real adapter builds.
 * Every invocation is recorded, which is what lets the test prove *how many* provider calls a job made
 * and that a resumed run did not submit twice.
 */
function createSupplier({ clips, behaviours = {} }) {
  const calls = [];
  const state = { submits: 0, queries: 0, credits: 1000, queryAnswers: [], failQueryTimes: behaviours.failQueryTimes ?? 0, alwaysQueryPending: behaviours.alwaysQueryPending === true };
  const cli = async ({ argv, args }) => {
    const command = args[0];
    calls.push({ command, argv, args });
    if (command === "user_credit") {
      return { stdout: JSON.stringify({ credit: state.credits }), stderr: "" };
    }
    if (command === "text2image" || command === "image2image" || command === "text2video" || command === "image2video" || command === "multimodal2video") {
      state.submits += 1;
      const submitId = `fake-submit-${state.submits}`;
      // Spend credits so the preflight/recheck delta is a measured figure.
      state.credits -= behaviours.creditsSpent ?? 5;
      const clip = clips[state.submits - 1] ?? clips[0];
      const payload = {
        submit_id: submitId,
        gen_status: behaviours.submitStatus ?? "queued",
        // The supplier double reports a LOCAL output path, which is what the adapter's
        // `cli_local_path` branch exists for. A URL would send the run into the network download path,
        // and this test must not need the network.
        videos: [{ path: clip.path, width: 1280, height: 720 }]
      };
      fs.writeFileSync(path.join(supplierRoot, `${submitId}.json`), JSON.stringify(payload, null, 2), "utf8");
      return { stdout: JSON.stringify(payload), stderr: "" };
    }
    if (command === "query_result") {
      state.queries += 1;
      if (state.failQueryTimes > 0) {
        state.failQueryTimes -= 1;
        const error = new Error("supplier double: transient query failure");
        error.code = "GENERATION_PROVIDER_CLI_FAILED";
        throw error;
      }
      const submitId = String(args[1] ?? "").replace("--submit_id=", "");
      if (state.alwaysQueryPending) return { stdout: JSON.stringify({ submit_id: submitId, gen_status: "queued" }), stderr: "" };
      const stored = JSON.parse(fs.readFileSync(path.join(supplierRoot, `${submitId}.json`), "utf8"));
      return { stdout: JSON.stringify({ ...stored, gen_status: "success", credit_count: behaviours.creditCount ?? 5 }), stderr: "" };
    }
    throw new Error(`supplier double received an unexpected command: ${command}`);
  };
  return { cli, calls, state };
}

/**
 * Wire the supplier double to the REAL service. Two distinct seams, and the test uses both:
 *   * `providerAdapters` replaces the gateway's Dreamina adapter (the service's other provider
 *     adapters stay real), so `beginGeneration` / `callProvider` / `finishGeneration` are executed;
 *   * that adapter ignores argv[0]-less args and simply delegates to the supplier CLI double.
 */
function createServiceForPaidRun({ adapter }) {
  return new VideoAssetService({
    pluginConfig: {
      repositoryRoot: repoRoot,
      generationJobs: { enabled: true, maxCredits: 1000, maxConcurrent: 1, allowedActors: ["agent:tuan"] },
      security: {
        generation: {
          allowSurfaces: ["tool"],
          allowActors: ["agent:tuan"],
          ledger: "memory",
          budget: { totalCredits: 1000, estimates: { "dreamina.video.generate": 5, "dreamina.image.generate": 2 } }
        }
      }
    },
    providerAdapters: {
      dreamina_cli: ({ argv }) => adapter.supplier.cli({ argv, args: argv })
      },
    logger: quiet
  });
}

const media = await buildSupplierMedia();
// A trusted caller context in the real Symbol-carrying form: plain object properties would not be read
// by the queue, which is exactly why the orchestrator takes it as an object and applies the seam itself.
const trustedContext = { trusted: true, surface: "tool", actor_id: "agent:tuan", actor_type: "agent", scopes: ["operator.read", "operator.write"] };

// The adapter is constructed after the service because the service owns the gateway it authorizes
// through. `service` is injected here exactly as `src/index.js` does it.
const supplier = createSupplier({ clips: media.clips });
const service = await createServiceForPaidRun({ adapter: { supplier } }).init();
const { DreaminaCliJobAdapter } = await import("../src/dreamina-cli-job-adapter.js");
service.setGenerationJobAdapter(new DreaminaCliJobAdapter({
  service,
  downloadRoot: path.join(repoRoot, "asset-repo", "staging", "provider-downloads"),
  pollIntervalMs: 5,
  pollTimeoutMs: 2000,
  logger: quiet
}));

const brief = {
  ...defaultBrief(),
  provider_budget: {
    authorized: true,
    max_credits: 60,
    estimate_credits: 5,
    entry: "dreamina.video.generate",
    provider: "dreamina_cli",
    trusted_context: trustedContext,
    // `require_audio: false` is a DECLARED policy, not a way to wave a missing track through: the
    // supplier may return a silent clip, the conform step inserts silence for it, and the per-shot
    // `audio_source` in the facts records which shots are provider audio and which are not.
    request: { generation_type: "image2video", model_version: "seedance2.0fast", video_resolution: "720p", prompt: "本地供应商替身", cli_poll_seconds: 0, require_audio: false }
  }
};

const runRoot = path.join(workRoot, "run");

try {
  // ---- 1. provider media validation: the four cases that must be distinguished -------------------
  const adapter = service.generationJobAdapter;
  // The real prober is captured here and restored after the scenario: leaving a fake prober installed
  // would silently change what the paid run validates (it did exactly that on the first attempt).
  const realProber = adapter.prober;
  const pngProbe = async () => ({ streams: [{ codec_type: "video", codec_name: "png", width: 512, height: 512, nb_frames: "1" }], format: { duration: "1" } });
  const videoProbe = async () => ({ streams: [{ codec_type: "video", codec_name: "h264", width: 1280, height: 720 }, { codec_type: "audio", codec_name: "aac" }], format: { duration: "5" } });
  const silentProbe = async () => ({ streams: [{ codec_type: "video", codec_name: "h264", width: 1280, height: 720 }], format: { duration: "2" } });

  {
    const files = [{ path: media.imagePath, sha256: "sha-image" }];
    adapter.prober = pngProbe;
    const imageJob = { job_id: "job-image", entry: "dreamina.image.generate", request: { generation_type: "image" }, result: { download: { files } } };
    const result = await adapter.validate(imageJob);
    check("IMAGE_RESULT_ACCEPTED", result.media_kind === "image" && result.audio_required === false, JSON.stringify({ kind: result.media_kind, audio_required: result.audio_required }));
    check("IMAGE_VALIDATION_REPORTS_STREAMS", result.checks[0].streams.still === 1 && result.checks[0].streams.audio === 0, JSON.stringify(result.checks[0].streams));

    const wrongKind = { ...imageJob, entry: "dreamina.video.generate", request: { generation_type: "image2video" } };
    adapter.prober = pngProbe;
    let kindError = null;
    try { await adapter.validate(wrongKind); } catch (error) { kindError = error; }
    check("STILL_REJECTED_AS_VIDEO", kindError?.code === "GENERATION_MEDIA_VALIDATION_FAILED" && /still image/.test(kindError.message), kindError?.message ?? "no error");

    adapter.prober = videoProbe;
    const videoJob = { job_id: "job-video", entry: "dreamina.video.generate", request: { generation_type: "image2video" }, result: { download: { files: [{ path: media.clips[0].path, sha256: "sha-video" }] } } };
    const videoResult = await adapter.validate(videoJob);
    check("VIDEO_RESULT_ACCEPTED_WITH_AUDIO", videoResult.media_kind === "video" && videoResult.audio_required === true, JSON.stringify({ kind: videoResult.media_kind, audio_required: videoResult.audio_required }));

    adapter.prober = silentProbe;
    let audioError = null;
    try { await adapter.validate(videoJob); } catch (error) { audioError = error; }
    check("DECLARED_AUDIO_MISSING_IS_REJECTED", audioError?.code === "GENERATION_MEDIA_VALIDATION_FAILED" && /no audio stream/.test(audioError.message), audioError?.message ?? "no error");
    const optOut = await adapter.validate({ ...videoJob, request: { generation_type: "image2video", require_audio: false } });
    check("AUDIO_OPT_OUT_ACCEPTS_SILENT_VIDEO", optOut.audio_required === false, JSON.stringify(optOut.audio_required));

    // Same rule against a REAL file (not a fake prober): the supplier's third clip was encoded without
    // an audio stream, so a strict request must refuse it and a permissive one must accept it.
    adapter.prober = realProber;
    let realAudioError = null;
    try { await adapter.validate({ ...videoJob, result: { download: { files: [{ path: media.clips[2].path, sha256: "sha-silent" }] } } }); } catch (error) { realAudioError = error; }
    check("REAL_SILENT_CLIP_REFUSED_WHEN_AUDIO_REQUIRED", realAudioError?.code === "GENERATION_MEDIA_VALIDATION_FAILED", realAudioError?.message ?? "no error");
    const realOptOut = await adapter.validate({ ...videoJob, request: { generation_type: "image2video", require_audio: false }, result: { download: { files: [{ path: media.clips[2].path, sha256: "sha-silent" }] } } });
    check("REAL_SILENT_CLIP_ACCEPTED_WHEN_DECLARED", realOptOut.audio_required === false, JSON.stringify(realOptOut.audio_required));
    adapter.prober = realProber;
  }
  report.scenarios.media_validation = report.checks.slice(-5);

  // ---- 2. real queue + real service: argv shape, one submit, measured credits --------------------
  {
    const argsFor = (job) => adapter.buildArgv(job);
    const argv = argsFor({ request: brief.provider_budget.request, job_id: "job-argv" });
    check("ARGV_CARRIES_NO_EXECUTABLE", !argv.some((item) => /dreamina(\.exe)?$/i.test(item)), JSON.stringify(argv.slice(0, 3)));
    check("ARGV_STARTS_WITH_SUBCOMMAND", argv[0] === "image2video", argv[0]);
    check("ARGV_IS_ASYNC_BY_DEFAULT", argv[argv.indexOf("--poll") + 1] === "0", `poll=${argv[argv.indexOf("--poll") + 1]}`);
  }

  const run = new SopV2Run({
    runRoot,
    service,
    brief,
    mode: SOP_V2_MODES.PAID_PROVIDER,
    workRoot: path.join(runRoot, "work"),
    outputRoot: path.join(runRoot, "output"),
    logger: quiet
  });
  const canvasStage = await run.run({ stages: ["brief_spec", "storyboard_refs", "canvas_gate"] });
  check("CANVAS_GATE_READY_BEFORE_PAID_RUN", canvasStage.executed.includes("canvas_gate"), canvasStage.executed.join(","));

  const generation = await run.run({ stages: ["generation"] });
  const generationFacts = JSON.parse(fs.readFileSync(run.factsFile("generation"), "utf8"));
  check("PROVIDER_SOURCE_RECORDED", generationFacts.source === "provider_job", generationFacts.source);
  check("NO_JOB_LEFT_NOT_COMPLETED", generationFacts.provider_jobs.every((job) => job.state === "completed"), JSON.stringify(generationFacts.provider_jobs.map((job) => job.state)));
  check("ONE_SUBMIT_PER_SHOT", supplier.state.submits === brief.shots.length, `submits=${supplier.state.submits} shots=${brief.shots.length}`);
  check("PROJECT_AND_CANVAS_BOUND_TO_JOBS", generationFacts.provider_jobs.every((job) => job.job_id) && Boolean(generationFacts.canvas_id) && Boolean(generationFacts.project_id),
    JSON.stringify({ canvas: generationFacts.canvas_id, project: generationFacts.project_id }));
  check("CREDITS_MEASURED_NOT_ESTIMATED", generationFacts.credits.measured_total === 15 && generationFacts.credits.evidence === "credit_delta",
    JSON.stringify(generationFacts.credits));
  check("CREDITS_KEEP_ESTIMATE_SEPARATE", generationFacts.credits.estimated_total === 15 && generationFacts.credits.measured_total !== null, JSON.stringify(generationFacts.credits));

  // The queue's own accounting must say the same thing.
  const jobRow = service.db.prepare("SELECT actual_credits FROM generation_jobs WHERE job_id = ?").get(generationFacts.provider_jobs[0].job_id);
  check("QUEUE_ACTUAL_CREDITS_MEASURED", jobRow.actual_credits === 5, JSON.stringify(jobRow));
  const ledger = service.db.prepare("SELECT actual_credits FROM generation_budget_ledger WHERE job_id = ?").get(generationFacts.provider_jobs[0].job_id);
  check("LEDGER_ACTUAL_CREDITS_MEASURED", ledger.actual_credits === 5, JSON.stringify(ledger));

  // Normalization really happened on supplier media.
  const conformed = generationFacts.shots.map((shot) => shot.file);
  check("SHOT_MEDIA_CONFORMED_TO_SPEC", conformed.every((file) => file.probe.video.width === REN11_FIXTURE_SPEC.width && file.probe.video.height === REN11_FIXTURE_SPEC.height),
    JSON.stringify(conformed.map((file) => ({ w: file.probe.video.width, src: file.scale_pad.source }))));
  check("SHORT_SHOT_PADDED_AND_DECLARED", conformed[1].duration_padded_seconds > 1.5 && conformed[1].scale_pad.source === "640x360",
    JSON.stringify({ padded: conformed[1].duration_padded_seconds, source: conformed[1].scale_pad.source }));
  check("SILENT_SHOT_AUDIO_PROVENANCE_DECLARED", conformed[2].audio_source === "synthesized_silence" && conformed[0].audio_source === "provider",
    JSON.stringify(conformed.map((file) => file.audio_source)));

  // ---- 3. resume must not resubmit ---------------------------------------------------------------
  const beforeResume = supplier.state.submits;
  const resumed = await run.run({ stages: ["generation"], force: true });
  const afterResumeFacts = JSON.parse(fs.readFileSync(run.factsFile("generation"), "utf8"));
  check("RESUME_REUSES_COMPLETED_JOBS", supplier.state.submits === beforeResume, `submits before=${beforeResume} after=${supplier.state.submits}`);
  check("RESUMED_FACTS_MARK_REUSE", afterResumeFacts.provider_jobs.every((job) => job.reused === true), JSON.stringify(afterResumeFacts.provider_jobs.map((job) => job.reused)));

  // ---- 4. post-production chain on provider media ------------------------------------------------
  const rest = await run.run({ stages: ["artifact_import", "audio", "subtitle", "edit", "qc", "export", "delivery"] });
  const importFacts = JSON.parse(fs.readFileSync(run.factsFile("artifact_import"), "utf8"));
  check("PROVIDER_MEDIA_IMPORTED", importFacts.source === "provider_job" && importFacts.imports.length >= 4, JSON.stringify({ source: importFacts.source, imports: importFacts.imports.length }));
  check("PROVIDER_IMPORT_RIGHTS_UNKNOWN", importFacts.provenance.license_status === "unknown" && importFacts.provenance.risk_level === "unknown", JSON.stringify(importFacts.provenance));
  check("QUEUE_INGEST_NOT_DUPLICATED", importFacts.provider_originals.length === brief.shots.length && importFacts.provider_originals.every((item) => item.reused_from_queue_ingest === true),
    JSON.stringify(importFacts.provider_originals.map((item) => item.asset_id)));

  const audioFacts = JSON.parse(fs.readFileSync(run.factsFile("audio"), "utf8"));
  check("AUDIO_STAGE_MEASURED_NOT_FIXTURE_ASSERTED", audioFacts.tone_check === "not_applicable" && audioFacts.loudness.measured === true, JSON.stringify({ tone_check: audioFacts.tone_check, measured: audioFacts.loudness.measured }));
  const subtitleFacts = JSON.parse(fs.readFileSync(run.factsFile("subtitle"), "utf8"));
  check("SUBTITLE_PLAN_FROM_BRIEF", subtitleFacts.cues.length === brief.shots.length && subtitleFacts.cues_inside_their_shot === true && subtitleFacts.srt_round_trip === true,
    JSON.stringify({ cues: subtitleFacts.cues.length, inside: subtitleFacts.cues_inside_their_shot, round_trip: subtitleFacts.srt_round_trip }));
  const editFacts = JSON.parse(fs.readFileSync(run.factsFile("edit"), "utf8"));
  check("SUBTITLES_REACH_THE_CONTAINER", editFacts.container_readback_matches === true && editFacts.subtitle_stream_present === true, JSON.stringify({ readback: editFacts.container_readback_matches, stream: editFacts.subtitle_stream_present }));
  const qcFacts = JSON.parse(fs.readFileSync(run.factsFile("qc"), "utf8"));
  check("QC_PASSES_ON_PROVIDER_TIMELINE", qcFacts.verdict === "pass" && qcFacts.negative_control_detected === true, JSON.stringify({ verdict: qcFacts.verdict, negative: qcFacts.negative_control_detected }));
  check("QC_BUILT_ITS_OWN_NEGATIVE_CONTROL", qcFacts.burn_in_instrumentation.built_by_stage === "qc" && qcFacts.negative_control.instrument === "local_qc_negative_control",
    JSON.stringify(qcFacts.negative_control));
  const deliveryFacts = JSON.parse(fs.readFileSync(run.factsFile("delivery"), "utf8"));
  check("DELIVERY_LABEL_IS_PROVIDER_PREVIEW", deliveryFacts.label === "provider_generated_preview" && deliveryFacts.publishable === false, JSON.stringify({ label: deliveryFacts.label, publishable: deliveryFacts.publishable }));
  check("DELIVERY_REF_AND_WRITEBACKS", deliveryFacts.writebacks.length === brief.shots.length && Boolean(deliveryFacts.project_ref.reference_id), JSON.stringify({ writebacks: deliveryFacts.writebacks.length }));
  check("RUN_ENDED_DELIVERED", run.state.label === "provider_generated_preview" && Boolean(run.state.deliverable?.sha256), JSON.stringify({ label: run.state.label, deliverable: run.state.deliverable?.asset_id ?? null }));
  report.scenarios.paid_chain = { executed: rest.executed, deliverable: run.state.deliverable };

  console.log(JSON.stringify({ passed: report.checks.every((item) => item.ok), checks: report.checks.length, scenarios: Object.keys(report.scenarios) }, null, 2));
} finally {
  service.close();
}

report.completed_at = new Date().toISOString();
report.passed = report.checks.every((item) => item.ok);
const reportPath = path.join(outputRoot, "evidence", "paid-path-e2e.json");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`paid-path e2e: ${report.passed ? "PASS" : "FAIL"} (${report.checks.length} checks) -> ${reportPath}`);
