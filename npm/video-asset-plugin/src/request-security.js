/**
 * REN-02: request-level trust decisions - browser origin (CSRF), forwarded headers, client address.
 *
 * Evidence this fixes (parent review, `05-evidence-review.md` §3 / `02-workbench-domain-audit.md`):
 *   * `security.js` let every request through when `auth.allowedOrigins` was empty and skipped the
 *     Origin check entirely when the header was absent - so a cross-site write from a browser that
 *     omits Origin (or any non-browser client) was never challenged;
 *   * `getClientIp()` trusted the FIRST `x-forwarded-for` entry. A caller can prepend an arbitrary
 *     address, so login rate limiting could be bypassed by rotating a spoofed header;
 *   * nothing looked at `x-forwarded-proto`, so the deployment could not tell whether the external
 *     hop was HTTPS (and therefore whether the session cookie must carry `Secure`).
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const FORWARDED_PROTO_VALUES = new Set(["http", "https"]);

/**
 * @param {Record<string, unknown>} [config] `security` block of the plugin config.
 */
export function resolveRequestSecurityConfig(config = {}) {
  const trustedProxies = Array.isArray(config.trustedProxies) ? config.trustedProxies.map((v) => String(v).trim()).filter(Boolean) : [];
  const allowedOrigins = Array.isArray(config.allowedOrigins) ? config.allowedOrigins : [];
  const publicOrigin = typeof config.publicOrigin === "string" && config.publicOrigin.trim() ? config.publicOrigin.trim() : null;
  return {
    mode: normalizeMode(config.csrfMode),
    allowedOrigins: allowedOrigins.map((value) => normalizeOrigin(value)).filter(Boolean),
    publicOrigin: publicOrigin ? normalizeOrigin(publicOrigin) : null,
    /** Trusting forwarded headers is opt-in: the default deployment terminates TLS in the gateway. */
    trustForwardedHeaders: config.trustProxyHeaders === true,
    trustedProxies,
    /**
     * `auto` derives the deployment origin from the Host header ONLY as a development fallback:
     * it applies when no explicit origin is configured and the Host is a loopback/localhost name.
     * A request can never widen a configured allowlist by forging Host + Origin together, and a
     * public Host is not trusted implicitly (review round 2, issue 5).
     */
    deriveOriginFromHost: config.deriveOriginFromHost !== false,
    /** When true, a write authenticated by an ambient cookie must also carry an allowed Origin. */
    enforceCookieCsrf: config.enforceCookieCsrf !== false
  };
}

function normalizeMode(value) {
  const mode = String(value ?? "auto").trim().toLowerCase();
  if (mode === "off" || mode === "auto" || mode === "strict") return mode;
  return "auto";
}

/**
 * Canonicalize an origin: lowercase scheme/host, drop the default port, drop any path.
 * Returns null for `null`, empty, malformed or non-http(s) values.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeOrigin(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.toLowerCase() === "null") return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  const port = url.port && url.port !== defaultPort ? `:${url.port}` : "";
  return `${url.protocol}//${url.hostname.toLowerCase()}${port}`;
}

/**
 * Origin/CSRF policy.
 *
 * Decision table (documented in the REN-02 security report):
 *   * an explicit Origin that is not on the allowlist is rejected for EVERY method - a browser
 *     never needs a foreign origin here, and rejecting it early removes the whole CORS question;
 *   * an unsafe method (POST/PUT/PATCH/DELETE) must carry an Origin on the allowlist when the
 *     deployment declared its origin (explicitly configured, or via the loopback development
 *     fallback) and the request is authenticated by an ambient cookie, and in `strict` mode in
 *     every case. Missing Origin in `auto` mode with no declared origin is the pre-existing
 *     in-process shape; it is reported as `policy: "underived"` instead of being silently accepted.
 *     A request `Host` never adds to configured origins: `origin_source` reports exactly where the
 *     declared set came from (config | host-derived-loopback | host-not-trusted | disabled).
 *   * the unauthenticated login route is exempt from the missing-Origin rule (a caller that has no
 *     session yet cannot be meaningfully CSRF-challenged, and it cannot guess the password), but a
 *     supplied foreign Origin is still rejected;
 *   * safe methods keep the pre-existing behaviour: no allowlist means "value not declared", and a
 *     supplied foreign Origin is rejected.
 */
export function createOriginPolicy(config = {}, { basePath = "/__openclaw__/video-assets" } = {}) {
  const settings = resolveRequestSecurityConfig(config);
  const workbenchPath = `${basePath}/workbench/`;

  /**
   * @param {Record<string, unknown>} req
   * @param {{ method?: string, hasAmbientCredential?: boolean, isLoginRoute?: boolean, protocol?: string }} [options]
   */
  function evaluate(req, options = {}) {
    const headers = (req && req.headers) || {};
    const method = String(options.method ?? req?.method ?? "GET").toUpperCase();
    const safe = SAFE_METHODS.has(method);
    const rawOrigin = headers.origin;
    const origin = normalizeOrigin(rawOrigin);
    const hasOriginHeader = typeof rawOrigin === "string" && rawOrigin.trim() !== "";

    if (settings.mode === "off") {
      return { ok: true, code: "CSRF_DISABLED", policy: "off", origin, declared_origins: declaredOrigins(req, options).origins };
    }

    const declaredSet = declaredOrigins(req, options);
    const declared = declaredSet.origins;
    const policyState = declared.length > 0 ? "declared" : "underived";

    if (hasOriginHeader && !origin) {
      return deny(403, "CSRF_ORIGIN_INVALID", "request origin is not a valid http(s) origin", { origin_header: String(rawOrigin).slice(0, 120), policy: policyState });
    }
    if (origin && !declared.includes(origin)) {
      return deny(403, "CSRF_ORIGIN_DENIED", "request origin is not allowed for this deployment", { origin, allowed_origins: declared, policy: policyState });
    }

    if (safe) return { ok: true, code: "OK", policy: policyState, origin, declared_origins: declared };

    // Unsafe method from here on.
    const crossSiteHint = String(headers["sec-fetch-site"] ?? "").toLowerCase();
    if (crossSiteHint === "cross-site") {
      return deny(403, "CSRF_CROSS_SITE", "cross-site request rejected for a state-changing method", { sec_fetch_site: "cross-site", origin, policy: policyState });
    }

    if (options.isLoginRoute) {
      return { ok: true, code: "OK", policy: policyState, origin, declared_origins: declared, note: "login route: missing Origin is not a CSRF signal" };
    }

    const strict = settings.mode === "strict";
    const declaredPolicy = policyState === "declared";
    const ambientCredential = options.hasAmbientCredential !== false;
    const originRequired = strict || (declaredPolicy && settings.enforceCookieCsrf && ambientCredential);
    if (!origin && originRequired) {
      return deny(403, "CSRF_ORIGIN_MISSING", "state-changing request must carry an allowed Origin header", {
        policy: policyState,
        mode: settings.mode,
        ambient_credential: ambientCredential,
        workbench_path: workbenchPath
      });
    }

    return {
      ok: true,
      code: "OK",
      policy: policyState,
      origin,
      declared_origins: declared,
      note: origin ? undefined : "no Origin header and no declared deployment origin: accepted as a non-browser client"
    };
  }

  /**
   * The authoritative declared-origin set.
   *
   * Priority (review round 2, issue 5): explicit configuration wins and is the ONLY source when it
   * exists; a Host-derived origin is a loopback-only development fallback and is never merged into a
   * configured allowlist. A request therefore cannot turn a fixed deployment domain into an open
   * whitelist by sending a matching Host and Origin.
   *
   * @returns {{origins: string[], source: "config"|"host-derived-loopback"|"host-not-trusted"|"disabled"}}
   */
  function declaredOrigins(req, options) {
    const explicit = [...settings.allowedOrigins];
    if (settings.publicOrigin) explicit.push(settings.publicOrigin);
    if (explicit.length > 0) return { origins: [...new Set(explicit)], source: "config" };
    if (!settings.deriveOriginFromHost) return { origins: [], source: "disabled" };
    const host = hostHeader(req);
    if (!host || !isLoopbackHost(host)) return { origins: [], source: "host-not-trusted" };
    const derived = originFromHost(req, options.protocol ?? "http");
    return derived ? { origins: [derived], source: "host-derived-loopback" } : { origins: [], source: "host-not-trusted" };
  }

  /** Declared origins for the current configuration, independent of any request (diagnostics/tests). */
  function configuredOrigins() {
    const explicit = [...settings.allowedOrigins];
    if (settings.publicOrigin) explicit.push(settings.publicOrigin);
    return { origins: [...new Set(explicit)], source: explicit.length > 0 ? "config" : "none" };
  }

  return { evaluate, declaredOrigins, configuredOrigins, settings, basePath };
}

function hostHeader(req) {
  const host = (req?.headers && (req.headers.host ?? req.headers[":authority"])) || null;
  if (typeof host !== "string" || !host.trim()) return null;
  const candidate = String(host).trim();
  // Reject header-injection shapes; a Host header may only be host[:port].
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(candidate)) return null;
  return candidate.toLowerCase().replace(/:\d+$/, "");
}

/** Only loopback development hosts may be derived from the request at all. */
export function isLoopbackHost(host) {
  const name = String(host ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!name) return false;
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (name === "127.0.0.1" || name.startsWith("127.")) return true;
  if (name === "::1") return true;
  return false;
}

function originFromHost(req, protocol) {
  const candidate = hostHeader(req);
  if (!candidate) return null;
  const rawHost = String(req?.headers?.host ?? req?.headers?.[":authority"] ?? "").trim();
  const hasPort = /:\d{1,5}$/.test(rawHost);
  const hostWithPort = hasPort ? rawHost.toLowerCase() : candidate;
  return normalizeOrigin(`${protocol === "https" ? "https" : "http"}://${hostWithPort}`);
}

function deny(status, code, error, details) {
  return { ok: false, status, code, error, details };
}

/**
 * Forwarded-header trust policy.
 *
 * Only a request that arrived FROM a configured trusted proxy may influence the client address or
 * the external protocol, and even then the address is derived by walking the forwarded chain from
 * the right (closest hop) to the left, skipping trusted proxies. With the default
 * `trustProxyHeaders: false` every forwarded header is ignored entirely, which is what makes a
 * spoofed `X-Forwarded-For` unable to bypass login rate limiting.
 */
export function createProxyTrustPolicy(config = {}) {
  const settings = resolveRequestSecurityConfig(config);

  function socketAddress(req) {
    const raw = req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? req?.clientAddress ?? null;
    return normalizeAddress(raw);
  }

  function trusted(hops) {
    for (const hop of hops) {
      if (settings.trustedProxies.some((entry) => matchesProxy(hop, entry))) return true;
    }
    return false;
  }

  /**
   * @returns {{ address: string, source: "socket"|"forwarded-chain"|"forwarded-untrusted-ignored", chain: string[], trusted: boolean }}
   */
  function resolveClientAddress(req) {
    const socket = socketAddress(req) ?? "unknown";
    if (!settings.trustForwardedHeaders || settings.trustedProxies.length === 0) {
      return { address: socket, source: "socket", chain: [socket], trusted: false, forwarded_ignored: forwardedHeaderPresent(req) };
    }
    if (!trusted([socket])) {
      return { address: socket, source: "forwarded-untrusted-ignored", chain: [socket], trusted: false, forwarded_ignored: forwardedHeaderPresent(req) };
    }
    const chain = splitForwardedChain(req?.headers?.["x-forwarded-for"]).concat([socket]);
    const hops = [];
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const hop = chain[index];
      hops.push(hop);
      if (!matchesAny(hop, settings.trustedProxies)) return { address: hop, source: "forwarded-chain", chain: hops, trusted: true };
    }
    return { address: chain[0] ?? socket, source: "forwarded-chain", chain: hops, trusted: true };
  }

  /**
   * External protocol for cookie flags. Only a trusted proxy may assert HTTPS via
   * `x-forwarded-proto`; otherwise the socket encryption is the only evidence.
   */
  function resolveProtocol(req, { clientAddressTrusted = false } = {}) {
    const socketIsTls = Boolean(req?.socket?.encrypted);
    if (settings.trustForwardedHeaders && clientAddressTrusted) {
      const values = splitForwardedProto(req?.headers?.["x-forwarded-proto"]);
      if (values.length > 0) return { protocol: values[values.length - 1], source: "x-forwarded-proto", trusted: true };
    }
    return { protocol: socketIsTls ? "https" : "http", source: socketIsTls ? "socket-tls" : "socket-plain", trusted: false };
  }

  return { resolveClientAddress, resolveProtocol, settings };
}

function forwardedHeaderPresent(req) {
  const headers = req?.headers ?? {};
  return Boolean(headers["x-forwarded-for"] || headers["x-forwarded-proto"] || headers["x-real-ip"] || headers["forwarded"]);
}

export function splitForwardedChain(value) {
  if (typeof value !== "string") return [];
  if (value.length > 2048) return [];
  return value
    .split(",")
    .map((entry) => normalizeAddress(entry))
    .filter(Boolean);
}

/**
 * `x-forwarded-proto` chain (a protocol token, not an address). Only `http`/`https` survive, and the
 * LAST value wins - the same closest-hop rule as the address chain.
 */
export function splitForwardedProto(value) {
  if (typeof value !== "string" || value.length > 512) return [];
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => FORWARDED_PROTO_VALUES.has(entry));
}

/** Normalize an IP literal: trim, strip port/brackets, unwrap IPv4-mapped IPv6. */
export function normalizeAddress(value) {
  if (value === undefined || value === null) return null;
  let raw = String(value).trim();
  if (!raw) return null;
  if (raw.startsWith("[") && raw.includes("]")) raw = raw.slice(1, raw.indexOf("]"));
  const lastColon = raw.lastIndexOf(":");
  if (lastColon > -1 && raw.indexOf(":") === lastColon && !raw.includes(".")) {
    // bare IPv6 (no brackets, single colon cannot happen) - keep as is
  } else if (lastColon > -1 && raw.slice(0, lastColon).includes(":") === false && raw.includes(".")) {
    raw = raw.slice(0, lastColon);
  }
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) raw = mapped[1];
  if (!/^[0-9A-Fa-f:.]{2,45}$/.test(raw)) return null;
  return raw.toLowerCase();
}

function matchesAny(address, patterns) {
  return patterns.some((pattern) => matchesProxy(address, pattern));
}

export function matchesProxy(address, pattern) {
  if (!address || !pattern) return false;
  const normalized = normalizeAddress(address);
  const normalizedPattern = String(pattern).trim().toLowerCase();
  if (!normalizedPattern) return false;
  if (normalizedPattern.includes("/")) return matchesCidr(normalized, normalizedPattern);
  return normalized === normalizeAddress(normalizedPattern);
}

function matchesCidr(address, cidr) {
  if (!address) return false;
  const [network, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0) return false;
  const addressParts = address.split(".").map(Number);
  const networkParts = String(network).split(".").map(Number);
  if (addressParts.length !== 4 || networkParts.length !== 4 || bits > 32) return false;
  if (addressParts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  if (networkParts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const toInt = (parts) => parts.reduce((acc, value) => (acc << 8) + value, 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(addressParts) & mask) === (toInt(networkParts) & mask);
}

/**
 * Secure-cookie decision.
 * `auto` (default): Secure is added whenever the effective external protocol is HTTPS - either the
 * socket is TLS or a TRUSTED proxy asserts `x-forwarded-proto: https`. An untrusted client cannot
 * turn the flag on (harmless) or off (harmful), because forwarded headers are ignored unless the
 * peer is a configured trusted proxy.
 */
export function resolveCookieSecure(config = {}, { protocol = "http" } = {}) {
  const setting = config.cookieSecure ?? config.auth?.cookieSecure ?? "auto";
  if (setting === true) return { secure: true, source: "config-forced" };
  if (setting === false) return { secure: false, source: "config-disabled" };
  return { secure: protocol === "https", source: protocol === "https" ? "https-detected" : "http-detected" };
}
