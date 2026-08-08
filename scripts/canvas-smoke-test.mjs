import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-canvas-"));
const repo = path.join(tmp, "repo");
const source = path.join(tmp, "角色参考.txt");
await fs.promises.writeFile(source, "canvas smoke asset", "utf8");

  const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const project = svc.createProject({ title: "中文画布项目" });
  const projectSpec = svc.updateProjectSpec({
    project_id: project.project_id,
    target_platforms: ["douyin", "bilibili"],
    aspect_ratio: "16:9",
    resolution: "1920x1080",
    fps: 24
  });
  assert.equal(projectSpec.aspect_ratio, "16:9");
  assert.equal(projectSpec.resolution, "1920x1080");
  assert.equal(projectSpec.fps, 24);
  assert.deepEqual(projectSpec.target_platforms, ["douyin", "bilibili"]);
  const asset = await svc.ingestAsset({ file_path: source, title: "角色参考素材", kind: "working" });
  const ref = svc.addProjectRef({ project_id: project.project_id, asset_id: asset.asset_id, asset_version_id: asset.default_version_id, role: "character", pin_mode: "pinned", required: true });

  const canvas = svc.createCanvas({ project_id: project.project_id, title: "中文项目资产画布", viewport: { x: -100, y: -80, zoom: 0.8, width: 1280, height: 720 } });
  assert.equal(canvas.project_id, project.project_id);
  assert.equal(canvas.shapes.length, 0);

  const projectShape = svc.upsertCanvasShape({
    canvas_id: canvas.canvas_id,
    shape_type: "project_card",
    subject_type: "project",
    subject_id: project.project_id,
    title: "中文画布项目",
    x: 0,
    y: 0,
    width: 260,
    height: 140,
    z_index: 1
  });
  const assetShape = svc.upsertCanvasShape({
    canvas_id: canvas.canvas_id,
    shape_type: "asset_card",
    subject_type: "asset",
    subject_id: asset.asset_id,
    title: "角色参考素材",
    x: 360,
    y: 40,
    width: 260,
    height: 140,
    z_index: 2
  });
  const refShape = svc.upsertCanvasShape({
    canvas_id: canvas.canvas_id,
    shape_type: "reference_card",
    subject_type: "project_ref",
    subject_id: ref.reference_id,
    title: "项目角色引用",
    x: 720,
    y: 40,
    width: 260,
    height: 140,
    z_index: 3
  });

  const edgeA = svc.linkCanvasShapes({ canvas_id: canvas.canvas_id, source_shape_id: projectShape.shape_id, target_shape_id: assetShape.shape_id, relation_type: "uses", label: "使用" });
  const edgeB = svc.linkCanvasShapes({ canvas_id: canvas.canvas_id, source_shape_id: assetShape.shape_id, target_shape_id: refShape.shape_id, relation_type: "belongs_to", label: "引用" });
  assert.ok(edgeA.edge_id);
  assert.ok(edgeB.edge_id);

  const initialLint = svc.lintCanvas({ canvas_id: canvas.canvas_id });
  assert.ok(initialLint.warnings.some((issue) => issue.code === "ASSET_LICENSE_NOT_CLEARED"));
  assert.ok(initialLint.warnings.some((issue) => issue.code === "MISSING_TAXONOMY"));

  svc.updateAssetRights({ asset_id: asset.asset_id, license_status: "cleared", risk_level: "low", source: { source_type: "internal_fixture", license_hint: "test cleared" } });
  svc.classifyAsset({ asset_id: asset.asset_id, asset_version_id: asset.default_version_id, domain: "character", type: "reference", confidence: "confirmed", source: "agent" });
  const entity = svc.createEntity({ entity_key: "char.canvas_smoke", entity_type: "character", canonical_name: "画布测试角色", project_id: project.project_id });
  svc.linkEntityAsset({ asset_id: asset.asset_id, asset_version_id: asset.default_version_id, entity_id: entity.entity_id, relation_type: "depicts", confidence: "confirmed" });
  svc.annotateAsset({ target_type: "asset", target_id: asset.asset_id, annotation_type: "character_profile", title: "角色信息卡", body: "用于 canvas smoke test 的角色信息卡。" });

  const saved = svc.saveCanvasSnapshot({
    canvas_id: canvas.canvas_id,
    viewport: { x: 0, y: 0, zoom: 1, width: 1280, height: 720 },
    state: { reason: "smoke" }
  });
  assert.equal(saved.shapes.length, 3);
  assert.equal(saved.edges.length, 2);
  assert.equal(saved.viewport.zoom, 1);

  const context = svc.canvasAgentContext({ canvas_id: canvas.canvas_id, viewport: { x: -20, y: -20, zoom: 1, width: 1100, height: 400 } });
  assert.equal(context.visible_shapes.length, 3);
  assert.equal(context.lint.errors.length, 0);
  assert.equal(context.lint.issue_count, 0);
  assert.equal(context.production_readiness.ok, true);
  assert.ok(context.action_policy.allowed_actions.some((action) => action.tool === "video_canvas_upsert_shape"));
  const assetContext = context.visible_shapes.find((shape) => shape.shape_id === assetShape.shape_id).subject_context;
  assert.equal(assetContext.taxonomy.domain, "character");
  assert.equal(assetContext.entity_links[0].entity_key, "char.canvas_smoke");
  assert.equal(assetContext.annotation_summary.required_count, 1);
  assert.ok(context.production_stages.some((stage) => stage.key === "characters"));

  const templated = svc.applyProductionCanvasTemplate({ canvas_id: canvas.canvas_id });
  assert.equal(templated.template.kind, "production_pilot");
  assert.equal(templated.template.stage_count, 8);
  assert.ok(templated.canvas.shapes.some((shape) => shape.subject_type === "section" && shape.props.stage === "characters"));
  assert.ok(templated.canvas.shapes.some((shape) => shape.props.role === "production_slot"));
  const templatedContext = svc.canvasAgentContext({ canvas_id: canvas.canvas_id, viewport: { x: -120, y: -120, zoom: 0.75, width: 1800, height: 1100 } });
  assert.equal(templatedContext.production_readiness.ok, true);
  assert.ok(templatedContext.action_policy.allowed_actions.some((action) => action.tool === "video_canvas_apply_production_template"));
  const characterStage = templatedContext.production_stages.find((stage) => stage.key === "characters");
  assert.ok(characterStage.content_count >= 2);
  assert.ok(templatedContext.production_stages.find((stage) => stage.key === "shots").slot_count >= 3);
  assert.equal(templatedContext.production_readiness.stage_ready, false);
  assert.ok(templatedContext.production_stage_gaps.some((stage) => stage.key === "scenes" && stage.missing.includes("content_card")));
  assert.ok(templatedContext.lint.warnings.some((issue) => issue.code === "PRODUCTION_STAGE_GAP" && issue.stage === "scenes"));

  const generationPackage = svc.canvasGenerationPackage({ canvas_id: canvas.canvas_id, generation_type: "image_to_video" });
  assert.equal(generationPackage.source, "canvas");
  assert.equal(generationPackage.generation_type, "image_to_video");
  assert.equal(generationPackage.slots.character_reference.length, 1);
  assert.equal(generationPackage.slots.character_reference[0].reference_id, ref.reference_id);
  assert.equal(generationPackage.gates.ok, false);
  assert.ok(generationPackage.gates.errors.some((item) => item.includes("图生视频")));
  assert.ok(generationPackage.gates.warnings.some((item) => item.includes("场景")));
  assert.ok(!generationPackage.gates.warnings.some((item) => item.includes("输出比例")));
  const handoff = svc.canvasGenerationHandoff({ canvas_id: canvas.canvas_id, generation_type: "image_to_video" });
  assert.equal(handoff.source, "canvas_generation_handoff");
  assert.equal(handoff.status, "blocked");
  assert.equal(handoff.validation.output_spec_ready, true);
  assert.equal(handoff.task.target.width, 1920);
  assert.equal(handoff.task.target.height, 1080);
  assert.equal(handoff.task.parameters.fps, 24);

  const deleted = svc.deleteCanvasShape({ shape_id: refShape.shape_id });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.removed_edges, 1);
  assert.equal(svc.getCanvas({ canvas_id: canvas.canvas_id }).shapes.length, templated.canvas.shapes.length - 1);

  console.log("canvas smoke test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
