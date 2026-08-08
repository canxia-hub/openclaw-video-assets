import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const packagePath = path.join(root, "package.json");
const manifestPath = path.join(root, "openclaw.plugin.json");
const indexPath = path.join(root, "src", "index.js");

const pkg = readJson(packagePath);
const manifest = readJson(manifestPath);
const indexSource = await fs.promises.readFile(indexPath, "utf8");

assert.equal(pkg.type, "module", "package.json must use ESM");
assert.ok(Array.isArray(pkg.openclaw?.extensions), "package.json openclaw.extensions must be an array");
assert.ok(pkg.openclaw.extensions.length > 0, "package.json openclaw.extensions must not be empty");

for (const extension of pkg.openclaw.extensions) {
  const extensionPath = path.join(root, extension);
  assert.ok(fs.existsSync(extensionPath), `extension entry does not exist: ${extension}`);
}

assert.equal(manifest.id, "video-assets", "manifest id should remain stable");
assert.equal(manifest.activation?.onStartup, true, "manifest should explicitly activate on startup for service/rpc routes");
assert.ok(manifest.configSchema && manifest.configSchema.type === "object", "manifest must include object configSchema");
assert.equal(manifest.configSchema.additionalProperties, false, "configSchema should reject unknown top-level plugin config keys");

const manifestTools = new Set(manifest.contracts?.tools ?? []);
assert.ok(manifestTools.size > 0, "manifest contracts.tools must not be empty");

assert.ok(!/async\s+register\s*\(/.test(indexSource), "OpenClaw plugin register(api) must be synchronous");
assert.ok(!/await\s+service\.init\s*\(/.test(indexSource), "service initialization in register must be synchronous");

const registeredTools = new Set([...indexSource.matchAll(/(?:tool|rawTool)\("([a-zA-Z0-9_]+)"/g)].map((match) => match[1]));
assert.deepEqual([...registeredTools].sort(), [...manifestTools].sort(), "manifest contracts.tools must match registered tools in src/index.js");

const requiredRpc = [
  "videoAssets.asset.search",
  "videoAssets.asset.get",
  "videoAssets.asset.updateRights",
  "videoAssets.asset.create",
  "videoAssets.asset.createVersion",
  "videoAssets.asset.createBranch",
  "videoAssets.asset.saveCopy",
  "videoAssets.asset.lineage",
  "videoAssets.asset.registerDerivedFile",
  "videoAssets.asset.generateDerivedFile",
  "videoAssets.asset.derivedFiles",
  "videoAssets.asset.integrityScan",
  "videoAssets.asset.classify",
  "videoAssets.asset.getClassification",
  "videoAssets.asset.taxonomyReport",
  "videoAssets.entity.create",
  "videoAssets.entity.search",
  "videoAssets.entity.linkAsset",
  "videoAssets.annotation.create",
  "videoAssets.annotation.list",
  "videoAssets.annotation.update",
  "videoAssets.project.create",
  "videoAssets.project.search",
  "videoAssets.project.get",
  "videoAssets.project.addRef",
  "videoAssets.project.updateRef",
  "videoAssets.project.removeRef",
  "videoAssets.project.listRefs",
  "videoAssets.project.report",
  "videoAssets.project.continuityReport",
  "videoAssets.file.roots",
  "videoAssets.file.list",
  "videoAssets.file.inspect",
  "videoAssets.file.search",
  "videoAssets.ui.dashboardSummary"
];
for (const rpcName of requiredRpc) {
  assert.ok(indexSource.includes(`"${rpcName}"`), `missing RPC registration: ${rpcName}`);
}

const requiredRoutes = [
  "/__openclaw__/video-assets/auth/login",
  "/__openclaw__/video-assets/auth/logout",
  "/__openclaw__/video-assets/auth/status",
  "/__openclaw__/video-assets/rpc/",
  "/__openclaw__/video-assets/file/",
  "/__openclaw__/video-assets/thumb/",
  "/__openclaw__/video-assets/proxy/",
  "/__openclaw__/video-assets/workbench/"
];
for (const route of requiredRoutes) {
  assert.ok(indexSource.includes(route), `missing HTTP route: ${route}`);
}
assert.ok(!indexSource.includes("thumbnail route is reserved but not implemented"), "thumbnail route must not remain a 501 placeholder");
assert.ok(!indexSource.includes("proxy route is reserved but not implemented"), "proxy route must not remain a 501 placeholder");
assert.ok(indexSource.includes("handleDerivedFileRequest"), "derived file HTTP route handler must be registered");

console.log(JSON.stringify({
  ok: true,
  packageName: pkg.name,
  pluginId: manifest.id,
  extensions: pkg.openclaw.extensions,
  tools: [...manifestTools].sort(),
  checkedRpc: requiredRpc.length,
  checkedRoutes: requiredRoutes.length
}, null, 2));

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
