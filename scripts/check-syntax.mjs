import fs from "node:fs";import path from "node:path";import {execFileSync} from "node:child_process";
const root=path.resolve(import.meta.dirname,"..");
const files=fs.readdirSync(path.join(root,"src"),{recursive:true}).filter(f=>f.endsWith(".js"));
for(const file of files)execFileSync(process.execPath,["--check",path.join(root,"src",file)],{stdio:"pipe"});
console.log(JSON.stringify({syntax:"passed",files:files.length}));
