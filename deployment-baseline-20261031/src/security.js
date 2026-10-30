import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DEFAULT_BASE_PATH, createBasePathHelpers } from "./base-path.js";
import { createOriginPolicy, createProxyTrustPolicy, resolveCookieSecure } from "./request-security.js";

/**
 * REN-02 security manager.
 *
 * Changes over the REN-01 baseline (each one is asserted by a check in `scripts/`):
 *   * Origin/CSRF: an explicit foreign Origin is rejected for every method, and a state-changing
 *     request authenticated by an ambient session cookie must carry an allowed Origin. The previous
 *     behaviour - "empty allowlist means everyone is allowed" and "no Origin header means skip the
 *     check" - is gone.
 *   * Client address: only a configured trusted proxy may supply `x-forwarded-for`, and the address
 *     is taken by walking the chain from the closest hop, so a spoofed first entry cannot rotate the
 *     login-rate-limit key.
 *   * Cookie: `Secure` is added when the effective external protocol is HTTPS (socket TLS or a
 *     trusted proxy asserting `x-forwarded-proto`), and the `Path` comes from the single base path.
 *   * Sessions: absolute TTL plus an optional idle timeout, explicit per-session and bulk
 *     revocation, and a token-free session inventory for operators.
 */

const DEFAULT_ITERATIONS = 210_000;
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_LOGIN_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_LOGIN_ATTEMPTS = 5;
const MAX_LOGIN_BODY_BYTES = 8 * 1024;
export const SESSION_COOKIE = "ova_session";
const ADMIN_ACTOR_ID = "human:plugin-admin";

export class SecurityManager {
  constructor({ pluginConfig = {}, basePath = DEFAULT_BASE_PATH, now = () => Date.now() } = {}) {
    const authConfig = pluginConfig.auth && typeof pluginConfig.auth === "object" ? pluginConfig.auth : {};
    const securityConfig = pluginConfig.security && typeof pluginConfig.security === "object" ? pluginConfig.security : {};
    this.enabled = authConfig.enabled !== false;
    this.passwordHash = resolvePasswordHash(pluginConfig, authConfig);
    this.paths = createBasePathHelpers(securityConfig.basePath ?? basePath);

    // Origin policy: the deployment origin may be declared either on `auth.allowedOrigins`
    // (existing field) or on the `security` block; both feed the same policy.
    const originConfig = {
      ...authConfig,
      ...securityConfig,
      allowedOrigins: [...(Array.isArray(authConfig.allowedOrigins) ? authConfig.allowedOrigins : []), ...(Array.isArray(securityConfig.allowedOrigins) ? securityConfig.allowedOrigins : [])]
    };
    this.originPolicy = createOriginPolicy(originConfig, { basePath: this.paths.basePath });
    this.proxyTrust = createProxyTrustPolicy(originConfig);
    this.cookieConfig = securityConfig;

    this.sessionTtlMs = minutesToMs(authConfig.sessionTtlMinutes ?? securityConfig.sessionTtlMinutes, DEFAULT_SESSION_TTL_MS);
    this.sessionIdleMs = minutesToMs(securityConfig.sessionIdleMinutes, 0);
    this.loginWindowMs = minutesToMs(authConfig.loginWindowMinutes, DEFAULT_LOGIN_WINDOW_MS);
    this.maxLoginAttempts = Number.isFinite(authConfig.maxLoginAttempts) ? Math.max(1, Number(authConfig.maxLoginAttempts)) : DEFAULT_MAX_LOGIN_ATTEMPTS;
    this.now = now;
    this.sessions = new Map();
    this.loginAttempts = new Map();
    this.lastDecisions = [];
  }

  isConfigured() {
    return !this.enabled || this.passwordHash.length > 0;
  }

  /**
   * Drop all plugin sessions and login-attempt counters.
   * Called when the plugin runtime is re-registered (host reload) so a session issued by a
   * previous generation can never authenticate against the new one.
   * @returns {{sessions:number, loginAttempts:number}}
   */
  disposeSessions() {
    const dropped = { sessions: this.sessions.size, loginAttempts: this.loginAttempts.size };
    this.sessions.clear();
    this.loginAttempts.clear();
    return dropped;
  }

  /** Explicit operator-initiated revocation of every session. */
  revokeAllSessions(reason = "operator-revoked") {
    const dropped = this.sessions.size;
    this.sessions.clear();
    this.recordDecision({ kind: "revoke_all", dropped, reason });
    return { dropped, reason };
  }

  /** Revoke one session by token. */
  revokeSession(token, reason = "operator-revoked") {
    if (!token) return { revoked: false };
    const revoked = this.sessions.delete(hashToken(token));
    this.recordDecision({ kind: "revoke_one", revoked, reason });
    return { revoked };
  }

  /** Token-free inventory of live sessions (never returns the token or its hash). */
  listSessions() {
    const now = this.now();
    return [...this.sessions.values()].map((session) => ({
      session_id: session.session_id,
      actor_id: session.actor_id,
      created_at: new Date(session.createdAt).toISOString(),
      last_seen_at: new Date(session.lastSeenAt).toISOString(),
      expires_at: new Date(session.expiresAt).toISOString(),
      idle_expires_at: session.idleExpiresAt ? new Date(session.idleExpiresAt).toISOString() : null,
      expired: session.expiresAt <= now,
      client: { address: session.address ?? session.ip ?? "unknown", source: session.address_source ?? "unknown" },
      user_agent_length: String(session.userAgent ?? "").length
    }));
  }

  /** Remove sessions that are already past their absolute or idle deadline. */
  pruneExpired() {
    const now = this.now();
    let pruned = 0;
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now || (session.idleExpiresAt && session.idleExpiresAt <= now)) {
        this.sessions.delete(key);
        pruned += 1;
      }
    }
    return { pruned, remaining: this.sessions.size };
  }

  async login({ password, ip = "unknown", userAgent = "", address = null, addressSource = "request" }) {
    const clientAddress = address ?? ip;
    if (!this.enabled) return { ok: true, token: this.createSession({ ip: clientAddress, userAgent, addressSource }) };
    if (!this.passwordHash) return { ok: false, status: 503, error: "plugin auth is not configured" };
    if (this.isRateLimited(clientAddress)) {
      this.recordDecision({ kind: "login_rate_limited", address: clientAddress, address_source: addressSource });
      return { ok: false, status: 429, error: "too many login attempts" };
    }

    const ok = await verifyPassword(password ?? "", this.passwordHash);
    if (!ok) {
      this.recordFailedAttempt(clientAddress);
      this.recordDecision({ kind: "login_failed", address: clientAddress, address_source: addressSource });
      return { ok: false, status: 401, error: "invalid password" };
    }

    this.loginAttempts.delete(clientAddress);
    const token = this.createSession({ ip: clientAddress, userAgent, addressSource });
    const session = this.sessions.get(hashToken(token));
    this.recordDecision({ kind: "login_ok", address: clientAddress, address_source: addressSource, session_id: session.session_id });
    return { ok: true, token, session: { session_id: session.session_id, expires_at: new Date(session.expiresAt).toISOString() } };
  }

  logout(token) {
    if (!token) return false;
    return this.sessions.delete(hashToken(token));
  }

  authenticateRequest(req) {
    if (!this.enabled) return { ok: true, actor_id: "plugin-auth-disabled", trusted: true, source: "auth-disabled" };
    const token = getRequestToken(req);
    if (!token) return { ok: false, status: 401, error: "missing plugin session" };
    const key = hashToken(token);
    const session = this.sessions.get(key);
    if (!session) return { ok: false, status: 401, error: "invalid plugin session" };
    const now = this.now();
    if (session.expiresAt <= now) {
      this.sessions.delete(key);
      return { ok: false, status: 401, error: "expired plugin session" };
    }
    if (session.idleExpiresAt && session.idleExpiresAt <= now) {
      this.sessions.delete(key);
      return { ok: false, status: 401, error: "session idle timeout" };
    }
    session.lastSeenAt = now;
    if (this.sessionIdleMs > 0) session.idleExpiresAt = now + this.sessionIdleMs;
    return { ok: true, actor_id: session.actor_id, trusted: true, source: "plugin-session", session_id: session.session_id };
  }

  /** Legacy single-check helper kept for callers that only need the allowlist verdict. */
  checkOrigin(req) {
    const result = this.originPolicy.evaluate(req, { method: "GET" });
    if (result.ok) return { ok: true };
    return { ok: false, status: result.status, error: result.error, code: result.code };
  }

  /**
   * Full request-level gate used by every route: foreign Origin, cross-site hint and the
   * cookie-authenticated CSRF rule.
   * @param {Record<string, unknown>} req
   * @param {{ method?: string, isLoginRoute?: boolean }} [options]
   */
  checkRequest(req, options = {}) {
    const client = this.resolveClient(req);
    const cookieToken = getCookie(req, SESSION_COOKIE);
    const result = this.originPolicy.evaluate(req, {
      method: options.method,
      isLoginRoute: options.isLoginRoute === true,
      protocol: client.protocol.protocol,
      hasAmbientCredential: Boolean(cookieToken)
    });
    this.recordDecision({
      kind: "origin_check",
      method: String(options.method ?? req?.method ?? "GET").toUpperCase(),
      ok: result.ok,
      code: result.code,
      policy: result.policy,
      origin: result.origin ?? null,
      ambient_credential: Boolean(cookieToken)
    });
    if (result.ok) return { ok: true, policy: result.policy };
    return { ok: false, status: result.status, code: result.code, error: result.error, details: result.details };
  }

  /** Trusted client identity for logging, rate limiting and cookie flags. */
  resolveClient(req) {
    const address = this.proxyTrust.resolveClientAddress(req);
    const protocol = this.proxyTrust.resolveProtocol(req, { clientAddressTrusted: address.trusted });
    return { address: address.address, address_source: address.source, forwarded_ignored: address.forwarded_ignored ?? false, protocol: protocol.protocol, protocol_source: protocol.source, chain: address.chain };
  }

  /** Cookie attributes for this request (Secure decided per request, never on a global toggle alone). */
  cookieOptions(req) {
    const client = req ? this.resolveClient(req) : { protocol: "http" };
    const secure = resolveCookieSecure(this.cookieConfig, { protocol: client.protocol });
    return { secure: secure.secure, secure_source: secure.source, path: this.paths.cookiePath(), protocol: client.protocol };
  }

  describe() {
    return {
      enabled: this.enabled,
      configured: this.isConfigured(),
      base_path: this.paths.basePath,
      cookie: { name: SESSION_COOKIE, path: this.paths.cookiePath(), http_only: true, same_site: "Strict", secure: this.cookieConfig.cookieSecure ?? "auto" },
      origin_policy: {
        mode: this.originPolicy.settings.mode,
        declared_origins: [...this.originPolicy.settings.allowedOrigins, ...(this.originPolicy.settings.publicOrigin ? [this.originPolicy.settings.publicOrigin] : [])],
        derive_origin_from_host: this.originPolicy.settings.deriveOriginFromHost,
        enforce_cookie_csrf: this.originPolicy.settings.enforceCookieCsrf
      },
      proxy_trust: {
        trust_forwarded_headers: this.proxyTrust.settings.trustForwardedHeaders,
        trusted_proxies: this.proxyTrust.settings.trustedProxies
      },
      sessions: { live: this.sessions.size, ttl_minutes: Math.round(this.sessionTtlMs / 60000), idle_minutes: this.sessionIdleMs > 0 ? Math.round(this.sessionIdleMs / 60000) : 0 },
      rate_limit: { max_attempts: this.maxLoginAttempts, window_minutes: Math.round(this.loginWindowMs / 60000), key: "trusted client address (forwarded headers ignored unless the peer is a trusted proxy)" }
    };
  }

  /** Recent security decisions, newest last. Token-free by construction. */
  recentDecisions(limit = 20) {
    return this.lastDecisions.slice(-limit).map((entry) => ({ ...entry }));
  }

  recordDecision(entry) {
    this.lastDecisions.push({ at: new Date(this.now()).toISOString(), ...entry });
    if (this.lastDecisions.length > 200) this.lastDecisions.splice(0, this.lastDecisions.length - 200);
  }

  createSession({ ip, userAgent, addressSource = "request" }) {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = this.now();
    const session = {
      session_id: `sess-${crypto.randomBytes(6).toString("hex")}`,
      actor_id: ADMIN_ACTOR_ID,
      ip,
      address: ip,
      address_source: addressSource,
      userAgent,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.sessionTtlMs,
      idleExpiresAt: this.sessionIdleMs > 0 ? now + this.sessionIdleMs : null
    };
    this.sessions.set(hashToken(token), session);
    return token;
  }

  isRateLimited(ip) {
    const now = this.now();
    const record = this.loginAttempts.get(ip);
    if (!record || now - record.firstAt > this.loginWindowMs) return false;
    return record.count >= this.maxLoginAttempts;
  }

  recordFailedAttempt(ip) {
    const now = this.now();
    const record = this.loginAttempts.get(ip);
    if (!record || now - record.firstAt > this.loginWindowMs) {
      this.loginAttempts.set(ip, { firstAt: now, count: 1 });
      return;
    }
    record.count += 1;
  }
}

export async function hashPassword(password, { iterations = DEFAULT_ITERATIONS } = {}) {
  if (typeof password !== "string" || password.length < 12) {
    throw new Error("password must be at least 12 characters");
  }
  const salt = crypto.randomBytes(16).toString("base64url");
  const derived = await pbkdf2(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${salt}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password, encodedHash) {
  const parts = String(encodedHash).split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;
  const iterations = Number(parts[2]);
  const salt = parts[3];
  const expected = Buffer.from(parts[4], "base64url");
  if (!Number.isSafeInteger(iterations) || iterations < 100_000 || !salt || expected.length === 0) return false;
  const actual = await pbkdf2(password, salt, iterations);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export async function readJsonBody(req, maxBytes = MAX_LOGIN_BODY_BYTES) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, "request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function sendJson(res, statusCode, payload, extraHeaders = {}) {
  applySecurityHeaders(res);
  for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

/**
 * Session cookie.
 * `HttpOnly` + `SameSite=Strict` are unchanged; `Secure` and `Path` now follow the deployment
 * (effective protocol / single base path) instead of being hard-coded.
 */
export function setSessionCookie(res, token, maxAgeMs, { secure = false, path: cookiePath = DEFAULT_BASE_PATH } = {}) {
  res.setHeader("set-cookie", serializeSessionCookie(`${SESSION_COOKIE}=${token}`, { maxAgeSeconds: Math.floor(maxAgeMs / 1000), secure, path: cookiePath }));
}

export function clearSessionCookie(res, { secure = false, path: cookiePath = DEFAULT_BASE_PATH } = {}) {
  res.setHeader("set-cookie", serializeSessionCookie(`${SESSION_COOKIE}=`, { maxAgeSeconds: 0, secure, path: cookiePath }));
}

function serializeSessionCookie(pair, { maxAgeSeconds, secure, path: cookiePath }) {
  const attributes = [`Max-Age=${maxAgeSeconds}`, `Path=${cookiePath}`, "HttpOnly", "SameSite=Strict"];
  if (secure) attributes.push("Secure");
  return `${pair}; ${attributes.join("; ")}`;
}

export function applySecurityHeaders(res, { contentSecurityPolicy = "default-src 'none'; frame-ancestors 'none'" } = {}) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("cache-control", "no-store");
  if (contentSecurityPolicy) res.setHeader("content-security-policy", contentSecurityPolicy);
}

export function requireSafePath(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(resolvedRoot, candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw httpError(400, "unsafe path");
  return resolvedCandidate;
}

export function getRequestToken(req) {
  return getBearerToken(req) ?? getCookie(req, SESSION_COOKIE);
}

/**
 * @deprecated REN-02: use `SecurityManager.resolveClient(req)`.
 * Kept for compatibility; the previous implementation trusted the FIRST `x-forwarded-for` entry,
 * which is exactly the spoofable behaviour REN-02 removes. This wrapper now ignores forwarded
 * headers entirely (no trusted proxy is known at this call site).
 */
export function getClientIp(req) {
  const socket = req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? "unknown";
  return String(socket).replace(/^::ffff:/i, "");
}

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function resolvePasswordHash(pluginConfig, authConfig) {
  if (typeof authConfig.adminPasswordHash === "string" && authConfig.adminPasswordHash.trim()) {
    return authConfig.adminPasswordHash.trim();
  }
  const hashFile = resolvePasswordHashFile(pluginConfig, authConfig);
  try {
    return fs.readFileSync(hashFile, "utf8").trim();
  } catch {
    return "";
  }
}

function resolvePasswordHashFile(pluginConfig, authConfig) {
  if (typeof authConfig.adminPasswordHashFile === "string" && authConfig.adminPasswordHashFile.trim()) {
    return path.resolve(expandHome(authConfig.adminPasswordHashFile.trim()));
  }
  const configuredRoot = typeof pluginConfig.repositoryRoot === "string" ? pluginConfig.repositoryRoot.trim() : "";
  const root = configuredRoot ? path.resolve(expandHome(configuredRoot)) : path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".openclaw-video-assets");
  return path.join(root, "auth", "admin-password.hash");
}

function expandHome(value) {
  if (value === "~") return process.env.USERPROFILE || process.env.HOME || value;
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(process.env.USERPROFILE || process.env.HOME || "~", value.slice(2));
  return value;
}

function getBearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function getCookie(req, name) {
  const cookie = req.headers.cookie;
  if (typeof cookie !== "string") return undefined;
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

function minutesToMs(value, fallback) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
  return minutes * 60 * 1000;
}

function pbkdf2(password, salt, iterations) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, 32, "sha256", (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}
