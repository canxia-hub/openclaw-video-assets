import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { VideoAssetService } from "../src/service.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-robustness-"));
const repo = path.join(tmp, "repo");
const source = path.join(tmp, "分页夹具.txt");
await fs.promises.writeFile(source, "分页、并发与锁恢复夹具", "utf8");

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
let peer = null;
try {
  const targetAsset = await svc.ingestAsset({ file_path: source, title: "唯一旧素材" });
  const targetProject = svc.createProject({ title: "唯一旧项目" });
  const targetCanvas = svc.createCanvas({ project_id: targetProject.project_id, title: "唯一旧画布" });
  const targetEntity = svc.createEntity({ entity_key: "unique_old_entity", entity_type: "prop", canonical_name: "唯一旧实体", project_id: targetProject.project_id });

  for (let index = 0; index < 8; index += 1) {
    await delay(2);
    await svc.ingestAsset({ file_path: source, title: `普通新素材 ${index}` });
    const project = svc.createProject({ title: `普通新项目 ${index}` });
    svc.createCanvas({ project_id: project.project_id, title: `普通新画布 ${index}` });
    svc.createEntity({ entity_key: `ordinary_new_entity_${index}`, entity_type: "prop", canonical_name: `普通新实体 ${index}`, project_id: project.project_id });
  }

  assert.equal(svc.searchAssets({ query: "唯一旧素材", limit: 1 })[0]?.asset_id, targetAsset.asset_id);
  assert.equal(svc.searchProjects({ query: "唯一旧项目", limit: 1 })[0]?.project_id, targetProject.project_id);
  assert.equal(svc.searchCanvases({ query: "唯一旧画布", limit: 1 })[0]?.canvas_id, targetCanvas.canvas_id);
  assert.equal(svc.searchEntities({ query: "唯一旧实体", limit: 1 })[0]?.entity_id, targetEntity.entity_id);

  const firstAssetPage = svc.searchAssets({ limit: 3, offset: 0 });
  const secondAssetPage = svc.searchAssets({ limit: 3, offset: 3 });
  assert.equal(firstAssetPage.length, 3);
  assert.equal(secondAssetPage.length, 3);
  assert.equal(firstAssetPage.some((left) => secondAssetPage.some((right) => right.asset_id === left.asset_id)), false);
  assert.throws(() => svc.searchAssets({ limit: 0 }), /limit must be an integer between 1 and 100/);
  assert.throws(() => svc.searchAssets({ offset: -1 }), /offset must be an integer between 0 and 100000/);
  assert.throws(() => svc.searchEntities({ limit: -1 }), /limit must be an integer between 1 and 100/);

  const oldProjectCommit = svc.listCommits({ target_id: targetProject.project_id, action: "project.create", query: "唯一旧项目", limit: 1 });
  assert.equal(oldProjectCommit.length, 1);
  const firstCommitPage = svc.listCommits({ limit: 5, offset: 0 });
  const secondCommitPage = svc.listCommits({ limit: 5, offset: 5 });
  assert.equal(firstCommitPage.some((left) => secondCommitPage.some((right) => right.commit_id === left.commit_id)), false);

  const concurrentAsset = await svc.ingestAsset({ file_path: source, title: "并发更新素材" });
  await Promise.all(Array.from({ length: 20 }, (_, index) => Promise.resolve().then(() => svc.updateAssetMetadata({
    asset_id: concurrentAsset.asset_id,
    description: `并发描述 ${index}`,
    tags: [`并发-${index}`]
  }))));
  const concurrentDetail = svc.getAsset({ asset_id: concurrentAsset.asset_id });
  assert.match(concurrentDetail.description, /^并发描述 \d+$/);
  assert.equal(concurrentDetail.tags.length, 1);
  assert.equal(svc.listCommits({ target_id: concurrentAsset.asset_id, action: "asset.metadata.update", limit: 100 }).length, 20);

  peer = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
  svc.db.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(
      () => peer.updateAssetMetadata({ asset_id: concurrentAsset.asset_id, description: "锁内不应落库" }),
      /database is locked/i
    );
  } finally {
    svc.db.exec("ROLLBACK");
  }
  assert.notEqual(peer.getAsset({ asset_id: concurrentAsset.asset_id }).description, "锁内不应落库");
  const recovered = peer.updateAssetMetadata({ asset_id: concurrentAsset.asset_id, description: "锁释放后恢复成功" });
  assert.equal(recovered.asset.description, "锁释放后恢复成功");

  console.log("robustness regression test passed");
} finally {
  peer?.close();
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
