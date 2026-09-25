/**
 * REN-11 crash worker: runs the SOP-v2 chain in a *separate process* and dies at a chosen point.
 *
 * Usage:
 *   node scripts/ren11-sop-v2-crash-worker.mjs <outputRoot> <runRoot> <crashStage> <when> [snapshotPath]
 *   when: after_artifacts | stage_start
 *
 * `after_artifacts` is the interesting window: the stage's side effects and files already exist, but
 * the run state has not recorded completion yet. Resume must therefore re-run that stage, and the
 * surrounding asset/canvas state must come out exactly once - not twice.
 */
import fs from "node:fs";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";
import { SopV2Run, SOP_V2_MODES, defaultBrief } from "../src/sop-v2-orchestrator.js";
import { resolveAssetRoot } from "./ren11-paths.mjs";

const [outputRoot, runRoot, crashStage, when, snapshotPath] = process.argv.slice(2);
if (!outputRoot || !runRoot || !crashStage || !when) {
  throw new Error("usage: node scripts/ren11-sop-v2-crash-worker.mjs <outputRoot> <runRoot> <crashStage> <when> [snapshotPath]");
}

const quiet = { log: () => {}, warn: () => {}, error: console.error, debug: () => {} };
// Same isolated library the parent resumes against: the run root is passed in, but the library has a
// single owner (the acceptance harness), never the worker's own guess.
const repoRoot = path.join(resolveAssetRoot(), "asset-repo", "crash-resume");
fs.mkdirSync(repoRoot, { recursive: true });

function snapshot(label) {
  const service = new VideoAssetService({ pluginConfig: { repositoryRoot: repoRoot }, logger: quiet }).init();
  try {
    const rows = service.db.prepare("SELECT COUNT(*) AS n FROM assets").get().n;
    const versions = service.db.prepare("SELECT COUNT(*) AS n FROM asset_versions").get().n;
    const refs = service.db.prepare("SELECT COUNT(*) AS n FROM project_references").get().n;
    const canvases = service.db.prepare("SELECT COUNT(*) AS n FROM canvases").get().n;
    const shapes = service.db.prepare("SELECT COUNT(*) AS n FROM canvas_shapes").get().n;
    const edges = service.db.prepare("SELECT COUNT(*) AS n FROM canvas_edges").get().n;
    const state = JSON.parse(fs.readFileSync(path.join(runRoot, "state.json"), "utf8"));
    return {
      label,
      at: new Date().toISOString(),
      pid: process.pid,
      db: { assets: rows, asset_versions: versions, project_references: refs, canvases, canvas_shapes: shapes, canvas_edges: edges },
      stages: Object.fromEntries(Object.entries(state.stages).map(([stage, record]) => [stage, {
        status: record.status,
        attempts: record.attempts ?? 0,
        artifacts: (record.artifacts ?? []).map((a) => ({ name: a.name, sha256: a.sha256 }))
      }])),
      label_state: state.label,
      deliverable: state.deliverable
    };
  } finally {
    service.close();
  }
}

const hooks = {};
if (when === "after_artifacts") {
  hooks.onArtifactsWritten = ({ stage }) => {
    if (stage !== crashStage) return;
    const fact = snapshot(`pre-crash:${stage}:after_artifacts`);
    if (snapshotPath) fs.writeFileSync(snapshotPath, `${JSON.stringify(fact, null, 2)}\n`, "utf8");
    process.stderr.write(`[worker] hard exit(9) after artifacts of stage=${stage} (state not yet marked completed)\n`);
    process.exit(9);
  };
} else if (when === "stage_start") {
  hooks.onStageStart = ({ stage }) => {
    if (stage !== crashStage) return;
    const fact = snapshot(`pre-crash:${stage}:stage_start`);
    if (snapshotPath) fs.writeFileSync(snapshotPath, `${JSON.stringify(fact, null, 2)}\n`, "utf8");
    process.stderr.write(`[worker] hard exit(9) at the start of stage=${stage}\n`);
    process.exit(9);
  };
} else {
  throw new Error(`unknown crash timing: ${when}`);
}

const service = await new VideoAssetService({ pluginConfig: { repositoryRoot: repoRoot }, logger: quiet }).init();
try {
  const run = new SopV2Run({
    runRoot,
    service,
    brief: defaultBrief(),
    mode: SOP_V2_MODES.REAL_LOCAL,
    workRoot: path.join(runRoot, "work"),
    outputRoot: path.join(runRoot, "output"),
    logger: quiet,
    hooks
  });
  const result = await run.run();
  process.stdout.write(`${JSON.stringify({ worker: "completed", executed: result.executed, skipped: result.skipped.map((s) => s.stage) })}\n`);
  const fact = snapshot("post-run");
  if (snapshotPath) fs.writeFileSync(snapshotPath.replace(/\.json$/, "-post.json"), `${JSON.stringify(fact, null, 2)}\n`, "utf8");
} finally {
  service.close();
}
