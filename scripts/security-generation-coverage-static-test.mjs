/**
 * REN-02 check: static coverage of the generation authorization boundary.
 *
 * The runtime guarantee is that the guard lives INSIDE the seven provider-backed service methods, so
 * every tool, gateway method and browser alias funnels into the same decision. This check proves that
 * structurally against the real sources:
 *   * every provider call site goes through `this.callProvider(...)`;
 *   * no generation method calls a provider adapter directly;
 *   * every policy entry has a guard call with the matching entry id;
 *   * the registered surfaces are covered by the AUTHORITATIVE census in `src/generation-registry.js`
 *     (review round 2, issue 4): every registered tool and gateway method is declared, every declared
 *     provider operation names an existing entry, and the census and the entry tables agree in both
 *     directions;
 *   * and the bypass negative control: a plugin build that registers one extra provider-shaped tool
 *     must FAIL to register instead of silently escaping the gate.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as loaderApi from "node:module";

const rootDir = path.resolve(import.meta.dirname, "..");
const serviceSource = fs.readFileSync(path.join(rootDir, "src", "service.js"), "utf8");
const policySource = fs.readFileSync(path.join(rootDir, "src", "generation-policy.js"), "utf8");
const registrySource = fs.readFileSync(path.join(rootDir, "src", "generation-registry.js"), "utf8");

const { GENERATION_ENTRY_POLICY, GENERATION_SERVICE_ENTRIES, generationCoverageMatrix, generationEntryKeys, resolveGenerationEntriesByName } = await import("../src/generation-policy.js");
const { CLASSIFICATION_KINDS, RPC_CLASSIFICATION, TOOL_CLASSIFICATION, censusProviderNames, classifyRegistration, parseClassification } = await import("../src/generation-registry.js");

// ------------------------------------------------------------------------------------------------
// 1. provider calls only happen through the gateway
// ------------------------------------------------------------------------------------------------
// Provider adapters may only be bound in the constructor, and every other provider call must go
// through `this.callProvider(...)`. Removing the adapter block, the import lines and the adapter
// function definitions must therefore leave ZERO references to the adapter functions.
const adapterBlock = /adapters: \{[\s\S]*?\n      \},/.exec(serviceSource);
assert.ok(adapterBlock, "the provider adapter block must stay in the constructor");
const residual = serviceSource
  .replace(adapterBlock[0], "")
  .replace(/^\s*runDoubaoAudioGeneration,\s*$/m, "")
  .replace(/^\s*runKieSunoGeneration,\s*$/m, "")
  .replace(/function runDreaminaCli\(/g, "function REMOVED_A(")
  .replace(/function runDoubaoAudioGeneration\(/g, "function REMOVED_B(")
  .replace(/function runKieSunoGeneration\(/g, "function REMOVED_C(");
for (const name of ["runDreaminaCli", "runDoubaoAudioGeneration", "runKieSunoGeneration"]) {
  const references = residual.match(new RegExp(`\\b${name}\\b`, "g")) ?? [];
  assert.equal(references.length, 0, `${name} must not be referenced outside the adapter binding (found ${references.length})`);
}

// Every provider call must go through `this.callProvider({...})`.
//
// REN-11 fix round: this used to be a raw call-site count with a floor of 13. The Dreamina tool surface
// moved its three calls per tool (credit preflight / generate / credit recheck) plus the new read-only
// convergence queries into two shared helpers (`dreaminaCreditProbe` / `submitDreaminaCliGeneration`),
// so the count legitimately dropped while the invariant is unchanged. A count is a poor proxy anyway -
// it cannot tell "fewer call sites" from "a call that bypasses the gateway". The invariant is asserted
// directly instead: a gateway call site exists, nothing reaches the gateway around `callProvider`, and
// every Dreamina tool routes through the shared helpers.
const gatewayCallSites = (serviceSource.match(/this\.callProvider\(\{/g) ?? []).length;
assert.ok(gatewayCallSites >= 5, `every provider call must go through this.callProvider (found ${gatewayCallSites}, expected at least 5)`);
assert.equal((serviceSource.match(/this\.providerGateway\.(invokeAdapter|invoke)\(/g) ?? []).length, 1,
  "the provider gateway must be reached from exactly one place");
const callProviderBody = /async callProvider\(\{[\s\S]*?\n  \}/.exec(serviceSource);
assert.ok(callProviderBody, "callProvider must exist");
assert.match(callProviderBody[0], /this\.providerGateway\.invokeAdapter\(/, "and that place must be callProvider (no generation path may bypass it)");
for (const helper of ["dreaminaCreditProbe", "submitDreaminaCliGeneration"]) {
  assert.ok(serviceSource.includes(`async ${helper}(`), `${helper} must exist as a shared Dreamina provider call path`);
  assert.ok((serviceSource.match(new RegExp(`this\\.${helper}\\(\\{`, "g")) ?? []).length >= 3,
    `every Dreamina tool must route its provider work through ${helper}`);
}

assert.match(serviceSource, /invokeAdapter\(\{\s*audit_id: audit\?\.audit_id/, "the service must pass the authorization id when calling a provider");
assert.equal((serviceSource.match(/execFile\(/g) ?? []).length, 1, "the Dreamina binary must be spawned from exactly one place (the adapter)");
// the trusted context must ride along so the gateway can bind an adapter call to its actor
assert.match(serviceSource, /context: trustedContextOf\(audit\)/, "callProvider must forward the trusted context");
// and the service must close the authorization when the generation method is done
assert.ok((serviceSource.match(/this\.finishGeneration\(authorization/g) ?? []).length >= 3, "the Dreamina chain must close its authorization");

// ------------------------------------------------------------------------------------------------
// 2. every policy entry is guarded with its own entry id
// ------------------------------------------------------------------------------------------------
for (const [entry, method] of Object.entries(GENERATION_SERVICE_ENTRIES)) {
  assert.match(policySource, new RegExp(`"${entry.replace(/\./g, "\\.")}": "${method}"`), `${entry} must map to ${method}`);
  assert.ok(serviceSource.includes(`this.beginGeneration({ entry: "${entry}"`), `service method ${method} must guard entry ${entry}`);
  assert.match(serviceSource, new RegExp(`\\n  (async )?${method}\\(input`), `the service must define ${method}`);
}
assert.equal((serviceSource.match(/this\.beginGeneration\(\{ entry:/g) ?? []).length, generationEntryKeys().length, "exactly one guard per policy entry");

// ------------------------------------------------------------------------------------------------
// 3. no identity or permission is read from the wire for the generation decision
// ------------------------------------------------------------------------------------------------
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const policyCode = stripComments(policySource);
assert.doesNotMatch(policyCode, /params\.actor_id|params\.scope|params\.scopes|params\.trusted/, "the decision must never read identity from params");
assert.doesNotMatch(policyCode, /params\.(permission|permissions|grant|admin)\b/, "the decision must never read a declared permission from params");
assert.match(policyCode, /confirmationPresent\(params\)/, "only the cost-confirmation flags may be read from params");
// monitor mode must be a refusal, not an allow
assert.match(policyCode, /MONITOR_OBSERVE_ONLY/, "monitor mode must produce an explicit observe-only denial");
assert.doesNotMatch(policyCode, /if \(policy\.mode === "monitor"\) \{\s*return \{ allowed: true/, "monitor mode must never allow");
// cost evidence must not come from the reference constants
assert.match(policyCode, /evidence: "none"/, "an entry without an operator estimate must report no evidence");

// ------------------------------------------------------------------------------------------------
// 4. the census grammar and completeness
// ------------------------------------------------------------------------------------------------
assert.equal(Object.keys(TOOL_CLASSIFICATION).length, 69, "the census must declare all 69 tools");
// 89 since REN-10 added eight persistent generation-job methods after REN-08's 81-method surface. The census
// count is asserted rather than derived so that a new surface cannot appear without someone classifying it here -
// which is exactly what happened when the three were first registered: assertGenerationPolicyCoverage refused to
// start until each had an entry. The reasoning for the three is in src/index.js (allRpc) and the registration
// contract test.
assert.equal(Object.keys(RPC_CLASSIFICATION).length, 89, "the census must declare all 89 gateway methods (81 before REN-10 added the eight generation-job methods)");
for (const [name, value] of Object.entries(TOOL_CLASSIFICATION)) {
  const parsed = parseClassification(value);
  assert.equal(parsed.valid, true, `tool census entry ${name} is invalid: ${parsed.error}`);
  assert.ok(CLASSIFICATION_KINDS.includes(parsed.kind));
  if (parsed.kind === "provider-operation") assert.ok(GENERATION_ENTRY_POLICY[parsed.entry], `${name} points at unknown entry ${parsed.entry}`);
}
for (const [name, value] of Object.entries(RPC_CLASSIFICATION)) {
  const parsed = parseClassification(value);
  assert.equal(parsed.valid, true, `rpc census entry ${name} is invalid: ${parsed.error}`);
}
// grammar negative controls: the parser must reject the shapes that would let a name sneak through
assert.equal(parseClassification("provider-operation").valid, false, "a provider operation without an entry must be invalid");
assert.equal(parseClassification("local-read dreamina.video.generate").valid, false, "a non-provider kind must not carry an entry");
assert.equal(parseClassification("provider-operation nope.not.an.entry").valid, true, "the grammar is only about shape; existence is checked against the entry table");
assert.equal(parseClassification("totally-new-kind").valid, false, "an unknown kind must be invalid");
assert.equal(parseClassification("").valid, false, "an empty classification must be invalid");
// and the registry source must not contain a naming heuristic anymore
assert.doesNotMatch(registrySource, /looksLikeGenerationName|NON_PROVIDER_GENERATION_NAMES/, "the census must not fall back to a name heuristic");

// ------------------------------------------------------------------------------------------------
// 5. census <-> policy cross-check, and the bypass negative control
// ------------------------------------------------------------------------------------------------
const bogusTool = "video_canvas_dreamina_cli_generate_video_v3";
{
  const classification = classifyRegistration({
    toolNames: ["video_asset_search", bogusTool],
    rpcNames: ["videoAssets.asset.search"],
    entries: GENERATION_ENTRY_POLICY
  });
  assert.equal(classification.unclassified.includes(`tool:${bogusTool}`), true, "an undeclared tool must be reported as unclassified");
  assert.equal(classification.fatal.some((item) => item.includes("unclassified")), true, "an undeclared tool must be fatal");
}
{
  const classification = classifyRegistration({
    toolNames: Object.keys(TOOL_CLASSIFICATION),
    rpcNames: Object.keys(RPC_CLASSIFICATION),
    entries: GENERATION_ENTRY_POLICY
  });
  assert.deepEqual(classification.fatal, [], `the census must be consistent with the entry table as shipped: ${classification.fatal.join("; ")}`);
  assert.equal(classification.provider_operations.length, 12, "7 tools + 5 gateway methods are provider operations");
}
{
  const census = censusProviderNames();
  assert.equal(census.tools.length, 7, "exactly seven tools may reach a provider");
  assert.equal(census.rpc.length, 5, "exactly five gateway methods may reach a provider");
}

// ------------------------------------------------------------------------------------------------
// 6. real registration: every surface is classified, and an extra provider-shaped tool is fatal
// ------------------------------------------------------------------------------------------------
const { installSdkAliasHooks } = await import("./fixtures/sdk-alias-hooks.mjs");
installSdkAliasHooks(loaderApi);
process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = "2026.9.3";
const { createHostApiStub } = await import("./fixtures/host-api-stub.mjs");

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-ren02-coverage-"));
const entry = (await import("../src/index.js")).default;
const api = createHostApiStub({ pluginConfig: { repositoryRoot: path.join(tmp, "repo"), auth: { enabled: false } }, registrationMode: "full" });
await entry.register(api);

const registeredToolNames = api.tools.map((tool) => tool.definition.name);
const registeredRpcNames = api.gatewayMethods.map((method) => method.method);
assert.equal(registeredToolNames.length, 69, "the plugin must keep its 69-tool contract");
assert.equal(registeredRpcNames.length, 89, "the plugin must keep its 89-method gateway contract (81 before REN-10 added the generation-job surface)");

const matrix = generationCoverageMatrix({ toolNames: registeredToolNames, rpcNames: registeredRpcNames });
assert.deepEqual(matrix.ambiguous_names, [], "no generation name may map to two entries");
assert.deepEqual(matrix.entries_without_provider, []);
assert.deepEqual(matrix.unclassified_names, [], `every registered name must be declared in the census: ${matrix.unclassified_names.join(", ")}`);
assert.deepEqual(matrix.cross_check, [], `the census and the entry tables must agree: ${matrix.cross_check.join("; ")}`);
assert.equal(matrix.provider_operations.length, 12);

// the declared tools exist as registered tools, and each entry's tool/rpc name is a registered surface
const registeredTools = new Set(registeredToolNames);
const registeredRpc = new Set(registeredRpcNames);
for (const [entryId, definition] of Object.entries(GENERATION_ENTRY_POLICY)) {
  for (const name of definition.tools) assert.ok(registeredTools.has(name), `${entryId} declares unregistered tool ${name}`);
  for (const name of definition.rpc) assert.ok(registeredRpc.has(name), `${entryId} declares unregistered gateway method ${name}`);
}

// browser RPC surface: the UI bridge exposes the generation methods it is allowed to call
const browserSource = fs.readFileSync(path.join(rootDir, "src", "index.js"), "utf8");
for (const definition of Object.values(GENERATION_ENTRY_POLICY)) {
  for (const name of definition.browser) {
    assert.ok(browserSource.includes(`"${name}"`), `browser entry point ${name} must be present in the UI bridge allowlist`);
  }
}
const allowlistMatch = /const browserWriteAllowlist = new Set\(\[([\s\S]*?)\]\);/.exec(browserSource);
assert.ok(allowlistMatch, "the browser write allowlist must exist and stay reviewable");
const allowlisted = [...allowlistMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
const generationLike = allowlisted.filter((name) => /generate/i.test(name));
for (const name of generationLike) {
  const declared = parseClassification(RPC_CLASSIFICATION[name]);
  assert.equal(declared.valid, true, `browser-allowlisted method ${name} must be declared in the census`);
  if (declared.kind === "provider-operation") continue;
  assert.ok(
    declared.kind === "local-derivative",
    `browser-allowlisted generation-like method ${name} must be a declared local derivative, got ${String(declared.kind)}`
  );
}

// the registration-time coverage assertion is wired into register()
// REN-07 integration: the coverage assertion is invoked with the ACTIVE surface, so the pattern matches
// the two-argument form. The original guarantee is unchanged (the call is wired into register(), and an
// unclassified name is still fatal); requiring the surface argument makes it stricter than before, since a
// silent return to the one-argument form would census the default surface regardless of what was actually
// registered.
const coverageCall = /assertGenerationPolicyCoverage\(\s*api\s*(?:,\s*([A-Za-z_$][\w$]*)\(\)\s*)?\)/.exec(browserSource);
assert.ok(coverageCall, "register() must assert generation policy coverage");
assert.ok(
  coverageCall[1] === "toolSurfaceInUse",
  `the coverage assertion must pass the surface it is covering, got ${JSON.stringify(coverageCall[1] ?? null)}`
);
// Locate the register() body by brace matching rather than by a character window: a fixed-size window is
// either wrong (too small, and the check fails on healthy source) or meaningless (large enough to include
// unrelated code). Matching the braces states precisely what "inside register()" means.
function registerBodySource(source) {
  const decl = /register\(api\)\s*\{/.exec(source);
  if (!decl) return null;
  const open = source.indexOf("{", decl.index);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}
const registerBody = registerBodySource(browserSource);
assert.ok(registerBody, "the plugin entry point must declare a register(api) body");
assert.match(
  registerBody,
  /assertGenerationPolicyCoverage\(/,
  "the coverage assertion must be wired into register(), not merely present somewhere in the module"
);
assert.match(browserSource, /unclassified registered name/, "the assertion must treat an unclassified name as fatal");

// --- the bypass negative control: one extra provider-shaped tool in a patched copy ---------------
{
  const copyDir = path.join(tmp, "patched-plugin");
  await fs.promises.cp(rootDir, copyDir, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}node_modules`) && !source.includes(`${path.sep}.git`)
  });
  const copyIndex = path.join(copyDir, "src", "index.js");
  const originalIndex = await fs.promises.readFile(copyIndex, "utf8");
  const injected = originalIndex.replace(
    "    registerRpc(api);",
    `    registerToolDefinition(api, tool("${bogusTool}", "Injected provider-shaped tool for the coverage negative control.", {}, async () => ({ ok: true })));\n    registerRpc(api);`
  );
  assert.notEqual(injected, originalIndex, "the bypass negative control must really inject a registration");
  await fs.promises.writeFile(copyIndex, injected, "utf8");

  const copyManifestPath = path.join(copyDir, "openclaw.plugin.json");
  const manifest = JSON.parse(await fs.promises.readFile(copyManifestPath, "utf8"));
  manifest.contracts.tools = [...manifest.contracts.tools, bogusTool];
  await fs.promises.writeFile(copyManifestPath, JSON.stringify(manifest, null, 2), "utf8");

  const patchedEntry = (await import(`${pathToFileUrl(copyIndex)}?bypass=1`)).default;
  const patchedApi = createHostApiStub({ pluginConfig: { repositoryRoot: path.join(tmp, "repo-patched"), auth: { enabled: false } }, registrationMode: "full" });
  let failure = null;
  try {
    await patchedEntry.register(patchedApi);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "a plugin build with an unclassified provider-shaped tool must FAIL to register");
  assert.match(String(failure.message), /unclassified registered name: tool:/, `the failure must name the unclassified tool, got: ${String(failure.message)}`);
  assert.match(String(failure.message), new RegExp(bogusTool), "the failure must identify the offending tool");
}

function pathToFileUrl(filePath) {
  return new URL(`file:///${filePath.replace(/\\/g, "/")}`).href;
}

await api.services?.[0]?.stop?.();
await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => {});
console.log("REN-02 static generation-coverage check passed");
process.exit(0);
