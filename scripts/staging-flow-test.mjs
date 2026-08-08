import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-staging-flow-"));
const repo = path.join(tmp, "repo");

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const uploaded = await svc.uploadStagingFile({
    file_name: "sample upload.txt",
    content_base64: Buffer.from("staging upload smoke", "utf8").toString("base64"),
    actor_id: "test:staging"
  });
  assert.equal(uploaded.root_key, "asset-staging");
  assert.equal(uploaded.binding_state, "unbound");
  assert.match(uploaded.relative_path, /sample upload\.txt$/);

  const listed = await svc.listFiles({ root_key: "asset-staging" });
  assert.ok(listed.entries.some((entry) => entry.relative_path === uploaded.relative_path));

  const ingested = await svc.ingestStagingFile({
    relative_path: uploaded.relative_path,
    title: "Staged Asset",
    actor_id: "test:staging"
  });
  assert.equal(ingested.ok, true);
  assert.equal(ingested.asset.title, "Staged Asset");
  assert.ok(ingested.asset.default_version_id);
  assert.equal(ingested.file.binding_state, "bound");

  const rejectedUpload = await svc.uploadStagingFile({
    file_name: "reject-me.txt",
    content_base64: Buffer.from("reject smoke", "utf8").toString("base64"),
    actor_id: "test:staging"
  });
  const rejected = await svc.rejectStagingFile({
    relative_path: rejectedUpload.relative_path,
    reason: "smoke test",
    actor_id: "test:staging"
  });
  assert.equal(rejected.rejected, true);
  await assert.rejects(() => svc.inspectFile({ root_key: "asset-staging", relative_path: rejectedUpload.relative_path }), /ENOENT|no such file/i);

  await assert.rejects(() => svc.uploadStagingFile({
    file_name: "escape.txt",
    relative_path: "../metadata",
    content_base64: Buffer.from("x", "utf8").toString("base64")
  }), /inside the selected root/);
  await assert.rejects(() => svc.rejectStagingFile({ relative_path: "../metadata/video-assets.sqlite" }), /inside the selected root/);

  const commits = svc.listCommits({ scope: "system", query: "staging", limit: 10 });
  assert.ok(commits.some((commit) => commit.action === "staging.upload"));
  assert.ok(commits.some((commit) => commit.action === "staging.ingest"));
  assert.ok(commits.some((commit) => commit.action === "staging.reject"));

  console.log("staging flow test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
