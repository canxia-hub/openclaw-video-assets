/**
 * Host-shaped plugin API stub for isolated contract tests (REN-01).
 *
 * IMPORTANT SCOPE NOTE: this is NOT proof that the real OpenClaw loader accepts the
 * plugin. It reproduces the *shape* of the documented public plugin API so registration
 * contracts, scope metadata, route auth metadata and reload isolation can be asserted
 * without a gateway. Real loader acceptance is covered separately by
 * implementation/REN-01/host-smoke (installed-host install + inspect --runtime).
 */

const DEFAULT_RESOURCE_METHODS = [
  "registerAppResource",
  "registerResource",
  "registerUiResource",
  "registerWidgetResource"
];

export const HOST_API_METHODS = [
  "registerTool",
  "registerGatewayMethod",
  "registerHttpRoute",
  "registerService",
  "registerReload",
  ...DEFAULT_RESOURCE_METHODS
];

/**
 * @param {object} options
 * @param {object} [options.pluginConfig] plugin config handed to the plugin
 * @param {string} [options.registrationMode] api.registrationMode value
 * @param {string[]} [options.omitMethods] surfaces to remove (older/smaller host shape)
 */
export function createHostApiStub({ pluginConfig = {}, registrationMode = "full", omitMethods = [], defaultToolContext = null, restArgsRegisterTool = false, noRegistrationMode = false } = {}) {
  const omitted = new Set(omitMethods);
  const api = {
    id: "video-assets",
    name: "视频资产库",
    defaultToolContext,
    version: "0.1.0",
    description: "test stub",
    source: "test-stub",
    rootDir: process.cwd(),
    config: {},
    pluginConfig,
    logger: createLoggerRecorder(),
    tools: [],
    gatewayMethods: [],
    httpRoutes: [],
    services: [],
    reloads: [],
    resources: [],
    // `restArgsRegisterTool` reproduces the shape the REAL host exposes (measured 2026-09-21:
    // `api.registerTool.length === 0` because the registrar is wrapped with `(...args) => ...`).
    // `noRegistrationMode` models an older host that advertises neither modern signal.
    registerTool(tool, opts) {
      // REN-02: the host resolves a FACTORY with the runtime tool context
      // (`dist/loader-runtime-load-BgaHcThS.mjs:3929`). The stub mirrors that so tests can observe
      // both the factory seam and the identity the plugin derives from it.
      if (typeof tool === "function") {
        const context = opts?.toolContext ?? api.defaultToolContext ?? null;
        const resolved = tool(context);
        api.tools.push({ definition: resolved, opts, factory: tool, toolContext: context });
        return;
      }
      api.tools.push({ definition: tool, opts, factory: null, toolContext: null });
    },
    registerGatewayMethod(method, handler, opts) {
      api.gatewayMethods.push({ method, handler, opts });
    },
    registerHttpRoute(params) {
      api.httpRoutes.push(params);
    },
    registerService(service) {
      api.services.push(service);
    },
    registerReload(registration) {
      api.reloads.push(registration);
    }
  };
  for (const method of DEFAULT_RESOURCE_METHODS) {
    api[method] = (resources) => {
      api.resources.push({ method, resources });
    };
  }
  for (const method of omitted) delete api[method];
  // Applied AFTER the object literal so the property keeps a real rest-args signature (`length === 0`),
  // exactly like the host's registrar adapter. Defining it inline as `(...args) => {}` would be an
  // arrow property and is fine too, but this keeps one implementation of the registration body.
  if (restArgsRegisterTool) {
    const register = api.registerTool;
    api.registerTool = (...args) => register(...args);
  }
  if (noRegistrationMode) delete api.registrationMode; else api.registrationMode = registrationMode;
  return api;
}

export function createLoggerRecorder() {
  const entries = [];
  const push = (level) => (message) => entries.push({ level, message: String(message) });
  return {
    entries,
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    log: push("info")
  };
}

/** Minimal IncomingMessage-shaped request with an async-iterable body. */
export function fakeRequest({ method = "GET", url = "/", headers = {}, body } = {}) {
  const payload = body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8")];
  return {
    method,
    url,
    headers: { host: "127.0.0.1", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk;
    }
  };
}

/** Minimal ServerResponse-shaped recorder. */
export function fakeResponse() {
  const headers = {};
  return {
    statusCode: 200,
    headers,
    body: "",
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += String(chunk);
      this.ended = true;
    },
    json() {
      return this.body ? JSON.parse(this.body) : null;
    },
    cookieToken() {
      const cookie = headers["set-cookie"];
      const match = /ova_session=([^;]+)/.exec(String(cookie ?? ""));
      return match ? match[1] : null;
    }
  };
}

/** Read the repository manifest used as the contracts.tools admission list. */
export async function readPluginManifest(rootDir) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  return JSON.parse(fs.readFileSync(path.join(rootDir, "openclaw.plugin.json"), "utf8"));
}

export function findRoute(api, path) {
  return api.httpRoutes.find((route) => route.path === path);
}
