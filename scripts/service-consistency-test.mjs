import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-consistency-"));
const repo = path.join(tmp, "repo");
const a1 = path.join(tmp, "asset-a.txt");
const a2 = path.join(tmp, "asset-b.txt");
const v2 = path.join(tmp, "asset-a-v2.txt");
await fs.promises.writeFile(a1, "asset A", "utf8");
await fs.promises.writeFile(a2, "asset B", "utf8");
await fs.promises.writeFile(v2, "asset A v2", "utf8");

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const assetA = await svc.ingestAsset({ file_path: a1, title: "A" });
  const assetB = await svc.ingestAsset({ file_path: a2, title: "B" });
  const branchB = svc.createBranch({ asset_id: assetB.asset_id, base_version_id: assetB.default_version_id, name: "b-edit" });
  const project = svc.createProject({ title: "Consistency Project" });

  assert.throws(
    () => svc.createBranch({ asset_id: assetA.asset_id, base_version_id: assetB.default_version_id, name: "bad-base" }),
    /base_version_id .* belongs to asset/
  );

  await assert.rejects(
    () => svc.createVersion({
      asset_id: assetA.asset_id,
      file_path: v2,
      branch_id: branchB.branch_id,
      change_summary: "bad branch",
      change_items: [{ summary: "bad branch" }]
    }),
    /branch_id .* belongs to asset/
  );

  await assert.rejects(
    () => svc.createVersion({
      asset_id: assetA.asset_id,
      file_path: v2,
      parent_version_id: assetB.default_version_id,
      change_summary: "bad parent",
      change_items: [{ summary: "bad parent" }]
    }),
    /parent_version_id .* belongs to asset/
  );

  assert.throws(
    () => svc.addProjectRef({ project_id: project.project_id, asset_id: assetA.asset_id, asset_version_id: assetB.default_version_id }),
    /asset_version_id .* belongs to asset/
  );

  assert.throws(
    () => svc.saveCopy({ source_asset_id: assetA.asset_id, source_version_id: assetB.default_version_id, copy_type: "working_copy" }),
    /source_version_id .* belongs to asset/
  );

  assert.throws(
    () => svc.addProjectRef({ project_id: "project_missing", asset_id: assetA.asset_id, asset_version_id: assetA.default_version_id }),
    /Project not found/
  );

  console.log("service consistency test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
