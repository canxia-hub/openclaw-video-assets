import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";
import { CliBridge } from "../src/cli-bridge.js";
import { withTrustedContext } from "../src/provider-gateway.js";

const nodeFlags=[{name:"node-id",type:"string"},{name:"submit-id",type:"string"},{name:"credit-token",type:"string"},{name:"run",type:"boolean"},{name:"title",type:"string"},{name:"prompt",type:"string"}];
const schema={ok:true,data:{command:"dreamina-canvas",subcommands:[
 {name:"version",reads:true,writes:false,flags:[]},
 {name:"node",subcommands:[
  {name:"run",reads:true,writes:true,flags:nodeFlags},
  {name:"create",subcommands:[{name:"image",reads:true,writes:true,flags:nodeFlags}]},
  {name:"delete",subcommands:[{name:"confirm",reads:true,writes:true,flags:[{name:"node-id",type:"string"},{name:"project-id",type:"string"}]}]}
 ]}
]}};
const ctx={trusted:true,actor_id:"agent:tuan",actor_type:"agent",surface:"tool",scopes:["operator.write"],source:"test-host"};
const trusted=args=>withTrustedContext(args,ctx);
function setup(t,{config={},runner:override}={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"ova-cli-"));
 const svc=new VideoAssetService({pluginConfig:{repositoryRoot:dir,security:{generation:{mode:"enforce",allowSurfaces:["tool"],allowActors:["agent:tuan"],requireOperatorScope:false,ledger:"memory",budget:{totalCredits:50,estimates:{"dreamina.cli.execute":5,"dreamina.canvas.execute":5}}}},...config}});
 svc.init();const calls=[];
 const runner=async(exe,argv,opts)=>{calls.push({exe,argv});if(argv.includes("schema"))return{stdout:JSON.stringify(schema)};if(override)return override(exe,argv,opts);return{stdout:JSON.stringify(exe.includes("dreamina-canvas")?{ok:true,data:{submitId:"fixed",nodeId:"node_test"}}:{gen_status:"querying",submit_id:"fixed"})};};
 const cli=new CliBridge({service:svc,runner});
 t.after(()=>{svc.close();fs.rmSync(dir,{recursive:true,force:true});});return{svc,cli,calls};
}
test("both CLI plans require no provider I/O and no internal canvas",async t=>{
 const{cli,calls,svc}=setup(t);
 for(const provider of["dreamina","dreamina_canvas"]) {
  const r=await cli.run(provider,{command:"version"});assert.equal(r.status,"planned");assert.equal(r.frontend_required,false);assert.equal(r.internal_canvas_required,false);
 }
 assert.equal(calls.length,0);assert.equal(svc.db.prepare("SELECT count(*) n FROM cli_bridge_operations").get().n,0);
});
test("paid legacy command cannot be smuggled through a read command or shell",async t=>{
 const{cli,calls}=setup(t);
 await assert.rejects(cli.run("dreamina",{command:"version; text2video",execute:true}),{code:"CLI_COMMAND_INVALID"});
 await assert.rejects(cli.run("dreamina",{command:"session delete; user_credit",execute:true}),{code:"CLI_COMMAND_INVALID"});
 assert.equal(calls.length,0);
});
test("untrusted actor and missing consent make zero paid calls",async t=>{
 const{cli,calls}=setup(t);
 await assert.rejects(cli.run("dreamina",{command:"text2image",execute:true,operation_key:"a",accept_credit_spend:true}),{code:"CLI_TRUSTED_ACTOR_REQUIRED"});
 await assert.rejects(cli.run("dreamina",trusted({command:"text2image",execute:true,operation_key:"b"})),{code:"CLI_CREDIT_CONFIRMATION_REQUIRED"});
 assert.equal(calls.length,0);
});
test("unknown plugin budget cost blocks even with credit acceptance",async t=>{
 const{cli,calls}=setup(t,{config:{security:{generation:{mode:"enforce",allowSurfaces:["tool"],allowActors:["agent:tuan"],requireOperatorScope:false,ledger:"memory",budget:{totalCredits:50,estimates:{}}}}}});
 const r=await cli.run("dreamina",trusted({command:"text2image",argv:["--prompt","test","--resolution_type","2k"],execute:true,operation_key:"missing-price",accept_credit_spend:true}));
 assert.equal(r.status,"blocked");assert.equal(calls.filter(c=>c.argv.includes("text2image")).length,0);
});
test("legacy submission is asynchronous and stable key never submits twice",async t=>{
 const{cli,calls,svc}=setup(t);
 const args=trusted({command:"text2image",argv:["--prompt","test","--resolution_type","2k"],execute:true,operation_key:"one",accept_credit_spend:true});
 const first=await cli.run("dreamina",args),again=await cli.run("dreamina",args);
 assert.equal(first.status,"submitted");assert.equal(again.reused,true);
 const submits=calls.filter(c=>c.argv.includes("text2image"));assert.equal(submits.length,1);assert.ok(submits[0].argv.includes("--poll=0"));
 const row=svc.db.prepare("SELECT * FROM cli_bridge_operations").get();assert.ok(!JSON.stringify(row).includes("prompt"));assert.equal(row.actor_id,"agent:tuan");
 await assert.rejects(cli.run("dreamina",trusted({...args,argv:["--prompt","different"]})),{code:"CLI_OPERATION_KEY_CONFLICT"});
});
test("uncertain submit is durably retained and replay does not submit",async t=>{
 const{cli,calls}=setup(t,{runner:async(exe,argv)=>{if(argv[0]==="user_credit")return{stdout:"{}"};throw Object.assign(new Error("transport ended after dispatch"),{code:"CLI_OUTCOME_UNCERTAIN"});}});
 const args=trusted({command:"text2video",argv:["--prompt","test"],execute:true,operation_key:"timeout",accept_credit_spend:true});
 await assert.rejects(cli.run("dreamina",args),{code:"CLI_OUTCOME_UNCERTAIN"});
 const again=await cli.run("dreamina",args);assert.equal(again.status,"uncertain");assert.equal(again.reused,true);assert.equal(calls.filter(c=>c.argv.includes("text2video")).length,1);
});
test("official --run cannot bypass credit confirmation and singleton flags cannot be overridden",async t=>{
 const{cli,calls}=setup(t);
 await assert.rejects(cli.run("dreamina_canvas",trusted({command:"node create image",argv:["--run"],execute:true,operation_key:"hidden-run"})),{code:"CLI_CREDIT_CONFIRMATION_REQUIRED"});
 await assert.rejects(cli.run("dreamina_canvas",{command:"node create image",argv:["--run=false","--run=true"]}),{code:"CLI_FLAG_DUPLICATE"});
 await assert.rejects(cli.run("dreamina_canvas",{command:"node create image",argv:["--yes"]}),{code:"CLI_FLAG_UNKNOWN"});
 assert.equal(calls.length,0);
});
test("official paid run refreshes live schema and requires a stable submit-id",async t=>{
 const{cli,calls}=setup(t);
 await assert.rejects(cli.run("dreamina_canvas",trusted({command:"node run",argv:["--node-id","node_test","--credit-token","token"],execute:true,operation_key:"no-id",accept_credit_spend:true})),{code:"CLI_SUBMIT_ID_REQUIRED"});
 assert.equal(calls.filter(c=>c.argv.includes("run")).length,0);
 const args=trusted({command:"node run",argv:["--node-id","node_test","--submit-id","11111111-1111-4111-8111-111111111111","--credit-token","token"],execute:true,operation_key:"official-one",accept_credit_spend:true});
 const r=await cli.run("dreamina_canvas",args);assert.equal(r.status,"submitted");assert.equal(r.identities.nodeId,"node_test");
 await cli.run("dreamina_canvas",args);assert.equal(calls.filter(c=>c.argv.includes("run")).length,1);
});
test("provider command deletion requires its own explicit confirmation",async t=>{
 const{cli,calls}=setup(t);
 await assert.rejects(cli.run("dreamina_canvas",trusted({command:"node delete confirm",argv:["--node-id","node_test"],execute:true,operation_key:"delete"})),{code:"CLI_DESTRUCTIVE_CONFIRMATION_REQUIRED"});
 assert.equal(calls.length,0);
});
test("official schema changes fail closed before a mutation",async t=>{
 const{cli,calls}=setup(t);
 cli.liveCatalog=async()=>new Map([["version",{reads:true,writes:true,flags:[]}]]);
 await assert.rejects(cli.run("dreamina_canvas",{command:"version",execute:true}),{code:"CLI_SCHEMA_CHANGED"});
 assert.equal(calls.length,0);
});
test("the two profiles cannot mix credential/region arguments",async t=>{
 const{cli}=setup(t);
 await assert.rejects(cli.run("dreamina",{command:"version",profile:"default"}),{code:"CLI_PROFILE_MISMATCH"});
 await assert.rejects(cli.run("dreamina_canvas",{command:"version",profile:"../other"}),{code:"CLI_PROFILE_INVALID"});
});

test("a false help flag cannot reclassify paid commands as reads",async t=>{
 const{cli,calls}=setup(t);
 await assert.rejects(cli.run("dreamina",trusted({command:"text2image",argv:["--help=false"],execute:true,operation_key:"false-help"})),{code:"CLI_CREDIT_CONFIRMATION_REQUIRED"});
 await assert.rejects(cli.run("dreamina_canvas",trusted({command:"node run",argv:["--help=false"],execute:true,operation_key:"false-help-official"})),{code:"CLI_CREDIT_CONFIRMATION_REQUIRED"});
 assert.equal(calls.length,0);
});

test("simultaneous calls with one key submit once",async t=>{
 const{cli,calls}=setup(t);const a=trusted({command:"text2image",argv:["--prompt","test"],execute:true,operation_key:"parallel",accept_credit_spend:true});
 const results=await Promise.all([cli.run("dreamina",a),cli.run("dreamina",a)]);
 assert.equal(results.filter(x=>x.reused).length,1);assert.equal(calls.filter(c=>c.argv.includes("text2image")).length,1);
});
test("restart reuses durable outcome without another provider call",async t=>{
 const{cli,svc}=setup(t);const a=trusted({command:"text2image",argv:["--prompt","test"],execute:true,operation_key:"restart",accept_credit_spend:true});
 await cli.run("dreamina",a);let invoked=0;const restarted=new CliBridge({service:svc,runner:async()=>{invoked++;throw Error("must not dispatch");}});
 const r=await restarted.run("dreamina",a);assert.equal(r.reused,true);assert.equal(invoked,0);
});
