import assert from "node:assert/strict";import fs from "node:fs";import os from "node:os";import path from "node:path";
import {VideoAssetService} from "../src/service.js";import {narrativeRpc} from "../src/narrative-contract.js";import {withTrustedContext,buildTrustedContext} from "../src/provider-gateway.js";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"ova-narrative-headless-boundary-"));
const service=new VideoAssetService({pluginConfig:{repositoryRoot:root}}).init();
const handlers=narrativeRpc(service),results=[];
const context=buildTrustedContext({surface:"gateway",actorId:"human:test",actorType:"human",trusted:true,source:"isolated-host",scopes:["operator.write"]});
async function request(method,params){try{const result=await handlers["videoAssets."+method].handler(withTrustedContext(params,context));return{status:200,body:{ok:true,result}};}catch(e){return{status:e.status??400,body:{ok:false,code:e.code,error:e.message}};}}
async function rpc(method,params){const r=await request(method,params);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.result;}
async function check(name, fn) {
  try { await fn(); results.push({ name, passed: true }); console.log("PASS " + name); }
  catch (error) { results.push({ name, passed: false, error: error.message }); console.log("FAIL " + name + ": " + error.message); }
}
try {
  // Business boundary assertions use headless RPC dispatch, not a web server.
  const project_id = service.createProject({ title: "Narrative HTTP boundary fixture" }).project_id;
  const params = value => ({ project_id, ...value });
  const doc = value => rpc("novel.document.write", params(value));
  const flow = value => rpc("novel.workflow.write", params(value));
  await check("read-only RPC cannot write documents",async()=>{const r=await request("novel.document.read",params({op:"save"}));assert.equal(r.status,403);assert.equal(r.body.code,"OPERATION_SCOPE_MISMATCH");});
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
  await check("headless nested mapping cannot override its pinned source chapter", async () => {
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
    const previous = fs.readFileSync(service.resolveVersionFile(priorExport.asset_version_id).file_path);
    assert.match(previous.toString("utf8"), /First chapter fixture text/);
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
    await check("reviewed " + format.toUpperCase() + " export is registered and readable locally", async () => {
      const exported = await flow({ op: "export", format, revision_ids: [revised.revision_id] });
      const resolved=service.resolveVersionFile(exported.asset_version_id);
      const bytes=fs.readFileSync(resolved.file_path);
      assert.ok(bytes.length > 0);
      if (format === "epub") {
        assert.equal(resolved.mime_type, "application/epub+zip");
        assert.equal(bytes.readUInt32LE(0), 0x04034b50);
      } else assert.match(bytes.toString("utf8"), /A reviewed chapter/);
    });
  }
} finally {
  service.close();
  fs.rmSync(root,{recursive:true,force:true});
}
const report = { passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length,
  results, real_provider_calls: 0, surface: "headless narrative RPC business boundary with trusted host fixture",
  gateway_loader_verified: false, root };
const reportIndex = process.argv.indexOf("--report");
if (reportIndex >= 0) fs.writeFileSync(process.argv[reportIndex + 1], JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (report.failed && !process.argv.includes("--probe")) process.exitCode = 1;
