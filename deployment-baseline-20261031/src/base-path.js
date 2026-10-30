/**
 * REN-02: single source of truth for the plugin's URL base path.
 *
 * Why this module exists
 * ---------------------
 * Before REN-02 every route path, the session cookie `Path`, the workbench UI mount point and the
 * UI's own fetch targets were written as independent string literals. They agreed by convention
 * only, so a deployment behind a prefix (for example `https://chat.tkx.info` where the gateway is
 * itself mounted under a path) could serve the UI from one prefix while the cookie was scoped to
 * another - the browser then silently drops the session cookie and the whole authenticated surface
 * degrades to "login succeeds, every subsequent call is 401".
 *
 * REN-02 removes the duplication: this module derives every externally visible path from ONE value
 * (the effective base path), and the deployment can move the plugin without touching code.
 *
 * Default is unchanged (`/__openclaw__/video-assets`) so existing routes, cookies and UI keep the
 * exact same URLs.
 */

export const DEFAULT_BASE_PATH = "/__openclaw__/video-assets";

/** Sub-paths that hang off the base path. Keep the list in one place so routes and checks agree. */
export const ROUTE_SEGMENTS = Object.freeze({
  authLogin: "auth/login",
  authLogout: "auth/logout",
  authStatus: "auth/status",
  rpc: "rpc",
  file: "file",
  thumb: "thumb",
  proxy: "proxy",
  // REN-06: streaming upload endpoint. Declared here - the same single source of truth that drives every
  // other route, the session cookie Path and the workbench URL - so the new route can not drift from the
  // rest of the surface. Uploads can not ride the `rpc` segment because that transport reads the entire
  // request body into memory as JSON, which is exactly what a large streaming upload must avoid.
  upload: "upload",
  workbench: "workbench"
});

/**
 * Normalize a configured base path.
 * Rules: absolute path only, no scheme/host/query/fragment, no traversal segments, no trailing
 * slash, no duplicate slashes. Anything else is rejected loudly instead of being silently coerced
 * (a silently coerced base path is how cookie/route mismatches happen in the first place).
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeBasePath(value) {
  if (value === undefined || value === null || String(value).trim() === "") return DEFAULT_BASE_PATH;
  let candidate = String(value).trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) throw new Error(`basePath must be a path, not a URL: ${candidate}`);
  if (/[?#]/.test(candidate)) throw new Error(`basePath must not contain a query or fragment: ${candidate}`);
  if (!candidate.startsWith("/")) candidate = `/${candidate}`;
  candidate = candidate.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  if (candidate === "") throw new Error("basePath must not be the site root");
  const segments = candidate.split("/").slice(1);
  for (const segment of segments) {
    if (segment === "." || segment === "..") throw new Error(`basePath must not contain traversal segments: ${value}`);
    if (!/^[A-Za-z0-9._~-]+$/.test(segment)) throw new Error(`basePath segment has unsupported characters: ${segment}`);
  }
  return candidate;
}

/**
 * Resolve the effective base path from plugin config.
 * @param {{ basePath?: unknown, auth?: { basePath?: unknown } }} [pluginConfig]
 * @returns {string}
 */
export function resolveBasePath(pluginConfig = {}) {
  const configured = pluginConfig?.security?.basePath ?? pluginConfig?.basePath;
  return normalizeBasePath(configured);
}

/**
 * Build the helper bundle used by the plugin runtime, the request layer and the tests so that no
 * caller has to concatenate paths by hand.
 * @param {unknown} basePath
 */
export function createBasePathHelpers(basePath) {
  const root = normalizeBasePath(basePath);
  const join = (...parts) => {
    const tail = parts
      .filter((part) => part !== undefined && part !== null && String(part) !== "")
      .map((part) => String(part).replace(/^\/+|\/+$/g, ""))
      .filter((part) => part !== "");
    return tail.length === 0 ? `${root}/` : `${root}/${tail.join("/")}`;
  };

  return {
    basePath: root,
    /** Absolute plugin path, e.g. `/__openclaw__/video-assets/rpc`. */
    url: (segment = "") => join(segment),
    /** Prefix route path (trailing slash) as registered with the host, e.g. `/…/rpc/`. */
    prefix: (segment) => `${join(segment)}/`,
    /** Exact route path as registered with the host. */
    exact: (segment) => join(segment),
    /** Session cookie `Path` attribute: the base path, so cookies never leak to sibling mounts. */
    cookiePath: () => (root === "" ? "/" : root),
    /** Public URL of the browser workbench inside a deployment origin. */
    workbenchUrl: (origin = "") => `${String(origin).replace(/\/+$/, "")}${join(ROUTE_SEGMENTS.workbench)}/`,
    /** True when `pathname` belongs to this plugin's surface. */
    owns: (pathname) => {
      const value = String(pathname ?? "");
      return value === root || value.startsWith(`${root}/`);
    },
    /** Strip the base path from a request pathname; throws when the path is not ours. */
    relative: (pathname) => {
      const value = String(pathname ?? "");
      if (value === root) return "/";
      if (!value.startsWith(`${root}/`)) throw new Error(`path is outside the plugin base path: ${value}`);
      return value.slice(root.length);
    }
  };
}
