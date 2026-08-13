import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-asset-meta-"));
const repo = path.join(tmp, "repo");
const source = path.join(tmp, "asset.txt");
await fs.promises.writeFile(source, "asset metadata fixture", "utf8");

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const asset = await svc.ingestAsset({
    file_path: source,
    title: "旧标题 1942公有领域",
    description: "旧描述",
    tags: ["legacy", "1942公有领域"]
  });

  const updated = svc.updateAssetMetadata({
    asset_id: asset.asset_id,
    title: "新标题：授权待复核",
    description: "已清理历史错误字样",
    tags: ["legacy", "rights-review", "rights-review", " needs-check "],
    notes: "metadata cleanup"
  });

  assert.equal(updated.asset.title, "新标题：授权待复核");
  assert.equal(updated.asset.description, "已清理历史错误字样");
  assert.deepEqual(updated.asset.tags, ["legacy", "rights-review", "needs-check"]);
  assert.deepEqual(updated.updated_fields, ["title", "description", "tags"]);

  const clearedDescription = svc.updateAssetMetadata({
    asset_id: asset.asset_id,
    description: ""
  });
  assert.equal(clearedDescription.asset.description, null);

  assert.throws(() => svc.updateAssetMetadata({ title: "missing asset" }), /asset_id is required/);
  assert.throws(() => svc.updateAssetMetadata({ asset_id: asset.asset_id }), /title, description, or tags is required/);
  assert.throws(() => svc.updateAssetMetadata({ asset_id: asset.asset_id, title: "   " }), /title must not be empty/);
  assert.throws(() => svc.updateAssetMetadata({ asset_id: asset.asset_id, tags: "not-an-array" }), /tags must be an array/);

  console.log("asset metadata test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
