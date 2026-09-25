import assert from "node:assert/strict";
import { dreaminaModelCatalog, VideoAssetService } from "../src/service.js";

// 本用例锁定「即梦模型规格表」与 CLI 实测矩阵的一致性。
// 规格来源：dreamina CLI 1.4.18（build ec1b9fa）各子命令 `--help` 实测输出（2026-09-20）。
// CLI 升级后若支持集合变化，请重跑 `dreamina <cmd> --help` 并同步更新下方期望值。

const EXPECTED_VIDEO = {
  "seedance2.5": { generation_types: ["text_to_video", "image_to_video", "multimodal_to_video"], duration: [4, 30], resolutions: ["480p", "720p", "1080p"], vip_only: true },
  "seedance2.0": { generation_types: ["text_to_video", "image_to_video", "multimodal_to_video"], duration: [4, 15], resolutions: ["720p"] },
  "seedance2.0fast": { generation_types: ["text_to_video", "image_to_video", "multimodal_to_video"], duration: [4, 15], resolutions: ["720p"] },
  "seedance2.0_vip": { generation_types: ["text_to_video", "image_to_video", "multimodal_to_video"], duration: [4, 15], resolutions: ["720p", "1080p", "4k"] },
  "seedance2.0fast_vip": { generation_types: ["text_to_video", "image_to_video", "multimodal_to_video"], duration: [4, 15], resolutions: ["720p", "1080p"] },
  "seedance2.0mini": { generation_types: ["text_to_video", "image_to_video", "multimodal_to_video"], duration: [4, 15], resolutions: ["720p"] },
  "seedance1.5pro": { generation_types: ["image_to_video"], duration: [5, 12], resolutions: ["720p"] },
  "seedance1.0fast": { generation_types: ["image_to_video"], duration: [5, 10], resolutions: ["720p"] },
  "3.5pro": { generation_types: ["image_to_video"], duration: [4, 12], resolutions: ["720p"] },
  "3.5_pro": { generation_types: ["image_to_video"], duration: [4, 12], resolutions: ["720p"] },
  "3.0fast": { generation_types: ["image_to_video"], duration: [3, 10], resolutions: ["720p"] },
  "3.0pro": { generation_types: ["image_to_video"], duration: [3, 10], resolutions: ["720p"] },
  "3.0_fast": { generation_types: ["image_to_video"], duration: [3, 10], resolutions: ["720p"] },
  "3.0_pro": { generation_types: ["image_to_video"], duration: [3, 10], resolutions: ["720p"] }
};

const EXPECTED_IMAGE_MODELS = ["3.0", "3.1", "4.0", "4.1", "4.5", "4.6", "4.7", "5.0", "5.0Pro"];

assert.deepEqual([...dreaminaModelCatalog.video.models].sort(), Object.keys(EXPECTED_VIDEO).sort(), "video model list must match the CLI matrix");
assert.deepEqual([...dreaminaModelCatalog.image.models].sort(), [...EXPECTED_IMAGE_MODELS].sort(), "image model list must match the CLI matrix");

assert.deepEqual([...dreaminaModelCatalog.video.resolutions].sort(), ["1080p", "480p", "4k", "720p"].sort(), "video resolutions must be derived from the spec table");
assert.deepEqual([...dreaminaModelCatalog.image.resolutions].sort(), ["1.5k", "1k", "2k", "4k"].sort(), "image resolution types must include the 5.0Pro 1.5k tier");
assert.deepEqual([...dreaminaModelCatalog.image.upscale_resolutions].sort(), ["2k", "4k", "8k"].sort(), "image_upscale must expose exactly 2k/4k/8k");
assert.deepEqual([...dreaminaModelCatalog.video.ratios].sort(), ["1:1", "3:4", "16:9", "4:3", "9:16", "21:9"].sort(), "video ratios must stay at the 6 CLI values");
assert.deepEqual([...dreaminaModelCatalog.image.ratios].sort(), ["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"].sort(), "image ratios must include 3:2 and 2:3");
assert.deepEqual([...dreaminaModelCatalog.image.generation_types].sort(), ["cover", "edit", "image"].sort(), "image generation types must stay bounded");

assert.equal(typeof VideoAssetService.prototype.canvasDreaminaCliGenerateImage, "function", "canvas image generation method must exist");

// 5.0Pro 是 CLI 原值（大写 P）：规格表必须保留原值，不得写成 seedream-5.0-pro 之类自造名。
assert.ok(dreaminaModelCatalog.image.models.includes("5.0Pro"), "5.0Pro must be exposed with the CLI spelling");
assert.equal(dreaminaModelCatalog.image.models.some((model) => model.toLowerCase() === "seedream-5.0-pro"), false, "no invented Seedream alias may enter the catalog");

// 后端 version 白名单核验（2026-09-20 实测）：“3.0”裸值不在 image2video 白名单，已从规格表移除；
// 而 3.0fast / 3.0_fast / 3.0pro / 3.0_pro / 3.5pro / 3.5_pro 仍在白名单内，必须保留（legacy 可用，勿误删）。
assert.equal(dreaminaModelCatalog.video.models.includes("3.0"), false, "bare '3.0' is rejected by the backend version whitelist and must stay out of the catalog");
for (const legacy of ["3.0fast", "3.0_fast", "3.0pro", "3.0_pro", "3.5pro", "3.5_pro"]) {
  assert.ok(dreaminaModelCatalog.video.models.includes(legacy), `legacy model ${legacy} is still accepted by the backend and must remain available`);
}
// 4k 仅 seedance2.0_vip 可用（CLI help 与后端一致）
assert.ok(dreaminaModelCatalog.video.resolutions.includes("4k"), "4k must be exposed now that seedance2.0_vip supports it");
assert.equal(dreaminaModelCatalog.video.models.some((model) => model.includes("4k")), false, "4k is a resolution tier, not a model name");
assert.equal(typeof VideoAssetService.prototype.canvasDreaminaCliUpscaleImage, "function", "canvas image upscale method must exist");

console.log("dreamina video/image model spec test passed");
