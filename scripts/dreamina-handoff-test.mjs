import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-dreamina-handoff-"));
const repo = path.join(tmp, "repo");
const source = path.join(tmp, "character-reference.png");
await fs.promises.writeFile(source, Buffer.from(png1x1, "base64"));

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const project = svc.createProject({ title: "Dreamina CLI Handoff Test" });
  svc.updateProjectSpec({
    project_id: project.project_id,
    target_platforms: ["douyin"],
    aspect_ratio: "16:9",
    resolution: "1920x1080",
    fps: 24
  });

  const asset = await svc.ingestAsset({ file_path: source, title: "Character Reference Image", kind: "working" });
  svc.updateAssetRights({
    asset_id: asset.asset_id,
    license_status: "cleared",
    risk_level: "low",
    source: { source_type: "internal_fixture", license_hint: "test fixture" }
  });
  svc.classifyAsset({
    asset_id: asset.asset_id,
    asset_version_id: asset.default_version_id,
    domain: "character",
    type: "reference",
    confidence: "confirmed",
    source: "agent"
  });

  const ref = svc.addProjectRef({
    project_id: project.project_id,
    asset_id: asset.asset_id,
    asset_version_id: asset.default_version_id,
    role: "character",
    usage_scope: "Dreamina image-to-video source image.",
    pin_mode: "pinned",
    required: true
  });

  const canvas = svc.createCanvas({ project_id: project.project_id, title: "Dreamina Canvas" });
  svc.upsertCanvasShape({
    canvas_id: canvas.canvas_id,
    shape_type: "reference_card",
    subject_type: "project_ref",
    subject_id: ref.reference_id,
    title: "Main image reference",
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

  const handoff = svc.canvasGenerationHandoff({ canvas_id: canvas.canvas_id, generation_type: "image_to_video" });
  assert.equal(handoff.status, "ready");
  assert.equal(handoff.validation.gates.ok, true);
  assert.equal(handoff.validation.dreamina_cli_ready, true);
  assert.equal(handoff.task.providers.dreamina_cli.provider_id, "dreamina_cli");
  assert.equal(handoff.task.execution.command.kind, "image2video");
  assert.ok(handoff.task.execution.command.argv.includes("image2video"));
  assert.ok(handoff.task.execution.command.argv.includes("--image"));
  assert.ok(handoff.task.execution.command.argv.includes("--prompt"));
  assert.ok(handoff.task.execution.command.argv.includes("seedance2.0fast"));
  assert.equal(handoff.task.execution.preflight[0].name, "check_login_and_credits");
  assert.equal(handoff.task.inputs[0].file_path.endsWith(".blob"), true);
  assert.equal(fs.existsSync(handoff.task.inputs[0].file_path), true);

  console.log("dreamina handoff test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
