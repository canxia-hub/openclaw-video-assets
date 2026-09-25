/**
 * REN-02 check: forwarded-header trust, client-address resolution and cookie flags.
 *
 * These assertions are the unit-level half of the "proxy header spoofing must not bypass rate
 * limiting" acceptance item; the isolated-daemon half (real HTTP through the real gateway) lives in
 * implementation/REN-02/host-smoke.
 */
import assert from "node:assert/strict";

const { SecurityManager, hashPassword } = await import("../src/security.js");
const { createProxyTrustPolicy, matchesProxy, normalizeAddress, normalizeOrigin, resolveCookieSecure, splitForwardedChain } = await import("../src/request-security.js");

const CORRECT_PASSWORD = "ren02-proxy-check-password";
const PASSWORD_HASH = await hashPassword(CORRECT_PASSWORD, { iterations: 100_000 });
const request = ({ headers = {}, remoteAddress = "127.0.0.1", encrypted = false } = {}) => ({
  method: "POST",
  url: "/__openclaw__/video-assets/auth/login",
  headers: { host: "chat.tkx.info", ...headers },
  socket: { remoteAddress, encrypted }
});

// ------------------------------------------------------------------------------------------------
// address/origin primitives
// ------------------------------------------------------------------------------------------------
assert.equal(normalizeAddress("::ffff:127.0.0.1"), "127.0.0.1");
assert.equal(normalizeAddress("10.1.2.3:5555"), "10.1.2.3");
assert.equal(normalizeAddress("[2001:db8::1]"), "2001:db8::1");
assert.equal(normalizeAddress("not-an-ip"), null);
assert.deepEqual(splitForwardedChain("1.1.1.1, 2.2.2.2"), ["1.1.1.1", "2.2.2.2"]);
assert.deepEqual(splitForwardedChain("1.1.1.1, bogus, 2.2.2.2"), ["1.1.1.1", "2.2.2.2"], "malformed hops are dropped, not trusted");
assert.equal(matchesProxy("10.1.2.3", "10.0.0.0/8"), true);
assert.equal(matchesProxy("11.1.2.3", "10.0.0.0/8"), false);
assert.equal(matchesProxy("127.0.0.1", "127.0.0.1"), true);
assert.equal(matchesProxy("127.0.0.1", "127.0.0.0/8"), true);
assert.equal(normalizeOrigin("https://Chat.TKX.info:443/__openclaw__"), "https://chat.tkx.info", "default port and path are normalized away");
assert.equal(normalizeOrigin("null"), null);
assert.equal(normalizeOrigin("ftp://x"), null);

// ------------------------------------------------------------------------------------------------
// default: forwarded headers are ignored entirely
// ------------------------------------------------------------------------------------------------
{
  const manager = new SecurityManager({ pluginConfig: { auth: { enabled: true, adminPasswordHash: PASSWORD_HASH, maxLoginAttempts: 2, loginWindowMinutes: 10 } } });
  const spoofed = request({ headers: { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" } });
  const resolved = manager.resolveClient(spoofed);
  assert.equal(resolved.address, "127.0.0.1", "an untrusted peer cannot change the client address");
  assert.equal(resolved.address_source, "socket");
  assert.equal(resolved.forwarded_ignored, true, "the harness must disclose that forwarded headers were present but ignored");
  assert.equal(resolved.protocol, "http", "an untrusted x-forwarded-proto cannot claim HTTPS");
  assert.equal(manager.cookieOptions(spoofed).secure, false, "so the cookie must not claim Secure");
}

// rate limiting cannot be bypassed by rotating X-Forwarded-For
{
  const manager = new SecurityManager({
    pluginConfig: { auth: { enabled: true, adminPasswordHash: PASSWORD_HASH, maxLoginAttempts: 2, loginWindowMinutes: 10 }, security: { trustProxyHeaders: true, trustedProxies: ["10.9.9.9"] } }
  });
  for (const address of ["203.0.113.1", "203.0.113.2"]) {
    const attempt = await manager.login({ password: "wrong-password", ip: manager.resolveClient(request({ headers: { "x-forwarded-for": address } })).address });
    assert.equal(attempt.ok, false);
    assert.equal(attempt.status, 401);
  }
  const third = await manager.login({ password: "wrong-password", ip: manager.resolveClient(request({ headers: { "x-forwarded-for": "203.0.113.3" } })).address });
  assert.equal(third.status, 429, "rotating a spoofed X-Forwarded-For must not reset the login rate limit");
  assert.ok(manager.recentDecisions(20).some((decision) => decision.kind === "login_rate_limited"));
}

// ------------------------------------------------------------------------------------------------
// trusted peer: chain is walked from the closest hop
// ------------------------------------------------------------------------------------------------
{
  const manager = new SecurityManager({
    pluginConfig: { auth: { enabled: true, adminPasswordHash: PASSWORD_HASH }, security: { trustProxyHeaders: true, trustedProxies: ["127.0.0.1"] } }
  });
  const single = manager.resolveClient(request({ headers: { "x-forwarded-for": "203.0.113.7" } }));
  assert.equal(single.address, "203.0.113.7");
  assert.equal(single.address_source, "forwarded-chain");

  // rightmost untrusted hop wins: a client that prepends a fake entry cannot hide behind it
  const chain = manager.resolveClient(request({ headers: { "x-forwarded-for": "198.51.100.66, 203.0.113.7" } }));
  assert.equal(chain.address, "203.0.113.7", `right-most untrusted hop must win, got ${chain.address}`);

  // an entirely trusted chain falls back to the left-most entry
  const allTrusted = manager.resolveClient(request({ headers: { "x-forwarded-for": "127.0.0.1, 127.0.0.1" } }));
  assert.equal(allTrusted.address, "127.0.0.1");

  // trusted proxy may assert HTTPS -> Secure cookie
  const https = request({ headers: { "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" } });
  const resolvedHttps = manager.resolveClient(https);
  assert.equal(resolvedHttps.protocol, "https");
  assert.equal(resolvedHttps.protocol_source, "x-forwarded-proto");
  assert.equal(manager.cookieOptions(https).secure, true, "a trusted proxy asserting HTTPS must yield a Secure cookie");
  assert.equal(manager.cookieOptions(https).path, "/__openclaw__/video-assets");
}

// trust only applies to the configured peer addresses
{
  const policy = createProxyTrustPolicy({ trustProxyHeaders: true, trustedProxies: ["127.0.0.1"] });
  const fromElsewhere = policy.resolveClientAddress(request({ remoteAddress: "198.51.100.5", headers: { "x-forwarded-for": "203.0.113.9" } }));
  assert.equal(fromElsewhere.address, "198.51.100.5");
  assert.equal(fromElsewhere.source, "forwarded-untrusted-ignored");
  assert.equal(policy.resolveProtocol(request({ remoteAddress: "198.51.100.5", headers: { "x-forwarded-proto": "https" } })).protocol, "http");
}

// cookie Secure decision table
assert.equal(resolveCookieSecure({}, { protocol: "https" }).secure, true);
assert.equal(resolveCookieSecure({}, { protocol: "http" }).secure, false);
assert.equal(resolveCookieSecure({ cookieSecure: true }, { protocol: "http" }).secure, true);
assert.equal(resolveCookieSecure({ cookieSecure: false }, { protocol: "https" }).secure, false, "an operator can still disable Secure for plain-HTTP debugging");

// ------------------------------------------------------------------------------------------------
// session lifecycle: absolute TTL, idle timeout, revocation, token-free inventory
// ------------------------------------------------------------------------------------------------
{
  let now = 0;
  const manager = new SecurityManager({
    pluginConfig: { auth: { enabled: true, adminPasswordHash: PASSWORD_HASH, sessionTtlMinutes: 5 }, security: { sessionIdleMinutes: 1 } },
    now: () => now
  });
  const login = await manager.login({ password: CORRECT_PASSWORD, ip: "203.0.113.7" });
  const req = { headers: { authorization: `Bearer ${login.token}` } };
  assert.equal(manager.authenticateRequest(req).ok, true);
  now += 30_000;
  assert.equal(manager.authenticateRequest(req).ok, true, "activity refreshes the idle deadline");
  now += 61_000;
  const idle = manager.authenticateRequest(req);
  assert.equal(idle.status, 401, "an idle-expired session must be rejected");
  assert.match(idle.error, /idle/);

  const second = await manager.login({ password: CORRECT_PASSWORD, ip: "203.0.113.8" });
  const inventory = manager.listSessions();
  assert.equal(inventory.length, 1);
  assert.equal(JSON.stringify(inventory).includes(second.token), false, "the inventory must not expose the token");
  assert.equal(manager.revokeSession(second.token, "test").revoked, true);
  assert.equal(manager.authenticateRequest({ headers: { authorization: `Bearer ${second.token}` } }).status, 401);
  assert.equal(manager.revokeAllSessions("test").dropped, manager.sessions.size);
}
{
  let now = 0;
  const manager = new SecurityManager({ pluginConfig: { auth: { enabled: true, adminPasswordHash: PASSWORD_HASH, sessionTtlMinutes: 1 } }, now: () => now });
  const login = await manager.login({ password: CORRECT_PASSWORD, ip: "203.0.113.7" });
  now += 61_000;
  assert.equal(manager.authenticateRequest({ headers: { authorization: `Bearer ${login.token}` } }).status, 401, "absolute TTL still applies");
}

console.log("REN-02 forwarded-header/cookie/session check passed");
process.exit(0);
