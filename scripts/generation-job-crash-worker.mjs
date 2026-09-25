// REN-10 crash worker: runs one generation job until the requested phase has REALLY taken effect,
// writes the evidence the parent needs, and then dies with `process.exit(9)`.
//
// Why a separate process: inside one process, any failure raised by a phase is caught by
// `continuePostSubmit` and persisted as `failed_recoverable`. That is a different state from what a
// hard stop leaves behind, and only the latter is the defect under repair. Killing the process is
// the only way to produce the real leftover row.
//
// Zero cost: the adapter is local, no provider and no network are used.
import fs from "node:fs";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";
import {
  CRASH_EXIT_CODE,
  FIXTURE_NOT_CRASHED_EXIT_CODE,
  call,
  crashFixtureConfig,
  downloadPathFor,
  jobMarker,
  sha256File,
  toolA,
  writeJson
} from "./lib-generation-job-crash-fixture.mjs";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

const repositoryRoot = arg("repo");
const jobId = arg("job");
const phase = arg("phase");
const canvasId = arg("canvas");
const anchorId = arg("anchor");
const sourceFile = arg("source");
const evidencePath = arg("evidence");

if (!repositoryRoot || !jobId || !phase || !canvasId || !anchorId || !sourceFile || !evidencePath) {
  console.error("usage: node generation-job-crash-worker.mjs --repo <root> --job <id> --phase <poll|download|validate|ingest|writeback> --canvas <id> --anchor <shape id> --source <file> --evidence <json>");
  process.exit(2);
}

const counters = { submit: 0, poll: 0, download: 0, validate: 0, ingest: 0, writeback: 0 };
let sideEffect = null;
let service = null;

// Write the evidence BEFORE exiting: the parent must be able to tell "the side effect happened and
// then the process died" from "the phase never ran".
function crash(job) {
  const row = service.db.prepare("SELECT state,phase,failed_phase,error_code,provider_submit_state,provider_request_id,submit_attempts,result_json FROM generation_jobs WHERE job_id=?").get(job.job_id);
  const result = JSON.parse(row.result_json ?? "{}");
  const compensationEvents = service.db.prepare("SELECT COUNT(*) AS n FROM generation_job_events WHERE job_id=? AND event_type IN ('compensation_pending','failed')").get(job.job_id).n;
  writeJson(evidencePath, {
    worker_pid: process.pid,
    job_id: job.job_id,
    crash_phase: phase,
    crash_exit_code: CRASH_EXIT_CODE,
    counters: { ...counters },
    side_effect: sideEffect,
    job_row_at_crash: {
      state: row.state,
      phase: row.phase,
      failed_phase: row.failed_phase,
      error_code: row.error_code,
      provider_submit_state: row.provider_submit_state,
      provider_request_id: row.provider_request_id,
      submit_attempts: row.submit_attempts,
      result_keys: Object.keys(result)
    },
    // 0 proves no in-process failure handler ran: the row was left by a process death, not by
    // `fail(...)`, which would have appended `compensation_pending`.
    in_process_failure_events: compensationEvents,
    side_effect_durable_probe: sideEffect?.file_path ? { file_exists: fs.existsSync(sideEffect.file_path), sha256: sideEffect.sha256 ?? null } : null
  });
  process.exit(CRASH_EXIT_CODE);
}

const adapter = {
  async submit(job) {
    counters.submit += 1;
    return { provider_request_id: `crash_${job.job_id}`, mock: true };
  },
  async poll(job) {
    counters.poll += 1;
    return { status: "completed", actual_credits: 2, mock: true };
  },
  async download(job) {
    counters.download += 1;
    const target = downloadPathFor(repositoryRoot, job.job_id);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(sourceFile, target);
    const value = { file_path: target, sha256: sha256File(target), bytes: fs.statSync(target).size, mock: true };
    sideEffect = value;
    if (phase === "download") crash(job);
    return value;
  },
  async validate(job) {
    counters.validate += 1;
    return { ok: fs.existsSync(job.result.download.file_path), mock: true };
  },
  async ingest(job) {
    counters.ingest += 1;
    const asset = await service.ingestAsset(call({
      file_path: job.result.download.file_path,
      title: jobMarker(job.job_id),
      kind: "working",
      tags: ["ren10", "phase-crash-fixture"]
    }, toolA));
    const value = { asset_id: asset.asset_id, asset_version_id: asset.default_version_id, license_status: asset.license_status, mock: true };
    sideEffect = value;
    if (phase === "ingest") crash(job);
    return value;
  },
  async writeback(job) {
    counters.writeback += 1;
    const shapeId = `shape_job_${job.job_id}`;
    const edgeId = `edge_job_${job.job_id}`;
    service.upsertCanvasShape(call({
      canvas_id: canvasId,
      shape_id: shapeId,
      shape_type: "asset_card",
      subject_type: "asset_version",
      subject_id: job.result.ingest.asset_version_id,
      title: `Crash fixture ${job.job_id}`,
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
    sideEffect = value;
    if (phase === "writeback") crash(job);
    return value;
  }
};

service = new VideoAssetService({ pluginConfig: crashFixtureConfig(repositoryRoot), generationJobAdapter: adapter }).init();
try {
  await service.processGenerationJob(call({ job_id: jobId }, toolA));
} finally {
  service.close();
}
// Reached only when the requested phase never crashed - the fixture did not do its job.
console.error(`fixture did not crash in phase ${phase}`);
process.exit(FIXTURE_NOT_CRASHED_EXIT_CODE);
