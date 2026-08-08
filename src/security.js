import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_ITERATIONS = 210_000;
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_LOGIN_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_LOGIN_ATTEMPTS = 5;
const MAX_LOGIN_BODY_BYTES = 8 * 1024;
const SESSION_COOKIE = "ova_session";

export class SecurityManager {
  constructor({ pluginConfig = {}, now = () => Date.now() } = {}) {
    const authConfig = pluginConfig.auth && typeof pluginConfig.auth === "object" ? pluginConfig.auth : {};
    this.enabled = authConfig.enabled !== false;
    this.passwordHash = resolvePasswordHash(pluginConfig, authConfig);
    this.allowedOrigins = Array.isArray(authConfig.allowedOrigins) ? authConfig.allowedOrigins : [];
    this.sessionTtlMs = minutesToMs(authConfig.sessionTtlMinutes, DEFAULT_SESSION_TTL_MS);
    this.loginWindowMs = minutesToMs(authConfig.loginWindowMinutes, DEFAULT_LOGIN_WINDOW_MS);
    this.maxLoginAttempts = Number.isFinite(authConfig.maxLoginAttempts) ? Math.max(1, Number(authConfig.maxLoginAttempts)) : DEFAULT_MAX_LOGIN_ATTEMPTS;
    this.now = now;
    this.sessions = new Map();
    this.loginAttempts = new Map();
  }

  isConfigured() {
    return !this.enabled || this.passwordHash.length > 0;
  }

  async login({ password, ip = "unknown", userAgent = "" }) {
    if (!this.enabled) return { ok: true, token: this.createSession({ ip, userAgent }) };
    if (!this.passwordHash) return { ok: false, status: 503, error: "plugin auth is not configured" };
    if (this.isRateLimited(ip)) return { ok: false, status: 429, error: "too many login attempts" };

    const ok = await verifyPassword(password ?? "", this.passwordHash);
    if (!ok) {
      this.recordFailedAttempt(ip);
      return { ok: false, status: 401, error: "invalid password" };
    }

    this.loginAttempts.delete(ip);
    return { ok: true, token: this.createSession({ ip, userAgent }) };
  }

  logout(token) {
    if (!token) return false;
    return this.sessions.delete(hashToken(token));
  }

  authenticateRequest(req) {
    if (!this.enabled) return { ok: true, actor_id: "plugin-auth-disabled" };
    const token = getRequestToken(req);
    if (!token) return { ok: false, status: 401, error: "missing plugin session" };
    const session = this.sessions.get(hashToken(token));
    if (!session) return { ok: false, status: 401, error: "invalid plugin session" };
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(hashToken(token));
      return { ok: false, status: 401, error: "expired plugin session" };
    }
    session.lastSeenAt = this.now();
    return { ok: true, actor_id: session.actor_id };
  }

  checkOrigin(req) {
    if (this.allowedOrigins.length === 0) return { ok: true };
    const origin = req.headers.origin;
    if (!origin) return { ok: true };
    if (this.allowedOrigins.includes(origin)) return { ok: true };
    return { ok: false, status: 403, error: "origin is not allowed" };
  }

  createSession({ ip, userAgent }) {
    const token = crypto.randomBytes(32).toString("base64url");
    this.sessions.set(hashToken(token), {
      actor_id: "human:plugin-admin",
      ip,
      userAgent,
      createdAt: this.now(),
      lastSeenAt: this.now(),
      expiresAt: this.now() + this.sessionTtlMs
    });
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

export function setSessionCookie(res, token, maxAgeMs) {
  res.setHeader("set-cookie", `${SESSION_COOKIE}=${token}; Max-Age=${Math.floor(maxAgeMs / 1000)}; Path=/__openclaw__/video-assets; HttpOnly; SameSite=Strict`);
}

export function clearSessionCookie(res) {
  res.setHeader("set-cookie", `${SESSION_COOKIE}=; Max-Age=0; Path=/__openclaw__/video-assets; HttpOnly; SameSite=Strict`);
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

export function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
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
