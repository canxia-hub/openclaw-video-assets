import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-taxonomy-continuity-"));
const repo = path.join(tmp, "repo");
const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();

try {
  const project = svc.createProject({ title: "Taxonomy Continuity Project" });

  const unconfirmed = await makeAsset("unconfirmed-character");
  svc.classifyAsset({ asset_id: unconfirmed.asset_id, asset_version_id: unconfirmed.default_version_id, domain: "character", type: "main", confidence: "candidate" });
  svc.addProjectRef({ project_id: project.project_id, asset_id: unconfirmed.asset_id, asset_version_id: unconfirmed.default_version_id, role: "character", pin_mode: "pinned", required: true });

  const noAnnotation = await makeAsset("prop-no-annotation");
  svc.classifyAsset({ asset_id: noAnnotation.asset_id, asset_version_id: noAnnotation.default_version_id, domain: "prop", type: "hero", confidence: "confirmed" });
  const propEntity = svc.createEntity({ entity_key: "prop_no_annotation", entity_type: "prop", canonical_name: "No Annotation Prop" });
  svc.linkEntityAsset({ asset_id: noAnnotation.asset_id, asset_version_id: noAnnotation.default_version_id, entity_key: propEntity.entity_key, relation_type: "prop_for", confidence: "confirmed" });
  svc.addProjectRef({ project_id: project.project_id, asset_id: noAnnotation.asset_id, asset_version_id: noAnnotation.default_version_id, role: "other", pin_mode: "pinned", required: true });

  const conflictEntity = svc.createEntity({ entity_key: "char_conflict", entity_type: "character", canonical_name: "Conflict Character" });
  const conflictA = await makeAsset("conflict-a");
  const conflictB = await makeAsset("conflict-b");
  for (const asset of [conflictA, conflictB]) {
    svc.classifyAsset({ asset_id: asset.asset_id, asset_version_id: asset.default_version_id, domain: "character", type: "main", confidence: "confirmed" });
    svc.linkEntityAsset({ asset_id: asset.asset_id, asset_version_id: asset.default_version_id, entity_key: conflictEntity.entity_key, relation_type: "depicts", confidence: "confirmed" });
    svc.annotateAsset({ target_type: "entity", target_id: conflictEntity.entity_id, annotation_type: "character_profile", title: "Conflict profile", body: "Profile exists so conflict warning is isolated.", structured: { canonical_name: "Conflict Character" } });
    svc.addProjectRef({ project_id: project.project_id, asset_id: asset.asset_id, asset_version_id: asset.default_version_id, role: "character", pin_mode: "pinned", required: true });
  }

  const costume = await makeAsset("costume-owner-mismatch");
  svc.classifyAsset({ asset_id: costume.asset_id, asset_version_id: costume.default_version_id, domain: "costume", type: "formal", confidence: "confirmed" });
  const costumeEntity = svc.createEntity({ entity_key: "costume_owner_mismatch", entity_type: "costume", canonical_name: "Owner Mismatch Costume" });
  svc.linkEntityAsset({ asset_id: costume.asset_id, asset_version_id: costume.default_version_id, entity_key: costumeEntity.entity_key, relation_type: "costume_for", confidence: "confirmed" });
  svc.annotateAsset({ target_type: "entity", target_id: costumeEntity.entity_id, annotation_type: "costume_spec", title: "Owner mismatch costume", body: "Costume references a character not present in project.", structured: { costume_name: "Owner Mismatch Costume", owner_character_key: "char_absent" } });
  svc.addProjectRef({ project_id: project.project_id, asset_id: costume.asset_id, asset_version_id: costume.default_version_id, role: "character", pin_mode: "pinned", required: true });

  const missingTaxonomy = await makeAsset("library-missing-taxonomy");

  const report = svc.projectContinuityReport({ project_id: project.project_id, stage: "delivery" });
  const codes = report.issues.map((issue) => issue.code);
  assert.ok(codes.includes("UNCONFIRMED_TAXONOMY"), codes.join("\n"));
  assert.ok(codes.includes("MISSING_ENTITY_LINK"), codes.join("\n"));
  assert.ok(codes.includes("MISSING_KEY_ANNOTATION"), codes.join("\n"));
  assert.ok(codes.includes("ENTITY_VERSION_CONFLICT"), codes.join("\n"));
  assert.ok(codes.includes("COSTUME_OWNER_NOT_IN_PROJECT"), codes.join("\n"));
  assert.ok(report.errors.some((issue) => issue.code === "UNCONFIRMED_TAXONOMY"));

  const taxonomyReport = svc.assetTaxonomyReport({ limit: 100 });
  assert.ok(taxonomyReport.issues.some((issue) => issue.asset_id === missingTaxonomy.asset_id && issue.code === "MISSING_TAXONOMY"), JSON.stringify(taxonomyReport, null, 2));
  assert.ok(taxonomyReport.assets_scanned >= 5);

  svc.annotateAsset({
    target_type: "asset",
    target_id: missingTaxonomy.asset_id,
    annotation_type: "review_note",
    title: "Known fixture waiver",
    body: "This fixture intentionally has no taxonomy and should not pollute asset taxonomy report warnings.",
    structured: { waives_issues: ["MISSING_TAXONOMY"], reason: "negative test fixture" }
  });
  const waivedReport = svc.assetTaxonomyReport({ limit: 100 });
  assert.ok(!waivedReport.issues.some((issue) => issue.asset_id === missingTaxonomy.asset_id && issue.code === "MISSING_TAXONOMY"), JSON.stringify(waivedReport, null, 2));
  assert.ok(waivedReport.waived.some((issue) => issue.asset_id === missingTaxonomy.asset_id && issue.code === "MISSING_TAXONOMY"), JSON.stringify(waivedReport, null, 2));

  console.log("taxonomy continuity test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}

async function makeAsset(name) {
  const file = path.join(tmp, `${name}.txt`);
  await fs.promises.writeFile(file, `${name} fixture`, "utf8");
  return svc.ingestAsset({ file_path: file, title: name, kind: "working" });
}
