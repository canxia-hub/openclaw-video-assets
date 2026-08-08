import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";
import { getObjectPath } from "../src/storage.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-derived-integrity-"));
const repo = path.join(tmp, "repo");
const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();

try {
  const sourcePath = path.join(tmp, "source.txt");
  const thumbPath = path.join(tmp, "thumb.txt");
  await fs.promises.writeFile(sourcePath, "source fixture", "utf8");
  await fs.promises.writeFile(thumbPath, "thumbnail fixture", "utf8");

  const asset = await svc.ingestAsset({ file_path: sourcePath, title: "Derived Integrity Source", kind: "working" });
  const derived = await svc.registerDerivedFile({
    asset_id: asset.asset_id,
    asset_version_id: asset.default_version_id,
    file_path: thumbPath,
    derivative_type: "thumbnail",
    profile: "tiny-text-fixture",
    metadata: { width_hint: 64, generated_by: "test" }
  });

  assert.equal(derived.derivative_type, "thumbnail");
  assert.equal(derived.profile, "tiny-text-fixture");
  assert.equal(derived.metadata.generated_by, "test");

  const listed = svc.listDerivedFiles({ asset_id: asset.asset_id, asset_version_id: asset.default_version_id });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].derived_file_id, derived.derived_file_id);

  const resolvedByDerivedId = svc.resolveDerivedFile(derived.derived_file_id, ["thumbnail", "contact_sheet"]);
  assert.equal(resolvedByDerivedId.derived_file_id, derived.derived_file_id);
  assert.equal(resolvedByDerivedId.derivative_type, "thumbnail");
  assert.match(resolvedByDerivedId.file_path, /\.blob$/);

  const resolvedByVersionId = svc.resolveDerivedFile(asset.default_version_id, ["thumbnail"]);
  assert.equal(resolvedByVersionId.derived_file_id, derived.derived_file_id);
  assert.throws(() => svc.resolveDerivedFile(derived.derived_file_id, ["proxy"]), /not one of/);

  const cleanScan = svc.integrityScan({ deep: true });
  assert.equal(cleanScan.ok, true, JSON.stringify(cleanScan, null, 2));
  assert.equal(cleanScan.issues.length, 0, JSON.stringify(cleanScan, null, 2));
  assert.equal(cleanScan.scanned.derived_files, 1);

  await fs.promises.rm(getObjectPath(repo, derived.object_id), { force: true });
  const brokenScan = svc.integrityScan({ deep: false });
  assert.equal(brokenScan.ok, false, JSON.stringify(brokenScan, null, 2));
  assert.ok(brokenScan.errors.some((issue) => issue.code === "DERIVED_OBJECT_MISSING" && issue.derived_file_id === derived.derived_file_id), JSON.stringify(brokenScan, null, 2));

  console.log("derived integrity test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
