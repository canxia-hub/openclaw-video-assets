// Isolated real HTTP/browser runtime using the production plugin entry and SQLite service.
import fs from "node:fs";import os from "node:os";import path from "node:path";import http from "node:http";import * as loader from "node:module";
import {installSdkAliasHooks} from "./fixtures/sdk-alias-hooks.mjs";
import {createHostApiStub} from "./fixtures/host-api-stub.mjs";
import {hashPassword} from "../src/security.js";
installSdkAliasHooks(loader);process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION="2026.9.7";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"ova-novel-browser-"));
const password="isolated-narrative-test-only";
const pluginConfig={repositoryRoot:root,auth:{enabled:true,adminPasswordHash:await hashPassword(password)},security:{allowedOrigins:["http://127.0.0.1:34871"]},generationJobs:{providerAdapter:"none"}};
const entry=await import("../src/index.js");const api=createHostApiStub({pluginConfig,registrationMode:"full",defaultToolContext:{agentId:"test",sessionKey:"agent:test:main",requesterSenderId:"gateway-owner",senderIsOwner:true}});
entry.default.register(api);
const service=entry.getPluginService();
const project=service.createProject({title:"插件运行验收（隔离夹具）",description:"不是P1正式立项；零费用工程验证"});
const server=http.createServer(async(req,res)=>{
 const pathname=new URL(req.url,"http://127.0.0.1").pathname;
 const route=api.httpRoutes.filter(r=>r.match==="prefix"?pathname.startsWith(r.path):pathname===r.path).sort((a,b)=>b.path.length-a.path.length)[0];
 if(!route){res.writeHead(404);res.end("Not found");return;}
 try{await route.handler(req,res);}catch(e){res.writeHead(500);res.end(String(e.message));}
});
server.listen(34871,"127.0.0.1",()=>{const info={root,url:"http://127.0.0.1:34871/__openclaw__/video-assets/workbench/#/novel",project_id:project.project_id,password,tools:api.tools.length,rpc:api.gatewayMethods.length};if(process.env.NARRATIVE_SERVER_INFO)fs.writeFileSync(process.env.NARRATIVE_SERVER_INFO,JSON.stringify(info,null,2));console.log(JSON.stringify({...info,password:"[fixture password stored locally]"},null,2));});
for(const signal of ["SIGTERM","SIGINT"])process.on(signal,()=>server.close(async()=>{for(const s of api.services)await s.stop();process.exit(0);}));
