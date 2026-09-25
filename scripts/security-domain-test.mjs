/**
 * REN-02 check: base path, Origin/CSRF, cookie flags and session lifecycle at the real route
 * handlers (host-shaped stub, real plugin entry, REAL security.js).
 *
 * Scope: handler-level HTTP behaviour of the plugin's own routes. Real daemon/TLS/proxy behaviour is
 * covered separately in implementation/REN-02/host-smoke.
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
const { DEFAULT_BASE_PATH, createBasePathHelpers, normalizeBasePath, resolveBasePath } = await import("../src/base-path.js");
const { hashPassword } = await import("../src/security.js");

const rootDir = path.resolve(import.meta.dirname, "..");
const password = "ren02-domain-check-password";
const hash = await hashPassword(password, { iterations: 100_000 });

// ------------------------------------------------------------------------------------------------
// 1. base path is a single source of truth
// ------------------------------------------------------------------------------------------------
assert.equal(normalizeBasePath(undefined), DEFAULT_BASE_PATH);
assert.equal(normalizeBasePath(""), DEFAULT_BASE_PATH);
assert.equal(normalizeBasePath("/__openclaw__/video-assets/"), DEFAULT_BASE_PATH, "trailing slash normalized away");
assert.equal(normalizeBasePath("custom/mount"), "/custom/mount", "leading slash added");
assert.throws(() => normalizeBasePath("https://chat.tkx.info/__openclaw__"), /must be a path, not a URL/);
assert.throws(() => normalizeBasePath("/a/../../etc"), /traversal/);
assert.throws(() => normalizeBasePath("/a?x=1"), /query or fragment/);
assert.equal(resolveBasePath({ security: { basePath: "/mnt/x" } }), "/mnt/x");
assert.equal(resolveBasePath({ basePath: "/mnt/y" }), "/mnt/y");
assert.equal(resolveBasePath({}), DEFAULT_BASE_PATH);

const helpers = createBasePathHelpers("/__openclaw__/video-assets");
assert.equal(helpers.url("rpc"), "/__openclaw__/video-assets/rpc");
assert.equal(helpers.prefix("file"), "/__openclaw__/video-assets/file/");
assert.equal(helpers.cookiePath(), "/__openclaw__/video-assets");
assert.equal(helpers.workbenchUrl("https://chat.tkx.info"), "https://chat.tkx.info/__openclaw__/video-assets/workbench/");
assert.equal(helpers.owns("/__openclaw__/video-assets/rpc/"), true);
assert.equal(helpers.owns("/__openclaw__/video-assets-other/rpc/"), false, "sibling prefix must not be claimed");
assert.throws(() => helpers.relative("/other"), /outside the plugin base path/);

// ------------------------------------------------------------------------------------------------
// 2. routes derive from the base path and keep their legacy shape
// ------------------------------------------------------------------------------------------------
const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-ren02-domain-"));
const allowedOrigin = "http://127.0.0.1";

async function registerPlugin(pluginConfig, query = "") {
  const entry = (await import(`../src/index.js${query}`)).default;
  const api = createHostApiStub({ pluginConfig, registrationMode: "full" });
  await entry.register(api);
  return api;
}

const api = await registerPlugin({
  repositoryRoot: path.join(tmp, "repo"),
  auth: { enabled: true, adminPasswordHash: hash, maxLoginAttempts: 5, loginWindowMinutes: 10, sessionTtlMinutes: 60 },
  security: { publicOrigin: allowedOrigin, csrfMode: "auto" }
});

const routePaths = api.httpRoutes.map((route) => route.path).sort();
assert.deepEqual(
  routePaths,
  [
    "/__openclaw__/video-assets/auth/login",
    "/__openclaw__/video-assets/auth/logout",
    "/__openclaw__/video-assets/auth/status",
    "/__openclaw__/video-assets/file/",
    "/__openclaw__/video-assets/proxy/",
    "/__openclaw__/video-assets/rpc/",
    "/__openclaw__/video-assets/thumb/",
    // REN-06: the streaming upload route. Every path here must move together with the base path, which is
    // exactly what this assertion proves; the new route is registered from that same single source.
    "/__openclaw__/video-assets/upload/",
    "/__openclaw__/video-assets/workbench/"
  ],
  "default base path must keep every route path byte-identical (the REN-01/05 set plus the REN-06 upload route) for one base path"
);
assert.equal(api.httpRoutes.length, 9, "REN-02's security surface is unreduced by REN-06's single added upload route (see the registration contract test)");

// Custom base path moves every route together (proves there is one source, not eight literals).
const apiCustom = await registerPlugin({ repositoryRoot: path.join(tmp, "repo-custom"), auth: { enabled: false }, security: { basePath: "/mnt/video-assets" } }, "?custom=1");
assert.deepEqual(
  apiCustom.httpRoutes.map((route) => route.path).sort(),
  [
    "/mnt/video-assets/auth/login",
    "/mnt/video-assets/auth/logout",
    "/mnt/video-assets/auth/status",
    "/mnt/video-assets/file/",
    "/mnt/video-assets/proxy/",
    "/mnt/video-assets/rpc/",
    "/mnt/video-assets/thumb/",
    "/mnt/video-assets/upload/",
    "/mnt/video-assets/workbench/"
  ],
  "a custom basePath must relocate routes, file routes and the workbench together"
);

// ------------------------------------------------------------------------------------------------
// 3. login -> cookie flags -> CSRF -> session lifecycle
// ------------------------------------------------------------------------------------------------
const loginRoute = findRoute(api, "/__openclaw__/video-assets/auth/login");
const logoutRoute = findRoute(api, "/__openclaw__/video-assets/auth/logout");
const statusRoute = findRoute(api, "/__openclaw__/video-assets/auth/status");
const rpcRoute = findRoute(api, "/__openclaw__/video-assets/rpc/");

// foreign Origin on the login route is rejected
{
  const res = fakeResponse();
  await loginRoute.handler(fakeRequest({ method: "POST", url: "/__openclaw__/video-assets/auth/login", headers: { origin: "https://evil.example" }, body: { password } }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, "CSRF_ORIGIN_DENIED");
}

// login without Origin is allowed (documented exemption: no ambient credential yet)
let token;
{
  const res = fakeResponse();
  await loginRoute.handler(fakeRequest({ method: "POST", url: "/__openclaw__/video-assets/auth/login", headers: { origin: allowedOrigin }, body: { password } }), res);
  assert.equal(res.statusCode, 200, `login with the declared origin must succeed: ${res.body}`);
  const cookie = String(res.headers["set-cookie"]);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\/__openclaw__\/video-assets(;|$)/, `cookie Path must follow the base path: ${cookie}`);
  assert.doesNotMatch(cookie, /Secure/, "loopback HTTP without a trusted proxy must NOT set Secure");
  token = res.cookieToken();
  assert.ok(token, "login must return a session cookie");
}
{
  const res = fakeResponse();
  await loginRoute.handler(fakeRequest({ method: "POST", url: "/__openclaw__/video-assets/auth/login", headers: { "content-type": "application/json" }, body: { password } }), res);
  assert.equal(res.statusCode, 200, "missing Origin on the login route stays allowed");
}

// cookie-authenticated write without Origin -> CSRF_ORIGIN_MISSING
{
  const res = fakeResponse();
  await rpcRoute.handler(fakeRequest({ method: "POST", url: "/__openclaw__/video-assets/rpc/", headers: { cookie: `ova_session=${token}` }, body: { method: "videoAssets.ui.dashboardSummary", params: {} } }), res);
  assert.equal(res.statusCode, 403, "a cookie-authenticated write without Origin must be rejected");
  assert.equal(res.json().code, "CSRF_ORIGIN_MISSING");
}
// foreign Origin -> denied
{
  const res = fakeResponse();
  await rpcRoute.handler(fakeRequest({ method: "POST", url: "/__openclaw__/video-assets/rpc/", headers: { cookie: `ova_session=${token}`, origin: "https://evil.example" }, body: { method: "videoAssets.ui.dashboardSummary", params: {} } }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, "CSRF_ORIGIN_DENIED");
}
// Sec-Fetch-Site: cross-site -> denied even with an allowed Origin
{
  const res = fakeResponse();
  await rpcRoute.handler(fakeRequest({ method: "POST", url: "/__openclaw__/video-assets/rpc/", headers: { cookie: `ova_session=${token}`, origin: allowedOrigin, "sec-fetch-site": "cross-site" }, body: { method: "videoAssets.ui.dashboardSummary", params: {} } }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, "CSRF_CROSS_SITE");
}
// allowed Origin -> 200, and the dashboard now exposes the security posture
{
  const res = fakeResponse();
  await rpcRoute.handler(fakeRequest({ method: "POST", url: "/__openclaw__/video-assets/rpc/", headers: { cookie: `ova_session=${token}`, origin: allowedOrigin }, body: { method: "videoAssets.ui.dashboardSummary", params: { actor_id: "human:plugin-admin" } } }), res);
  assert.equal(res.statusCode, 200, `allowed-origin write must succeed: ${res.body}`);
  const payload = res.json();
  assert.equal(payload.ok, true);
  assert.ok(payload.result.security, "dashboard summary must expose the security posture");
  assert.equal(payload.result.security.base_path, DEFAULT_BASE_PATH);
  assert.equal(payload.result.security.auth.proxy_trust.trust_forwarded_headers, false, "forwarded headers are not trusted by default");
  assert.ok(Array.isArray(payload.result.security.generation.policy.allow_surfaces));
  assert.equal(payload.result.security.generation.policy.ledger, "none", "no budget ledger is configured by default");
}
// safe method without Origin still works
{
  const res = fakeResponse();
  await statusRoute.handler(fakeRequest({ method: "GET", url: "/__openclaw__/video-assets/auth/status", headers: { cookie: `ova_session=${token}` } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().actor_source, "plugin-session", "the session actor must be reported as trusted");
}
// GET on the logout/operator route returns a token-free inventory
{
  const res = fakeResponse();
  await logoutRoute.handler(fakeRequest({ method: "GET", url: "/__openclaw__/video-assets/auth/logout", headers: { cookie: `ova_session=${token}` } }), res);
  assert.equal(res.statusCode, 200);
  const payload = res.json();
  assert.ok(payload.sessions.length >= 1);
  assert.equal(payload.sessions.some((session) => JSON.stringify(session).includes(token)), false, "the inventory must never contain a session token");
  assert.ok(payload.describe.origin_policy.declared_origins.includes(allowedOrigin));
  assert.ok(payload.decisions.some((decision) => decision.kind === "origin_check"));
}
// logout revokes the session; reuse is rejected
{
  const res = fakeResponse();
  await logoutRoute.handler(fakeRequest({ method: "POST", url: "/__openclaw__/video-assets/auth/logout", headers: { cookie: `ova_session=${token}`, origin: allowedOrigin } }), res);
  assert.equal(res.statusCode, 200);
  const after = fakeResponse();
  await statusRoute.handler(fakeRequest({ method: "GET", url: "/__openclaw__/video-assets/auth/status", headers: { cookie: `ova_session=${token}` } }), after);
  assert.equal(after.statusCode, 401);
}
// DELETE revokes every session
{
  const relog = fakeResponse();
  await loginRoute.handler(fakeRequest({ method: "POST", url: "/__openclaw__/video-assets/auth/login", headers: { origin: allowedOrigin }, body: { password } }), relog);
  const token2 = relog.cookieToken();
  const revoke = fakeResponse();
  await logoutRoute.handler(fakeRequest({ method: "DELETE", url: "/__openclaw__/video-assets/auth/logout", headers: { cookie: `ova_session=${token2}`, origin: allowedOrigin } }), revoke);
  assert.equal(revoke.statusCode, 200);
  assert.ok(revoke.json().revoked >= 1);
  const after = fakeResponse();
  await statusRoute.handler(fakeRequest({ method: "GET", url: "/__openclaw__/video-assets/auth/status", headers: { cookie: `ova_session=${token2}` } }), after);
  assert.equal(after.statusCode, 401);
}

// ------------------------------------------------------------------------------------------------
// 4. documented legacy shape: no declared deployment origin -> missing Origin on a write is accepted
// ------------------------------------------------------------------------------------------------
{
  const legacyApi = await registerPlugin({ repositoryRoot: path.join(tmp, "repo-legacy"), auth: { enabled: false }, security: { csrfMode: "auto" } }, "?legacy=1");
  const legacyRpc = findRoute(legacyApi, "/__openclaw__/video-assets/rpc/");
  const res = fakeResponse();
  await legacyRpc.handler(fakeRequest({ method: "POST", url: "/__openclaw__/video-assets/rpc/", body: { method: "videoAssets.ui.dashboardSummary", params: {} } }), res);
  assert.equal(res.statusCode, 200, "with no declared origin the pre-REN-02 in-process shape is preserved");
  const denied = fakeResponse();
  await legacyRpc.handler(fakeRequest({ method: "POST", url: "/__openclaw__/video-assets/rpc/", headers: { origin: "https://evil.example" }, body: { method: "videoAssets.ui.dashboardSummary", params: {} } }), denied);
  assert.equal(denied.statusCode, 403, "an explicit foreign Origin is rejected even without a declared origin");
}
let strictApi = null;
// strict mode rejects the missing-Origin write even with no declared origin
{
  strictApi = await registerPlugin({ repositoryRoot: path.join(tmp, "repo-strict"), auth: { enabled: false }, security: { csrfMode: "strict" } }, "?strict=1");
  const strictRpc = findRoute(strictApi, "/__openclaw__/video-assets/rpc/");
  const res = fakeResponse();
  await strictRpc.handler(fakeRequest({ method: "POST", url: "/__openclaw__/video-assets/rpc/", body: { method: "videoAssets.ui.dashboardSummary", params: {} } }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, "CSRF_ORIGIN_MISSING");
}

// ------------------------------------------------------------------------------------------------
// 5. the shipped workbench carries no bare loopback/private addresses
// ------------------------------------------------------------------------------------------------
{
  const uiDir = path.join(rootDir, "ui-dist");
  const offenders = [];
  for (const name of fs.readdirSync(uiDir, { recursive: true })) {
    const file = path.join(uiDir, name);
    if (!fs.statSync(file).isFile()) continue;
    if (!/\.(js|html|css)$/i.test(name)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (/https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|10\.|192\.168\.)/.test(text)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], "the built workbench must not embed loopback/private absolute URLs");
  // The built shell must reference its own assets through the workbench prefix (the route is covered
  // over real HTTP in host-smoke; the stub response object cannot stream).
  const indexHtml = fs.readFileSync(path.join(uiDir, "index.html"), "utf8");
  const assetRefs = [...indexHtml.matchAll(/src="([^"]+)"|href="([^"]+)"/g)].map((match) => match[1] ?? match[2]);
  assert.ok(assetRefs.length >= 2, "the workbench shell must reference its built assets");
  for (const ref of assetRefs) {
    assert.ok(ref.startsWith("/__openclaw__/video-assets/workbench/"), `built asset reference must stay under the workbench base: ${ref}`);
  }
  assert.ok(findRoute(api, "/__openclaw__/video-assets/workbench/"), "the workbench route must be registered under the effective base path");
}

// Close the plugin generations this check created (each registration keeps a SQLite handle open until
// the next generation disposes it), then exit explicitly: the harness intentionally loads several
// module generations, and an explicit exit keeps the check deterministic instead of waiting on
// teardown of those extra module graphs.
for (const generation of [apiCustom, strictApi]) {
  try {
    await generation.services[0]?.stop?.();
  } catch {
    // best-effort: the handle may already be closed by a later registration
  }
}
await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => {});
console.log("REN-02 domain/CSRF/cookie check passed");
process.exit(0);
