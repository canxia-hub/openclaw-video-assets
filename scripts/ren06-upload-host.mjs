// REN-06 / scripts/ren06-upload-host.mjs
//
// A REAL HTTP host for the plugin's registered routes, used to exercise the streaming upload endpoint
// over a real socket on an explicit loopback port.
//
// WHAT IS REAL HERE
//   * The plugin's own entry point (src/index.js) is loaded and its register() runs, so the upload route
//     under test is the one the plugin actually declares - not a reimplementation.
//   * A real node http.Server listens on port 20006 and dispatches by the plugin's own base path, so the
//     byte accounting, the offsets, the streaming and the status codes are produced by the real handlers.
//   * Authentication is the plugin's real path: a password hash is configured, /auth/login mints a
//     session, and upload requests carry that session cookie. The upload store identifies the owner from
//     that session - there is no owner parameter a caller can set.
//
// WHAT IS NOT REAL HERE (stated plainly)
//   * The host adapter is a minimal stand-in for the OpenClaw gateway: it records routes/tools/services
//     and serves the HTTP routes. It is NOT the production gateway.
//
// Usage: node scripts/ren06-upload-host.mjs --repo <repositoryRoot> --port 20006 --out <json> [--keep-alive-ms N]
// Prints one JSON object with the endpoint/credential facts the caller needs, then stays up until stdin
// closes or the timeout elapses.

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { register as registerLoaderHook } from "node:module";
import { hashPassword } from "../src/security.js";
import { DEFAULT_BASE_PATH } from "../src/base-path.js";

registerLoaderHook(new URL("../../../host/loader.mjs", import.meta.url));

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const repoRoot = arg("repo");
const port = Number(arg("port", "20006"));
const outPath = arg("out");
const keepAliveMs = Number(arg("keep-alive-ms", "0"));
const testPassword = arg("password", "ren06-isolated-test-password");
const basePath = arg("base-path", DEFAULT_BASE_PATH);
const policyOverrides = arg("policy");
const rssLogPath = arg("rss-log");
/** Set when --rss-log is in use: records request boundaries for memory attribution (test instrumentation). */
let MARK_REQUEST = null;
if (!repoRoot) {
  console.error("usage: node scripts/ren06-upload-host.mjs --repo <repositoryRoot> --port <port> --out <json>");
  process.exit(2);
}

// The port must be free: this host binds an explicit port and never hunts for one, so a stale listener is
// a failure to report rather than something to route around.
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
  // SecurityManager reads the password hash from pluginConfig.auth, not from a `security` block.
  auth: {
    enabled: true,
    adminPasswordHash: await hashPassword(testPassword),
    sessionTtlMinutes: 60,
    allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
  },
  ...(policyOverrides ? { upload: JSON.parse(policyOverrides) } : {})
};

const routes = [];
const tools = [];
const services = [];
const api = {
  pluginConfig,
  logger,
  registerHttpRoute: (route) => routes.push(route),
  registerTool: (definition) => tools.push(definition),
  registerGatewayMethod: () => {},
  registerService: (definition) => services.push(definition),
  registerReloadPolicy: () => {},
  registerResource: () => {},
  on: () => {}
};

registerLoaderHook(new URL("../../../host/loader.mjs", import.meta.url));
const plugin = (await import("../src/index.js")).default;
await plugin.register(api);

// The service holds the repository; the host uses it only to read the upload policy summary, so the
// listener reports exactly the limits the plugin is enforcing.
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const route = routes.find((candidate) => {
    if (candidate.match === "prefix") {
      // A prefix route is registered WITH a trailing slash (`.../upload/`), but the collection URL itself is
      // naturally written without it (`POST .../upload`). Matching only `startsWith(".../upload/")` therefore
      // 404s the collection endpoint while accepting every item URL - a discrepancy that would look like a
      // missing feature. Both forms are accepted here, mirroring the file route's behaviour.
      const base = candidate.path.replace(/\/+$/, "");
      return pathname === base || pathname.startsWith(candidate.path);
    }
    return pathname === candidate.path;
  });
  if (!route) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: `no route for ${pathname}` }));
    return;
  }
  // Handlers are asynchronous; an unhandled rejection must not take the host down mid-run, because that
  // would look like a network fault rather than a bug in the thing under test.
  MARK_REQUEST?.("start", req.method, pathname);
  const finish = () => MARK_REQUEST?.("end", req.method, pathname);
  res.on("finish", finish);
  res.on("close", finish);
  Promise.resolve(route.handler(req, res)).catch((error) => {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
    } else {
      res.destroy();
    }
  });
});

await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

const facts = {
  port,
  base_path: basePath,
  repository_root: repoRoot,
  password: testPassword,
  http_routes: routes.map((route) => `${route.match ?? "exact"} ${route.path}`),
  upload_route_registered: routes.some((route) => route.path === `${basePath}/upload/`),
  endpoints: {
    create: `${basePath}/upload`,
    append: `${basePath}/upload/<upload_id>`,
    status: `${basePath}/upload/<upload_id>`,
    complete: `${basePath}/upload/<upload_id>/complete`,
    cancel: `${basePath}/upload/<upload_id>`,
    list: `${basePath}/upload`
  },
  // Deliberately NOT a copy of the limits: the host adapter records route definitions, not live service
  // instances, so any value read here would be second-hand. The acceptance checks read the enforced
  // policy from the authenticated GET /upload response, which is the handler's own view.
  upload_policy_source: "GET " + basePath + "/upload (authenticated)"
};

if (outPath) fs.writeFileSync(outPath, `${JSON.stringify(facts, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, ...facts }));

// TEST INSTRUMENTATION (not part of the plugin): the host samples its OWN resident set size and appends
// it to a file. The alternative - having the test spawn `Get-Process`/`tasklist` on a timer - would add a
// process launch to every sample and pollute both the timing and the very measurement being taken.
// `rss` is the whole server process; `heapUsed`/`external` are reported alongside so a large buffer would
// show up as `external` growth even if `rss` were dominated by the runtime baseline.
if (rssLogPath) {
  const startedAt = Date.now();
  const sample = () => {
    const memory = process.memoryUsage();
    fs.appendFileSync(rssLogPath, `${JSON.stringify({ kind: "sample", t_ms: Date.now() - startedAt, rss: memory.rss, heap_used: memory.heapUsed, external: memory.external, array_buffers: memory.arrayBuffers ?? null })}\n`, "utf8");
  };
  sample();
  const timer = setInterval(sample, 200);
  timer.unref?.();
  // Request-boundary markers in the same stream, so a memory spike can be attributed to the request that
  // was in flight. Without them the only thing a spike tells you is "something happened".
  MARK_REQUEST = (phase, method, pathname) => {
    const memory = process.memoryUsage();
    fs.appendFileSync(rssLogPath, `${JSON.stringify({ kind: "mark", phase, method, path: pathname, t_ms: Date.now() - startedAt, rss: memory.rss, external: memory.external })}\n`, "utf8");
  };
}

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on("SIGTERM", shutdown);
if (keepAliveMs > 0) setTimeout(shutdown, keepAliveMs).unref();
process.stdin.on("end", shutdown);
process.stdin.resume();
