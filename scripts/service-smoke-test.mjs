import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-service-"));
const repo = path.join(tmp, "repo");
const sourceV1 = path.join(tmp, "sample-v1.txt");
const sourceV2 = path.join(tmp, "sample-v2.txt");
await fs.promises.writeFile(sourceV1, "hello asset v1", "utf8");
await fs.promises.writeFile(sourceV2, "hello asset v2", "utf8");

const svc = await new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const asset = await svc.ingestAsset({ file_path: sourceV1, kind: "raw", title: "sample" });
  const branch = svc.createBranch({ asset_id: asset.asset_id, base_version_id: asset.default_version_id, name: "edit-test" });
  await svc.createVersion({
    asset_id: asset.asset_id,
    file_path: sourceV2,
    branch_id: branch.branch_id,
    change_summary: "Edited text sample",
    change_items: [{ category: "metadata", summary: "Changed sample body", tool: "manual" }]
  });
  const copy = svc.saveCopy({ source_asset_id: asset.asset_id, source_version_id: asset.default_version_id, copy_type: "working_copy", reason: "Smoke test copy" });
  const project = svc.createProject({ title: "Smoke Project" });
  svc.addProjectRef({ project_id: project.project_id, asset_id: asset.asset_id, role: "reference" });
  const lineage = svc.lineage({ asset_id: asset.asset_id });
  const resolved = svc.resolveVersionFile(asset.default_version_id);

  assert.equal(lineage.versions.length, 2);
  assert.equal(lineage.branches.length, 2);
  assert.ok(copy.asset_id);
  assert.equal(svc.listProjectRefs({ project_id: project.project_id }).length, 1);
  assert.equal(await fs.promises.readFile(resolved.file_path, "utf8"), "hello asset v1");
  assert.match(resolved.file_path, /objects[\\/]sha256/);
  console.log("service smoke test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
