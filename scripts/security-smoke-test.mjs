import assert from "node:assert/strict";
import { SecurityManager, hashPassword, requireSafePath, verifyPassword } from "../src/security.js";

const password = "correct horse battery staple";
const encoded = await hashPassword(password, { iterations: 100_000 });
assert.equal(await verifyPassword(password, encoded), true);
assert.equal(await verifyPassword("wrong password", encoded), false);

let now = 1_000;
const manager = new SecurityManager({
  pluginConfig: {
    auth: {
      enabled: true,
      adminPasswordHash: encoded,
      maxLoginAttempts: 2,
      loginWindowMinutes: 10,
      sessionTtlMinutes: 1,
      allowedOrigins: ["https://assets.example.com"]
    }
  },
  now: () => now
});

assert.equal(manager.isConfigured(), true);
assert.equal((await manager.login({ password: "bad", ip: "1.2.3.4" })).ok, false);
assert.equal((await manager.login({ password: "bad", ip: "1.2.3.4" })).ok, false);
assert.equal((await manager.login({ password, ip: "1.2.3.4" })).status, 429);

const login = await manager.login({ password, ip: "5.6.7.8", userAgent: "test" });
assert.equal(login.ok, true);
const req = { headers: { authorization: `Bearer ${login.token}`, origin: "https://assets.example.com" } };
assert.equal(manager.checkOrigin(req).ok, true);
assert.equal(manager.authenticateRequest(req).ok, true);
now += 61_000;
assert.equal(manager.authenticateRequest(req).status, 401);

assert.throws(() => requireSafePath("/repo/root", "../../secret"), /unsafe path/);
assert.match(requireSafePath("/repo/root", "asset/file.txt"), /repo[\\/]root[\\/]asset[\\/]file\.txt$/);

console.log("security smoke test passed");
