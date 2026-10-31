import fs from "node:fs";import path from "node:path";import assert from "node:assert/strict";import {buildAgentToolSpecs} from "../src/tool-specs.js";
const root=path.resolve(import.meta.dirname,".."),specs=buildAgentToolSpecs({},{}),manifestPath=path.join(root,"openclaw.plugin.json"),manifest=JSON.parse(fs.readFileSync(manifestPath));
const artifact={version:"0.4.0",generatedFrom:"src/tool-specs.js + src/cli-tools.js + src/narrative-contract.js",tools:specs.map(({name,description,properties,required})=>({name,description,parameters:{type:"object",additionalProperties:false,properties,required}}))};
const artifactPath=path.join(root,"contract","agent-tools.generated.json");
if(process.argv.includes("--check")){assert.deepEqual(manifest.contracts.tools,specs.map(x=>x.name));assert.deepEqual(JSON.parse(fs.readFileSync(artifactPath)),artifact);console.log(JSON.stringify({contract:"passed",tools:specs.length}));}
else{manifest.contracts.tools=specs.map(x=>x.name);fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+"\n");fs.writeFileSync(artifactPath,JSON.stringify(artifact,null,2)+"\n");}
