/**
 * REN-01: plugin registration contract test (isolated, host-shaped).
 *
 * Loads the REAL plugin entry (which imports the REAL installed
 * `openclaw/plugin-sdk/plugin-entry` module through fixtures/sdk-alias-hooks.mjs) and calls
 * `register(api)` with a host-shaped api stub.
 *
 * Scope honesty: this proves the plugin's own registration contracts and metadata, not that
 * the gateway accepts them. Loader acceptance is covered by
 * implementation/REN-01/host-smoke (isolated install + `plugins inspect --runtime`).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as loaderApi from "node:module";

const { installSdkAliasHooks } = await import("./fixtures/sdk-alias-hooks.mjs");
const hookMode = installSdkAliasHooks(loaderApi);
process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = "2026.9.3";

const { OPERATOR_SCOPES, ROUTE_AUTH_VALUES, ROUTE_MATCH_VALUES, READ_SCOPE, WRITE_SCOPE } = await import("../src/sdk-compat.js");
const { createHostApiStub, findRoute, readPluginManifest } = await import("./fixtures/host-api-stub.mjs");

const rootDir = path.resolve(import.meta.dirname, "..");
const manifest = await readPluginManifest(rootDir);
const declaredTools = manifest.contracts.tools;

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-rpc-contract-"));
const pluginConfig = {
  repositoryRoot: path.join(tmp, "repo"),
  auth: { enabled: false }
};

const entry = (await import("../src/index.js")).default;
assert.equal(typeof entry.register, "function", "plugin entry must expose a synchronous register(api)");

const api = createHostApiStub({ pluginConfig, registrationMode: "full" });
await entry.register(api);

// --- tools + contracts.tools ----------------------------------------------------

assert.equal(api.tools.length, declaredTools.length, `registered tool count must equal manifest contracts.tools (${declaredTools.length})`);
const registeredNames = api.tools.map((entry) => entry.definition.name).sort();
assert.deepEqual(registeredNames, [...declaredTools].sort(), "no undeclared tools and no unimplemented declarations");

const seenDescriptions = new Set();
for (const { definition } of api.tools) {
  assert.equal(typeof definition.name, "string");
  assert.match(definition.name, /^[a-z0-9_]+$/, `tool name must stay snake_case: ${definition.name}`);
  assert.ok(definition.description.trim().length > 0, `tool ${definition.name} needs a description`);
  assert.equal(definition.parameters.type, "object", `tool ${definition.name} parameters.type`);
  assert.equal(definition.parameters.additionalProperties, false, `tool ${definition.name} must reject unknown keys`);
  assert.equal(definition.parameters.anyOf, undefined, `tool ${definition.name} must not use a top-level anyOf`);
  assert.equal(typeof definition.execute, "function", `tool ${definition.name} needs execute`);
  assert.ok(!seenDescriptions.has(definition.description), `tool ${definition.name} has a duplicate description`);
  seenDescriptions.add(definition.description);
  for (const requiredName of definition.parameters.required ?? []) {
    assert.ok(definition.parameters.properties[requiredName], `tool ${definition.name} requires undeclared property ${requiredName}`);
  }
}

// --- gateway RPC scope metadata --------------------------------------------------

// 89: REN-10 adds eight durable generation-job methods to REN-08's 81-method surface. The count is asserted so that a
// surface change cannot happen silently; each increase is deliberate and explained here, in the same place REN-07
// recorded its own.
//
// REN-08's three, and why THREE rather than one per gesture (drag / connect / delete / copy / undo / redo):
//   * canvas.getRevision  (read)  - the revision and command count, for a client that wants the version without
//                                   re-reading the whole document.
//   * canvas.applyCommand (write) - the single write path. Every gesture is the same operation with a different
//                                   payload, so one entry point means the concurrency question is answered once,
//                                   in one place, instead of once per gesture with a chance to differ.
//   * canvas.listCommands (read)  - the command log, which is what makes a conflict explainable after the fact.
// Nothing here changes the tool surface: contracts.tools stays at 17 and the legacy surface at 69. The editor is a
// BROWSER surface - a person dragging a card in the workbench - so it belongs on the RPC surface, not in the model's
// tool list.
// Narrative domain adds four read/write pairs; old 89 RPC names remain compatible.
assert.equal(api.gatewayMethods.length, 97, "gateway RPC surface must keep its 89 methods (81 from REN-08 plus REN-10's eight generation-job methods)");
const methodNames = new Set();
const scopeTally = { [READ_SCOPE]: 0, [WRITE_SCOPE]: 0 };
for (const { method, opts, handler } of api.gatewayMethods) {
  assert.ok(method.startsWith("videoAssets."), `gateway method namespace drift: ${method}`);
  assert.ok(!methodNames.has(method), `duplicate gateway method: ${method}`);
  methodNames.add(method);
  assert.ok(OPERATOR_SCOPES.includes(opts?.scope), `gateway method ${method} must declare a public OperatorScope (got ${opts?.scope})`);
  assert.notEqual(opts.scope, "operator.admin", `gateway method ${method} must not claim operator.admin`);
  assert.equal(typeof handler, "function");
  scopeTally[opts.scope] += 1;
}
assert.deepEqual(Object.keys(scopeTally).sort(), [READ_SCOPE, WRITE_SCOPE].sort(), "only read/write scopes are used");
assert.ok(scopeTally[READ_SCOPE] > 0 && scopeTally[WRITE_SCOPE] > 0);

// --- HTTP routes -----------------------------------------------------------------

// REN-06 raised this from 8 to 9 by adding the streaming upload route. The count is a CONTRACT, not a
// coincidence, so the change is recorded here explicitly rather than by editing a magic number:
//
//   * Why a new route was needed at all: uploads must be STREAMED. The `rpc` route reads the whole
//     request body into memory as JSON, and the legacy staging entry took the file as base64 inside that
//     JSON - so a 200 MiB upload would need a ~270 MiB body buffer on the server. No amount of care in a
//     handler fixes that; the transport itself has to accept a raw, un-buffered body.
//   * Why exactly ONE more route: the upload surface (create / append / status / complete / cancel / list)
//     is dispatched internally by method and sub-path, so the route table grows by one entry and the
//     sub-path grammar lives in one module with its own checks.
//   * Why this is not "editing the number until the test passes": the new route is declared in
//     ROUTE_SEGMENTS (base-path.js) - the same single source of truth that every other route, the session
//     cookie Path and the workbench URL derive from - and the expected-path list below names it. The old
//     value of 8 was a snapshot of what existed, not a ceiling; holding it as a ceiling would have forced
//     uploads back onto a transport that can not meet the memory requirement.
assert.equal(api.httpRoutes.length, 9, "HTTP route surface must keep its 9 routes (8 from REN-01/05 plus the REN-06 streaming upload route)");
const routeKeys = new Set();
for (const route of api.httpRoutes) {
  const key = `${route.match ?? "exact"} ${route.path}`;
  assert.ok(!routeKeys.has(key), `duplicate route registration: ${key}`);
  routeKeys.add(key);
  assert.ok(ROUTE_AUTH_VALUES.includes(route.auth), `route ${route.path} auth must be gateway|plugin`);
  assert.equal(route.auth, "plugin", `route ${route.path} must stay plugin-authenticated`);
  assert.ok(route.match === undefined || ROUTE_MATCH_VALUES.includes(route.match), `route ${route.path} match`);
  assert.equal(typeof route.handler, "function");
}
for (const expected of [
  "/__openclaw__/video-assets/auth/login",
  "/__openclaw__/video-assets/auth/logout",
  "/__openclaw__/video-assets/auth/status",
  "/__openclaw__/video-assets/rpc/",
  "/__openclaw__/video-assets/file/",
  "/__openclaw__/video-assets/thumb/",
  "/__openclaw__/video-assets/proxy/",
  "/__openclaw__/video-assets/upload/",
  "/__openclaw__/video-assets/workbench/"
]) {
  assert.ok(api.httpRoutes.some((route) => route.path === expected), `missing route ${expected}`);
}

// --- service + reload policy ------------------------------------------------------

assert.equal(api.services.length, 1, "exactly one plugin service");
const service = api.services[0];
assert.equal(service.id, "video-assets-repository");
assert.deepEqual(service.reload.configPrefixes, ["plugins.entries.video-assets.config"], "service must declare its config reload prefix");
assert.equal(typeof service.start, "function");
assert.equal(typeof service.stop, "function");

assert.equal(api.reloads.length, 1, "exactly one reload-policy registration");
assert.deepEqual(api.reloads[0], {
  hotPrefixes: ["plugins.entries.video-assets.config"],
  restartPrefixes: [],
  noopPrefixes: []
});
assert.ok((api.reloads[0].restartPrefixes.length + api.reloads[0].hotPrefixes.length + api.reloads[0].noopPrefixes.length) > 0, "host rejects an empty reload registration");

assert.equal(api.resources.length, 1, "widget resource registration attempted exactly once");

// --- compat report + ledger -------------------------------------------------------

const { getCompatReport, getRegistrationLedgerSnapshot } = await import("../src/index.js");
const report = getCompatReport();
assert.equal(report.overall, "pass", `compat report should pass on 2026.9.3 (${JSON.stringify(report.degraded)})`);
assert.equal(report.hostVersion.raw, "2026.9.3");
assert.equal(report.registrationMode, "full");
assert.equal(report.secretInputDeclaration.ok, true);

const ledger = getRegistrationLedgerSnapshot();
assert.equal(ledger.generation, 1);
assert.equal(ledger.currentGeneration.length, api.tools.length + api.gatewayMethods.length + api.httpRoutes.length + 3, "one ledger claim per tool/rpc/route plus service, reload policy and widget resource");

// --- tool input validation + structured tool errors -------------------------------

const toolWithRequired = api.tools.find((entry) => (entry.definition.parameters.required ?? []).length > 0);
assert.ok(toolWithRequired, "at least one tool must declare required properties");
const missingRequired = await toolWithRequired.definition.execute("call-1", {});
assert.equal(missingRequired.details.ok, false);
assert.equal(missingRequired.details.error.code, "VIDEO_ASSETS_INVALID_INPUT");
assert.match(missingRequired.content[0].text, /^ERROR: VIDEO_ASSETS_INVALID_INPUT: /);
assert.equal(missingRequired.isError, true);
assert.ok(Array.isArray(missingRequired.details.error.details.problems));

const unknownKey = await api.tools[0].definition.execute("call-2", { definitely_not_a_parameter: 1 });
assert.equal(unknownKey.details.error.code, "VIDEO_ASSETS_INVALID_INPUT");
assert.ok(unknownKey.details.error.details.problems.some((problem) => /unknown property/.test(problem.message)));

const searchTool = api.tools.find((entry) => entry.definition.name === "video_asset_search").definition;
const searchResult = await searchTool.execute("call-3", {});
assert.equal(searchResult.details, undefined, "a valid call keeps the historical plain-text-only result shape");
assert.equal(typeof searchResult.content[0].text, "string");

// --- plugin-side gateway scope guard (defense in depth) ---------------------------

const readMethod = api.gatewayMethods.find((entry) => entry.opts.scope === READ_SCOPE);
const denied = [];
await readMethod.handler({
  params: {},
  trustedScopes: [],
  respond(...args) {
    denied.push(args);
  }
});
assert.equal(denied[0][0], false);
assert.equal(denied[0][1].code, "VIDEO_ASSETS_FORBIDDEN", "trusted scopes without the required scope must be denied");

const allowed = [];
await readMethod.handler({
  params: {},
  respond(...args) {
    allowed.push(args);
  }
});
assert.equal(allowed[0][0], true, "no trusted scope list means host-enforced authority (unchanged legacy behavior)");

// --- teardown --------------------------------------------------------------------

for (const registered of api.services) await registered.stop();
await fs.promises.rm(tmp, { recursive: true, force: true });

console.log(
  JSON.stringify(
    {
      ok: true,
      sdkAliasHookMode: hookMode,
      tools: api.tools.length,
      gatewayMethods: api.gatewayMethods.length,
      scopeTally,
      httpRoutes: api.httpRoutes.length,
      services: api.services.length,
      reloads: api.reloads.length,
      compatOverall: report.overall
    },
    null,
    2
  )
);
console.log("plugin registration contract test passed");
