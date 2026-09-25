import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-dreamina-image-"));
const repo = path.join(tmp, "repo");
const source = path.join(tmp, "main-reference.png");
await fs.promises.writeFile(source, Buffer.from(png1x1, "base64"));

const argvValue = (argv, flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : null;
};

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const project = svc.createProject({ title: "Dreamina CLI Image Generate Test" });
  svc.updateProjectSpec({
    project_id: project.project_id,
    target_platforms: ["douyin"],
    aspect_ratio: "16:9",
    resolution: "1920x1080",
    fps: 24
  });

  const asset = await svc.ingestAsset({ file_path: source, title: "Main Reference Image", kind: "working" });
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
    role: "reference",
    usage_scope: "Dreamina CLI image source reference.",
    pin_mode: "pinned",
    required: true
  });

  const canvas = svc.createCanvas({ project_id: project.project_id, title: "Dreamina CLI Image Canvas" });
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
    props: { generation_slot: "main_reference", stage: "shots", role: "project_ref" }
  });

  // 1) 计划路径：Seedream 5.0Pro + 2k，不消耗积分
  const plan = svc.canvasDreaminaCliPlan({
    canvas_id: canvas.canvas_id,
    generation_type: "image",
    model_version: "5.0Pro",
    resolution_type: "2k"
  });
  assert.equal(plan.command.kind, "text2image");
  assert.equal(argvValue(plan.command.argv, "--model_version"), "5.0Pro");
  assert.equal(argvValue(plan.command.argv, "--resolution_type"), "2k");
  assert.equal(plan.command.argv.includes("text2video"), false);

  // 2) 大小写容错：5.0pro / 5.0PRO 归一到 CLI 原值 5.0Pro
  for (const variant of ["5.0pro", "5.0PRO", "5.0Pro"]) {
    const normalized = svc.canvasDreaminaCliPlan({
      canvas_id: canvas.canvas_id,
      generation_type: "image",
      model_version: variant,
      resolution_type: "2k"
    });
    assert.equal(argvValue(normalized.command.argv, "--model_version"), "5.0Pro", `alias ${variant} must normalize to 5.0Pro`);
  }

  // 3) 5.0Pro 独有档位 1.5k；4k 同样合法
  for (const resolution of ["1.5k", "2k", "4k"]) {
    const planForResolution = svc.canvasDreaminaCliPlan({
      canvas_id: canvas.canvas_id,
      generation_type: "image",
      model_version: "5.0Pro",
      resolution_type: resolution
    });
    assert.equal(argvValue(planForResolution.command.argv, "--resolution_type"), resolution);
  }

  // 4) 不指定 resolution_type 时：目标规格 1920x1080 → 模型感知默认 2k（旧实现的非法 1k 不再出现）
  const defaultResolution = svc.canvasDreaminaCliPlan({ canvas_id: canvas.canvas_id, generation_type: "image" });
  assert.equal(argvValue(defaultResolution.command.argv, "--resolution_type"), "2k");
  assert.equal(defaultResolution.command.argv.includes("1k"), false);

  // 5) 未指定 model_version 时按 CLI 默认 5.0 解析，并显式写入 argv（便于 argv 自证所用模型）
  assert.equal(argvValue(defaultResolution.command.argv, "--model_version"), "5.0");

  // 6) 非法组合被拒绝
  await assert.rejects(
    () => svc.canvasDreaminaCliGenerateImage({ canvas_id: canvas.canvas_id, generation_type: "image", model_version: "5.0", resolution_type: "1.5k" }),
    /resolution_type 1.5k is not supported by model_version 5.0/
  );
  await assert.rejects(
    () => svc.canvasDreaminaCliGenerateImage({ canvas_id: canvas.canvas_id, generation_type: "image", model_version: "seedream-5.0-pro" }),
    /text2image model_version must be one of/
  );
  await assert.rejects(
    () => svc.canvasDreaminaCliGenerateImage({ canvas_id: canvas.canvas_id, generation_type: "image", model_version: "3.0", resolution_type: "4k" }),
    /resolution_type 4k is not supported by model_version 3.0/
  );

  // 7) 图像编辑（图生图）：透传 model_version 且必须带 --resolution_type
  const editPlan = svc.canvasDreaminaCliPlan({
    canvas_id: canvas.canvas_id,
    generation_type: "edit",
    model_version: "5.0Pro",
    resolution_type: "1.5k"
  });
  assert.equal(editPlan.command.kind, "image2image");
  assert.equal(argvValue(editPlan.command.argv, "--model_version"), "5.0Pro");
  assert.equal(argvValue(editPlan.command.argv, "--resolution_type"), "1.5k");
  // 上传路径必须已从内容寻址 .blob 物化为带正确扩展名的文件（实测 2026-09-20：CLI 按扩展名判定，.blob 会被拒）
  const editImageArg = argvValue(editPlan.command.argv, "--images");
  assert.equal(editImageArg.endsWith(".blob"), false, "CLI upload path must not keep the .blob extension");
  assert.equal(editImageArg.endsWith(".png"), true, `materialized upload path must carry the real media extension: ${editImageArg}`);
  assert.equal(fs.existsSync(editImageArg), true, "materialized upload file must exist on disk");
  assert.equal(fs.statSync(editImageArg).size, fs.statSync(source).size, "materialized upload file must match the source size");

  // 8) 直驱工具 dry-run
  const dryRun = await svc.canvasDreaminaCliGenerateImage({
    canvas_id: canvas.canvas_id,
    generation_type: "image",
    prompt: "a clean production test still",
    model_version: "5.0Pro",
    resolution_type: "2k",
    generate_num: 2,
    execute: false
  });
  assert.equal(dryRun.source, "canvas_dreamina_cli_image_generation");
  assert.equal(dryRun.status, "ready");
  assert.equal(dryRun.safety.image_only, true);
  assert.equal(dryRun.safety.dry_run, true);
  assert.equal(dryRun.parameters.model_version, "5.0Pro");
  assert.equal(dryRun.parameters.resolution_type, "2k");
  assert.equal(dryRun.parameters.generate_num, 2);
  assert.equal(dryRun.command.kind, "text2image");
  assert.equal(argvValue(dryRun.command.argv, "--generate_num"), "2");
  assert.equal(argvValue(dryRun.command.argv, "--model_version"), "5.0Pro");
  assert.equal(dryRun.cost_policy.some((item) => item.includes("图像生成")), true);

  // 9) 自定义宽高与 ratio 互斥（CLI 约束）→ 我们只透传自定义宽高
  const customSize = await svc.canvasDreaminaCliGenerateImage({
    canvas_id: canvas.canvas_id,
    generation_type: "image",
    model_version: "5.0Pro",
    resolution_type: "2k",
    width: 2050,
    height: 1153,
    execute: false
  });
  assert.equal(argvValue(customSize.command.argv, "--width"), "2050");
  assert.equal(argvValue(customSize.command.argv, "--height"), "1153");

  // 10) 越界守护
  await assert.rejects(
    () => svc.canvasDreaminaCliGenerateImage({ canvas_id: canvas.canvas_id, generation_type: "image", width: 2048 }),
    /width 与 height 必须同时提供/
  );
  await assert.rejects(
    () => svc.canvasDreaminaCliGenerateImage({ canvas_id: canvas.canvas_id, generation_type: "image", generate_num: 11 }),
    /generate_num must be an integer between 1 and 10/
  );
  await assert.rejects(
    () => svc.canvasDreaminaCliGenerateImage({ canvas_id: canvas.canvas_id, generation_type: "image", ratio: "5:4" }),
    /ratio must be one of/
  );
  await assert.rejects(
    () => svc.canvasDreaminaCliGenerateImage({ canvas_id: canvas.canvas_id, generation_type: "voice" }),
    /即梦图像生成工具只支持 image、cover 或 edit 生成型/
  );

  // 11) 图像放大（image_upscale）：P2 新接入
  const upscale = await svc.canvasDreaminaCliUpscaleImage({
    asset_version_id: asset.default_version_id,
    resolution_type: "8k",
    execute: false
  });
  assert.equal(upscale.source, "canvas_dreamina_cli_image_upscale");
  assert.equal(upscale.status, "ready");
  assert.equal(upscale.safety.upscale_only, true);
  assert.equal(upscale.safety.dry_run, true);
  assert.equal(upscale.parameters.resolution_type, "8k");
  assert.equal(upscale.command.kind, "image_upscale");
  assert.equal(argvValue(upscale.command.argv, "--resolution_type"), "8k");
  const upscaleArg = argvValue(upscale.command.argv, "--image");
  assert.equal(upscaleArg.endsWith(".blob"), false, "image_upscale upload path must not keep the .blob extension");
  assert.equal(upscaleArg.endsWith(".png"), true, `upscale upload path must carry the real media extension: ${upscaleArg}`);
  assert.equal(fs.existsSync(upscaleArg), true, "upscale upload file must exist on disk");

  // 12) 放大默认档与越界守护
  const upscaleDefault = await svc.canvasDreaminaCliUpscaleImage({ asset_version_id: asset.default_version_id, execute: false });
  assert.equal(upscaleDefault.parameters.resolution_type, "2k");
  const upscaleNoInput = await svc.canvasDreaminaCliUpscaleImage({ resolution_type: "2k", execute: false });
  assert.equal(upscaleNoInput.status, "blocked");
  assert.equal(upscaleNoInput.command, null);
  assert.ok(upscaleNoInput.blockers.some((item) => item.includes("asset_version_id")));
  await assert.rejects(
    () => svc.canvasDreaminaCliUpscaleImage({ asset_version_id: asset.default_version_id, resolution_type: "1k" }),
    /resolution_type must be one of: 2k, 4k, 8k/
  );

  console.log("dreamina cli image generate test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
