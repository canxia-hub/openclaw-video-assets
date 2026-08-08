import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-review-writeback-"));
const repo = path.join(tmp, "repo");
const source = path.join(tmp, "reference.txt");
const generated = path.join(tmp, "generated-output.txt");
const filledGenerated = path.join(tmp, "filled-generated-output.txt");
const revisedGenerated = path.join(tmp, "revised-generated-output.txt");
await fs.promises.writeFile(source, "source reference", "utf8");
await fs.promises.writeFile(generated, "generated output", "utf8");
await fs.promises.writeFile(filledGenerated, "filled generated output", "utf8");
await fs.promises.writeFile(revisedGenerated, "revised generated output", "utf8");

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const project = svc.createProject({ title: "Review Writeback Project" });
  const asset = await svc.ingestAsset({ file_path: source, title: "Reference Asset", kind: "working" });
  const ref = svc.addProjectRef({
    project_id: project.project_id,
    asset_id: asset.asset_id,
    asset_version_id: asset.default_version_id,
    role: "main_reference",
    pin_mode: "pinned",
    required: true
  });
  const canvas = svc.createCanvas({ project_id: project.project_id, title: "Review Writeback Canvas" });
  const refShape = svc.upsertCanvasShape({
    canvas_id: canvas.canvas_id,
    shape_type: "reference_card",
    subject_type: "project_ref",
    subject_id: ref.reference_id,
    title: "Reference Card",
    x: 0,
    y: 0,
    width: 260,
    height: 140,
    props: { generation_slot: "main_reference", stage: "shots", role: "project_ref" }
  });

  const brief = svc.canvasReviewBrief({
    canvas_id: canvas.canvas_id,
    shape_id: refShape.shape_id,
    title: "Need warmer lighting",
    requested_change: "Increase warmth and preserve silhouette."
  });
  assert.equal(brief.annotation_target.target_type, "project_ref");
  assert.equal(brief.annotation_target.target_id, ref.reference_id);
  assert.equal(brief.suggested_annotation.annotation_type, "review_note");

  const review = svc.registerCanvasReviewAnnotation({
    canvas_id: canvas.canvas_id,
    shape_id: refShape.shape_id,
    title: "Need warmer lighting",
    body: "Increase warmth and preserve silhouette.",
    severity: "revision",
    requested_change: "Warmer color temperature."
  });
  assert.equal(review.annotation.target_type, "project_ref");
  assert.equal(review.annotation.target_id, ref.reference_id);
  assert.equal(review.annotation.annotation_type, "review_note");
  assert.equal(svc.listAnnotations({ target_type: "project_ref", target_id: ref.reference_id }).length, 1);

  const reviewCard = svc.createCanvasRevisionCard({
    canvas_id: canvas.canvas_id,
    annotation_id: review.annotation.annotation_id,
    title: "Revision card from annotation"
  });
  assert.equal(reviewCard.revision_card.props.role, "revision_card");
  assert.equal(reviewCard.revision_card.props.annotation_id, review.annotation.annotation_id);
  assert.equal(reviewCard.revision_card.props.source_shape_id, refShape.shape_id);
  assert.equal(reviewCard.revision_card.props.target_type, "project_ref");
  assert.equal(reviewCard.revision_card.props.target_id, ref.reference_id);
  assert.equal(reviewCard.revision_card.props.requested_change, "Warmer color temperature.");
  assert.equal(reviewCard.edge.source_shape_id, refShape.shape_id);
  assert.equal(reviewCard.edge.target_shape_id, reviewCard.revision_card.shape_id);
  assert.equal(reviewCard.edge.relation_type, "references");
  assert.equal(reviewCard.edge.props.semantic, "reviewed_by");
  assert.ok(reviewCard.lint.canvas_id);

  const inProgressCard = svc.updateCanvasRevisionCardStatus({
    shape_id: reviewCard.revision_card.shape_id,
    status: "in_progress",
    status_note: "Designer is applying the warmer lighting note."
  });
  assert.equal(inProgressCard.revision_card.props.status, "in_progress");
  assert.equal(inProgressCard.revision_card.props.status_note, "Designer is applying the warmer lighting note.");
  assert.equal(inProgressCard.status_flow.previous_status, "open");
  assert.equal(inProgressCard.source_shape.shape_id, refShape.shape_id);
  assert.equal(inProgressCard.edge.edge_id, reviewCard.edge.edge_id);
  assert.equal(inProgressCard.revision_card.props.annotation_id, review.annotation.annotation_id);
  assert.equal(inProgressCard.revision_card.props.source_shape_id, refShape.shape_id);
  assert.equal(inProgressCard.revision_card.props.target_id, ref.reference_id);

  assert.throws(
    () => svc.updateCanvasRevisionCardStatus({ shape_id: reviewCard.revision_card.shape_id, status: "done" }),
    /Invalid revision card status/
  );
  assert.throws(
    () => svc.updateCanvasRevisionCardStatus({ shape_id: refShape.shape_id, status: "resolved" }),
    /not a revision_card/
  );

  const slot = svc.createGenerationSlot({
    canvas_id: canvas.canvas_id,
    generation_type: "image_to_video",
    target_width: 1080,
    target_height: 1920,
    required_refs: ["main_reference"],
    status: "ready",
    x: 320,
    y: 0
  });
  const inserted = await svc.insertGeneratedAsset({
    canvas_id: canvas.canvas_id,
    slot_shape_id: slot.shape_id,
    file_path: generated,
    title: "Generated Output v01",
    source: { source_type: "test_generator", license_hint: "test fixture" },
    license_status: "unknown",
    risk_level: "unknown",
    classification: { domain: "delivery", type: "draft_output" },
    project_ref: { role: "generated_output", pin_mode: "pinned", required: false },
    writeback: { placement: "right", relation_type: "derived_from" }
  });
  assert.ok(inserted.asset.asset_id);
  assert.equal(inserted.project_ref.project_id, project.project_id);
  assert.equal(inserted.shape.subject_type, "project_ref");
  assert.equal(inserted.shape.props.role, "generated_output");
  assert.equal(inserted.shape.props.slot_shape_id, slot.shape_id);
  assert.equal(inserted.edge.source_shape_id, slot.shape_id);
  assert.equal(inserted.edge.target_shape_id, inserted.shape.shape_id);
  assert.equal(inserted.updated_slot.generation_slot.status, "filled");

  const refs = svc.listProjectRefs({ project_id: project.project_id });
  assert.equal(refs.length, 2);
  const canvasAfter = svc.getCanvas({ canvas_id: canvas.canvas_id });
  assert.ok(canvasAfter.shapes.some((shape) => shape.shape_id === inserted.shape.shape_id));
  assert.ok(canvasAfter.edges.some((edge) => edge.edge_id === inserted.edge.edge_id));

  const fillSlot = svc.createGenerationSlot({
    canvas_id: canvas.canvas_id,
    generation_type: "image",
    target_width: 1024,
    target_height: 1024,
    replace_policy: "new_revision",
    status: "ready",
    x: 320,
    y: 260
  });
  const filled = await svc.fillGenerationSlot({
    canvas_id: canvas.canvas_id,
    slot_shape_id: fillSlot.shape_id,
    file_path: filledGenerated
  });
  assert.equal(filled.fill.source, "video_canvas_fill_generation_slot");
  assert.equal(filled.fill.target_spec.generation_type, "image");
  assert.equal(filled.fill.target_spec.target_width, 1024);
  assert.equal(filled.fill.target_spec.target_height, 1024);
  assert.equal(filled.fill.target_spec.replace_policy, "new_revision");
  assert.equal(filled.fill.writeback.placement, "below");
  assert.equal(filled.asset.license_status, "unknown");
  assert.equal(filled.asset.risk_level, "unknown");
  assert.equal(filled.shape.props.role, "revision_output");
  assert.equal(filled.shape.props.writeback_semantic, "revision");
  assert.equal(filled.shape.props.revision_index, 1);
  assert.equal(filled.lineage_edge, null);
  assert.equal(filled.asset_relation, null);
  assert.equal(filled.shape.props.slot_shape_id, fillSlot.shape_id);
  assert.equal(filled.shape.props.generation_type, "image");
  assert.equal(filled.updated_slot.generation_slot.status, "filled");
  assert.equal(filled.idempotent.reused, false);

  const refsBeforeDuplicateFill = svc.listProjectRefs({ project_id: project.project_id }).length;
  const canvasBeforeDuplicateFill = svc.getCanvas({ canvas_id: canvas.canvas_id });
  const duplicateFilled = await svc.fillGenerationSlot({
    canvas_id: canvas.canvas_id,
    slot_shape_id: fillSlot.shape_id,
    file_path: filledGenerated
  });
  assert.equal(duplicateFilled.idempotent.reused, true);
  assert.equal(duplicateFilled.asset.asset_id, filled.asset.asset_id);
  assert.equal(duplicateFilled.project_ref.reference_id, filled.project_ref.reference_id);
  assert.equal(duplicateFilled.shape.shape_id, filled.shape.shape_id);
  assert.equal(duplicateFilled.edge.edge_id, filled.edge.edge_id);
  assert.equal(svc.listProjectRefs({ project_id: project.project_id }).length, refsBeforeDuplicateFill);
  const canvasAfterDuplicateFill = svc.getCanvas({ canvas_id: canvas.canvas_id });
  assert.equal(canvasAfterDuplicateFill.shapes.length, canvasBeforeDuplicateFill.shapes.length);
  assert.equal(canvasAfterDuplicateFill.edges.length, canvasBeforeDuplicateFill.edges.length);

  const revised = await svc.fillGenerationSlot({
    canvas_id: canvas.canvas_id,
    slot_shape_id: fillSlot.shape_id,
    file_path: revisedGenerated,
    title: "Generated Output v02"
  });
  assert.equal(revised.shape.props.role, "revision_output");
  assert.equal(revised.shape.props.writeback_semantic, "revision");
  assert.equal(revised.shape.props.revision_index, 2);
  assert.equal(revised.shape.props.previous_shape_id, filled.shape.shape_id);
  assert.equal(revised.shape.props.previous_asset_id, filled.asset.asset_id);
  assert.equal(revised.lineage_edge.source_shape_id, filled.shape.shape_id);
  assert.equal(revised.lineage_edge.target_shape_id, revised.shape.shape_id);
  assert.equal(revised.lineage_edge.relation_type, "revises");
  assert.equal(revised.asset_relation.relation_type, "revision_of");
  assert.equal(revised.asset_relation.source_asset_id, filled.asset.asset_id);
  assert.equal(revised.asset_relation.target_asset_id, revised.asset.asset_id);
  assert.equal(revised.idempotent.reused, false);

  const lineageRevisionCard = svc.createCanvasRevisionCard({
    canvas_id: canvas.canvas_id,
    source_shape_id: revised.shape.shape_id,
    title: "Revision card from output lineage",
    body: "Check whether v02 resolved the lighting note.",
    requested_change: "Use this card to drive the next revision pass."
  });
  assert.equal(lineageRevisionCard.revision_card.props.role, "revision_card");
  assert.equal(lineageRevisionCard.revision_card.props.source_shape_id, revised.shape.shape_id);
  assert.equal(lineageRevisionCard.revision_card.props.previous_shape_id, filled.shape.shape_id);
  assert.equal(lineageRevisionCard.revision_card.props.previous_asset_id, filled.asset.asset_id);
  assert.equal(lineageRevisionCard.revision_card.props.current_asset_id, revised.asset.asset_id);
  assert.equal(lineageRevisionCard.revision_card.props.current_asset_version_id, revised.asset.default_version_id);
  assert.equal(lineageRevisionCard.revision_card.props.slot_shape_id, fillSlot.shape_id);
  assert.equal(lineageRevisionCard.revision_card.props.writeback_semantic, "revision");
  assert.equal(lineageRevisionCard.revision_card.props.lineage_edge_id, revised.lineage_edge.edge_id);
  assert.equal(lineageRevisionCard.edge.source_shape_id, revised.shape.shape_id);
  assert.equal(lineageRevisionCard.edge.target_shape_id, lineageRevisionCard.revision_card.shape_id);
  assert.equal(lineageRevisionCard.edge.props.semantic, "reviewed_by");

  const resolvedLineageCard = svc.updateCanvasRevisionCardStatus({
    shape_id: lineageRevisionCard.revision_card.shape_id,
    status: "resolved",
    status_note: "v02 accepted for this review pass."
  });
  assert.equal(resolvedLineageCard.revision_card.props.status, "resolved");
  assert.equal(resolvedLineageCard.revision_card.props.status_note, "v02 accepted for this review pass.");
  assert.equal(resolvedLineageCard.revision_card.props.previous_shape_id, filled.shape.shape_id);
  assert.equal(resolvedLineageCard.revision_card.props.current_asset_id, revised.asset.asset_id);
  assert.equal(resolvedLineageCard.revision_card.props.lineage_edge_id, revised.lineage_edge.edge_id);
  assert.equal(resolvedLineageCard.edge.edge_id, lineageRevisionCard.edge.edge_id);

  const rejectedLineageCard = svc.updateCanvasRevisionCardStatus({
    shape_id: lineageRevisionCard.revision_card.shape_id,
    status: "rejected",
    status_note: ""
  });
  assert.equal(rejectedLineageCard.revision_card.props.status, "rejected");
  assert.equal(rejectedLineageCard.revision_card.props.status_note, null);
  assert.equal(rejectedLineageCard.status_flow.previous_status, "resolved");

  const refsBeforeDuplicateRevision = svc.listProjectRefs({ project_id: project.project_id }).length;
  const canvasBeforeDuplicateRevision = svc.getCanvas({ canvas_id: canvas.canvas_id });
  const duplicateRevised = await svc.fillGenerationSlot({
    canvas_id: canvas.canvas_id,
    slot_shape_id: fillSlot.shape_id,
    file_path: revisedGenerated,
    title: "Generated Output v02"
  });
  assert.equal(duplicateRevised.idempotent.reused, true);
  assert.equal(duplicateRevised.asset.asset_id, revised.asset.asset_id);
  assert.equal(duplicateRevised.shape.shape_id, revised.shape.shape_id);
  assert.equal(duplicateRevised.lineage_edge.edge_id, revised.lineage_edge.edge_id);
  assert.equal(duplicateRevised.asset_relation.relation_id, revised.asset_relation.relation_id);
  assert.equal(svc.listProjectRefs({ project_id: project.project_id }).length, refsBeforeDuplicateRevision);
  const canvasAfterDuplicateRevision = svc.getCanvas({ canvas_id: canvas.canvas_id });
  assert.equal(canvasAfterDuplicateRevision.shapes.length, canvasBeforeDuplicateRevision.shapes.length);
  assert.equal(canvasAfterDuplicateRevision.edges.length, canvasBeforeDuplicateRevision.edges.length);

  const refsAfterFill = svc.listProjectRefs({ project_id: project.project_id });
  assert.equal(refsAfterFill.length, 4);
  assert.equal(refsAfterFill.find((item) => item.reference_id === filled.project_ref.reference_id)?.role, "generated_output");

  const filledLineage = svc.lineage({ asset_id: filled.asset.asset_id });
  assert.ok(filledLineage.outgoing.some((relation) => relation.relation_type === "revision_of" && relation.target_asset_id === revised.asset.asset_id));

  console.log("canvas review writeback test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
