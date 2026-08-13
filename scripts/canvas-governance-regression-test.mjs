import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-canvas-governance-"));
const repo = path.join(tmp, "repo");
const sourceUnknown = path.join(tmp, "unknown-rights.png");
const sourceUnclassified = path.join(tmp, "unclassified.png");
await fs.promises.writeFile(sourceUnknown, Buffer.from(png1x1, "base64"));
await fs.promises.writeFile(sourceUnclassified, Buffer.from(png1x1, "base64"));

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const project = svc.createProject({ title: "生成治理回归项目" });
  svc.updateProjectSpec({
    project_id: project.project_id,
    target_platforms: ["bilibili"],
    aspect_ratio: "16:9",
    resolution: "1920x1080",
    fps: 24
  });
  const canvas = svc.createCanvas({
    project_id: project.project_id,
    title: "生成治理回归画布",
    document: {
      selection: { shape_ids: ["shape-before"] },
      view_state: { zoom: 0.75 },
      template: { kind: "production_pilot" },
      qa_marker: "preserve-me"
    }
  });

  const merged = svc.saveCanvasSnapshot({
    canvas_id: canvas.canvas_id,
    document: { purpose: "partial-update" },
    document_mode: "merge"
  });
  assert.equal(merged.document.purpose, "partial-update");
  assert.equal(merged.document.qa_marker, "preserve-me");
  assert.deepEqual(merged.document.selection, { shape_ids: ["shape-before"] });
  assert.deepEqual(merged.document.template, { kind: "production_pilot" });

  assert.throws(
    () => svc.saveCanvasSnapshot({
      canvas_id: canvas.canvas_id,
      document: { purpose: "replace-without-confirmation" },
      document_mode: "replace"
    }),
    /confirm_document_replace/
  );
  const replaced = svc.saveCanvasSnapshot({
    canvas_id: canvas.canvas_id,
    document: { purpose: "confirmed-replace" },
    document_mode: "replace",
    confirm_document_replace: true
  });
  assert.deepEqual(replaced.document, { purpose: "confirmed-replace" });

  const slot = svc.createGenerationSlot({
    canvas_id: canvas.canvas_id,
    generation_type: "image_to_video",
    required_refs: ["main_reference"],
    status: "ready"
  });

  const unknownRights = await svc.ingestAsset({
    file_path: sourceUnknown,
    title: "授权未知但已分类素材",
    kind: "working"
  });
  svc.classifyAsset({
    asset_id: unknownRights.asset_id,
    asset_version_id: unknownRights.default_version_id,
    domain: "reference",
    type: "main_reference",
    confidence: "confirmed",
    source: "agent"
  });
  const unknownRef = svc.addProjectRef({
    project_id: project.project_id,
    asset_id: unknownRights.asset_id,
    asset_version_id: unknownRights.default_version_id,
    role: "main_reference",
    pin_mode: "pinned",
    required: true
  });
  svc.upsertCanvasShape({
    canvas_id: canvas.canvas_id,
    shape_type: "reference_card",
    subject_type: "project_ref",
    subject_id: unknownRef.reference_id,
    title: "授权未知输入",
    props: { generation_slot: "main_reference", stage: "shots", role: "project_ref" }
  });

  const unclassified = await svc.ingestAsset({
    file_path: sourceUnclassified,
    title: "已清权但未分类素材",
    kind: "working"
  });
  svc.updateAssetRights({
    asset_id: unclassified.asset_id,
    license_status: "cleared",
    risk_level: "low",
    source: { source_type: "internal_fixture", license_hint: "qa fixture" }
  });
  const unclassifiedRef = svc.addProjectRef({
    project_id: project.project_id,
    asset_id: unclassified.asset_id,
    asset_version_id: unclassified.default_version_id,
    role: "style_reference",
    pin_mode: "pinned",
    required: true
  });
  svc.upsertCanvasShape({
    canvas_id: canvas.canvas_id,
    shape_type: "reference_card",
    subject_type: "project_ref",
    subject_id: unclassifiedRef.reference_id,
    title: "未分类输入",
    props: { generation_slot: "style_reference", stage: "shots", role: "project_ref" }
  });

  const blocked = svc.canvasGenerationPackage({
    canvas_id: canvas.canvas_id,
    generation_type: "image_to_video",
    slot_shape_id: slot.shape_id
  });
  assert.equal(blocked.gates.ok, false);
  assert.ok(blocked.gates.errors.some((item) => item.includes("授权状态未清理")), JSON.stringify(blocked.gates, null, 2));
  assert.ok(blocked.gates.errors.some((item) => item.includes("缺少 taxonomy")), JSON.stringify(blocked.gates, null, 2));

  const blockedHandoff = svc.canvasGenerationHandoff({
    canvas_id: canvas.canvas_id,
    generation_type: "image_to_video",
    slot_shape_id: slot.shape_id
  });
  assert.equal(blockedHandoff.status, "blocked");
  assert.equal(blockedHandoff.task.execution.command, null);
  assert.ok(blockedHandoff.validation.generation_gate_blockers.some((item) => item.includes("授权状态未清理")));

  const blockedPlan = svc.canvasDreaminaCliPlan({
    canvas_id: canvas.canvas_id,
    generation_type: "image_to_video",
    slot_shape_id: slot.shape_id
  });
  assert.equal(blockedPlan.status, "blocked");
  assert.equal(blockedPlan.command, null);
  assert.ok(blockedPlan.blockers.some((item) => item.includes("授权状态未清理")));

  const blockedDryRun = await svc.canvasDreaminaCliGenerateVideo({
    canvas_id: canvas.canvas_id,
    generation_type: "image_to_video",
    execute: false,
    accept_credit_spend: false,
    run_preflight: false,
    download_outputs: false,
    ingest_outputs: false,
    writeback_canvas: false
  });
  assert.equal(blockedDryRun.status, "blocked");
  assert.equal(blockedDryRun.command, null);
  assert.ok(blockedDryRun.blockers.some((item) => item.includes("授权状态未清理")));

  svc.annotateAsset({
    target_type: "asset",
    target_id: unknownRights.asset_id,
    annotation_type: "source_rights",
    title: "授权门临时豁免",
    body: "仅用于隔离测试，保留 unknown 状态并记录显式豁免。",
    structured: { waiver: { codes: ["ASSET_LICENSE_NOT_CLEARED"] } }
  });
  svc.annotateAsset({
    target_type: "asset",
    target_id: unclassified.asset_id,
    annotation_type: "production_note",
    title: "分类门临时豁免",
    body: "仅用于隔离测试，后续必须补 taxonomy。",
    structured: { waiver: { codes: ["MISSING_TAXONOMY"] } }
  });

  const waived = svc.canvasGenerationPackage({
    canvas_id: canvas.canvas_id,
    generation_type: "image_to_video",
    slot_shape_id: slot.shape_id
  });
  assert.equal(waived.gates.ok, true, JSON.stringify(waived.gates, null, 2));
  assert.ok(waived.gates.waivers.some((item) => item.code === "ASSET_LICENSE_NOT_CLEARED"));
  assert.ok(waived.gates.waivers.some((item) => item.code === "MISSING_TAXONOMY"));

  const handoff = svc.canvasGenerationHandoff({
    canvas_id: canvas.canvas_id,
    generation_type: "image_to_video",
    slot_shape_id: slot.shape_id
  });
  assert.equal(handoff.status, "ready");
  assert.equal(handoff.validation.gates.waivers.length, 2);

  console.log("canvas governance regression test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
