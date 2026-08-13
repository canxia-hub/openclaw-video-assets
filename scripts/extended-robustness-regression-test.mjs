import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-extended-robustness-"));
const repo = path.join(tmp, "repo");
const unicodeFile = path.join(tmp, "中文 路径 🌊.txt");
const unicodeV2 = path.join(tmp, "中文 路径 🌊 v2.txt");
const largeFile = path.join(tmp, "五兆大文件.bin");
const otherFile = path.join(tmp, "其他素材.txt");
const missingFile = path.join(tmp, "不存在的素材.txt");
await fs.promises.writeFile(unicodeFile, "中文路径、空格与 emoji 入库夹具", "utf8");
await fs.promises.writeFile(unicodeV2, "中文路径、空格与 emoji 第二版本", "utf8");
await fs.promises.writeFile(largeFile, Buffer.alloc(5 * 1024 * 1024, 0x5a));
await fs.promises.writeFile(otherFile, "其他素材", "utf8");

let svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const unicode = await svc.ingestAsset({
    file_path: unicodeFile,
    title: "中文角色参考 🌊",
    description: "验证中文路径、空格、emoji 与 Unicode 标签。",
    tags: ["中文标签", "空格 路径", "emoji-🌊"]
  });
  assert.equal(unicode.title, "中文角色参考 🌊");
  assert.deepEqual(unicode.tags, ["中文标签", "空格 路径", "emoji-🌊"]);
  assert.equal(unicode.versions[0].file_name, path.basename(unicodeFile));
  assert.equal(svc.searchAssets({ query: "中文角色参考 🌊", limit: 1 })[0]?.asset_id, unicode.asset_id);

  const large = await svc.ingestAsset({ file_path: largeFile, title: "五兆大文件元数据夹具" });
  assert.equal(large.versions[0].size_bytes, 5 * 1024 * 1024);
  assert.match(large.versions[0].sha256, /^[a-f0-9]{64}$/);

  const project = svc.createProject({ title: "陈旧引用与恢复测试" });
  const pinned = svc.addProjectRef({
    project_id: project.project_id,
    asset_id: unicode.asset_id,
    asset_version_id: unicode.default_version_id,
    pin_mode: "pinned"
  });
  const v2 = await svc.createVersion({
    asset_id: unicode.asset_id,
    file_path: unicodeV2,
    change_summary: "中文路径第二版本",
    change_items: [{ category: "content", summary: "更新 Unicode 内容" }]
  });
  assert.notEqual(v2.default_version_id, unicode.default_version_id);
  assert.equal(svc.listProjectRefs({ project_id: project.project_id })[0].asset_version_id, unicode.default_version_id);

  const other = await svc.ingestAsset({ file_path: otherFile, title: "其他素材" });
  assert.throws(
    () => svc.updateProjectRef({ reference_id: pinned.reference_id, asset_version_id: other.default_version_id }),
    /asset_version_id .* belongs to asset/
  );
  assert.equal(svc.listProjectRefs({ project_id: project.project_id })[0].asset_version_id, unicode.default_version_id);

  const countsBeforeFailure = {
    assets: svc.db.prepare("SELECT COUNT(*) AS count FROM assets").get().count,
    versions: svc.db.prepare("SELECT COUNT(*) AS count FROM asset_versions").get().count,
    commits: svc.db.prepare("SELECT COUNT(*) AS count FROM commits").get().count
  };
  await assert.rejects(() => svc.ingestAsset({ file_path: missingFile, title: "不应落库" }), /ENOENT/);
  assert.deepEqual({
    assets: svc.db.prepare("SELECT COUNT(*) AS count FROM assets").get().count,
    versions: svc.db.prepare("SELECT COUNT(*) AS count FROM asset_versions").get().count,
    commits: svc.db.prepare("SELECT COUNT(*) AS count FROM commits").get().count
  }, countsBeforeFailure);

  const versionCountBefore = svc.getAsset({ asset_id: unicode.asset_id }).versions.length;
  const defaultBefore = svc.getAsset({ asset_id: unicode.asset_id }).default_version_id;
  await assert.rejects(() => svc.createVersion({
    asset_id: unicode.asset_id,
    file_path: missingFile,
    change_summary: "不应落库",
    change_items: [{ summary: "不应落库" }]
  }), /ENOENT/);
  assert.equal(svc.getAsset({ asset_id: unicode.asset_id }).versions.length, versionCountBefore);
  assert.equal(svc.getAsset({ asset_id: unicode.asset_id }).default_version_id, defaultBefore);

  svc.removeProjectRef({ reference_id: pinned.reference_id });
  assert.throws(() => svc.updateProjectRef({ reference_id: pinned.reference_id, role: "不应复活" }), /Project reference is removed/);
  assert.equal(svc.listProjectRefs({ project_id: project.project_id }).length, 0);

  svc.close();
  svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
  assert.equal(svc.getAsset({ asset_id: unicode.asset_id }).default_version_id, defaultBefore);
  assert.equal(svc.searchAssets({ query: "中文角色参考", limit: 1 })[0]?.asset_id, unicode.asset_id);
  assert.equal(svc.getProjectDetail({ project_id: project.project_id }).project_id, project.project_id);

  await assert.rejects(
    () => svc.ingestAsset({ file_path: unicodeFile, title: "非法标签", tags: { bad: true } }),
    /tags must be an array/
  );
  await assert.rejects(
    () => svc.ingestAsset({ file_path: unicodeFile, title: "T".repeat(513) }),
    /title must not exceed 512 characters/
  );
  await assert.rejects(
    () => svc.ingestAsset({ file_path: unicodeFile, title: "描述越界", description: "D".repeat(65537) }),
    /description must not exceed 65536 characters/
  );
  await assert.rejects(
    () => svc.ingestAsset({ file_path: unicodeFile, title: "标签数量越界", tags: Array.from({ length: 65 }, (_, index) => `tag-${index}`) }),
    /tags must contain at most 64 items/
  );
  await assert.rejects(
    () => svc.ingestAsset({ file_path: unicodeFile, title: "标签长度越界", tags: ["x".repeat(129)] }),
    /tags items must not exceed 128 characters/
  );

  const maxTags = Array.from({ length: 64 }, (_, index) => `${index}-` + "标".repeat(125));
  const maxMetadata = svc.updateAssetMetadata({
    asset_id: unicode.asset_id,
    title: "题".repeat(512),
    description: "述".repeat(65536),
    tags: maxTags
  });
  assert.equal(maxMetadata.asset.title.length, 512);
  assert.equal(maxMetadata.asset.description.length, 65536);
  assert.equal(maxMetadata.asset.tags.length, 64);
  assert.equal(maxMetadata.asset.tags[0].length, 127);

  console.log(JSON.stringify({
    status: "passed",
    unicode_asset_id: unicode.asset_id,
    large_asset_id: large.asset_id,
    large_size_bytes: large.versions[0].size_bytes,
    pinned_version_preserved: unicode.default_version_id,
    current_default_version: defaultBefore,
    restart_recovered: true,
    partial_failure_atomic: true,
    metadata_limits: { title: 512, description: 65536, tags: 64, tag_length: 128 }
  }, null, 2));
} finally {
  svc.close();
  const resolvedTmp = path.resolve(tmp);
  if (!resolvedTmp.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error(`Refusing to remove non-temp path: ${resolvedTmp}`);
  await fs.promises.rm(resolvedTmp, { recursive: true, force: true });
}
