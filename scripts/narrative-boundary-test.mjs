import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import * as loader from "node:module";
import { installSdkAliasHooks } from "./fixtures/sdk-alias-hooks.mjs";
import { createHostApiStub } from "./fixtures/host-api-stub.mjs";
import { hashPassword } from "../src/security.js";

installSdkAliasHooks(loader);
process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = "2026.9.7";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ova-narrative-boundary-"));
const basePath = "/__openclaw__/video-assets";
const password = "isolated-narrative-boundary-test";
let api;
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://127.0.0.1").pathname;
  const route = api.httpRoutes.filter(r => r.match === "prefix" ? pathname.startsWith(r.path) : pathname === r.path)
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!route) { res.writeHead(404); res.end("Not found"); return; }
  try { await route.handler(req, res); }
  catch (error) { res.writeHead(500); res.end(String(error.message)); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const entry = await import("../src/index.js");
api = createHostApiStub({
  pluginConfig: {
    repositoryRoot: root, auth: { enabled: true, adminPasswordHash: await hashPassword(password) },
    security: { allowedOrigins: [origin] }, generationJobs: { providerAdapter: "none" }
  }, registrationMode: "full"
});
const results = [];
let service;
let cookie;
// Use direct loopback HTTP; machine-wide outbound proxies must not intercept fixture sessions.
function localHttp(url, { method = "GET", headers = {}, body } = {}) {
  const target = new URL(url);
  assert.equal(target.origin, origin);
  return new Promise((resolve, reject) => {
    const req = http.request(target, { method, headers, agent: new http.Agent({ proxyEnv: { ...process.env, NO_PROXY: "127.0.0.1" } }) }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode,
          headers: { get: name => Array.isArray(res.headers[name]) ? res.headers[name][0] : res.headers[name] },
          json: async () => JSON.parse(bytes.toString("utf8")), arrayBuffer: async () => bytes });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}
async function request(method, params, authenticated = true) {
  const response = await localHttp(origin + basePath + "/rpc/", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin,
      ...(authenticated && cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ method, params })
  });
  return { status: response.status, body: await response.json() };
}
async function rpc(method, params) {
  const response = await request(method, params);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.ok, true, JSON.stringify(response.body));
  return response.body.result;
}
async function check(name, fn) {
  try { await fn(); results.push({ name, passed: true }); console.log("PASS " + name); }
  catch (error) { results.push({ name, passed: false, error: error.message }); console.log("FAIL " + name + ": " + error.message); }
}
try {
  entry.default.register(api);
  service = entry.getPluginService();
  // Fixture setup only; all narrative assertions are driven through the authenticated HTTP route.
  const project_id = service.createProject({ title: "Narrative HTTP boundary fixture" }).project_id;
  const params = value => ({ project_id, ...value });
  const doc = value => rpc("novel.document.write", params(value));
  const flow = value => rpc("novel.workflow.write", params(value));
  await check("anonymous narrative HTTP requests are rejected", async () => {
    assert.equal((await request("novel.document.read", params({ op: "list" }), false)).status, 401);
  });
  const login = await localHttp(origin + basePath + "/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ password })
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];
  const bible = await doc({ op: "save", document_key: "bible", kind: "bible", title: "Canon",
    body: "The protagonist repairs doors but cannot create them.", expected_head: null });
  await doc({ op: "approve", document_id: bible.document_id, expected_head: bible.revision_id });
  const snapshot = await flow({ op: "context" });
  async function chapter(key, title) {
    const saved = await doc({ op: "save", document_key: key, kind: "chapter", title, body: title + " fixture text.",
      expected_head: null, snapshot_id: snapshot.snapshot_id, dependencies: [bible.revision_id] });
    await doc({ op: "approve", document_id: saved.document_id, expected_head: saved.revision_id });
    return saved;
  }
  const first = await chapter("chapter:1", "First chapter");
  const second = await chapter("chapter:2", "Second chapter");
  const mapping = { scene_goal: "Repair the door", motivation: "Protect a friend", causality: "The hinge broke",
    emotion: "Concern", boundaries: "No magic door creation", visible_action: "Tighten the hinge", dialogue: "Hold it steady." };
  const adaptationBase = { op: "save", title: "First scene", expected_head: null,
    chapter_revision_id: first.revision_id, snapshot_id: snapshot.snapshot_id };
  let validMapping;
  const priorExport = await flow({ op: "export", format: "md" });
  await check("valid animation handoff pins its chapter and canon", async () => {
    const saved = await rpc("novel.adaptation.write", params({ ...adaptationBase, document_key: "adaptation:valid", mapping }));
    validMapping = saved;
    await doc({ op: "approve", document_id: saved.document_id, expected_head: saved.revision_id });
    const handoff = await rpc("novel.adaptation.read", params({ op: "handoff", document_id: saved.document_id }));
    assert.equal(handoff.ready, true);
    assert.equal(handoff.source_chapter.revision_id, first.revision_id);
  });
  await check("HTTP nested mapping cannot override its pinned source chapter", async () => {
    const response = await request("novel.adaptation.write", params({ ...adaptationBase,
      document_key: "adaptation:override", mapping: { ...mapping, chapter_revision_id: second.revision_id } }));
    assert.equal(response.status, 400, "mapping source override was accepted");
    assert.equal(response.body.code, "INVALID_MAPPING");
    const docs = await rpc("novel.document.read", params({ op: "list" }));
    assert.ok(!docs.some(d => d.document_key === "adaptation:override"));
  });
  await check("generic document save cannot bypass animation source dependencies", async () => {
    const response = await request("novel.document.write", params({ op: "save",
      document_key: "adaptation:raw", kind: "adaptation", title: "Invalid source binding", expected_head: null,
      snapshot_id: snapshot.snapshot_id, dependencies: [first.revision_id, bible.revision_id],
      body: JSON.stringify({ ...mapping, chapter_revision_id: second.revision_id, snapshot_id: snapshot.snapshot_id }) }));
    assert.equal(response.status, 400, "raw mapping with mismatched dependencies was accepted");
    assert.equal(response.body.code, "INVALID_MAPPING");
  });
  await check("mapping reads reject a revision belonging to another document", async () => {
    const other = await rpc("novel.adaptation.write", params({ ...adaptationBase, document_key: "adaptation:other", mapping }));
    const response = await request("novel.adaptation.read", params({ op: "get",
      document_id: validMapping.document_id, revision_id: other.revision_id }));
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "INVALID_REVISION");
  });
  // A newer draft can omit context; the still-approved older version remains snapshot-bound.
  await doc({ op: "save", document_key: "chapter:2", kind: "chapter", title: "Second chapter draft",
    body: "Unapproved draft without dependencies.", expected_head: second.revision_id });
  const character = await doc({ op: "save", document_key: "character:new", kind: "character",
    title: "New approved character", body: "The friend knows the door rule.", expected_head: null });
  await doc({ op: "approve", document_id: character.document_id, expected_head: character.revision_id });
  await check("adding approved canon marks existing snapshot-bound chapters for review", async () => {
    const d = await rpc("novel.document.read", params({ op: "get", document_id: first.document_id }));
    assert.equal(d.needs_review, 1);
    const behindDraft = await rpc("novel.document.read", params({ op: "get", document_id: second.document_id }));
    assert.equal(behindDraft.needs_review, 1);
    assert.equal(behindDraft.approved_revision_id, second.revision_id);
  });
  await check("stale chapters cannot be exported in any format and prior exports are retained", async () => {
    const before = await rpc("novel.workflow.read", params({ op: "exports" }));
    for (const format of ["txt", "md", "epub"]) {
      const response = await request("novel.workflow.write", params({ op: "export", format }));
      assert.equal(response.status, 409, format + " export accepted stale canon");
      assert.ok(["APPROVED_CHAPTER_REQUIRED", "STALE_SNAPSHOT"].includes(response.body.code));
    }
    assert.equal((await rpc("novel.workflow.read", params({ op: "exports" }))).length, before.length);
    assert.ok(before.length > 0);
    const previous = await localHttp(origin + basePath + "/file/" + priorExport.asset_version_id, { headers: { Cookie: cookie } });
    assert.equal(previous.status, 200);
    assert.match(Buffer.from(await previous.arrayBuffer()).toString("utf8"), /First chapter fixture text/);
  });
  const current = await flow({ op: "context" });
  const refs = await rpc("novel.workflow.read", params({ op: "sources" }));
  const sourceRef = refs.find(ref => ref.asset_id === first.asset_id);
  const resourceSnapshot = await flow({ op: "context", reference_ids: [sourceRef.reference_id] });
  const resourceBound = await doc({ op: "save", document_key: "chapter:resource", kind: "chapter",
    title: "Resource-bound chapter", body: "A chapter uses a fixed source resource.", expected_head: null,
    snapshot_id: resourceSnapshot.snapshot_id, dependencies: [bible.revision_id, character.revision_id] });
  await doc({ op: "approve", document_id: resourceBound.document_id, expected_head: resourceBound.revision_id });
  const revised = await doc({ op: "save", document_key: "chapter:1", kind: "chapter", title: "First chapter reviewed",
    body: "A reviewed chapter with the new character.", expected_head: first.revision_id,
    snapshot_id: current.snapshot_id, dependencies: [bible.revision_id, character.revision_id] });
  await doc({ op: "approve", document_id: revised.document_id, expected_head: revised.revision_id });
  await check("reference drift blocks export even without a canon review flag", async () => {
    const d = await rpc("novel.document.read", params({ op: "get", document_id: resourceBound.document_id }));
    assert.equal(d.needs_review, 0);
    const response = await request("novel.workflow.write", params({ op: "export", format: "md",
      revision_ids: [resourceBound.revision_id] }));
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "STALE_SNAPSHOT");
  });
  for (const format of ["txt", "md", "epub"]) {
    await check("reviewed " + format.toUpperCase() + " export is registered and downloads over HTTP", async () => {
      const exported = await flow({ op: "export", format, revision_ids: [revised.revision_id] });
      const download = await localHttp(origin + basePath + "/file/" + exported.asset_version_id, { headers: { Cookie: cookie } });
      assert.equal(download.status, 200);
      const bytes = Buffer.from(await download.arrayBuffer());
      assert.ok(bytes.length > 0);
      if (format === "epub") {
        assert.equal(download.headers.get("content-type"), "application/epub+zip");
        assert.equal(bytes.readUInt32LE(0), 0x04034b50);
      } else assert.match(bytes.toString("utf8"), /A reviewed chapter/);
    });
  }
} finally {
  await new Promise(resolve => server.close(resolve));
  for (const registered of api.services) await registered.stop();
}
const report = { passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length,
  results, real_provider_calls: 0, surface: "authenticated HTTP using production plugin entry with isolated host fixture",
  gateway_loader_verified: false, root };
const reportIndex = process.argv.indexOf("--report");
if (reportIndex >= 0) fs.writeFileSync(process.argv[reportIndex + 1], JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (report.failed && !process.argv.includes("--probe")) process.exitCode = 1;
