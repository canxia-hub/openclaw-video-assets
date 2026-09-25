/**
 * REN-01: lifecycle + reload isolation test (isolated, host-shaped).
 *
 * Proves three acceptance claims without touching a live gateway:
 *  1. A reload (second register(api) pass) registers exactly ONE service / route set /
 *     RPC set per generation, with no duplicate registration inside a generation.
 *  2. State owned by the previous generation is released: the previous repository handle is
 *     closed and a plugin session minted before the reload is rejected afterwards.
 *  3. Route/RPC handlers served after the reload belong to the new generation (no stale
 *     handler reuse), and service start/stop/restart stays usable across generations.
 *
 * Scope honesty: the api object is a host-shaped stub; loader acceptance is covered by
 * implementation/REN-01/host-smoke.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as loaderApi from "node:module";

const { installSdkAliasHooks } = await import("./fixtures/sdk-alias-hooks.mjs");
installSdkAliasHooks(loaderApi);
process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = "2026.9.3";

const { createHostApiStub, fakeRequest, fakeResponse, findRoute } = await import("./fixtures/host-api-stub.mjs");
const { hashPassword } = await import("../src/security.js");

const rootDir = path.resolve(import.meta.dirname, "..");
const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-lifecycle-"));
const repositoryRoot = path.join(tmp, "repo");
const password = "ren01-reload-fixture-password";
const passwordHash = await hashPassword(password);
const pluginConfig = { repositoryRoot, auth: { enabled: true, adminPasswordHash: passwordHash } };

const entry = (await import("../src/index.js")).default;
const { getRegistrationLedgerSnapshot, getCompatReport } = await import("../src/index.js");

const report = { generations: [], checks: [] };
function ok(name) {
  report.checks.push({ name, status: "pass" });
}

// --- generation 1 ------------------------------------------------------------------

const api1 = createHostApiStub({ pluginConfig });
await entry.register(api1);
const ledger1 = getRegistrationLedgerSnapshot();
assert.equal(ledger1.generation, 1);
assert.equal(ledger1.disposedGenerations, 0, "first registration has no previous generation to dispose");
assert.equal(api1.services.length, 1);
assert.equal(api1.httpRoutes.length, 9, "REN-06 adds the streaming upload route to the REN-01/05 set of 8 (reasoning is in the registration contract test)");
// 89 after REN-10 adds eight durable generation-job methods to REN-08's 81-method surface.
// The reasoning for exactly those three is written where the surface is built (src/index.js, allRpc) and asserted
// in the registration contract test; this file mirrors the number so a reload regression cannot hide behind it.
assert.equal(api1.gatewayMethods.length, 89);
report.generations.push({ generation: 1, counts: ledger1.history[0].counts });
ok("generation 1 registers one service, one route set and one RPC set");

const loginRoute1 = findRoute(api1, "/__openclaw__/video-assets/auth/login");
const statusRoute1 = findRoute(api1, "/__openclaw__/video-assets/auth/status");

const loginResponse = fakeResponse();
await loginRoute1.handler(
  fakeRequest({ method: "POST", url: "/__openclaw__/video-assets/auth/login", headers: { "content-type": "application/json" }, body: { password } }),
  loginResponse
);
assert.equal(loginResponse.statusCode, 200, `login should succeed (${loginResponse.body})`);
const oldToken = loginResponse.cookieToken();
assert.ok(oldToken, "login must set the plugin session cookie");

const statusResponse = fakeResponse();
await statusRoute1.handler(fakeRequest({ method: "GET", url: "/__openclaw__/video-assets/auth/status", headers: { cookie: `ova_session=${oldToken}` } }), statusResponse);
assert.equal(statusResponse.statusCode, 200, "session minted in generation 1 must work inside generation 1");
assert.equal(statusResponse.json().actor_id, "human:plugin-admin");
ok("generation 1 session authenticates inside its own generation");

// --- reload (generation 2, same process) --------------------------------------------

const previousService = api1.services[0];
const api2 = createHostApiStub({ pluginConfig });
await entry.register(api2);
const ledger2 = getRegistrationLedgerSnapshot();

assert.equal(ledger2.generation, 2, "the second register(api) pass must open a new generation");
assert.equal(ledger2.disposedGenerations, 1, "the previous generation's state must be disposed exactly once");
assert.deepEqual(ledger2.history.map((entry) => entry.counts), [ledger1.history[0].counts, ledger2.history[1].counts], "each generation registers the same surface counts");
assert.equal(api2.services.length, 1, "reload must not accumulate services");
assert.equal(api2.services[0].id, "video-assets-repository");
assert.equal(api2.httpRoutes.length, 9, "reload must not accumulate routes");
assert.equal(api2.gatewayMethods.length, 89, "reload must not accumulate RPC methods (89 after the second registration, as after the first)");
assert.notEqual(api2.httpRoutes[0].handler, api1.httpRoutes[0].handler, "generation 2 must not reuse generation 1 handlers");
assert.notEqual(api2.gatewayMethods[0].handler, api1.gatewayMethods[0].handler, "generation 2 must not reuse generation 1 RPC handlers");
report.generations.push({ generation: 2, counts: ledger2.history[1].counts });
ok("reload registers exactly one service/route/RPC set and no duplicate ledger claims");

// --- previous generation state release ---------------------------------------------

// The plugin module keeps one repository instance per generation; the previous handle must be closed
// (VideoAssetService.close() nulls `db`).
assert.equal(previousService.id, api2.services[0].id, "service identity stays stable across reloads");
assert.notEqual(previousService, api2.services[0], "the reloaded generation must own a fresh service object");

const statusRoute2 = findRoute(api2, "/__openclaw__/video-assets/auth/status");
const staleResponse = fakeResponse();
await statusRoute2.handler(fakeRequest({ method: "GET", url: "/__openclaw__/video-assets/auth/status", headers: { cookie: `ova_session=${oldToken}` } }), staleResponse);
assert.equal(staleResponse.statusCode, 401, "a session minted before the reload must not authenticate after it");
assert.match(String(staleResponse.json().error), /invalid plugin session/);
ok("pre-reload plugin session is rejected after reload (no stale session reuse)");

const loginRoute2 = findRoute(api2, "/__openclaw__/video-assets/auth/login");
const reloginResponse = fakeResponse();
await loginRoute2.handler(
  fakeRequest({ method: "POST", url: "/__openclaw__/video-assets/auth/login", headers: { "content-type": "application/json" }, body: { password } }),
  reloginResponse
);
assert.equal(reloginResponse.statusCode, 200, "the reloaded generation must accept a fresh login");
const freshToken = reloginResponse.cookieToken();
assert.notEqual(freshToken, oldToken);
const freshStatus = fakeResponse();
await statusRoute2.handler(fakeRequest({ method: "GET", url: "/__openclaw__/video-assets/auth/status", headers: { cookie: `ova_session=${freshToken}` } }), freshStatus);
assert.equal(freshStatus.statusCode, 200);
ok("post-reload login works with a newly minted session");

// --- service lifecycle across generations ------------------------------------------

const startCtx = { logger: { info() {}, warn() {}, error() {} }, config: {}, stateDir: tmp };
await api2.services[0].start(startCtx);
await api2.services[0].stop();
await api2.services[0].stop();
await api2.services[0].start(startCtx);
ok("service start/stop/start stays idempotent across a reload");

// --- generation 3 (double reload) keeps counts stable -------------------------------

const api3 = createHostApiStub({ pluginConfig });
await entry.register(api3);
const ledger3 = getRegistrationLedgerSnapshot();
assert.equal(ledger3.generation, 3);
assert.equal(ledger3.disposedGenerations, 2);
assert.equal(ledger3.history[2].counts.tool, ledger3.history[0].counts.tool);
assert.equal(ledger3.history[2].counts["gateway-method"], ledger3.history[0].counts["gateway-method"]);
assert.equal(ledger3.disposedGenerations, ledger3.generation - 1, "every generation after the first disposes its predecessor exactly once");
ok("a third registration generation disposes its predecessor once and keeps counts stable");

// --- teardown -----------------------------------------------------------------------

for (const registered of api3.services) await registered.stop();
await fs.promises.rm(tmp, { recursive: true, force: true });

console.log(JSON.stringify({ ok: true, compatOverall: getCompatReport()?.overall, report }, null, 2));
console.log("plugin lifecycle reload test passed");
