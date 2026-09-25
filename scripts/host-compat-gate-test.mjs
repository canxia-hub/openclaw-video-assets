/**
 * REN-01: host compatibility gate test.
 *
 * Two layers:
 *  A. Static declaration gate — the fields the HOST actually reads must exist and be valid
 *     under the host's own parsing rules:
 *       package.json openclaw.install.minHostVersion  (dist/min-host-version-DRD0HJBG.mjs)
 *       package.json openclaw.compat.pluginApi        (dist/package-compat-CurpuyOg.mjs)
 *  B. Runtime gate — assertSupportedHost() behavior for supported, incompatible, unverifiable
 *     and surface-incomplete hosts, using the same env knob the host itself honors for
 *     compatibility checks (OPENCLAW_COMPATIBILITY_HOST_VERSION).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "openclaw.plugin.json"), "utf8"));

const {
  COMPAT_ERROR_CODES,
  HOST_CONTRACT,
  IMPORTED_SDK_SUBPATHS,
  SDK_SURFACE_NOTES,
  assertSupportedHost,
  parseVersion,
  satisfiesRange
} = await import("../src/sdk-compat.js");
const { createHostApiStub } = await import("./fixtures/host-api-stub.js").catch(() => import("./fixtures/host-api-stub.mjs"));

const checks = [];
const check = (name, run) => checks.push({ name, run });

// The host accepts only ">=x.y.z[-prerelease][+build]" for minHostVersion
// (dist/min-host-version-DRD0HJBG.mjs:6-9); a bare legacy semver is allowed only for
// already-installed global plugins, which a candidate package must not rely on.
const HOST_MIN_HOST_VERSION_PATTERN = /^>=(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

check("package.json declares the host-enforced minHostVersion floor", () => {
  const declared = pkg.openclaw?.install?.minHostVersion;
  assert.equal(typeof declared, "string", "openclaw.install.minHostVersion must be present: it is the field the loader enforces");
  const match = HOST_MIN_HOST_VERSION_PATTERN.exec(declared.trim());
  assert.ok(match, `minHostVersion must match the host's accepted form, got ${JSON.stringify(declared)}`);
  assert.ok(parseVersion(match[1]), "minHostVersion floor must be a valid semver");
  assert.equal(declared, HOST_CONTRACT.minHostVersion, "adapter constant must mirror package.json");
});

check("package.json compat.pluginApi is a valid AND-only range", () => {
  const declared = pkg.openclaw?.compat?.pluginApi;
  assert.equal(typeof declared, "string");
  assert.ok(!declared.includes("||"), "the host returns false for || ranges, which would disable the plugin");
  for (const token of declared.trim().split(/\s+/)) {
    assert.match(token, /^(>=|<=|>|<|=|\^|~)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `unsupported range token ${token}`);
  }
  assert.equal(declared, HOST_CONTRACT.pluginApiRange);
});

check("install hints stay in package.json, not in the plugin manifest", () => {
  // docs/plugins/manifest/package-json.md:53 — "Do not move install hints into openclaw.plugin.json."
  assert.equal(manifest.install, undefined, "openclaw.plugin.json must not carry install hints");
  assert.equal(pkg.openclaw.compat.minGatewayVersion, ">=2026.3.24-beta.2", "minGatewayVersion is retained only for ClawHub catalog descriptors");
});

check("shipped ranges are meaningful: satisfied by verified hosts, rejected by an old host", () => {
  for (const host of HOST_CONTRACT.verifiedHosts) {
    assert.equal(satisfiesRange(host, HOST_CONTRACT.pluginApiRange), true, `${host} must satisfy the plugin API range`);
    assert.equal(satisfiesRange(host, HOST_CONTRACT.minHostVersion), true, `${host} must satisfy the host floor`);
  }
  assert.equal(satisfiesRange("2026.1.0", HOST_CONTRACT.pluginApiRange), false, "the floor must reject an older host");
  assert.equal(satisfiesRange("2025.12.31", HOST_CONTRACT.minHostVersion), false);
});

check("assertSupportedHost returns a report on a supported host", () => {
  const report = assertSupportedHost(createHostApiStub(), { env: { OPENCLAW_VERSION: "2026.9.3" } });
  assert.equal(report.overall, "pass");
  assert.equal(report.hostVersion.raw, "2026.9.3");
  assert.equal(report.pluginApiRange, HOST_CONTRACT.pluginApiRange);
  assert.ok(report.gates.every((gate) => gate.status === "pass"));
});

check("assertSupportedHost fails closed with an actionable error on an incompatible host", () => {
  let thrown = null;
  try {
    assertSupportedHost(createHostApiStub(), { env: { OPENCLAW_VERSION: "2026.1.0" } });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "an incompatible host must not register silently");
  assert.equal(thrown.code, COMPAT_ERROR_CODES.UNSUPPORTED_HOST);
  assert.match(thrown.message, /2026\.3\.24-beta\.2/);
  assert.match(thrown.hint, /openclaw --version/);
  assert.match(thrown.hint, /openclaw doctor/);
  assert.equal(thrown.retryable, false);
  assert.equal(thrown.toEnvelope().code, COMPAT_ERROR_CODES.UNSUPPORTED_HOST);
});

check("assertSupportedHost tolerates an unverifiable host version", () => {
  const report = assertSupportedHost(createHostApiStub(), { env: { OPENCLAW_VERSION: "unknown" } });
  assert.equal(report.overall, "degraded");
  assert.equal(report.gates.find((gate) => gate.id === "HOST-GATE-1").status, "warn");
});

check("assertSupportedHost fails with an actionable error when a required surface is missing", () => {
  let thrown = null;
  try {
    assertSupportedHost(createHostApiStub({ omitMethods: ["registerHttpRoute"] }), { env: { OPENCLAW_VERSION: "2026.9.3" } });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown?.code, COMPAT_ERROR_CODES.UNSUPPORTED_SDK_SURFACE);
  assert.match(thrown.message, /registerHttpRoute/);
  assert.deepEqual(thrown.details.missing, ["registerHttpRoute"]);
});

check("source imports only non-deprecated public SDK subpaths", () => {
  const srcDir = path.join(rootDir, "src");
  const specifiers = new Set();
  const files = fs.readdirSync(srcDir).filter((name) => name.endsWith(".js"));
  for (const file of files) {
    const source = fs.readFileSync(path.join(srcDir, file), "utf8");
    assert.ok(!/from\s+["'][^"']*\/dist\//.test(source), `${file} must not import from a packaged dist path`);
    assert.ok(!/require\(["']openclaw\//.test(source), `${file} must use ESM imports`);
    for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier.startsWith("openclaw")) specifiers.add(specifier);
    }
  }
  assert.deepEqual([...specifiers].sort(), [...IMPORTED_SDK_SUBPATHS].sort(), "the SDK import set must stay explicit and documented");
  for (const specifier of specifiers) {
    const subpath = specifier.replace("openclaw/plugin-sdk/", "");
    assert.ok(!SDK_SURFACE_NOTES.deprecatedSubpaths.includes(specifier), `${specifier} is a deprecated broad barrel (removal window 2026-10-01)`);
    assert.ok(subpath.length > 0);
  }
});

check("source avoids every host-deprecated flat plugin API method", () => {
  const srcDir = path.join(rootDir, "src");
  const files = fs.readdirSync(srcDir).filter((name) => name.endsWith(".js"));
  for (const file of files) {
    const source = fs.readFileSync(path.join(srcDir, file), "utf8");
    for (const method of SDK_SURFACE_NOTES.deprecatedOnHost) {
      const name = method.replace("api.", "");
      assert.ok(!new RegExp(`\\bapi\\??\\.${name}\\s*\\(`).test(source), `${file} calls deprecated ${method} (removal window 2026-10-01)`);
    }
  }
});

check("the adapter documents the deprecated host surfaces it must avoid", () => {
  assert.ok(SDK_SURFACE_NOTES.deprecatedOnHost.length >= 14);
  assert.ok(SDK_SURFACE_NOTES.deprecatedSubpaths.includes("openclaw/plugin-sdk/agent-runtime"));
});

let failures = 0;
for (const { name, run } of checks) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : String(error)}`);
  }
}
if (failures > 0) {
  console.error(`host compat gate test failed: ${failures}/${checks.length}`);
  process.exit(1);
}
console.log(`host compat gate test passed (${checks.length} checks)`);
