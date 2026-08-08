import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-dreamina-plan-"));
const repo = path.join(tmp, "repo");
const source = path.join(tmp, "main-reference.png");
await fs.promises.writeFile(source, Buffer.from(png1x1, "base64"));

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const project = svc.createProject({ title: "Dreamina CLI Plan Test" });
  svc.updateProjectSpec({
    project_id: project.project_id,
    target_platforms: ["douyin"],
    aspect_ratio: "1:1",
    resolution: "1328x1328",
    fps: 24
  });

  const asset = await svc.ingestAsset({ file_path: source, title: "Main Reference Image", kind: "working" });
  svc.updateAssetRights({
    asset_id: asset.asset_id,
    license_status: "cleared",
    risk_level: "low",
    source: { source_type: "internal_fixture", license_hint: "test fixture" }
  });
  const ref = svc.addProjectRef({
    project_id: project.project_id,
    asset_id: asset.asset_id,
    asset_version_id: asset.default_version_id,
    role: "reference",
    usage_scope: "Dreamina CLI plan source image.",
    pin_mode: "pinned",
    required: true
  });

  const canvas = svc.createCanvas({ project_id: project.project_id, title: "Dreamina CLI Plan Canvas" });
  svc.upsertCanvasShape({
    canvas_id: canvas.canvas_id,
    shape_type: "reference_card",
    subject_type: "project_ref",
    subject_id: ref.reference_id,
    title: "Bound image reference",
    x: 0,
    y: 0,
    width: 260,
    height: 140,
    props: {
      generation_slot: "main_reference",
      stage: "shots",
      role: "project_ref"
    }
  });

  const plan = svc.canvasDreaminaCliPlan({ canvas_id: canvas.canvas_id, generation_type: "image_to_video" });
  assert.equal(plan.source, "canvas_dreamina_cli_plan");
  assert.equal(plan.status, "ready");
  assert.equal(plan.guide_source.title, "即梦 CLI 体验指南");
  assert.equal(plan.recommended_provider, "dreamina_cli");
  assert.ok(plan.zero_cost_checks.some((check) => check.name === "credit"));
  assert.ok(plan.cost_policy.some((item) => item.includes("user_credit")));
  assert.equal(plan.command.kind, "image2video");
  assert.ok(plan.command.shell.includes("image2video"));
  assert.ok(plan.download_and_register.some((item) => item.includes("video_asset_ingest")));
  assert.ok(plan.canvas_writeback.some((item) => item.includes("video_canvas_upsert_shape")));
  assert.ok(plan.next_actions[0].includes("user_credit"));

  console.log("dreamina cli plan test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
