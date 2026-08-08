import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-file-api-"));
const repo = path.join(tmp, "repo");
const source = path.join(tmp, "asset.txt");
await fs.promises.writeFile(source, "file api smoke", "utf8");

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const asset = await svc.ingestAsset({ file_path: source, title: "File API Smoke" });
  const project = svc.createProject({ title: "File API Project", target_platforms: ["douyin"] });
  svc.addProjectRef({ project_id: project.project_id, asset_id: asset.asset_id, asset_version_id: asset.default_version_id });

  const roots = svc.fileRoots();
  assert.ok(roots.some((root) => root.root_key === "asset-raw"));

  const projects = svc.searchProjects({ query: "File API", limit: 10 });
  assert.equal(projects.length, 1);
  assert.equal(projects[0].ref_count, 1);

  const detail = svc.getProjectDetail({ project_id: project.project_id });
  assert.equal(detail.refs.length, 1);
  assert.equal(detail.target_platforms[0], "douyin");

  const raw = await svc.listFiles({ root_key: "asset-raw" });
  assert.deepEqual(raw.entries, []);

  const objectFile = await svc.listFiles({ root_key: "asset-derived", relative_path: "" });
  assert.equal(Array.isArray(objectFile.entries), true);

  const objectPath = svc.resolveVersionFile(asset.default_version_id).file_path;
  const objectRelative = path.relative(path.join(repo, "asset-repo", "objects", "sha256"), objectPath).replaceAll("\\", "/");
  const inspected = await svc.inspectFile({ root_key: "asset-objects", relative_path: objectRelative }).catch((error) => error);
  assert.match(String(inspected.message), /Unknown file root/);

  assert.throws(() => svc.resolveAllowedFilePath("asset-raw", "../metadata"), /inside the selected root/);
  assert.throws(() => svc.resolveAllowedFilePath("asset-raw", path.resolve(repo, "metadata")), /inside the selected root/);

  console.log("file api test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
