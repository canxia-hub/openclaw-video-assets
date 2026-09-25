/**
 * REN-11 zero-cost end-to-end acceptance.
 *
 * Runs the SOP-v2 chain in `real_local` mode against an **isolated** VideoAssetService repository,
 * then checks the properties the work package is accepted on:
 *   1. every stage completes and the chain closes brief -> delivery,
 *   2. the persistable outputs are real assets with version/spec/source/rights/provenance/hash,
 *   3. the canvas writeback is real (slot -> generated output shape + project ref),
 *   4. a second run with unchanged inputs skips everything (resume reuses verified products),
 *   5. a tampered artifact re-opens exactly the stage that owns it,
 *   6. a QC failure blocks the deliverable label (negative control, separate run),
 *   7. the production repository is untouched.
 *
 * Usage: node scripts/ren11-sop-v2-e2e-test.mjs [outputRoot]
 */
import assert from "node:assert/strict";
import { resolveAssetRoot, resolveOutputRoot } from "./ren11-paths.mjs";
import fs from "node:fs";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";
import { SopV2Run, SOP_V2_MODES, SOP_V2_STAGES, defaultBrief, hashOf } from "../src/sop-v2-orchestrator.js";

const outputRoot = resolveOutputRoot(process.argv[2] ?? null);

const report = { schema: "ren11.sop-v2.e2e.v1", started_at: new Date().toISOString(), checks: [], facts: {} };
const check = (code, condition, detail) => {
  report.checks.push({ code, ok: condition === true, detail });
  assert.ok(condition === true, `${code}: ${detail}`);
};

// The isolated plugin library (content-addressed objects + SQLite metadata) lives under the project's
// asset bundle path: its blobs *are* the ingested assets. Rendering and run state stay in output/.
/** Recursive fingerprint of a directory tree: files, bytes and the newest mtime. A name-only
 * listing would miss an in-place rewrite of an existing file, which is exactly what "no test asset
 * was written into the production library" has to rule out. */
function treeFingerprint(root) {
  if (!fs.existsSync(root)) return { exists: false };
  let files = 0;
  let bytes = 0;
  let newest = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        const stat = fs.statSync(full);
        files += 1;
        bytes += stat.size;
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      }
    }
  }
  return { exists: true, files, bytes, newest_mtime: new Date(newest).toISOString() };
}

const repoRoot = path.join(resolveAssetRoot(), "asset-repo", "acceptance");
// A clean slate: this is an acceptance run, and it asserts on what a fresh chain produces. The
// crash-resume evidence lives in its own run root and its own library so this test never deletes
// another run's state. The evidence *directory* is kept - the suite log is being written into it by
// the caller - so only this test's own report file is removed.
//
// The library wipe is scoped to THIS test's own repo directory. Removing its parent (the shared
// `asset-repo` root) also destroyed the paid-path / paid-boundaries repos, i.e. the durable half of
// other suites' evidence, while the comment above claimed the opposite.
fs.rmSync(path.join(outputRoot, "runs"), { recursive: true, force: true });
fs.rmSync(path.join(outputRoot, "evidence", "sop-v2-e2e.json"), { force: true });
fs.rmSync(repoRoot, { recursive: true, force: true });
fs.mkdirSync(repoRoot, { recursive: true });
const productionRepo = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".openclaw-video-assets");
const productionBefore = treeFingerprint(productionRepo);

const quiet = { log: () => {}, warn: () => {}, error: console.error, debug: () => {} };
const service = await new VideoAssetService({ pluginConfig: { repositoryRoot: repoRoot }, logger: quiet }).init();

try {
  const brief = defaultBrief();
  const runRoot = path.join(outputRoot, "runs", "e2e-real-local");
  const run = new SopV2Run({
    runRoot,
    service,
    brief,
    mode: SOP_V2_MODES.REAL_LOCAL,
    workRoot: path.join(runRoot, "work"),
    outputRoot: path.join(runRoot, "output"),
    logger: quiet
  });

  const first = await run.run();
  check("ALL_STAGES_EXECUTED", first.executed.length === SOP_V2_STAGES.length,
    `expected ${SOP_V2_STAGES.length} stages, executed ${first.executed.join(",")}`);
  check("STATE_COMPLETED", Object.values(run.state.stages).every((s) => s.status === "completed"), "every stage ends completed");
  check("LABEL_IS_TEST_PREVIEW", run.state.label === "engineering_test_preview", `label=${run.state.label}`);

  const facts = Object.fromEntries(SOP_V2_STAGES.map((stage) => [stage, JSON.parse(fs.readFileSync(run.factsFile(stage), "utf8"))]));
  report.facts.stage_facts = facts;

  // ---- 2. real assets with provenance -------------------------------------------------------
  const imports = facts.artifact_import.imports;
  // The local chain's persisted set is one entry per *role*, and the role set grew when the import
  // stage became source-aware: the master render, one render per shot, and the two preview renders the
  // local generation stage produces. Pinning the count to the roles (not to a stale literal) is what
  // keeps this check about "every persisted product is a real asset" rather than about arithmetic.
  const expectedImportRoles = ["master_render", ...brief.shots.map((shot) => `shot_render_${shot.key}`), ...Object.keys(facts.generation.preview_renders ?? {}).map((role) => `preview_${role}`)];
  check("IMPORTS_ARE_REAL_ASSETS", imports.length === expectedImportRoles.length
    && expectedImportRoles.every((role) => imports.some((item) => item.role === role))
    && imports.every((i) => /^asset_/.test(i.asset_id) && /^ver_/.test(i.asset_version_id)),
  JSON.stringify({ expected: expectedImportRoles, got: imports.map((i) => ({ role: i.role, asset_id: i.asset_id })) }));
  check("IMPORT_REPLAYED_ON_SECOND_LOOKUP", (() => {
    const again = run.findVersionBySha(imports[0].file.sha256);
    return again?.asset_version_id === imports[0].asset_version_id;
  })(), "content hash resolves to the same version (no duplicate asset on re-run)");
  const assetRow = service.getAsset({ asset_id: imports[0].asset_id });
  const versionRow = service.db.prepare("SELECT sha256, size_bytes, width, height, duration_ms, codec FROM asset_versions WHERE asset_version_id = ?").get(imports[0].asset_version_id);
  check("VERSION_CARRIES_HASH_AND_SPEC", versionRow.sha256 === imports[0].file.sha256 && versionRow.width === 1280 && versionRow.height === 720 && versionRow.duration_ms >= 14900,
    JSON.stringify(versionRow));
  check("RIGHTS_RECORDED", assetRow.license_status === "cleared" && assetRow.risk_level === "low", `license=${assetRow.license_status} risk=${assetRow.risk_level}`);
  const classification = service.getClassificationsForAsset(imports[0].asset_id, imports[0].asset_version_id);
  check("CLASSIFICATION_RECORDED", JSON.stringify(classification).includes("engineering_test_preview"), JSON.stringify(classification).slice(0, 200));
  const sourceRows = service.listAssetSources(imports[0].asset_id);
  check("SOURCE_RECORDED", sourceRows.some((row) => row.source_type === "internal_synthetic_fixture"), JSON.stringify(sourceRows));

  // ---- 3. canvas writeback ------------------------------------------------------------------
  const delivery = facts.delivery;
  check("PROJECT_REF_PINNED", delivery.project_ref.pin_mode === "pinned" && delivery.project_ref.role === "delivery_export", JSON.stringify(delivery.project_ref));
  check("WRITEBACK_PER_SHOT", delivery.writebacks.length === 3 && delivery.writebacks.every((w) => w.output_shape_id),
    JSON.stringify(delivery.writebacks));
  const canvasState = service.getCanvas({ canvas_id: delivery.canvas_id });
  const outputShapes = canvasState.shapes.filter((shape) => shape.props?.role === "generated_output");
  check("CANVAS_HOLDS_OUTPUTS", outputShapes.length === 3, `generated output shapes=${outputShapes.length}`);
  const canvasEdgesFromSlots = canvasState.edges.filter((edge) => outputShapes.some((shape) => shape.shape_id === edge.target_shape_id));
  check("CANVAS_EDGES_PRESENT", canvasEdgesFromSlots.length === 3, `edges=${canvasEdgesFromSlots.length}`);
  const deliveryProbe = facts.export.export.probe;
  check("DELIVERY_PROBE", deliveryProbe.video.width === 1280 && deliveryProbe.video.height === 720 && deliveryProbe.audio.codec === "aac" && deliveryProbe.subtitle.codec === "mov_text",
    JSON.stringify(deliveryProbe));
  check("LABEL_NOT_FINAL", delivery.publishable === false && delivery.label === "engineering_test_preview", delivery.publish_blocker);

  // ---- 4. resume skips verified work --------------------------------------------------------
  const second = await run.resume();
  check("RESUME_SKIPS_ALL", second.executed.length === 0 && second.skipped.length === SOP_V2_STAGES.length,
    `executed=${second.executed.join(",") || "none"} skipped=${second.skipped.length}`);

  // ---- 5. tampered artifact re-opens exactly its own stage -----------------------------------
  const audioArtifact = run.state.stages.audio.artifacts.find((a) => a.name === "master-audio.wav");
  const originalBytes = fs.readFileSync(audioArtifact.path);
  fs.writeFileSync(audioArtifact.path, Buffer.concat([originalBytes, Buffer.from([0])]));
  const third = await run.resume();
  // Re-opening the tampered stage invalidates the delivery claim the run had already made, so that
  // stage *and* the delivery stage run again: the tampered stage re-produces its artifact and delivery
  // re-states the claim on top of the repaired chain. Any other stage running here would mean the
  // inputs hash leaked, which is what this check is really about.
  check("TAMPER_REOPENS_ONE_STAGE", third.executed.length >= 1 && third.executed[0] === "audio"
    && third.executed.every((stage) => stage === "audio" || stage === "delivery"),
  `executed=${third.executed.join(",")}`);
  check("TAMPER_REGRAUNTS_THE_DELIVERY_CLAIM", run.state.label === "engineering_test_preview" && Boolean(run.state.deliverable?.sha256)
    && (run.state.deliverable_history ?? []).length >= 1,
  JSON.stringify({ label: run.state.label, deliverable: run.state.deliverable?.sha256?.slice(0, 16) ?? null, history: (run.state.deliverable_history ?? []).length }));
  check("TAMPER_RESTORES_BYTES", fs.readFileSync(audioArtifact.path).equals(originalBytes),
    "the re-run reproduced the same artifact bytes");
  const fourth = await run.resume();
  check("RESUME_STABLE_AGAIN", fourth.executed.length === 0, `executed=${fourth.executed.join(",")}`);

  // ---- 6. QC failure blocks the deliverable label (separate run) -----------------------------
  const negativeRoot = path.join(outputRoot, "runs", "e2e-qc-failure");
  const defective = facts.generation.defective_control.path;
  // The negative-control run walks the same chain (it must: QC consumes the edit stage's timeline),
  // but its QC stage is pointed at the deliberately defective render, so everything downstream of a
  // failed verdict has to refuse. Nothing here is faked by a flag - the file really is broken.
  const negativeRun = new SopV2Run({
    runRoot: negativeRoot,
    service,
    brief,
    mode: SOP_V2_MODES.REAL_LOCAL,
    workRoot: path.join(negativeRoot, "work"),
    outputRoot: path.join(negativeRoot, "output"),
    logger: quiet,
    qcOverrideFile: defective
  });
  const negativeResult = await negativeRun.run().then(() => null).catch((error) => error);
  check("NEGATIVE_RUN_HALTED_AT_EXPORT", negativeResult?.stage === "export" && negativeResult.code === "SOP_V2_QC_FAILED",
    `halted at ${negativeResult?.stage ?? "nothing"} code=${negativeResult?.code ?? "none"}`);
  const negativeQc = JSON.parse(fs.readFileSync(negativeRun.factsFile("qc"), "utf8"));
  check("NEGATIVE_QC_VERDICT_FAIL", negativeQc.verdict === "fail" && negativeQc.override_used === true,
    `verdict=${negativeQc.verdict} failed=${negativeQc.failed_checks.join(",")}`);
  check("NEGATIVE_QC_BLOCKS_LABEL", negativeQc.gate.deliverable_allowed === false && negativeRun.state.label === "withheld" && negativeRun.state.deliverable === null,
    `label=${negativeRun.state.label} deliverable=${JSON.stringify(negativeRun.state.deliverable)}`);
  check("NEGATIVE_DELIVERY_NEVER_RAN", (negativeRun.state.stages.delivery ?? { status: "absent" }).status !== "completed",
    `delivery status=${(negativeRun.state.stages.delivery ?? {}).status ?? "absent"}`);
  report.facts.negative_control = { qc_verdict: negativeQc.verdict, failed_checks: negativeQc.failed_checks, halted_stage: negativeResult?.stage ?? null, label: negativeRun.state.label };

  // ---- 7. dry_run plans only and cannot be laundered into a rendered result --------------------
  const dryRoot = path.join(outputRoot, "runs", "e2e-dry-run");
  const dryRun = new SopV2Run({ runRoot: dryRoot, service, brief, mode: SOP_V2_MODES.DRY_RUN, logger: quiet });
  await dryRun.run({ stages: ["brief_spec", "storyboard_refs", "canvas_gate", "generation"] });
  const dryFacts = JSON.parse(fs.readFileSync(dryRun.factsFile("generation"), "utf8"));
  check("DRY_RUN_PRODUCES_NO_MEDIA", dryFacts.status === "planned_only" && dryFacts.cost.credits_spent === 0,
    JSON.stringify(dryFacts.cost));
  const dryGenerationAssets = dryRun.state.stages.generation.artifacts.filter((a) => /\.(mp4|wav|srt)$/i.test(a.name));
  check("DRY_RUN_HAS_NO_MEDIA_ARTIFACT", dryGenerationAssets.length === 0, JSON.stringify(dryGenerationAssets.map((a) => a.name)));
  const laundered = await dryRun.run({ stages: ["artifact_import"] }).then(() => null).catch((error) => error);
  check("DRY_RUN_CANNOT_IMPORT_AS_MEDIA", laundered?.code === "SOP_V2_MODE_MISMATCH", `artifact_import on a dry run => ${laundered?.code ?? laundered?.message ?? "no error"}`);
  check("DRY_RUN_NO_DELIVERABLE", dryRun.state.deliverable === null && dryRun.state.label === "withheld",
    `label=${dryRun.state.label} deliverable=${JSON.stringify(dryRun.state.deliverable)}`);
  let modeSwitchRefused = false;
  try {
    new SopV2Run({ runRoot: dryRoot, service, brief, mode: SOP_V2_MODES.REAL_LOCAL, logger: quiet });
  } catch (error) {
    modeSwitchRefused = String(error.message).includes("SOP_V2_MODE_MISMATCH");
  }
  check("MODE_SWITCH_REFUSED", modeSwitchRefused, "a dry-run run root cannot be reopened as real_local");

  // ---- 7b. paid_provider without an authorised budget stops at the money gate ------------------
  const paidRoot = path.join(outputRoot, "runs", "e2e-paid-gate");
  const paidRun = new SopV2Run({ runRoot: paidRoot, service, brief, mode: SOP_V2_MODES.PAID_PROVIDER, logger: quiet });
  const paidError = await paidRun.run({ stages: ["generation"] }).then(() => null).catch((error) => error);
  check("PAID_MODE_REFUSED_WITHOUT_BUDGET", paidError?.code === "SOP_V2_PROVIDER_BUDGET_NOT_AUTHORIZED",
    `paid generation without authorisation => ${paidError?.code ?? paidError?.message ?? "no error"}`);
  report.facts.paid_gate = { code: paidError?.code ?? null, stage: paidError?.stage ?? null };

  // ---- 8. production repository untouched ----------------------------------------------------
  // Fingerprint (files/bytes/newest mtime), not a name listing: an in-place rewrite of an existing
  // production file would not change the listing but would change this.
  const productionAfter = treeFingerprint(productionRepo);
  check("PRODUCTION_REPO_UNTOUCHED", JSON.stringify(productionBefore) === JSON.stringify(productionAfter),
    `production repo ${productionRepo} before=${JSON.stringify(productionBefore)} after=${JSON.stringify(productionAfter)}`);
  report.facts.production_repo = { path: productionRepo, before: productionBefore, after: productionAfter };
  report.facts.isolated_library = repoRoot;

  report.facts.run_state_path = run.statePath;
  report.facts.deliverable = run.state.deliverable;
  report.facts.inputs_hash_first_stage = run.state.stages.brief_spec.inputs_hash;
  report.facts.brief_hash = hashOf(brief);
  report.completed_at = new Date().toISOString();
  report.passed = report.checks.every((c) => c.ok);
  const reportPath = path.join(outputRoot, "evidence", "sop-v2-e2e.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, report: reportPath, deliverable: run.state.deliverable }, null, 2));
} finally {
  service.close();
}
