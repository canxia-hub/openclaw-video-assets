import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHostApiStub } from "./fixtures/host-api-stub.mjs";
process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = "2026.9.7";
const {default:entry,getPluginService,getHeadlessReport}=await import("../src/index.js");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"ova-headless-"));
try {
  const manifest=JSON.parse(fs.readFileSync(new URL("../openclaw.plugin.json",import.meta.url)));
  const api=createHostApiStub({pluginConfig:{repositoryRoot:dir},defaultToolContext:{agentId:"tuan",sessionKey:"agent:tuan:headless-test",senderIsOwner:true},restArgsRegisterTool:true});
  await entry.register(api);
  assert.equal(api.tools.length,40);
  assert.deepEqual(api.tools.map(x=>x.definition.name).sort(),manifest.contracts.tools.slice().sort());
  assert.equal(api.httpRoutes.length,0); assert.equal(api.resources.length,0);
  assert.equal(api.services.length,1);
  assert.ok(api.tools.every(x=>!x.definition.name.includes("video_canvas_")&&!x.definition.name.includes("widget")));
  assert.ok(api.tools.every(x=>x.factory && !Object.hasOwn(x.definition.parameters.properties,"canvas_id")));
  assert.ok(api.gatewayMethods.every(x=>!x.method.includes(".canvas.")&&!x.method.includes(".ui.")));
  const official=api.tools.find(x=>x.definition.name==="video_dreamina_canvas_cli").definition;
  const plan=await official.execute("t",{command:"node create text",argv:["--title","test","--text","hello"]});
  const payload=JSON.parse(plan.content[0].text);
  assert.equal(payload.status,"planned");assert.equal(payload.frontend_required,false);
  const bad=await official.execute("bad",{command:"unknown-command"});assert.equal(bad.isError,true);assert.equal(JSON.parse(bad.content[0].text).code,"CLI_COMMAND_UNKNOWN");
  // A plan does not submit, write a draft, or create an operation journal row.
  assert.equal(getPluginService().db.prepare("SELECT count(*) AS n FROM cli_bridge_operations").get().n,0);
  getPluginService().close();
  const api2=createHostApiStub({pluginConfig:{repositoryRoot:dir},defaultToolContext:{agentId:"tuan"}});
  // The host uses a new plugin module generation on reload. Exercise another registration here.
  await entry.register(api2);
  assert.equal(api2.tools.length,40);assert.equal(api2.httpRoutes.length,0);
  assert.equal(getHeadlessReport().http_routes,0);
  console.log(JSON.stringify({status:"passed",registeredTools:api2.tools.length,rpcs:api2.gatewayMethods.length,httpRoutes:0,widgets:0,reload:"passed"}));
}finally{try{getPluginService()?.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});}
