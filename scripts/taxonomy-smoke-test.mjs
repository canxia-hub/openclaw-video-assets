import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-taxonomy-"));
const repo = path.join(tmp, "repo");
const domains = [
  { domain: "character", type: "main", subtype: "turnaround", entity_type: "character", entity_key: "char_luo_ming", name: "洛明", annotation_type: "character_profile", relation_type: "depicts", role: "character" },
  { domain: "scene", type: "interior", subtype: "concept_art", entity_type: "scene", entity_key: "scene_moon_palace", name: "月宫内殿", annotation_type: "scene_concept", relation_type: "scene_for", role: "scene" },
  { domain: "costume", type: "formal", subtype: "reference", entity_type: "costume", entity_key: "costume_luo_ming_ceremony", name: "洛明礼服", annotation_type: "costume_spec", relation_type: "costume_for", role: "character" },
  { domain: "prop", type: "hero", subtype: "design", entity_type: "prop", entity_key: "prop_silver_key", name: "银钥匙", annotation_type: "prop_function", relation_type: "prop_for", role: "other" }
];

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const project = svc.createProject({ title: "Taxonomy Smoke Project" });
  const refs = [];
  for (const item of domains) {
    const file = path.join(tmp, `${item.entity_key}.txt`);
    await fs.promises.writeFile(file, `${item.domain} fixture`, "utf8");
    const asset = await svc.ingestAsset({ file_path: file, title: item.name, kind: "working" });
    const classification = svc.classifyAsset({ asset_id: asset.asset_id, asset_version_id: asset.default_version_id, domain: item.domain, type: item.type, subtype: item.subtype, confidence: "confirmed" });
    assert.equal(classification.classifications[0].domain, item.domain);

    const entity = svc.createEntity({ entity_key: item.entity_key, entity_type: item.entity_type, canonical_name: item.name, aliases: [`${item.name}别名`] });
    assert.equal(entity.entity_key, item.entity_key);

    const linked = svc.linkEntityAsset({ asset_id: asset.asset_id, asset_version_id: asset.default_version_id, entity_key: item.entity_key, relation_type: item.relation_type, confidence: "confirmed" });
    assert.equal(linked.entity_links[0].entity_key, item.entity_key);

    const annotation = svc.annotateAsset({ target_type: "entity", target_id: entity.entity_id, annotation_type: item.annotation_type, title: `${item.name} annotation`, body: `${item.name} detailed production note`, structured: { entity_key: item.entity_key } });
    assert.equal(annotation.annotation_type, item.annotation_type);
    assert.equal(svc.listAnnotations({ target_type: "entity", target_id: entity.entity_id }).length, 1);

    refs.push(svc.addProjectRef({ project_id: project.project_id, asset_id: asset.asset_id, asset_version_id: asset.default_version_id, role: item.role, pin_mode: "pinned", required: true }));
  }

  const continuity = svc.projectContinuityReport({ project_id: project.project_id, stage: "delivery" });
  assert.equal(continuity.errors.length, 0, JSON.stringify(continuity, null, 2));
  assert.equal(continuity.refs.length, domains.length);

  const missingFile = path.join(tmp, "missing-taxonomy.txt");
  await fs.promises.writeFile(missingFile, "missing taxonomy", "utf8");
  const missingAsset = await svc.ingestAsset({ file_path: missingFile, title: "Missing Taxonomy", kind: "working" });
  svc.addProjectRef({ project_id: project.project_id, asset_id: missingAsset.asset_id, asset_version_id: missingAsset.default_version_id, role: "character", pin_mode: "pinned", required: true });
  const broken = svc.projectContinuityReport({ project_id: project.project_id, stage: "delivery" });
  assert.ok(broken.errors.some((issue) => issue.code === "MISSING_TAXONOMY"), JSON.stringify(broken, null, 2));

  const firstAnnotation = svc.listAnnotations({ target_type: "entity", target_id: svc.searchEntities({ query: "洛明" })[0].entity_id })[0];
  const updated = svc.updateAnnotation({ annotation_id: firstAnnotation.annotation_id, status: "superseded" });
  assert.equal(updated.status, "superseded");

  console.log("taxonomy smoke test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
