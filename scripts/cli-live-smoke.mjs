import assert from "node:assert/strict";import fs from "node:fs";import os from "node:os";import path from "node:path";
import {VideoAssetService} from "../src/service.js";import {CliBridge} from "../src/cli-bridge.js";import {withTrustedContext} from "../src/provider-gateway.js";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"ova-cli-live-"));const service=new VideoAssetService({pluginConfig:{repositoryRoot:root}}).init();const cli=new CliBridge({service});
const results=[];
try {
 for(const provider of["dreamina","dreamina_canvas"]){const r=await cli.run(provider,{command:"version",execute:true});assert.equal(r.status,"succeeded");results.push({provider,command:"version",status:r.status,version:r.result?.data?.version??r.result?.version});}
 const auth=await cli.run("dreamina_canvas",{command:"auth status",execute:true});assert.equal(auth.status,"succeeded");results.push({provider:"dreamina_canvas",command:"auth status",loggedIn:auth.result?.data?.loggedIn,status:auth.status});
 const local=await cli.run("dreamina_canvas",{command:"node create text",argv:["--title","CLI-only local validation","--text","local validation only","--dry-run"],execute:true});assert.equal(local.status,"succeeded");results.push({provider:"dreamina_canvas",command:"node create text --dry-run",status:local.status,localOnly:true});
 assert.equal(service.db.prepare("SELECT count(*) n FROM cli_bridge_operations").get().n,0);
 console.log(JSON.stringify({results,paid_submissions:0,cloud_writes:0,frontend_required:false},null,2));
}finally{service.close();fs.rmSync(root,{recursive:true,force:true});}
