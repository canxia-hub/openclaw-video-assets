import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-ref-life-"));
const repo = path.join(tmp, "repo");
const a1 = path.join(tmp, "a1.txt");
const a2 = path.join(tmp, "a2.txt");
await fs.promises.writeFile(a1, "asset A", "utf8");
await fs.promises.writeFile(a2, "asset B", "utf8");

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const assetA = await svc.ingestAsset({ file_path: a1, title: "A" });
  const assetB = await svc.ingestAsset({ file_path: a2, title: "B" });
  const project = svc.createProject({ title: "Reference Lifecycle" });
  const ref = svc.addProjectRef({ project_id: project.project_id, asset_id: assetA.asset_id, asset_version_id: assetA.default_version_id, pin_mode: "candidate", role: "reference" });

  assert.equal(svc.listProjectRefs({ project_id: project.project_id }).length, 1);

  const updated = svc.updateProjectRef({ reference_id: ref.reference_id, asset_id: assetB.asset_id, pin_mode: "pinned", role: "source", required: false, notes: "promoted through service" });
  assert.equal(updated.asset_id, assetB.asset_id);
  assert.equal(updated.asset_version_id, assetB.default_version_id);
  assert.equal(updated.pin_mode, "pinned");
  assert.equal(updated.required, 0);

  assert.throws(
    () => svc.updateProjectRef({ reference_id: ref.reference_id, asset_id: assetA.asset_id, asset_version_id: assetB.default_version_id }),
    /asset_version_id .* belongs to asset/
  );

  const removed = svc.removeProjectRef({ reference_id: ref.reference_id });
  assert.deepEqual(removed, { reference_id: ref.reference_id, status: "removed" });
  assert.equal(svc.listProjectRefs({ project_id: project.project_id }).length, 0);
  assert.throws(() => svc.updateProjectRef({ reference_id: ref.reference_id, notes: "should fail" }), /removed/);

  console.log("project ref lifecycle test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
