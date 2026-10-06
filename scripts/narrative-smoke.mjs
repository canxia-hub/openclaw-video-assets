import assert from "node:assert/strict";
import fs from "node:fs";import os from "node:os";import path from "node:path";
import { VideoAssetService } from "../src/service.js";
import { withTrustedContext,buildTrustedContext } from "../src/provider-gateway.js";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"ova-novel-"));
let service=new VideoAssetService({pluginConfig:{repositoryRoot:root,generationJobs:{providerAdapter:"none"}}}).init();
const human=buildTrustedContext({surface:"browser",actorId:"human:test",actorType:"human",trusted:true,source:"test",scopes:["operator.write"]});
const agent=buildTrustedContext({surface:"tool",actorId:"agent:test",actorType:"agent",trusted:true,source:"test",scopes:[]});
const p=service.createProject({title:"叙事运行测试"}).project_id;
const params=(input,ctx=human)=>withTrustedContext({project_id:p,...input},ctx);
const results=[];async function test(name,fn){await fn();results.push({name,passed:true});console.log("PASS "+name);}
const doc=input=>service.novelDocument(params(input));
let bible,chapter,snapshot;
await test("save registers canonical asset, taxonomy, annotation and project reference",async()=>{
  bible=await doc({op:"save",document_key:"bible",kind:"bible",title:"共享设定",body:"主角只能修门，不能凭空开门。",expected_head:null});
  assert.equal(service.getAsset({asset_id:bible.asset_id}).versions.length,1);
  assert.equal(service.db.prepare("SELECT count(*) n FROM asset_annotations WHERE target_id=?").get(bible.asset_version_id).n,1);
  assert.equal(service.listProjectRefs({project_id:p}).length,1);
});
await test("CAS conflicts never create metadata or overwrite",async()=>{
  await assert.rejects(doc({op:"save",document_key:"bible",kind:"bible",title:"共享设定",body:"错误覆盖",expected_head:null}),{code:"HEAD_CONFLICT"});
  assert.equal(service.getAsset({asset_id:bible.asset_id}).versions.length,1);
});
await test("agents cannot claim human approval",async()=>{
  await assert.rejects(service.novelDocument(params({op:"approve",document_id:bible.document_id,revision_id:bible.revision_id,expected_head:bible.revision_id},agent)),{code:"HUMAN_APPROVAL_REQUIRED"});
});
await test("human approval pins project ref",async()=>{
  await doc({op:"approve",document_id:bible.document_id,revision_id:bible.revision_id,expected_head:bible.revision_id});
  assert.equal(service.listProjectRefs({project_id:p})[0].pin_mode,"pinned");
});
await test("immutable context snapshot",async()=>{
  snapshot=await service.novelWorkflow(params({op:"context"}));
  assert.deepEqual(snapshot.canon.map(r=>r.revision_id),[bible.revision_id]);
});
await test("mandatory context never silently truncated",async()=>{
  await assert.rejects(service.novelWorkflow(params({op:"context",max_chars:1})),{code:"MANDATORY_CONTEXT_TOO_LARGE"});
});
await test("chapter save and staged approval",async()=>{
  chapter=await doc({op:"save",document_key:"chapter:1",kind:"chapter",title:"第一章",body:"他伸手扶住门框。\n门没有开。",expected_head:null,snapshot_id:snapshot.snapshot_id,dependencies:[bible.revision_id],chapter_order:1});
  await doc({op:"approve",document_id:chapter.document_id,revision_id:chapter.revision_id,expected_head:chapter.revision_id});
});
await test("project isolation rejects foreign revisions and snapshots",async()=>{
  const other=service.createProject({title:"另一个项目"}).project_id;
  await assert.rejects(service.novelDocument(withTrustedContext({project_id:other,op:"save",kind:"chapter",document_key:"a",title:"a",body:"b",expected_head:null,dependencies:[bible.revision_id]},human)),{code:"CROSS_PROJECT_REFERENCE"});
  await assert.rejects(service.novelWorkflow(withTrustedContext({project_id:other,op:"snapshot",snapshot_id:snapshot.snapshot_id},human)),{code:"CROSS_PROJECT_REFERENCE"});
});
await test("MD TXT EPUB exports are registered and pinned",async()=>{
  for(const format of ["md","txt","epub"]){
    const exported=await service.novelWorkflow(params({op:"export",format}));
    assert.equal(exported.chapters.length,1);
    const bytes=fs.readFileSync(service.resolveVersionFile(exported.asset_version_id).file_path);
    assert.ok(bytes.length>0);
    if(format==="epub"){assert.equal(bytes.readUInt32LE(0),0x04034b50);assert.equal(bytes.subarray(30,38).toString(),"mimetype");}
  }
});
let mapping;
await test("animation mapping pins chapter and canon",async()=>{
  mapping=await service.novelAdaptation(params({op:"save",document_key:"adaptation:1",title:"第一场",expected_head:null,chapter_revision_id:chapter.revision_id,snapshot_id:snapshot.snapshot_id,mapping:{scene_goal:"守住门",motivation:"保护家人",causality:"门破了",emotion:"紧张",boundaries:"不可开凭空的门",visible_action:"用手扶门框",dialogue:"别过来"}}));
  await assert.rejects(service.novelAdaptation(params({op:"handoff",document_id:mapping.document_id})),{code:"ADAPTATION_NOT_APPROVED"});
  await doc({op:"approve",document_id:mapping.document_id,revision_id:mapping.revision_id,expected_head:mapping.revision_id});
  assert.equal((await service.novelAdaptation(params({op:"handoff",document_id:mapping.document_id}))).ready,true);
});
await test("canon revision invalidates dependents, not old bodies",async()=>{
  const newer=await doc({op:"save",document_key:"bible",kind:"bible",title:"共享设定",body:"主角只能修门，代价是一天记忆。",expected_head:bible.revision_id});
  const impact=await service.novelWorkflow(params({op:"impact",revision_id:bible.revision_id}));assert.equal(impact.documents.length,2);
  await doc({op:"approve",document_id:newer.document_id,expected_head:newer.revision_id});
  assert.equal(service.narrative.documentRow({project_id:p,document_id:chapter.document_id}).needs_review,1);
  assert.equal(service.narrative.readRevision({project_id:p},bible.revision_id).body,"主角只能修门，不能凭空开门。");
  await assert.rejects(service.novelWorkflow(params({op:"export"})),{code:"APPROVED_CHAPTER_REQUIRED"});
  await assert.rejects(service.novelAdaptation(params({op:"handoff",document_id:mapping.document_id})),{code:"ADAPTATION_NOT_APPROVED"});
});
await test("paid generation is fail closed without provider I/O",async()=>{
  await assert.rejects(service.novelGenerate(params({op:"execute",job_key:"must-not-spend"})),{code:"PAID_GENERATION_DISABLED"});
});
await test("reload persists all document and export state",async()=>{
  service.close();service=new VideoAssetService({pluginConfig:{repositoryRoot:root}}).init();
  assert.equal((await doc({op:"history",document_id:bible.document_id})).length,2);
  assert.equal((await service.novelWorkflow(params({op:"exports"}))).length,3);
});
service.close();
const report={passed:results.length,failed:0,root,results,paid_calls:0,quality_evaluated:false};
if(process.env.NARRATIVE_REPORT)fs.writeFileSync(process.env.NARRATIVE_REPORT,JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
