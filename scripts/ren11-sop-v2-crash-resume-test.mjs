/**
 * REN-11 process-interruption recovery test.
 *
 * A worker process is killed with a real `process.exit(9)` (a genuine death, not a caught
 * exception) in two windows, and a *different* process then resumes the same run root:
 *   A. after a stage's artifacts exist but before its completion is recorded,
 *   B. at the very start of a stage, before it produced anything.
 *
 * What must hold afterwards: the interrupted stage re-runs, completed stages are reused, the
 * deliverables come out exactly once (no duplicate asset versions for the same content hash, three
 * canvas outputs - not six), and the run reaches the same end state as an uninterrupted run.
 * Raw worker stdout/stderr is preserved next to the JSON evidence.
 *
 * Usage: node scripts/ren11-sop-v2-crash-resume-test.mjs [outputRoot]
 */
import assert from "node:assert/strict";
import { resolveAssetRoot, resolveOutputRoot } from "./ren11-paths.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VideoAssetService } from "../src/service.js";
import { SopV2Run, SOP_V2_MODES, defaultBrief } from "../src/sop-v2-orchestrator.js";

const outputRoot = resolveOutputRoot(process.argv[2] ?? null);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(scriptDir, "ren11-sop-v2-crash-worker.mjs");

const report = { schema: "ren11.sop-v2.crash-resume.v1", started_at: new Date().toISOString(), scenarios: [], checks: [] };
const check = (code, condition, detail) => {
  report.checks.push({ code, ok: condition === true, detail });
  assert.ok(condition === true, `${code}: ${detail}`);
};

const crashRoot = path.join(outputRoot, "crash");
fs.rmSync(crashRoot, { recursive: true, force: true });
// A separate isolated library: a crash fixture must never be able to leave debris in the library the
// acceptance run reports on.
const repoRoot = path.join(resolveAssetRoot(), "asset-repo", "crash-resume");
fs.rmSync(repoRoot, { recursive: true, force: true });
fs.mkdirSync(repoRoot, { recursive: true });
const evidenceDir = path.join(crashRoot, "logs");
fs.mkdirSync(evidenceDir, { recursive: true });

const quiet = { log: () => {}, warn: () => {}, error: console.error, debug: () => {} };

function runWorker({ runRoot, crashStage, when, snapshotPath, logName }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerPath, outputRoot, runRoot, crashStage, when, snapshotPath], {
      cwd: path.join(scriptDir, ".."),
      env: { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "" },
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (code) => {
      fs.writeFileSync(path.join(evidenceDir, `${logName}.stdout.log`), Buffer.concat(stdout));
      fs.writeFileSync(path.join(evidenceDir, `${logName}.stderr.log`), Buffer.concat(stderr));
      resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

function dbCounts(service) {
  const one = (sql) => service.db.prepare(sql).get().n;
  return {
    assets: one("SELECT COUNT(*) AS n FROM assets"),
    versions: one("SELECT COUNT(*) AS n FROM asset_versions"),
    refs: one("SELECT COUNT(*) AS n FROM project_references"),
    canvases: one("SELECT COUNT(*) AS n FROM canvases"),
    shapes: one("SELECT COUNT(*) AS n FROM canvas_shapes"),
    edges: one("SELECT COUNT(*) AS n FROM canvas_edges")
  };
}

function duplicateContentHashes(service, runId) {
  // Scoped to the run that owns the assets: the same render legitimately recurs across runs (the
  // library dedups the blob by sha256), but one run must not publish two versions of one file.
  const marker = `sop-v2:${runId}%`;
  return service.db.prepare(
    "SELECT av.sha256, COUNT(*) AS n FROM asset_versions av JOIN assets a ON a.asset_id = av.asset_id WHERE a.description LIKE ? GROUP BY av.sha256 HAVING n > 1"
  ).all(marker);
}

function libraryDuplicateContent(service) {
  return service.db.prepare("SELECT sha256, COUNT(*) AS n FROM asset_versions GROUP BY sha256 HAVING n > 1").all();
}

async function scenario({ name, crashStage, when, expectedExecutedAfterResume, verify }) {
  const runRoot = path.join(crashRoot, `run-${name}`);
  fs.mkdirSync(runRoot, { recursive: true });
  // Baseline before this scenario touches anything: the library is shared between scenarios (it is
  // one isolated repository), so "nothing was produced" has to be measured, not assumed.
  const baselineService = await new VideoAssetService({ pluginConfig: { repositoryRoot: repoRoot }, logger: quiet }).init();
  const baseline = dbCounts(baselineService);
  baselineService.close();
  const snapshotPath = path.join(runRoot, "pre-crash-snapshot.json");
  const worker = await runWorker({ runRoot, crashStage, when, snapshotPath, logName: `${name}-worker` });
  check(`${name.toUpperCase()}_WORKER_DIED`, worker.code === 9, `worker exit code=${worker.code} stderr=${worker.stderr.trim().slice(0, 200)}`);
  const preCrash = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  check(`${name.toUpperCase()}_STAGE_NOT_COMPLETED`, preCrash.stages[crashStage]?.status !== "completed",
    `stage ${crashStage} status at crash=${preCrash.stages[crashStage]?.status}`);

  // A different process resumes the same run root.
  const service = await new VideoAssetService({ pluginConfig: { repositoryRoot: repoRoot }, logger: quiet }).init();
  try {
    const run = new SopV2Run({
      runRoot,
      service,
      brief: defaultBrief(),
      mode: SOP_V2_MODES.REAL_LOCAL,
      workRoot: path.join(runRoot, "work"),
      outputRoot: path.join(runRoot, "output"),
      logger: quiet
    });
    const resumed = await run.resume();
    check(`${name.toUpperCase()}_RESUME_RERAN_INTERRUPTED`, resumed.executed.includes(crashStage),
      `executed after resume=${resumed.executed.join(",") || "none"}`);
    check(`${name.toUpperCase()}_RESUME_REUSED_COMPLETED`, resumed.skipped.length > 0,
      `skipped after resume=${resumed.skipped.map((s) => s.stage).join(",")}`);
    check(`${name.toUpperCase()}_ENDED_COMPLETED`, Object.values(run.state.stages).every((s) => s.status === "completed"),
      JSON.stringify(Object.fromEntries(Object.entries(run.state.stages).map(([k, v]) => [k, v.status]))));
    if (expectedExecutedAfterResume) {
      check(`${name.toUpperCase()}_EXECUTED_SET`, expectedExecutedAfterResume.every((stage) => resumed.executed.includes(stage)),
        `executed=${resumed.executed.join(",")}`);
    }
    const finalCounts = dbCounts(service);
    const duplicates = duplicateContentHashes(service, `run-${name}`);
    check(`${name.toUpperCase()}_NO_DUPLICATE_CONTENT`, duplicates.length === 0,
      `asset versions of this run sharing one sha256: ${JSON.stringify(duplicates)}`);
    const canvasState = service.getCanvas({ canvas_id: JSON.parse(fs.readFileSync(run.factsFile("canvas_gate"), "utf8")).canvas_id });
    const generatedOutputs = canvasState.shapes.filter((shape) => shape.props?.role === "generated_output");
    check(`${name.toUpperCase()}_CANVAS_OUTPUTS_ONCE`, generatedOutputs.length === 3,
      `generated output shapes=${generatedOutputs.length}`);
    const refsForDelivery = service.db.prepare("SELECT COUNT(*) AS n FROM project_references WHERE role = 'delivery_export' AND project_id = ?")
      .get(JSON.parse(fs.readFileSync(run.factsFile("canvas_gate"), "utf8")).project_id).n;
    check(`${name.toUpperCase()}_DELIVERY_REF_ONCE`, refsForDelivery === 1, `delivery_export refs for this run's project=${refsForDelivery}`);
    const second = await run.resume();
    check(`${name.toUpperCase()}_STABLE_AFTER_RESUME`, second.executed.length === 0, `executed=${second.executed.join(",")}`);
    const scenarioFact = {
      name,
      crash: { stage: crashStage, when, worker_exit_code: worker.code, worker_stderr: worker.stderr.trim().slice(0, 400) },
      pre_crash: preCrash,
      after_resume: { executed: resumed.executed, skipped: resumed.skipped.map((s) => s.stage), counts: finalCounts, duplicate_hashes: duplicates, library_duplicate_hashes: libraryDuplicateContent(service), canvas_generated_outputs: generatedOutputs.length, delivery_refs: refsForDelivery },
      run_state: run.statePath,
      state_label: run.state.label,
      deliverable: run.state.deliverable
    };
    if (verify) await verify({ service, run, scenarioFact, baseline });
    report.scenarios.push(scenarioFact);
  } finally {
    service.close();
  }
}

await scenario({
  name: "crash-after-edit-artifacts",
  crashStage: "edit",
  when: "after_artifacts",
  expectedExecutedAfterResume: ["edit", "qc", "export", "delivery"],
  verify: async ({ run, scenarioFact }) => {
    // The stage's product existed on disk before the crash, yet the state said "running": resume has
    // to re-run it rather than trusting the file it found. The timeline's name carries the run's own
    // tag (`ren11-<tag>-timeline.mp4`) and the stage writes its facts before the crash hook fires, so
    // the path is read from those facts instead of being guessed from a name that has since changed.
    const editFactsFile = run.factsFile("edit");
    const timeline = fs.existsSync(editFactsFile)
      ? JSON.parse(fs.readFileSync(editFactsFile, "utf8")).timeline.path
      : path.join(run.outputRoot, "media", "edit", "ren11-timeline-15s.mp4");
    // What the snapshot proves is the crash *window*: the state still said "running" with zero recorded
    // artifacts. What this side proves is that the stage's declared product is a real, non-empty file at
    // the path the stage itself reports.
    const timelineFile = fs.existsSync(timeline) ? fs.statSync(timeline) : null;
    check("CRASH_EDIT_ARTIFACT_EXISTED_BUT_UNRECORDED", timelineFile !== null && timelineFile.size > 0
      && scenarioFact.pre_crash.stages.edit.status === "running"
      && (scenarioFact.pre_crash.stages.edit.artifacts ?? []).length === 0,
    `timeline ${timeline} exists=${fs.existsSync(timeline)} bytes=${timelineFile?.size ?? 0} status=${scenarioFact.pre_crash.stages.edit.status} recorded artifacts=${(scenarioFact.pre_crash.stages.edit.artifacts ?? []).length}`);
  }
});

await scenario({
  name: "crash-at-generation-start",
  crashStage: "generation",
  when: "stage_start",
  expectedExecutedAfterResume: ["generation", "artifact_import", "audio", "subtitle", "edit", "qc", "export", "delivery"],
  verify: async ({ scenarioFact, baseline }) => {
    check("CRASH_GENERATION_NOTHING_PRODUCED", scenarioFact.pre_crash.db.assets === baseline.assets,
      `assets before=${baseline.assets} at crash=${scenarioFact.pre_crash.db.assets} (library-wide, shared with the other scenario)`);
  }
});

report.completed_at = new Date().toISOString();
report.passed = report.checks.every((c) => c.ok);
const reportPath = path.join(outputRoot, "evidence", "sop-v2-crash-resume.json");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, report: reportPath, scenarios: report.scenarios.map((s) => ({ name: s.name, exit: s.crash.worker_exit_code, executed: s.after_resume.executed })) }, null, 2));
