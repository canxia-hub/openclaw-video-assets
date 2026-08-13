import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-localization-"));
const repo = path.join(tmp, "repo");
const source = path.join(tmp, "中文参考.txt");
await fs.promises.writeFile(source, "中文本地化回归夹具", "utf8");

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const project = svc.createProject({ title: "中文项目" });
  const asset = await svc.ingestAsset({ file_path: source, title: "中文参考素材", kind: "raw" });
  svc.updateAssetMetadata({ asset_id: asset.asset_id, description: "用于中文化回归" });
  svc.updateAssetRights({ asset_id: asset.asset_id, license_status: "unknown", risk_level: "unknown" });
  svc.createBranch({ asset_id: asset.asset_id, base_version_id: asset.default_version_id, name: "中文分支" });
  const ref = svc.addProjectRef({ project_id: project.project_id, asset_id: asset.asset_id, role: "document", required: false });
  const canvas = svc.createCanvas({ project_id: project.project_id, title: "中文画布" });
  svc.applyProductionCanvasTemplate({ canvas_id: canvas.canvas_id });

  const canvasDetail = svc.getCanvas({ canvas_id: canvas.canvas_id });
  const refCard = canvasDetail.shapes.find((shape) => shape.subject_type === "project_ref" && shape.subject_id === ref.reference_id);
  assert.ok(refCard, "production template should create a project-ref card");
  assert.equal(refCard.title, "中文参考素材");

  const revision = svc.createCanvasRevisionCard({ canvas_id: canvas.canvas_id, source_shape_id: refCard.shape_id });
  assert.equal(revision.edge.label, "返修卡");
  assert.equal(revision.revision_card.props.body, "请求审阅。");

  svc.classifyAsset({ asset_id: asset.asset_id, domain: "reference", type: "document" });
  const entity = svc.createEntity({ entity_key: "qa_entity", entity_type: "prop", canonical_name: "中文实体", project_id: project.project_id });
  svc.linkEntityAsset({ asset_id: asset.asset_id, entity_id: entity.entity_id, relation_type: "depicts" });
  svc.annotateAsset({ target_type: "asset", target_id: asset.asset_id, annotation_type: "production_note", title: "中文批注", body: "中文批注正文" });

  const missingTaxonomy = await svc.ingestAsset({ file_path: source, title: "缺失分类素材", kind: "raw" });
  svc.addProjectRef({ project_id: project.project_id, asset_id: missingTaxonomy.asset_id, role: "document", required: false });

  const report = svc.projectReport({ project_id: project.project_id });
  assert.ok(report.warnings.some((issue) => issue.code === "LICENSE_UNKNOWN" && issue.message.includes("授权状态")));

  const continuity = svc.projectContinuityReport({ project_id: project.project_id, stage: "review" });
  assert.ok(
    continuity.issues.some((issue) => issue.asset_id === missingTaxonomy.asset_id && issue.code === "MISSING_TAXONOMY" && issue.message === "项目素材引用缺少 taxonomy 分类。"),
    JSON.stringify(continuity, null, 2)
  );
  const taxonomy = svc.assetTaxonomyReport({ limit: 100 });
  assert.ok(
    taxonomy.issues.some((issue) => issue.asset_id === missingTaxonomy.asset_id && issue.code === "MISSING_TAXONOMY" && issue.message === "素材缺少 taxonomy 分类。"),
    JSON.stringify(taxonomy, null, 2)
  );

  const commits = svc.listCommits({ limit: 300 });
  const messages = commits.map((item) => item.message);
  for (const expected of [
    "已创建项目：中文项目",
    "已入库素材：中文参考素材",
    `已添加项目素材引用：${ref.reference_id}`,
    "已创建画布：中文画布",
    "已分类素材：reference.document",
    "已创建生产实体：qa_entity",
    "已关联素材与实体：qa_entity"
  ]) {
    assert.ok(messages.includes(expected), `missing localized commit message: ${expected}`);
  }
  const leaked = messages.filter((message) => /^(Ingested|Created|Updated|Added|Removed|Deleted|Linked|Unlinked|Registered|Generated|Classified|Annotated|Uploaded|Rejected|Lazy re-probed)\b/.test(message));
  assert.deepEqual(leaked, []);

  console.log("localization regression test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
