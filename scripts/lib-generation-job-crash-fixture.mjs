// REN-10 phase-interrupt crash fixture - shared by the crashing worker and the restarting driver.
//
// The point of this fixture is FIDELITY: the interrupted phase's real side effect is performed by a
// separate child process which then dies with `process.exit(9)`. Nothing catches the error, no
// cleanup runs, and the parent process never observes an exception from the job queue. That is what
// distinguishes this fixture from the in-process fault injection in
// `generation-job-lifecycle-test.mjs`, where the side effect completes and the failure is caught and
// persisted by the running process (`fail(...)` -> `failed_recoverable`).
//
// Everything here is local and zero-cost: no provider is contacted, no credits are spent.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withTrustedContext } from "../src/provider-gateway.js";

// A genuinely hard process death: a value no `catch` block in the queue can intercept.
export const CRASH_EXIT_CODE = 9;
// Returned when the worker survived to the end of `processGenerationJob`, i.e. the fixture did not
// crash where it was asked to. The driver treats this as a failed fixture rather than a pass.
export const FIXTURE_NOT_CRASHED_EXIT_CODE = 11;

export const toolA = { trusted: true, actor_id: "agent:a", actor_type: "agent", surface: "tool", scopes: ["operator.read", "operator.write"] };
export const call = (input, context) => withTrustedContext(input, context);

export function crashFixtureConfig(repositoryRoot) {
  return {
    repositoryRoot,
    generationJobs: {
      enabled: true,
      maxCredits: 5000,
      maxConcurrent: 1,
      allowedActors: ["agent:a"],
      allowedSurfaces: ["tool", "ui", "browser", "gateway"]
    }
  };
}

// The download phase's side effect is a real file on disk, so its recovery probe is a real fs check
// instead of a value kept in memory by the process that died.
export function downloadPathFor(repositoryRoot, jobId) {
  return path.join(repositoryRoot, "asset-repo", "staging", "generation-downloads", `${jobId}.mp4`);
}

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Stable, per-job ingest title, so a duplicate ingest would be visible as a second asset row.
export function jobMarker(jobId) {
  return `ren10-phase-crash ${jobId}`;
}

export function sqlitePath(repositoryRoot) {
  return path.join(repositoryRoot, "metadata", "video-assets.sqlite");
}

const STATE_BY_PHASE = Object.freeze({
  poll: "running",
  download: "downloading",
  validate: "validating",
  ingest: "ingesting",
  writeback: "writing_back"
});

export function interruptedStateForPhase(phase) {
  return STATE_BY_PHASE[phase] ?? null;
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
