/**
 * OpenClaw plugin SDK compatibility adapter (REN-01).
 *
 * Purpose: keep every host-facing contract in ONE place so the plugin's surfaces
 * (tools, contracts.tools, gateway RPC scope, plugin HTTP routes, service lifecycle,
 * SecretRef config metadata, structured errors) can be probed, validated and tested
 * against a concrete OpenClaw host version instead of being re-derived inline.
 *
 * Ground rules encoded here (all verified against the installed host, see
 * implementation/REN-01/compatibility-matrix.md for the file:line evidence):
 *  1. Only PUBLIC `openclaw/plugin-sdk/*` subpaths may be imported. Never import
 *     anything from `openclaw/dist/...`; those are private and not a long-term API.
 *  2. The host remains authoritative for scope enforcement and for the
 *     `openclaw.compat.pluginApi` / `openclaw.install.minHostVersion` gates. This
 *     adapter adds defense-in-depth and actionable diagnostics, and mirrors the
 *     host's own range semantics so failures are reproducible off-host.
 *  3. Nothing here may perform network I/O, credential resolution, or paid calls.
 *     Secret inspection is metadata-only and never returns a secret value.
 */

export const PLUGIN_ID = "video-assets";

/** Version of this adapter's own contract table. Bump when the table changes. */
export const ADAPTER_VERSION = 1;

/**
 * Host compatibility declaration mirrored from package.json.
 * `pluginApiRange`   -> enforced by the host at discovery/load (package.json openclaw.compat.pluginApi).
 * `minHostVersion`   -> enforced by the host at install/manifest-registry load (package.json openclaw.install.minHostVersion).
 * `minGatewayVersion`-> retained for ClawHub-style catalog descriptors; NO reader on the
 *                       local discovery/load path in 2026.9.3 (see compat matrix row HOST-GATE-3).
 */
export const HOST_CONTRACT = Object.freeze({
  pluginApiRange: ">=2026.3.24-beta.2",
  minHostVersion: ">=2026.3.24-beta.2",
  /** Versions with direct runtime evidence in this work package. */
  verifiedHosts: Object.freeze(["2026.9.3", "2026.9.7"]),
  /** Range syntax accepted by the host: whitespace-separated comparators ANDed; "||" is unsupported. */
  rangeSyntax: "and-only"
});

/** Operator scopes accepted by api.registerGatewayMethod (public OperatorScope union). */
export const OPERATOR_SCOPES = Object.freeze([
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.pairing",
  "operator.talk",
  "operator.talk.secrets"
]);

export const READ_SCOPE = "operator.read";
export const WRITE_SCOPE = "operator.write";

/** api.registerHttpRoute auth values (OpenClawPluginHttpRouteAuth). */
export const ROUTE_AUTH_VALUES = Object.freeze(["gateway", "plugin"]);
/** api.registerHttpRoute match values (OpenClawPluginHttpRouteMatch). */
export const ROUTE_MATCH_VALUES = Object.freeze(["exact", "prefix"]);
/** Plugin registration modes reported by api.registrationMode. */
export const REGISTRATION_MODES = Object.freeze([
  "full",
  "discovery",
  "tool-discovery",
  "setup-only",
  "setup-runtime",
  "cli-metadata"
]);

export const COMPAT_ERROR_CODES = Object.freeze({
  UNSUPPORTED_HOST: "VIDEO_ASSETS_UNSUPPORTED_HOST",
  UNSUPPORTED_SDK_SURFACE: "VIDEO_ASSETS_UNSUPPORTED_SDK_SURFACE",
  INVALID_TOOL_CONTRACT: "VIDEO_ASSETS_INVALID_TOOL_CONTRACT",
  UNDECLARED_TOOL: "VIDEO_ASSETS_UNDECLARED_TOOL",
  DUPLICATE_REGISTRATION: "VIDEO_ASSETS_DUPLICATE_REGISTRATION",
  INVALID_ROUTE: "VIDEO_ASSETS_INVALID_ROUTE",
  INVALID_SCOPE: "VIDEO_ASSETS_INVALID_SCOPE",
  INVALID_INPUT: "VIDEO_ASSETS_INVALID_INPUT",
  FORBIDDEN: "VIDEO_ASSETS_FORBIDDEN",
  INVALID_SECRET_DECLARATION: "VIDEO_ASSETS_INVALID_SECRET_DECLARATION",
  INTERNAL: "VIDEO_ASSETS_INTERNAL"
});

/** Legacy gateway RPC failure code kept byte-for-byte for clients written before REN-01. */
export const LEGACY_RPC_ERROR_CODE = "UNAVAILABLE";

// ---------------------------------------------------------------------------
// Structured errors
// ---------------------------------------------------------------------------

/**
 * Error carrying a stable machine-readable code and structured detail so callers
 * (gateway RPC, plugin HTTP RPC, tool results) can react without string matching.
 */
export class CompatError extends Error {
  constructor(code, message, { details, hint, retryable = false, retryAfterMs, cause } = {}) {
    super(message);
    this.name = "CompatError";
    this.code = code;
    this.details = details;
    this.hint = hint;
    this.retryable = retryable;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    if (cause !== undefined) this.cause = cause;
  }

  /** Gateway-method error envelope (GatewayMethodDispatchError shape). */
  toEnvelope() {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
      ...(this.retryable ? { retryable: true } : {}),
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {})
    };
  }
}

/**
 * Normalize any thrown value into the structured envelope.
 *
 * `isStructured` is false for non-CompatError failures; callers that must stay
 * wire-compatible with pre-REN-01 clients use it to emit the legacy
 * `{ code: "UNAVAILABLE", message }` envelope unchanged.
 */
export function toStructuredError(error) {
  if (error instanceof CompatError) {
    return { envelope: error.toEnvelope(), isStructured: true, hint: error.hint ?? null };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    envelope: { code: LEGACY_RPC_ERROR_CODE, message },
    isStructured: false,
    hint: error instanceof Error && typeof error.status === "number" ? `http_status=${error.status}` : null
  };
}

// ---------------------------------------------------------------------------
// Version parsing / comparison (mirrors the host's own plugin-api range rules)
// ---------------------------------------------------------------------------

/**
 * Parse an OpenClaw-style version string.
 * @returns {{raw:string, nums:number[], prerelease:string[]|null}|null}
 */
export function parseVersion(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^v/i, "");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(trimmed);
  if (!match) return null;
  return {
    raw: trimmed,
    nums: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : null
  };
}

function comparePrereleaseIdentifiers(a, b) {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Math.sign(Number(a) - Number(b));
  if (aNum) return -1;
  if (bNum) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Compare two parsed versions: -1 | 0 | 1, or null when either side is unparsable. */
export function compareVersions(a, b) {
  const left = typeof a === "string" ? parseVersion(a) : a;
  const right = typeof b === "string" ? parseVersion(b) : b;
  if (!left || !right) return null;
  for (let index = 0; index < 3; index += 1) {
    if (left.nums[index] !== right.nums[index]) return left.nums[index] < right.nums[index] ? -1 : 1;
  }
  if (!left.prerelease && !right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aId = left.prerelease[index];
    const bId = right.prerelease[index];
    if (aId === undefined) return -1;
    if (bId === undefined) return 1;
    const compared = comparePrereleaseIdentifiers(aId, bId);
    if (compared !== 0) return compared;
  }
  return 0;
}

const OPENCLAW_RELEASE_SUFFIX_PATTERN = /^[vV]?(\d{4}\.[1-9]\d?\.[1-9]\d*)(?:-\d+|-(?:alpha|beta|rc)\.\d+)$/i;
const OPENCLAW_NUMERIC_CORRECTION_PATTERN = /^[vV]?(\d{4}\.[1-9]\d?\.[1-9]\d*)-\d+$/;

/**
 * Host-side normalization of a host version before comparator evaluation:
 * a numeric correction ("2026.9.3-1") collapses to the release, and a release-candidate
 * suffix collapses too unless the range target itself carries a prerelease.
 * Mirrors dist/package-compat-CurpuyOg.mjs:13-24.
 */
export function normalizeHostVersionForComparator(version, target) {
  const trimmed = String(version ?? "").trim();
  const numericCorrection = OPENCLAW_NUMERIC_CORRECTION_PATTERN.exec(trimmed);
  if (numericCorrection) return numericCorrection[1];
  const targetHasPrerelease = Boolean(parseVersion(target)?.prerelease) || /^[vV]?\d+\.\d+\.\d+-/.test(String(target ?? "").trim());
  if (targetHasPrerelease) return trimmed;
  const releaseSuffix = OPENCLAW_RELEASE_SUFFIX_PATTERN.exec(trimmed);
  return releaseSuffix ? releaseSuffix[1] : trimmed;
}

function satisfiesComparator(hostVersion, token) {
  const trimmed = String(token ?? "").trim();
  if (!trimmed) return true;
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(trimmed);
  if (!match) return false;
  const operator = match[1] ?? "";
  const target = String(match[2] ?? "").trim();
  if (!target || /^[<>=^~]/.test(target)) return false;
  const comparable = normalizeHostVersionForComparator(hostVersion, target);
  const parsedComparable = parseVersion(comparable);
  const partialMatch = /^[vV]?(\d+)\.(\d+)$/.exec(target);
  const parsedTarget = partialMatch
    ? { raw: `${partialMatch[1]}.${partialMatch[2]}.0`, nums: [Number(partialMatch[1]), Number(partialMatch[2]), 0], prerelease: null }
    : parseVersion(target);
  if (!parsedComparable || !parsedTarget) return false;
  const compared = compareVersions(parsedComparable, parsedTarget);
  if (compared === null) return false;
  const effectiveOperator = partialMatch && !operator ? ">=" : operator;
  switch (effectiveOperator) {
    case "":
    case "=":
      return compared === 0;
    case ">=":
      return compared >= 0;
    case ">":
      return compared > 0;
    case "<=":
      return compared <= 0;
    case "<":
      return compared < 0;
    case "^":
      return compared >= 0 && parsedComparable.nums[0] === parsedTarget.nums[0];
    case "~":
      return compared >= 0 && parsedComparable.nums[0] === parsedTarget.nums[0] && parsedComparable.nums[1] === parsedTarget.nums[1];
    default:
      return false;
  }
}

/**
 * Evaluate an OpenClaw plugin-api range exactly like the host does:
 * whitespace-separated comparators ANDed together, and "||" explicitly unsupported
 * (the host returns false for it, so an "||" range reads as incompatible).
 */
export function satisfiesRange(hostVersion, range) {
  const raw = String(range ?? "").trim();
  if (!raw) return true;
  if (raw.includes("||")) return false;
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((token) => satisfiesComparator(hostVersion, token));
}

/**
 * Resolve the host version visible to plugin code.
 * The host computes this from OPENCLAW_COMPATIBILITY_HOST_VERSION, then OPENCLAW_VERSION,
 * then the runtime build version (dist/version-Do2--r0p.mjs:80-89). Plugin code cannot read
 * the runtime constant (private), so we use the env-visible subset and report the source.
 */
export function resolveHostVersion(env = process.env) {
  const explicit = normalizeEnvVersion(env.OPENCLAW_COMPATIBILITY_HOST_VERSION);
  if (explicit) return { raw: explicit, source: "env:OPENCLAW_COMPATIBILITY_HOST_VERSION", known: true };
  const versioned = normalizeEnvVersion(env.OPENCLAW_VERSION);
  if (versioned) return { raw: versioned, source: "env:OPENCLAW_VERSION", known: true };
  const npm = normalizeEnvVersion(env.npm_package_version);
  if (npm) return { raw: npm, source: "env:npm_package_version", known: true };
  return { raw: null, source: "unavailable", known: false };
}

function normalizeEnvVersion(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Public API surface probe + compatibility report
// ---------------------------------------------------------------------------

/** Registration surfaces this plugin depends on, with the contract floor we require. */
export const REQUIRED_SURFACES = Object.freeze([
  { method: "registerTool", role: "tools", required: true, contract: "OpenClawPluginApi.registerTool" },
  { method: "registerGatewayMethod", role: "gateway-rpc", required: true, contract: "OpenClawPluginApi.registerGatewayMethod" },
  { method: "registerHttpRoute", role: "http-routes", required: true, contract: "OpenClawPluginApi.registerHttpRoute" },
  { method: "registerService", role: "service-lifecycle", required: true, contract: "OpenClawPluginApi.registerService" },
  { method: "registerReload", role: "config-reload-classification", required: false, contract: "OpenClawPluginApi.registerReload" }
]);

/** Native widget resource registration is probe-based with a protected-route fallback. */
export const OPTIONAL_RESOURCE_SURFACES = Object.freeze([
  "registerAppResource",
  "registerResource",
  "registerUiResource",
  "registerWidgetResource"
]);

/** Returns the registration surfaces actually exposed by the live `api` object. */
export function probePluginApi(api) {
  const present = [];
  const missing = [];
  const optionalMissing = [];
  for (const surface of REQUIRED_SURFACES) {
    if (typeof api?.[surface.method] === "function") present.push(surface.method);
    else if (surface.required) missing.push(surface.method);
    else optionalMissing.push(surface.method);
  }
  for (const method of OPTIONAL_RESOURCE_SURFACES) {
    if (typeof api?.[method] === "function") present.push(method);
  }
  const nativeResource = OPTIONAL_RESOURCE_SURFACES.some((method) => typeof api?.[method] === "function");
  return { present, missing, optionalMissing, nativeWidgetResource: nativeResource };
}

/**
 * Build the machine-readable host compatibility report used by register(), the
 * contract tests, and the compatibility matrix.
 *
 * `gates` entries are `pass` / `warn` / `fail` so a caller can fail closed on a
 * verified-incompatible host while staying tolerant of an unverifiable host version
 * (the host itself only *warns and skips* in that case, so reaching register() with an
 * unknown version is not by itself proof of incompatibility).
 */
export function buildHostCompatReport(api, { env = process.env, pluginApiRange = HOST_CONTRACT.pluginApiRange, minHostVersion = HOST_CONTRACT.minHostVersion } = {}) {
  const hostVersion = resolveHostVersion(env);
  const parsed = hostVersion.known ? parseVersion(hostVersion.raw) : null;
  // An unparsable host version string must never read as "incompatible": the host itself
  // only warns and skips on an unknown host version, so we degrade instead of failing closed.
  const versionComparable = hostVersion.known && parsed !== null;
  const unverifiableDetail = hostVersion.known
    ? `host version "${hostVersion.raw}" (${hostVersion.source}) is not a parsable semver; range not evaluated locally`
    : "host version not visible to plugin code; the host already enforced this gate before load";
  const gates = [];
  const degraded = [];

  gates.push({
    id: "HOST-GATE-1",
    requirement: `openclaw.compat.pluginApi ${pluginApiRange}`,
    status: versionComparable ? (satisfiesRange(hostVersion.raw, pluginApiRange) ? "pass" : "fail") : "warn",
    detail: versionComparable
      ? `host ${hostVersion.raw} (${hostVersion.source}); range parsed locally with the host's AND-only comparator rules`
      : unverifiableDetail
  });

  gates.push({
    id: "HOST-GATE-2",
    requirement: `openclaw.install.minHostVersion ${minHostVersion}`,
    status: versionComparable ? (satisfiesRange(hostVersion.raw, minHostVersion) ? "pass" : "fail") : "warn",
    detail: versionComparable
      ? `host ${hostVersion.raw}; floor enforced by the host at install and manifest-registry load`
      : unverifiableDetail
  });

  const surface = probePluginApi(api);
  gates.push({
    id: "HOST-GATE-3",
    requirement: "required registration surfaces present",
    status: surface.missing.length === 0 ? "pass" : "fail",
    detail: surface.missing.length === 0 ? `present: ${surface.present.join(", ")}` : `missing: ${surface.missing.join(", ")}`
  });
  if (surface.optionalMissing.length > 0) {
    degraded.push({
      capability: "config-reload-classification",
      reason: `api.${surface.optionalMissing.join(" / api.")} not exposed`,
      fallback: "plugin config changes fall back to host default plugin reload policy (plugins.* is hot)"
    });
  }
  if (!surface.nativeWidgetResource) {
    degraded.push({
      capability: "native-widget-resource",
      reason: "no registerAppResource/registerResource/registerUiResource/registerWidgetResource on api",
      fallback: "protected workbench route /__openclaw__/video-assets/workbench/"
    });
  }
  const registrationMode = typeof api?.registrationMode === "string" ? api.registrationMode : null;
  if (registrationMode && registrationMode !== "full") {
    degraded.push({
      capability: "registration-mode",
      reason: `host invoked register(api) in "${registrationMode}" mode`,
      fallback: "surfaces are registered for whichever mode the host requested; tests cover full mode"
    });
  }

  return {
    pluginId: PLUGIN_ID,
    adapterVersion: ADAPTER_VERSION,
    contractVersion: 1,
    hostVersion: { ...hostVersion, parsed: parsed ? { nums: parsed.nums, prerelease: parsed.prerelease } : null },
    pluginApiRange,
    minHostVersion,
    registrationMode,
    surface,
    gates,
    degraded,
    overall: gates.some((gate) => gate.status === "fail") ? "fail" : degraded.length > 0 || gates.some((gate) => gate.status === "warn") ? "degraded" : "pass",
    checkedAt: new Date().toISOString()
  };
}

/**
 * Fail closed on a verified-incompatible host with an actionable error; return the
 * report otherwise (including the degraded/unknown case, which is reported, not hidden).
 */
export function assertSupportedHost(api, options = {}) {
  const report = buildHostCompatReport(api, options);
  // Check the more specific failure first so the caller gets the actionable surface error
  // rather than a generic unsupported-host message.
  if (report.surface.missing.length > 0) {
    throw new CompatError(
      COMPAT_ERROR_CODES.UNSUPPORTED_SDK_SURFACE,
      `OpenClaw plugin API is missing required surface(s): ${report.surface.missing.join(", ")}`,
      {
        details: { missing: report.surface.missing, hostVersion: report.hostVersion },
        hint: "This host is older than the supported plugin API floor. Upgrade OpenClaw or install a compatible plugin version.",
        retryable: false
      }
    );
  }
  const failed = report.gates.filter((gate) => gate.status === "fail");
  if (failed.length > 0) {
    throw new CompatError(
      COMPAT_ERROR_CODES.UNSUPPORTED_HOST,
      `video-assets requires ${HOST_CONTRACT.pluginApiRange} plugin API and ${HOST_CONTRACT.minHostVersion} host floor, but ${failed
        .map((gate) => `${gate.id} (${gate.requirement}) failed for host ${report.hostVersion.raw ?? "unknown"}`)
        .join("; ")}`,
      {
        details: { report },
        hint: 'Run "openclaw --version" and "openclaw doctor". Upgrade OpenClaw, or set OPENCLAW_COMPATIBILITY_HOST_VERSION only in an isolated test harness.',
        retryable: false
      }
    );
  }
  return report;
}

// ---------------------------------------------------------------------------
// Registration ledger (reload / duplicate-registration isolation)
// ---------------------------------------------------------------------------

const LEDGER_SYMBOL = Symbol.for("openclaw.video-assets.sdk-compat-ledger");

/**
 * Process-wide registration ledger keyed by plugin id.
 *
 * Why: plugin modules can be re-evaluated across host reloads, and the host builds a
 * fresh registry per load generation. The failure modes we must make impossible are
 * (a) registering the same logical surface twice inside one generation, and
 * (b) carrying in-memory state (service handle, plugin sessions) from a previous
 * generation into the new one.
 */
export function getRegistrationLedger(pluginId = PLUGIN_ID) {
  const root = (globalThis[LEDGER_SYMBOL] ??= {});
  if (!root[pluginId]) {
    root[pluginId] = {
      pluginId,
      generation: 0,
      current: new Map(),
      cumulative: new Map(),
      history: [],
      disposedGenerations: 0,
      lastDisposedAt: null
    };
  }
  return root[pluginId];
}

export function beginRegistrationGeneration(pluginId = PLUGIN_ID, meta = {}) {
  const ledger = getRegistrationLedger(pluginId);
  ledger.generation += 1;
  ledger.current = new Map();
  ledger.history.push({ generation: ledger.generation, startedAt: new Date().toISOString(), meta, counts: {} });
  return ledger.generation;
}

export function currentGenerationRecord(pluginId = PLUGIN_ID) {
  const ledger = getRegistrationLedger(pluginId);
  return ledger.history.find((entry) => entry.generation === ledger.generation) ?? null;
}

/**
 * Claim a registration slot for this generation.
 * @returns {{ok:true, generation:number}|{ok:false, code:string, message:string}}
 */
export function claimRegistration(kind, key, { pluginId = PLUGIN_ID, detail } = {}) {
  const ledger = getRegistrationLedger(pluginId);
  const composite = `${kind}:${key}`;
  const existing = ledger.current.get(composite);
  if (existing) {
    return {
      ok: false,
      code: COMPAT_ERROR_CODES.DUPLICATE_REGISTRATION,
      message: `duplicate ${kind} registration in generation ${ledger.generation}: ${key}`
    };
  }
  ledger.current.set(composite, { kind, key, detail, generation: ledger.generation, at: new Date().toISOString() });
  ledger.cumulative.set(composite, (ledger.cumulative.get(composite) ?? 0) + 1);
  const record = currentGenerationRecord(pluginId);
  if (record) record.counts[kind] = (record.counts[kind] ?? 0) + 1;
  return { ok: true, generation: ledger.generation };
}

/** Duplicate claims are a wiring bug: fail loudly instead of double-registering. */
export function requireRegistration(kind, key, options = {}) {
  const claim = claimRegistration(kind, key, options);
  if (!claim.ok) {
    throw new CompatError(claim.code, claim.message, {
      details: { kind, key, generation: claim.generation },
      hint: "A surface was registered twice during one register(api) pass. Remove the duplicate call site."
    });
  }
  return claim.generation;
}

export function recordDisposal(pluginId = PLUGIN_ID, reason) {
  const ledger = getRegistrationLedger(pluginId);
  ledger.disposedGenerations += 1;
  ledger.lastDisposedAt = new Date().toISOString();
  ledger.lastDisposalReason = reason ?? "re-register";
  return ledger;
}

/** Snapshot for tests/diagnostics: per-generation counts and cumulative totals. */
export function describeRegistrationLedger(pluginId = PLUGIN_ID) {
  const ledger = getRegistrationLedger(pluginId);
  return {
    pluginId,
    generation: ledger.generation,
    disposedGenerations: ledger.disposedGenerations,
    lastDisposedAt: ledger.lastDisposedAt,
    currentGeneration: [...ledger.current.values()],
    history: ledger.history.map((entry) => ({ ...entry, counts: { ...entry.counts } })),
    cumulative: Object.fromEntries(ledger.cumulative)
  };
}

// ---------------------------------------------------------------------------
// Tool contract + input validation
// ---------------------------------------------------------------------------

/**
 * Validate one registered tool against the manifest's `contracts.tools` admission list.
 * The host hard-rejects undeclared tool names (loader-runtime-load-*.mjs:3923-3937), so a
 * mismatch must be caught here with an actionable message instead of a silent skip.
 */
export function validateToolRegistration({ name, tool, declaredNames, seenNames }) {
  const problems = [];
  if (typeof name !== "string" || !name.trim()) problems.push("tool name must be a non-empty string");
  if (declaredNames && !declaredNames.has(name)) {
    problems.push(`tool "${name}" is not declared in openclaw.plugin.json contracts.tools`);
  }
  if (seenNames?.has(name)) problems.push(`tool "${name}" is registered twice in this generation`);
  if (!tool || typeof tool !== "object") problems.push(`tool "${name}" must be an object`);
  else {
    if (typeof tool.description !== "string" || !tool.description.trim()) problems.push(`tool "${name}" needs a non-empty description`);
    if (typeof tool.execute !== "function") problems.push(`tool "${name}" needs an execute function`);
    const parameters = tool.parameters;
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
      problems.push(`tool "${name}" needs a parameters object`);
    } else {
      if (parameters.type !== "object") problems.push(`tool "${name}" parameters.type must be "object"`);
      if (!parameters.properties || typeof parameters.properties !== "object" || Array.isArray(parameters.properties)) {
        problems.push(`tool "${name}" parameters.properties must be an object`);
      }
      if (parameters.anyOf || parameters.oneOf) {
        problems.push(`tool "${name}" parameters must not use a top-level anyOf/oneOf (provider schema normalization flattens it)`);
      }
      if (parameters.required !== undefined && !Array.isArray(parameters.required)) {
        problems.push(`tool "${name}" parameters.required must be an array when present`);
      }
      for (const requiredName of parameters.required ?? []) {
        if (!parameters.properties?.[requiredName]) {
          problems.push(`tool "${name}" requires unknown property "${requiredName}"`);
        }
      }
    }
  }
  if (problems.length === 0) return { ok: true };
  return {
    ok: false,
    error: new CompatError(COMPAT_ERROR_CODES.INVALID_TOOL_CONTRACT, `invalid tool contract for "${name}": ${problems.join("; ")}`, {
      details: { tool: name, problems },
      hint: "Fix the tool definition or the manifest contracts.tools list together; the host skips undeclared tools."
    })
  };
}

/** Validate that manifest contracts.tools and the registered tool set are the same set. */
export function validateContractsCoverage({ declaredNames, registeredNames }) {
  const declared = new Set(declaredNames ?? []);
  const registered = new Set(registeredNames ?? []);
  const undeclared = [...registered].filter((name) => !declared.has(name)).sort();
  const unimplemented = [...declared].filter((name) => !registered.has(name)).sort();
  if (undeclared.length === 0 && unimplemented.length === 0) return { ok: true, declared: declared.size, registered: registered.size };
  return {
    ok: false,
    undeclared,
    unimplemented,
    error: new CompatError(
      COMPAT_ERROR_CODES.UNDECLARED_TOOL,
      `contracts.tools mismatch: ${undeclared.length} registered-but-undeclared, ${unimplemented.length} declared-but-unregistered`,
      {
        details: { undeclared, unimplemented },
        hint: "openclaw.plugin.json contracts.tools is a runtime admission list, not documentation."
      }
    )
  };
}

const JSON_TYPE_CHECKS = {
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number" && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === "boolean",
  array: (value) => Array.isArray(value),
  object: (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  null: (value) => value === null
};

/**
 * Validate tool arguments against the declared parameters schema.
 *
 * Scope: exactly the keywords this plugin's tools declare (type, properties, required,
 * additionalProperties:false, enum, minimum/maximum, minLength/maxLength, minItems/maxItems,
 * items). `anyOf`/`oneOf` branches are intentionally NOT evaluated locally: the host/provider
 * normalize those before execution, and a partial local interpretation would reject valid
 * input. Anything skipped is reported in `skipped` so the gap stays visible.
 */
export function validateToolInput({ name, parameters, args }) {
  const problems = [];
  const skipped = [];
  const schema = parameters ?? {};
  const value = args === undefined || args === null ? {} : args;
  if (!JSON_TYPE_CHECKS.object(value)) {
    problems.push({ path: "", message: "arguments must be a JSON object" });
    return { ok: false, problems, skipped };
  }
  const properties = schema.properties ?? {};
  for (const requiredName of schema.required ?? []) {
    if (value[requiredName] === undefined) problems.push({ path: requiredName, message: "required property is missing" });
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) problems.push({ path: key, message: "unknown property (additionalProperties is false)" });
    }
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    const propertyValue = value[key];
    if (propertyValue === undefined) continue;
    problems.push(...validatePropertyValue(key, propertyValue, propertySchema, skipped));
  }
  if (problems.length === 0) return { ok: true, skipped };
  return {
    ok: false,
    problems,
    skipped,
    error: new CompatError(COMPAT_ERROR_CODES.INVALID_INPUT, `invalid input for ${name}: ${problems.map((problem) => `${problem.path || "<root>"}: ${problem.message}`).join("; ")}`, {
      details: { tool: name, problems },
      hint: "Fix the tool call arguments; the declared schema is authoritative for this plugin's write operations."
    })
  };
}

function validatePropertyValue(path, value, schema, skipped) {
  const problems = [];
  if (!schema || typeof schema !== "object") return problems;
  if (schema.anyOf || schema.oneOf) {
    skipped.push({ path, keyword: schema.anyOf ? "anyOf" : "oneOf" });
    return problems;
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0) {
    const matched = types.some((type) => JSON_TYPE_CHECKS[type]?.(value) === true);
    if (!matched) problems.push({ path, message: `expected ${types.join("|")}` });
    else if (types.length === 1) problems.push(...validateConstraints(path, value, schema, types[0]));
    return problems;
  }
  problems.push(...validateConstraints(path, value, schema, null));
  return problems;
}

function validateConstraints(path, value, schema, type) {
  const problems = [];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    problems.push({ path, message: `must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}` });
  }
  if ((type === "number" || type === "integer") && typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) problems.push({ path, message: `must be >= ${schema.minimum}` });
    if (typeof schema.maximum === "number" && value > schema.maximum) problems.push({ path, message: `must be <= ${schema.maximum}` });
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) problems.push({ path, message: `must be > ${schema.exclusiveMinimum}` });
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) problems.push({ path, message: `must be < ${schema.exclusiveMaximum}` });
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) problems.push({ path, message: `must have at least ${schema.minLength} characters` });
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) problems.push({ path, message: `must have at most ${schema.maxLength} characters` });
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) problems.push({ path, message: `must have at least ${schema.minItems} items` });
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) problems.push({ path, message: `must have at most ${schema.maxItems} items` });
    if (schema.items && typeof schema.items === "object" && !schema.items.anyOf && !schema.items.oneOf) {
      value.forEach((item, index) => {
        problems.push(...validatePropertyValue(`${path}[${index}]`, item, schema.items, []));
      });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// SecretRef metadata (inspection only; never returns a value)
// ---------------------------------------------------------------------------

const SECRET_REF_SOURCES = ["env", "file", "exec", "store"];

/** Canonical SecretRef shape check (public shape: {source, provider, id}). */
export function isSecretRefShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!SECRET_REF_SOURCES.includes(value.source)) return false;
  if (typeof value.provider !== "string" || !value.provider.trim()) return false;
  if (typeof value.id !== "string" || !value.id.trim()) return false;
  return true;
}

function readConfigPath(pluginConfig, dottedPath) {
  let cursor = pluginConfig;
  for (const segment of String(dottedPath).split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function readSchemaPath(configSchema, dottedPath) {
  let cursor = configSchema;
  for (const segment of String(dottedPath).split(".")) {
    const properties = cursor?.properties ?? cursor?.anyOf?.find?.((branch) => branch?.properties)?.properties;
    if (!properties || !properties[segment]) return undefined;
    cursor = properties[segment];
  }
  return cursor;
}

/**
 * Describe each declared secret input without exposing it.
 * `status`: configured-literal | configured-ref | missing
 * `ref`: { source, provider } only — `id` is concealed, matching host Settings redaction.
 */
export function describeSecretInputs({ pluginConfig = {}, declaredPaths = [] }) {
  return declaredPaths.map((entry) => {
    const path = typeof entry === "string" ? entry : entry?.path;
    const expected = (typeof entry === "object" && entry?.expected) || "string";
    const ownerKind = (typeof entry === "object" && entry?.ownerKind) || null;
    const value = readConfigPath(pluginConfig, path);
    if (value === undefined) return { path, expected, ownerKind, status: "missing", ref: null };
    if (isSecretRefShape(value)) return { path, expected, ownerKind, status: "configured-ref", ref: { source: value.source, provider: value.provider } };
    if (typeof value === "string") {
      return { path, expected, ownerKind, status: value.trim() ? "configured-literal" : "missing", ref: null };
    }
    return { path, expected, ownerKind, status: "invalid", ref: null, reason: "expected a string or a SecretRef object" };
  });
}

/**
 * Cross-check manifest configContracts.secretInputs against configSchema.
 * Catches drift where a declared secret path has no schema node, or a schema node that
 * cannot accept a SecretRef (the host validates the pre-resolution source config).
 */
export function validateSecretInputDeclarations({ configSchema, declaredPaths = [] }) {
  const problems = [];
  for (const entry of declaredPaths) {
    const path = typeof entry === "string" ? entry : entry?.path;
    if (!path) {
      problems.push("secretInputs.paths entry is missing `path`");
      continue;
    }
    if (typeof entry === "object" && entry?.expected && entry.expected !== "string") {
      problems.push(`${path}: expected "${entry.expected}" is not supported (only "string")`);
    }
    if (typeof entry === "object" && entry?.ownerKind && !["capability", "route"].includes(entry.ownerKind)) {
      problems.push(`${path}: ownerKind must be "capability" or "route"`);
    }
    const node = readSchemaPath(configSchema, path);
    if (!node) {
      problems.push(`${path}: declared secret input has no node in configSchema`);
      continue;
    }
    const acceptsString = node.type === "string" || node.anyOf?.some?.((branch) => branch?.type === "string");
    const acceptsRef = node.anyOf?.some?.((branch) => branch?.type === "object" && branch?.properties?.source && branch?.properties?.id);
    if (!acceptsString) {
      problems.push(`${path}: configSchema node must accept a literal string (a plaintext source value still has to validate)`);
    }
    if (!acceptsRef) {
      // docs/plugins/manifest/config-and-secrets.md: configSchema validates the pre-resolution
      // source config, so a node that only accepts a string rejects a configured SecretRef and
      // silently disables SecretRef support for that path.
      problems.push(`${path}: configSchema node must accept a SecretRef object, otherwise a configured SecretRef is rejected at load`);
    }
  }
  if (problems.length === 0) return { ok: true, declared: declaredPaths.length };
  return {
    ok: false,
    problems,
    error: new CompatError(COMPAT_ERROR_CODES.INVALID_SECRET_DECLARATION, `invalid configContracts.secretInputs: ${problems.join("; ")}`, {
      details: { problems },
      hint: "Keep openclaw.plugin.json configContracts.secretInputs and configSchema in sync."
    })
  };
}

// ---------------------------------------------------------------------------
// Route + scope validation
// ---------------------------------------------------------------------------

export function validateRouteRegistration({ path, auth, match }) {
  const problems = [];
  if (typeof path !== "string" || !path.startsWith("/")) problems.push("path must be an absolute route path");
  if (!ROUTE_AUTH_VALUES.includes(auth)) problems.push(`auth must be one of ${ROUTE_AUTH_VALUES.join(", ")} (got ${JSON.stringify(auth)})`);
  if (match !== undefined && !ROUTE_MATCH_VALUES.includes(match)) problems.push(`match must be one of ${ROUTE_MATCH_VALUES.join(", ")} (got ${JSON.stringify(match)})`);
  if (problems.length === 0) return { ok: true };
  return {
    ok: false,
    error: new CompatError(COMPAT_ERROR_CODES.INVALID_ROUTE, `invalid HTTP route ${path}: ${problems.join("; ")}`, {
      details: { path, auth, match, problems },
      hint: "Use auth \"plugin\" (plugin-owned session) or \"gateway\" (gateway auth), and match \"exact\" or \"prefix\"."
    })
  };
}

export function validateGatewayScope(scope) {
  if (OPERATOR_SCOPES.includes(scope)) return { ok: true };
  return {
    ok: false,
    error: new CompatError(COMPAT_ERROR_CODES.INVALID_SCOPE, `unsupported gateway method scope ${JSON.stringify(scope)}`, {
      details: { scope, allowed: [...OPERATOR_SCOPES] },
      hint: "api.registerGatewayMethod accepts the public OperatorScope union; reserved core namespaces normalize to operator.admin."
    })
  };
}

/**
 * Defense-in-depth authorization seam for gateway RPC calls.
 *
 * The HOST is authoritative: api.registerGatewayMethod(..., { scope }) drives the real
 * enforcement, and REN-02 owns trusted-identity policy. This function exists so the plugin
 * can (a) never treat a model-supplied `actor_id`/`scope` in params as identity, and
 * (b) be unit-tested for the denial path before the host-level check is exercised.
 *
 * @returns {{allowed:true, source:string}|{allowed:false, error:CompatError}}
 */
export function authorizeGatewayCall({ requiredScope, trustedScopes, params }) {
  if (params && typeof params === "object" && ("actor_id" in params || "scope" in params || "scopes" in params)) {
    // Wire params are untrusted input: strip them from the authorization decision entirely.
    // (They stay untouched for the handler; they simply carry no authority.)
  }
  if (!Array.isArray(trustedScopes)) {
    return { allowed: true, source: "host-enforced" };
  }
  if (trustedScopes.includes("operator.admin") || trustedScopes.includes(requiredScope)) {
    return { allowed: true, source: "host-context" };
  }
  if (requiredScope === WRITE_SCOPE && trustedScopes.includes(READ_SCOPE)) {
    return {
      allowed: false,
      error: new CompatError(COMPAT_ERROR_CODES.FORBIDDEN, "write scope is required for this video-assets gateway method", {
        details: { requiredScope, trustedScopes },
        hint: "Re-authorize the gateway client with operator.write for asset/canvas mutations."
      })
    };
  }
  return {
    allowed: false,
    error: new CompatError(COMPAT_ERROR_CODES.FORBIDDEN, `missing required gateway scope ${requiredScope}`, {
      details: { requiredScope, trustedScopes }
    })
  };
}

/**
 * Read caller scopes from a trusted host context if the host exposes them.
 * Returns undefined when the host does not provide a trusted scope list, in which case
 * the host's own registration-scope enforcement is the only (and sufficient) authority.
 */
export function readTrustedScopes(handlerOptions) {
  const candidates = [handlerOptions?.trustedScopes, handlerOptions?.client?.scopes, handlerOptions?.client?.connect?.scopes, handlerOptions?.context?.scopes];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.every((entry) => typeof entry === "string")) return candidate;
  }
  return undefined;
}

/** The public SDK subpaths this plugin imports. Anything else is a compatibility defect. */
export const IMPORTED_SDK_SUBPATHS = Object.freeze(["openclaw/plugin-sdk/plugin-entry"]);

export const SDK_SURFACE_NOTES = Object.freeze({
  deprecatedOnHost: [
    "api.registerSessionExtension",
    "api.enqueueNextTurnInjection",
    "api.registerControlUiDescriptor",
    "api.registerRuntimeLifecycle",
    "api.registerAgentEventSubscription",
    "api.emitAgentEvent",
    "api.setRunContext",
    "api.getRunContext",
    "api.clearRunContext",
    "api.registerSessionSchedulerJob",
    "api.registerSessionAction",
    "api.sendSessionAttachment",
    "api.scheduleSessionTurn",
    "api.unscheduleSessionTurnsByTag"
  ],
  deprecatedSubpaths: [
    "openclaw/plugin-sdk/agent-runtime",
    "openclaw/plugin-sdk/cli-runtime",
    "openclaw/plugin-sdk/conversation-runtime",
    "openclaw/plugin-sdk/hook-runtime",
    "openclaw/plugin-sdk/media-runtime",
    "openclaw/plugin-sdk/plugin-runtime",
    "openclaw/plugin-sdk/security-runtime"
  ]
});
