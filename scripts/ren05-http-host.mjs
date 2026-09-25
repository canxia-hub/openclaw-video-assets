// REN-05 / scripts/ren05-http-host.mjs
//
// A REAL HTTP host for the plugin's registered routes.
//
// WHAT IS REAL HERE
//   * The plugin's own entry point (src/index.js) is loaded and its register() runs, so the routes
//     under test are the ones the plugin actually declares - not a reimplementation.
//   * A real node http.Server listens on an explicit loopback port and dispatches by the plugin's
//     own base path, so byte ranges, HEAD, and status codes are produced by the real handlers over a
//     real socket.
//   * Authentication is the plugin's real path: a password hash is configured, the /auth/login
//     route mints a session, and requests carry that session cookie or bearer token.
//
// WHAT IS NOT REAL HERE (stated plainly, and it matters)
//   * The host adapter is a minimal stand-in for the OpenClaw gateway: it records routes, tools and
//     services, and serves the HTTP routes. It is NOT the production gateway and this is NOT a
//     production UI acceptance run.
//   * The playback page served at /render-check is a MINIMAL TEST PAGE built by this script for
//     media-element verification. It is not the workbench UI and says nothing about the UI's own
//     layout or design.
//
// Usage: node scripts/ren05-http-host.mjs --repo <repositoryRoot> --port <port> --out <json> [--keep-alive-ms N]
// Prints one JSON object with the endpoint/credential facts the caller needs, then stays up until
// stdin closes or the timeout elapses.

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { register as registerLoaderHook } from "node:module";
import { hashPassword } from "../src/security.js";
import { DEFAULT_BASE_PATH } from "../src/base-path.js";

// The plugin entry imports "openclaw/plugin-sdk/plugin-entry", which an isolated clone has no
// node_modules for. The loader maps that ONE specifier to a local stub, and it is registered before
// the entry is imported so the resolution happens at import time.
registerLoaderHook(new URL("../../../host/loader.mjs", import.meta.url));

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const repoRoot = arg("repo");
const port = Number(arg("port", "20005"));
const outPath = arg("out");
const keepAliveMs = Number(arg("keep-alive-ms", "0"));
const testPassword = arg("password", "ren05-isolated-test-password");
const basePath = arg("base-path", DEFAULT_BASE_PATH);
if (!repoRoot) {
  console.error("usage: node scripts/ren05-http-host.mjs --repo <repositoryRoot> --port <port> --out <json>");
  process.exit(2);
}

// The port must be free: this host binds an explicit port and never hunts for one, so a stale
// listener is a failure to report rather than something to route around.
await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", (error) => reject(new Error(`port ${port} is not free: ${error.code}`)));
  probe.once("listening", () => probe.close(resolve));
  probe.listen(port, "127.0.0.1");
}).catch((error) => {
  console.error(String(error.message));
  process.exit(3);
});

const logger = { lines: [], info: (m) => logger.lines.push(`info:${m}`), warn: (m) => logger.lines.push(`warn:${m}`), error: (m) => logger.lines.push(`error:${m}`), debug: () => {} };

const pluginConfig = {
  repositoryRoot: repoRoot,
  basePath,
  // SecurityManager reads the password from pluginConfig.auth (resolvePasswordHash), not from a
  // `security` block; getting this wrong makes every login answer 503.
  auth: {
    enabled: true,
    adminPasswordHash: await hashPassword(testPassword),
    sessionTtlMinutes: 60,
    // The test host is reached over loopback HTTP, so that origin has to be explicitly allowed:
    // an ambient-session request with a foreign Origin is rejected by design.
    allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
  }
};

const routes = [];
const tools = [];
const services = [];
const rpc = [];
const api = {
  pluginConfig,
  logger,
  registerTool: (definition) => {
    const resolved = typeof definition === "function" ? definition({ runContext: {}, registrationMode: "static" }) : definition;
    if (resolved?.name) tools.push(resolved);
    return resolved;
  },
  registerHttpRoute: (route) => routes.push(route),
  registerGatewayMethod: (name, fn) => rpc.push({ name, fn }),
  registerService: (service) => services.push(service),
  registerReload: () => {},
  registerRoute: (route) => routes.push(route),
  registerRpcMethod: (name, fn) => rpc.push({ name, fn }),
  registerCommand: () => {},
  registerSessionResource: () => {},
  registerNativeWidgetResource: () => null,
  registerAppResource: () => [],
  on: () => {},
  getConfig: () => pluginConfig,
  registrationMode: "static"
};

const entry = (await import("../src/index.js")).default;
await entry.register(api);

// Dispatch exactly as the gateway contract describes: exact paths first, then the longest matching
// prefix, so /file/ and /inline/ can not shadow one another.
function findRoute(urlPath) {
  const exact = routes.filter((r) => (r.match ?? "exact") === "exact" && r.path === urlPath);
  if (exact.length) return exact[0];
  const prefixed = routes.filter((r) => r.match === "prefix" && urlPath.startsWith(r.path)).sort((a, b) => b.path.length - a.path.length);
  return prefixed[0] ?? null;
}

// The page is a real file (host/render-check.html) rather than an inline template: inlining it made the
// nested quoting unreadable and un-reviewable. It is a MINIMAL TEST PAGE for media-element checks.
const RENDER_CHECK_PAGE = fs.readFileSync(new URL("../../../host/render-check.html", import.meta.url), "utf8");

const server = http.createServer(async (req, res) => {
  const urlPath = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (urlPath === "/render-check" || urlPath === "/render-check/") {
    // The media URLs and the test password are injected per request. The password comes from this
    // host's own configuration and is never taken from the query string, so the page can not be
    // pointed at a different credential by whoever opens the URL.
    const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
    const urls = {
      video: query.get("video") ?? "",
      audio: query.get("audio") ?? "",
      image: query.get("image") ?? ""
    };
    const inject = `id="run" data-urls='${JSON.stringify(urls)}' data-password="${testPassword.replace(/"/g, "&quot;")}"`;
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(RENDER_CHECK_PAGE.replace('id="run"', inject));
    return;
  }
  const route = findRoute(urlPath);
  if (!route) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "no route", code: "ROUTE_NOT_FOUND" }));
    return;
  }
  try {
    await route.handler(req, res);
  } catch (error) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: false, error: "handler threw", code: "HANDLER_ERROR" }));
    } else {
      res.end();
    }
  }
});

await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

const facts = {
  ok: true,
  port,
  base_path: basePath,
  origin: `http://127.0.0.1:${port}`,
  render_check_path: "/render-check",
  repository_root: repoRoot,
  test_password: testPassword,
  login_path: `${basePath}auth/login`.replace(/\/\//g, "/"),
  route_count: routes.length,
  routes: routes.map((r) => ({ path: r.path, match: r.match ?? "exact", auth: r.auth })),
  tool_count: tools.length,
  service_count: services.length,
  rpc_count: rpc.length,
  scope_note: "minimal test host adapter; serves the plugin's real registered routes over a real socket. Not the production gateway."
};
if (outPath) {
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await fs.promises.writeFile(outPath, `${JSON.stringify(facts, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify(facts));

const shutdown = async () => {
  await new Promise((resolve) => server.close(resolve));
  try {
    entry.dispose?.();
  } catch {
    /* disposal is best-effort in the test host */
  }
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("close", shutdown);
process.stdin.resume();
if (keepAliveMs > 0) setTimeout(shutdown, keepAliveMs);

