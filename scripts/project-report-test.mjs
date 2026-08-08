import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";
import { getObjectPath } from "../src/storage.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-report-"));
const repo = path.join(tmp, "repo");
const sourceA = path.join(tmp, "a.txt");
const sourceB = path.join(tmp, "b.txt");
const sourceC = path.join(tmp, "c.txt");
await fs.promises.writeFile(sourceA, "asset A", "utf8");
await fs.promises.writeFile(sourceB, "asset B", "utf8");
await fs.promises.writeFile(sourceC, "asset C", "utf8");

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const assetA = await svc.ingestAsset({ file_path: sourceA, title: "A" });
  const assetB = await svc.ingestAsset({ file_path: sourceB, title: "B" });
  const assetC = await svc.ingestAsset({ file_path: sourceC, title: "C" });
  const project = svc.createProject({ title: "Report Matrix" });
  const now = new Date().toISOString();

  for (const asset of [assetA, assetB, assetC]) {
    const rights = svc.updateAssetRights({
      asset_id: asset.asset_id,
      license_status: "cleared",
      risk_level: "low",
      source: {
        source_type: "fixture",
        original_author: "OpenClaw test fixture",
        license_hint: "internal test fixture",
        retrieval_method: "generated",
        notes: "Generated inside project-report-test.mjs"
      },
      notes: "Clear fixture rights for report matrix"
    });
    assert.equal(rights.asset.license_status, "cleared");
    assert.equal(rights.sources.at(-1).license_hint, "internal test fixture");
  }

  svc.addProjectRef({ project_id: project.project_id, asset_id: assetA.asset_id, asset_version_id: assetA.default_version_id, pin_mode: "follow_latest", role: "source" });
  svc.addProjectRef({ project_id: project.project_id, asset_id: assetB.asset_id, asset_version_id: assetB.default_version_id, pin_mode: "candidate", role: "source" });

  const licenseAsset = await svc.ingestAsset({ file_path: sourceA, title: "License Unknown" });
  svc.addProjectRef({ project_id: project.project_id, asset_id: licenseAsset.asset_id, asset_version_id: licenseAsset.default_version_id, role: "reference" });

  // Deliberately corrupt legacy rows to verify report diagnostics. Service APIs now reject these.
  svc.db.prepare("PRAGMA foreign_keys = OFF").run();
  insertRef({ reference_id: "ref_missing_version", asset_id: assetA.asset_id, asset_version_id: "ver_missing", required: 1 });
  insertRef({ reference_id: "ref_mismatch", asset_id: assetA.asset_id, asset_version_id: assetB.default_version_id, required: 1 });

  const versionC = svc.getVersionRow(assetC.default_version_id);
  await fs.promises.rm(getObjectPath(svc.root, versionC.object_id), { force: true });
  insertRef({ reference_id: "ref_missing_object", asset_id: assetC.asset_id, asset_version_id: assetC.default_version_id, required: 1 });
  insertRef({ reference_id: "ref_optional_missing_version", asset_id: assetA.asset_id, asset_version_id: "ver_optional_missing", required: 0 });

  const report = svc.projectReport({ project_id: project.project_id });
  const codes = report.issues.map((issue) => `${issue.level}:${issue.code}:${issue.reference_id}`);

  assert.ok(codes.some((code) => code.startsWith("warning:FOLLOW_LATEST:")), codes.join("\n"));
  assert.ok(codes.some((code) => code.startsWith("warning:CANDIDATE_REF:")), codes.join("\n"));
  assert.ok(codes.some((code) => code.startsWith("warning:LICENSE_UNKNOWN:")), codes.join("\n"));
  assert.ok(codes.includes("error:MISSING_VERSION:ref_missing_version"), codes.join("\n"));
  assert.ok(codes.includes("error:ASSET_VERSION_MISMATCH:ref_mismatch"), codes.join("\n"));
  assert.ok(codes.includes("error:MISSING_OBJECT_FILE:ref_missing_object"), codes.join("\n"));
  assert.ok(codes.includes("info:MISSING_VERSION:ref_optional_missing_version"), codes.join("\n"));
  assert.ok(report.warnings.every((issue) => issue.level === "warning"));

  console.log("project report test passed");

  function insertRef({ reference_id, asset_id, asset_version_id, required }) {
    svc.db.prepare(`INSERT INTO project_references (reference_id, project_id, asset_id, asset_version_id, role, usage_scope, pin_mode, required, notes, status, added_by, added_at, updated_at)
      VALUES (?, ?, ?, ?, 'fixture', NULL, 'pinned', ?, NULL, 'active', 'agent:test', ?, ?)`).run(reference_id, project.project_id, asset_id, asset_version_id, required, now, now);
  }
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
