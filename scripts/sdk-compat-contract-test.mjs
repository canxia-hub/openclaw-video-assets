/**
 * REN-01: SDK compatibility adapter contract tests.
 *
 * Covers: version/range semantics, host gate outcomes, registration ledger,
 * tool contract + input validation, structured errors, scope/route validation,
 * and SecretRef metadata (including redaction). Pure adapter tests — no host process.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  COMPAT_ERROR_CODES,
  CompatError,
  HOST_CONTRACT,
  OPERATOR_SCOPES,
  READ_SCOPE,
  WRITE_SCOPE,
  authorizeGatewayCall,
  buildHostCompatReport,
  compareVersions,
  describeRegistrationLedger,
  describeSecretInputs,
  isSecretRefShape,
  normalizeHostVersionForComparator,
  parseVersion,
  satisfiesRange,
  toStructuredError,
  validateContractsCoverage,
  validateGatewayScope,
  validateRouteRegistration,
  validateSecretInputDeclarations,
  validateToolInput,
  validateToolRegistration
} from "../src/sdk-compat.js";
import { createHostApiStub, HOST_API_METHODS } from "./fixtures/host-api-stub.mjs";

const checks = [];
const check = (name, run) => checks.push({ name, run });

// --- version + range semantics -------------------------------------------------

check("parseVersion accepts OpenClaw release and prerelease forms", () => {
  assert.deepEqual(parseVersion("2026.9.3")?.nums, [2026, 9, 3]);
  assert.equal(parseVersion("2026.9.3")?.prerelease, null);
  assert.deepEqual(parseVersion("v2026.3.24-beta.2")?.prerelease, ["beta", "2"]);
  assert.equal(parseVersion("2026.9"), null);
  assert.equal(parseVersion("not-a-version"), null);
  assert.equal(parseVersion(undefined), null);
});

check("compareVersions orders releases, prereleases and numeric identifiers", () => {
  assert.equal(compareVersions("2026.9.3", "2026.9.3"), 0);
  assert.equal(compareVersions("2026.9.3", "2026.3.24-beta.2"), 1);
  assert.equal(compareVersions("2026.3.24-beta.2", "2026.3.24"), -1);
  assert.equal(compareVersions("2026.3.24-beta.2", "2026.3.24-beta.10"), -1);
  assert.equal(compareVersions("2026.9.3", "2026.10.0"), -1);
  assert.equal(compareVersions("bogus", "2026.9.3"), null);
});

check("satisfiesRange mirrors the host's AND-only comparator rules", () => {
  assert.equal(satisfiesRange("2026.9.3", ">=2026.3.24-beta.2"), true);
  assert.equal(satisfiesRange("2026.2.1", ">=2026.3.24-beta.2"), false);
  assert.equal(satisfiesRange("2026.9.3", ""), true);
  assert.equal(satisfiesRange("2026.9.3", ">=2026.3.24-beta.2 <2027.0.0"), true);
  assert.equal(satisfiesRange("2026.9.3", ">=2026.3.24-beta.2 <2026.5.0"), false);
  // The host returns false for "||" ranges (dist/package-compat-CurpuyOg.mjs:57-58).
  assert.equal(satisfiesRange("2026.9.3", ">=2026.1.0 || >=2026.2.0"), false);
  assert.equal(satisfiesRange("2026.9.0", ">=2026.3"), true, "a partial range target is treated as a floor");
  assert.equal(satisfiesRange("2026.9", ">=2026.3.24"), false, "a partial host version is not a comparable semver for the host either");
  assert.equal(satisfiesRange("2026.9.3", "~2026.9.0"), true);
  assert.equal(satisfiesRange("2026.10.1", "~2026.9.0"), false);
  assert.equal(satisfiesRange("2026.9.3", ">=bogus"), false);
});

check("normalizeHostVersionForComparator collapses corrections but keeps prerelease floors", () => {
  assert.equal(normalizeHostVersionForComparator("2026.9.3-1", "2026.3.24-beta.2"), "2026.9.3");
  assert.equal(normalizeHostVersionForComparator("2026.9.3-beta.1", "2026.3.24-beta.2"), "2026.9.3-beta.1");
  assert.equal(normalizeHostVersionForComparator("2026.9.3-beta.1", "2026.3.24"), "2026.9.3");
  assert.equal(normalizeHostVersionForComparator("2026.9.3", "2026.3.24"), "2026.9.3");
});

// --- host gate ------------------------------------------------------------------

check("buildHostCompatReport passes on a verified host and lists degraded capabilities", () => {
  const api = createHostApiStub({ omitMethods: ["registerReload", ...HOST_API_METHODS.filter((m) => m.startsWith("registerApp") || m.startsWith("registerResource") || m.startsWith("registerUi") || m.startsWith("registerWidget"))] });
  const report = buildHostCompatReport(api, { env: { OPENCLAW_VERSION: "2026.9.3" } });
  assert.equal(report.gates.find((gate) => gate.id === "HOST-GATE-1").status, "pass");
  assert.equal(report.gates.find((gate) => gate.id === "HOST-GATE-2").status, "pass");
  assert.equal(report.gates.find((gate) => gate.id === "HOST-GATE-3").status, "pass", "registerReload is optional");
  assert.equal(report.overall, "degraded");
  assert.ok(report.degraded.some((entry) => entry.capability === "config-reload-classification"));
  assert.ok(report.degraded.some((entry) => entry.capability === "native-widget-resource"));
  assert.equal(report.hostVersion.source, "env:OPENCLAW_VERSION");
});

check("buildHostCompatReport fails a verified-incompatible host", () => {
  const report = buildHostCompatReport(createHostApiStub(), { env: { OPENCLAW_VERSION: "2026.1.0" } });
  assert.equal(report.gates.find((gate) => gate.id === "HOST-GATE-1").status, "fail");
  assert.equal(report.overall, "fail");
});

check("an unparsable host version warns instead of failing closed", () => {
  const report = buildHostCompatReport(createHostApiStub(), { env: { OPENCLAW_VERSION: "unknown" } });
  assert.equal(report.gates.find((gate) => gate.id === "HOST-GATE-1").status, "warn");
  assert.equal(report.overall, "degraded");
  const absent = buildHostCompatReport(createHostApiStub(), { env: {} });
  assert.equal(absent.hostVersion.known, false);
  assert.equal(absent.gates.find((gate) => gate.id === "HOST-GATE-2").status, "warn");
});

check("buildHostCompatReport reports a missing required surface as a hard failure", () => {
  const report = buildHostCompatReport(createHostApiStub({ omitMethods: ["registerService"] }), { env: { OPENCLAW_VERSION: "2026.9.3" } });
  assert.equal(report.gates.find((gate) => gate.id === "HOST-GATE-3").status, "fail");
  assert.deepEqual(report.surface.missing, ["registerService"]);
});

check("HOST_CONTRACT stays aligned with the package.json declaration", async () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.equal(pkg.openclaw.compat.pluginApi, HOST_CONTRACT.pluginApiRange);
  assert.equal(pkg.openclaw.install.minHostVersion, HOST_CONTRACT.minHostVersion);
  assert.equal(HOST_CONTRACT.rangeSyntax, "and-only");
});

// --- structured errors -----------------------------------------------------------

check("toStructuredError keeps the legacy envelope for plain errors and adds codes for CompatError", () => {
  const legacy = toStructuredError(new Error("fixture failure"));
  assert.equal(legacy.isStructured, false);
  assert.deepEqual(legacy.envelope, { code: "UNAVAILABLE", message: "fixture failure" });

  const structured = toStructuredError(new CompatError(COMPAT_ERROR_CODES.INVALID_INPUT, "bad input", { details: { a: 1 }, retryable: true, retryAfterMs: 250 }));
  assert.equal(structured.isStructured, true);
  assert.deepEqual(structured.envelope, { code: COMPAT_ERROR_CODES.INVALID_INPUT, message: "bad input", details: { a: 1 }, retryable: true, retryAfterMs: 250 });
});

// --- registration ledger ---------------------------------------------------------

check("registration ledger rejects duplicate claims inside one generation", async () => {
  const { beginRegistrationGeneration, claimRegistration, requireRegistration } = await import("../src/sdk-compat.js");
  const pluginId = `ledger-fixture-${Date.now()}`;
  beginRegistrationGeneration(pluginId);
  assert.equal(claimRegistration("tool", "alpha", { pluginId }).ok, true);
  const duplicate = claimRegistration("tool", "alpha", { pluginId });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, COMPAT_ERROR_CODES.DUPLICATE_REGISTRATION);
  assert.throws(() => requireRegistration("tool", "alpha", { pluginId }), /duplicate tool registration/);
  beginRegistrationGeneration(pluginId);
  assert.equal(claimRegistration("tool", "alpha", { pluginId }).ok, true, "a new generation may re-register the same surface");
  const snapshot = describeRegistrationLedger(pluginId);
  assert.equal(snapshot.generation, 2);
  assert.deepEqual(snapshot.history.map((entry) => entry.counts.tool), [1, 1]);
});

// --- tool contract + input validation -------------------------------------------

const validTool = () => ({
  name: "video_asset_get",
  description: "Get an asset",
  parameters: { type: "object", additionalProperties: false, properties: { asset_id: { type: "string" } }, required: ["asset_id"] },
  async execute() {
    return { content: [] };
  }
});

check("validateToolRegistration accepts a well-formed declared tool", () => {
  const result = validateToolRegistration({ name: "video_asset_get", tool: validTool(), declaredNames: new Set(["video_asset_get"]), seenNames: new Set() });
  assert.equal(result.ok, true);
});

check("validateToolRegistration rejects undeclared names, duplicates and malformed schemas", () => {
  const undeclared = validateToolRegistration({ name: "video_asset_get", tool: validTool(), declaredNames: new Set(["other_tool"]), seenNames: new Set() });
  assert.equal(undeclared.ok, false);
  assert.equal(undeclared.error.code, COMPAT_ERROR_CODES.INVALID_TOOL_CONTRACT);

  const duplicate = validateToolRegistration({ name: "video_asset_get", tool: validTool(), declaredNames: new Set(["video_asset_get"]), seenNames: new Set(["video_asset_get"]) });
  assert.match(duplicate.error.message, /registered twice/);

  const noExecute = validTool();
  delete noExecute.execute;
  assert.equal(validateToolRegistration({ name: "t", tool: noExecute, seenNames: new Set() }).ok, false);

  const flattened = validTool();
  flattened.parameters = { type: "object", anyOf: [{ properties: { a: { type: "string" } } }] };
  assert.match(validateToolRegistration({ name: "t", tool: flattened, seenNames: new Set() }).error.message, /anyOf/);

  const danglingRequired = validTool();
  danglingRequired.parameters.required = ["missing_field"];
  assert.match(validateToolRegistration({ name: "t", tool: danglingRequired, seenNames: new Set() }).error.message, /requires unknown property/);
});

check("validateContractsCoverage reports both mismatch directions", () => {
  assert.equal(validateContractsCoverage({ declaredNames: ["a", "b"], registeredNames: ["b", "a"] }).ok, true);
  const mismatch = validateContractsCoverage({ declaredNames: ["a", "b"], registeredNames: ["a", "c"] });
  assert.equal(mismatch.ok, false);
  assert.deepEqual(mismatch.undeclared, ["c"]);
  assert.deepEqual(mismatch.unimplemented, ["b"]);
  assert.equal(mismatch.error.code, COMPAT_ERROR_CODES.UNDECLARED_TOOL);
});

check("validateToolInput enforces required, types, enums and unknown keys", () => {
  const parameters = {
    type: "object",
    additionalProperties: false,
    properties: {
      asset_id: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 50 },
      mode: { type: "string", enum: ["a", "b"] },
      tags: { type: "array", maxItems: 2, items: { type: "string" } }
    },
    required: ["asset_id"]
  };
  assert.equal(validateToolInput({ name: "t", parameters, args: { asset_id: "x" } }).ok, true);
  assert.equal(validateToolInput({ name: "t", parameters, args: undefined }).ok, false, "missing required property");
  assert.equal(validateToolInput({ name: "t", parameters, args: { asset_id: "" } }).ok, false, "minLength");
  assert.equal(validateToolInput({ name: "t", parameters, args: { asset_id: "x", limit: 99 } }).ok, false, "maximum");
  assert.equal(validateToolInput({ name: "t", parameters, args: { asset_id: "x", mode: "c" } }).ok, false, "enum");
  assert.equal(validateToolInput({ name: "t", parameters, args: { asset_id: "x", nope: 1 } }).ok, false, "unknown key");
  assert.equal(validateToolInput({ name: "t", parameters, args: { asset_id: "x", tags: ["a", "b", "c"] } }).ok, false, "maxItems");
  assert.equal(validateToolInput({ name: "t", parameters, args: { asset_id: "x", tags: [1] } }).ok, false, "items type");
  assert.equal(validateToolInput({ name: "t", parameters, args: [] }).ok, false, "arguments must be an object");

  const failure = validateToolInput({ name: "t", parameters, args: {} });
  assert.equal(failure.error.code, COMPAT_ERROR_CODES.INVALID_INPUT);
  assert.equal(failure.error.details.tool, "t");
  assert.ok(failure.error.details.problems.some((problem) => problem.path === "asset_id"));

  const branchy = validateToolInput({ name: "t", parameters: { type: "object", additionalProperties: false, properties: { key: { anyOf: [{ type: "string" }, { type: "object" }] } } }, args: { key: { source: "store" } } });
  assert.equal(branchy.ok, true);
  assert.deepEqual(branchy.skipped, [{ path: "key", keyword: "anyOf" }], "unverifiable branches stay visible instead of silently passing");
});

// --- scope / route validation -----------------------------------------------------

check("validateGatewayScope accepts the public OperatorScope union only", () => {
  for (const scope of OPERATOR_SCOPES) assert.equal(validateGatewayScope(scope).ok, true, scope);
  const bad = validateGatewayScope("operator.everything");
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, COMPAT_ERROR_CODES.INVALID_SCOPE);
  assert.deepEqual(bad.error.details.allowed, [...OPERATOR_SCOPES]);
});

check("validateRouteRegistration requires an absolute path and declared auth/match values", () => {
  assert.equal(validateRouteRegistration({ path: "/__openclaw__/video-assets/file/", auth: "plugin", match: "prefix" }).ok, true);
  assert.equal(validateRouteRegistration({ path: "/__openclaw__/video-assets/file/", auth: "plugin" }).ok, true);
  assert.equal(validateRouteRegistration({ path: "file/", auth: "plugin" }).ok, false);
  assert.equal(validateRouteRegistration({ path: "/x", auth: "public" }).ok, false);
  assert.equal(validateRouteRegistration({ path: "/x", auth: "plugin", match: "regex" }).ok, false);
  assert.equal(validateRouteRegistration({ path: "/x", auth: "public" }).error.code, COMPAT_ERROR_CODES.INVALID_ROUTE);
});

check("authorizeGatewayCall never trusts wire params and denies insufficient trusted scope", () => {
  const hostEnforced = authorizeGatewayCall({ requiredScope: WRITE_SCOPE, trustedScopes: undefined, params: {} });
  assert.equal(hostEnforced.allowed, true);
  assert.equal(hostEnforced.source, "host-enforced");

  const admin = authorizeGatewayCall({ requiredScope: WRITE_SCOPE, trustedScopes: ["operator.admin"], params: {} });
  assert.equal(admin.allowed, true);

  const readOnlyWrite = authorizeGatewayCall({ requiredScope: WRITE_SCOPE, trustedScopes: [READ_SCOPE], params: {} });
  assert.equal(readOnlyWrite.allowed, false);
  assert.equal(readOnlyWrite.error.code, COMPAT_ERROR_CODES.FORBIDDEN);

  const escalation = authorizeGatewayCall({
    requiredScope: WRITE_SCOPE,
    trustedScopes: [READ_SCOPE],
    params: { actor_id: "human:plugin-admin", scopes: ["operator.admin"], scope: "operator.admin" }
  });
  assert.equal(escalation.allowed, false, "params-supplied identity must not grant scope");
});

// --- SecretRef metadata ------------------------------------------------------------

check("isSecretRefShape accepts the canonical SecretRef and rejects partial shapes", () => {
  assert.equal(isSecretRefShape({ source: "store", provider: "default", id: "KIE_API_KEY" }), true);
  assert.equal(isSecretRefShape({ source: "file", provider: "mounted-json", id: "/providers/kie/apiKey" }), true);
  assert.equal(isSecretRefShape({ source: "vault", provider: "x", id: "y" }), false);
  assert.equal(isSecretRefShape({ source: "store", provider: "default" }), false);
  assert.equal(isSecretRefShape("KIE_API_KEY"), false);
  assert.equal(isSecretRefShape(null), false);
});

check("describeSecretInputs reports status without leaking values or ref ids", () => {
  const descriptions = describeSecretInputs({
    pluginConfig: {
      audio: {
        kie: { apiKey: { source: "store", provider: "default", id: "KIE_API_KEY_SECRET_ID" } },
        doubao: { apiKey: "plaintext-doubao-key-value" }
      }
    },
    declaredPaths: [
      { path: "audio.kie.apiKey", expected: "string", ownerKind: "capability" },
      { path: "audio.doubao.apiKey", expected: "string", ownerKind: "capability" },
      { path: "audio.missing.apiKey" }
    ]
  });
  assert.deepEqual(descriptions[0], { path: "audio.kie.apiKey", expected: "string", ownerKind: "capability", status: "configured-ref", ref: { source: "store", provider: "default" } });
  assert.equal(descriptions[1].status, "configured-literal");
  assert.equal(descriptions[2].status, "missing");

  const serialized = JSON.stringify(descriptions);
  assert.ok(!serialized.includes("KIE_API_KEY_SECRET_ID"), "SecretRef id must be concealed");
  assert.ok(!serialized.includes("plaintext-doubao-key-value"), "literal secret must never be echoed");

  const invalid = describeSecretInputs({ pluginConfig: { audio: { kie: { apiKey: 42 } } }, declaredPaths: ["audio.kie.apiKey"] });
  assert.equal(invalid[0].status, "invalid");
});

check("validateSecretInputDeclarations agrees with the shipped manifest", () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "openclaw.plugin.json"), "utf8"));
  const declared = manifest.configContracts.secretInputs.paths;
  assert.equal(validateSecretInputDeclarations({ configSchema: manifest.configSchema, declaredPaths: declared }).ok, true);

  const drifted = validateSecretInputDeclarations({
    configSchema: manifest.configSchema,
    declaredPaths: [{ path: "audio.unknown.apiKey", expected: "string" }]
  });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.error.code, COMPAT_ERROR_CODES.INVALID_SECRET_DECLARATION);

  const unsupported = validateSecretInputDeclarations({ configSchema: manifest.configSchema, declaredPaths: [{ path: "audio.kie.apiKey", expected: "number" }] });
  assert.match(unsupported.problems.join(" "), /not supported/);

  const badOwner = validateSecretInputDeclarations({ configSchema: manifest.configSchema, declaredPaths: [{ path: "audio.kie.apiKey", ownerKind: "banana" }] });
  assert.match(badOwner.problems.join(" "), /ownerKind/);
});

let failures = 0;
for (const { name, run } of checks) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures > 0) {
  console.error(`sdk-compat contract test failed: ${failures}/${checks.length}`);
  process.exit(1);
}
console.log(`sdk compat contract test passed (${checks.length} checks)`);
