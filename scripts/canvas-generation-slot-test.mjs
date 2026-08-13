import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-generation-slot-"));
const repo = path.join(tmp, "repo");
const source = path.join(tmp, "main-reference.png");
await fs.promises.writeFile(source, Buffer.from(png1x1, "base64"));

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const project = svc.createProject({ title: "Generation Slot Project" });
  svc.updateProjectSpec({
    project_id: project.project_id,
    target_platforms: ["bilibili"],
    aspect_ratio: "16:9",
    resolution: "1920x1080",
    fps: 24
  });
  const canvas = svc.createCanvas({ project_id: project.project_id, title: "Generation Slot Canvas" });
  assert.throws(
    () => svc.createGenerationSlot({ canvas_id: canvas.canvas_id, required_refs: ["draft_output"] }),
    /required_refs 只能包含输入槽 key/
  );
  const slot = svc.createGenerationSlot({
    canvas_id: canvas.canvas_id,
    generation_type: "image_to_video",
    target_width: 1080,
    target_height: 1920,
    duration_seconds: 6,
    replace_policy: "replace_slot",
    required_refs: ["main_reference"],
    status: "ready"
  });

  assert.equal(slot.props.role, "generation_slot");
  assert.equal(slot.generation_slot.target_aspect_ratio, "9:16");
  assert.equal(slot.generation_slot.target_width, 1080);
  assert.equal(slot.generation_slot.replace_policy, "replace_slot");
  assert.deepEqual(slot.generation_slot.required_refs, ["main_reference"]);

  const blockedPackage = svc.canvasGenerationPackage({ canvas_id: canvas.canvas_id, generation_type: "image_to_video", slot_shape_id: slot.shape_id });
  assert.equal(blockedPackage.active_generation_slot.shape_id, slot.shape_id);
  assert.equal(blockedPackage.target_spec.resolution, "1080x1920");
  assert.equal(blockedPackage.target_spec.aspect_ratio, "9:16");
  assert.equal(blockedPackage.target_spec.duration_seconds, 6);
  assert.equal(blockedPackage.gates.ok, false);
  assert.ok(blockedPackage.gates.errors.some((item) => item.includes("主参考")));

  const asset = await svc.ingestAsset({ file_path: source, title: "Main Reference", kind: "working" });
  svc.updateAssetRights({
    asset_id: asset.asset_id,
    license_status: "cleared",
    risk_level: "low",
    source: { source_type: "internal_fixture", license_hint: "test fixture" }
  });
  svc.classifyAsset({
    asset_id: asset.asset_id,
    asset_version_id: asset.default_version_id,
    domain: "reference",
    type: "main_reference",
    confidence: "confirmed",
    source: "agent"
  });
  const ref = svc.addProjectRef({
    project_id: project.project_id,
    asset_id: asset.asset_id,
    asset_version_id: asset.default_version_id,
    role: "main_reference",
    pin_mode: "pinned",
    required: true
  });
  svc.upsertCanvasShape({
    canvas_id: canvas.canvas_id,
    shape_type: "reference_card",
    subject_type: "project_ref",
    subject_id: ref.reference_id,
    title: "Main Reference",
    x: 0,
    y: 0,
    width: 260,
    height: 140,
    props: { generation_slot: "main_reference", stage: "shots", role: "project_ref" }
  });

  const readyPackage = svc.canvasGenerationPackage({ canvas_id: canvas.canvas_id, generation_type: "image_to_video", slot_shape_id: slot.shape_id });
  assert.equal(readyPackage.gates.ok, true);
  assert.equal(readyPackage.slots.main_reference.length, 1);
  assert.equal(readyPackage.generation_slots.length, 1);

  const handoff = svc.canvasGenerationHandoff({ canvas_id: canvas.canvas_id, generation_type: "image_to_video", slot_shape_id: slot.shape_id });
  assert.equal(handoff.status, "ready");
  assert.equal(handoff.task.generation_slot_shape_id, slot.shape_id);
  assert.equal(handoff.task.target.width, 1080);
  assert.equal(handoff.task.target.height, 1920);
  assert.equal(handoff.task.target.aspect_ratio, "9:16");
  assert.equal(handoff.task.target.duration_seconds, 6);
  assert.equal(handoff.task.parameters.replace_policy, "replace_slot");

  const updated = svc.updateGenerationSlot({
    shape_id: slot.shape_id,
    target_width: 720,
    target_height: 1280,
    duration_seconds: 4,
    replace_policy: "insert_beside"
  });
  assert.equal(updated.generation_slot.target_aspect_ratio, "9:16");
  assert.equal(updated.generation_slot.target_width, 720);
  assert.equal(updated.generation_slot.duration_seconds, 4);
  assert.equal(updated.generation_slot.replace_policy, "insert_beside");

  console.log("canvas generation slot test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
