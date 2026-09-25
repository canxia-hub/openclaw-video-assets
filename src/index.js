import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOperationSpecs, CONTRACT_TOOL_NAMES, allAdapterTargets } from "./contract/contract-surface-core.js";
import { LEGACY_ALIAS, CONTRACT_VERSION } from "./contract/registry.generated.js";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { VideoAssetService } from "./service.js";
// REN-09：工具 schema 的模型/分辨率/比例枚举统一由能力注册表派生，
// 使「注册表 → schema」单向可追溯；枚举内不再手工维护第二份清单。
import { schemaEnums } from "./capability-registry.js";
import { createGatewayRpcHandler } from "./gateway-rpc.js";
import {
  SecurityManager,
  applySecurityHeaders,
  clearSessionCookie,
  getRequestToken,
  readJsonBody,
  sendJson,
  setSessionCookie
} from "./security.js";
import { DEFAULT_BASE_PATH, ROUTE_SEGMENTS, createBasePathHelpers, resolveBasePath } from "./base-path.js";
import { buildTrustedContext, toolContextToTrustedContext, withTrustedContext } from "./provider-gateway.js";
import { DISPOSITION_ATTACHMENT, DISPOSITION_INLINE, descriptorFromResolved, sendMedia, sendStreamError } from "./protected-stream.js";
import { createUploadHandlers } from "./upload-routes.js";
import { GENERATION_ENTRY_POLICY, generationCoverageMatrix } from "./generation-policy.js";
// REN-11: the durable generation queue needs a real provider adapter, otherwise every deployment
// answers GENERATION_PROVIDER_UNAVAILABLE and "real generation" is only a claim. The adapter routes
// every call through the REN-02 gateway; a call without a trusted caller context fails closed.
import { createDreaminaCliJobAdapter } from "./dreamina-cli-job-adapter.js";
import { assertContractProviderParity as assertContractProviderParityCore } from "./generation-registry.js";
import {
  ADAPTER_VERSION,
  PLUGIN_ID,
  assertSupportedHost,
  beginRegistrationGeneration,
  describeRegistrationLedger,
  recordDisposal,
  requireRegistration,
  toStructuredError,
  validateContractsCoverage,
  validateGatewayScope,
  validateRouteRegistration,
  validateSecretInputDeclarations,
  validateToolInput,
  validateToolRegistration
} from "./sdk-compat.js";

let service;
// Which tool surface the current registration generation exposed. Set by registerTools() so the manifest
// coverage gate and the generation census judge the surface that was actually registered instead of
// assuming the legacy one.
let activeToolSurface = "legacy";
function toolSurfaceInUse() {
  return activeToolSurface === "contract" ? "contract" : "legacy";
}
let security;
let compatReport;
// REN-06: the streaming upload subsystem. The store is backed by the same SQLite handle as the rest of
// the repository, so an upload session and the asset it becomes are committed together.
let uploadStore = null;
let uploadGate = null;
let uploadHandlers = null;
let pluginGeneration = 0;
// REN-02: every external path derives from this one bundle (routes, cookie path, UI mount).
let paths = createBasePathHelpers(DEFAULT_BASE_PATH);
/**
 * Trusted context for a tool call, derived from the HOST tool factory context.
 *
 * The host resolves function tools per run and calls the factory with an `OpenClawPluginToolContext`
 * (`dist/tools-ch1s-pbT.mjs:124-125` -> `entry.factory(ctx)`; the type is declared in
 * `dist/agent-harness-runtime-BwRgV0uy.d.ts:1966-2024`). That context carries the run's agent id,
 * session and requester/owner bits, so it is the trusted identity source for this surface - never
 * `params.actor_id`.
 *
 * `TOOL_SURFACE_CONTEXT` remains the fallback for a host that does not populate the context (or an
 * older host that cannot accept a factory): the call is then explicitly UNATTRIBUTED and the policy
 * decides through `security.generation.unattributedPolicy` instead of inventing an identity.
 */
const TOOL_SURFACE_CONTEXT = buildTrustedContext({ surface: "tool", trusted: false, source: "unattributed" });
const registeredToolNames = new Set();
/** Evidence about the tool-identity seam, captured once per registration (read-only diagnostics). */
let toolSurfaceIdentity = null;
// REN-09：schema 枚举由能力注册表派生（单次求值 + 冻结），工具定义处不再写第二份清单。
const videoSchema = Object.freeze(schemaEnums({ kind: "video" }));
const imageSchema = Object.freeze({ ...schemaEnums({ kind: "image" }), imageResolutionTypes: schemaEnums({ kind: "image" }).resolution_type });
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.resolve(MODULE_DIR, "..", "openclaw.plugin.json");
const UI_DIST_DIR = path.resolve(MODULE_DIR, "..", "ui-dist");
const VIDEO_ASSETS_WIDGET_URI = "ui://widget/video-assets/canvas.html";
const VIDEO_ASSETS_WORKBENCH_URL = `${DEFAULT_BASE_PATH}/workbench/`;
const UI_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "视频资产库",
  description: "面向视频生产的项目资产库、制作画布与生成写回工具集。",
  register(api) {
    // Reload isolation: start a new registration generation and dispose state owned by the
    // previous one (repository handle + plugin sessions) before anything new is created.
    registeredToolNames.clear();
    pluginGeneration = beginRegistrationGeneration(PLUGIN_ID, { registrationMode: api?.registrationMode ?? null });
    disposePreviousPluginState("re-register", api.logger);

    compatReport = assertSupportedHost(api);
    api.logger.info?.(
      `[video-assets] sdk-compat generation=${pluginGeneration} adapter=v${ADAPTER_VERSION} host=${compatReport.hostVersion.raw ?? "unknown"}(${compatReport.hostVersion.source}) overall=${compatReport.overall}`
    );
    for (const diagnostic of compatReport.degraded) {
      api.logger.warn?.(
        `[video-assets] degraded capability "${diagnostic.capability}": ${diagnostic.reason}; fallback: ${diagnostic.fallback}`
      );
    }

    // REN-11: wire the real provider adapter for the generation queue. Default is the verified
    // Dreamina CLI path; `generationJobs.providerAdapter: "none"` disables it explicitly (useful for
    // a deployment that only runs local pipelines), and the download staging dir stays inside the
    // repository root so provider output can never be written outside the managed area.
    const generationJobsConfig = api.pluginConfig?.generationJobs ?? {};
    const providerAdapterEnabled = generationJobsConfig.providerAdapter !== "none";
    const providerDownloadRoot = path.join(
      api.pluginConfig?.repositoryRoot && String(api.pluginConfig.repositoryRoot).trim()
        ? String(api.pluginConfig.repositoryRoot).trim()
        : path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".openclaw-video-assets"),
      "asset-repo", "staging", "provider-downloads"
    );
    if (providerAdapterEnabled) fs.mkdirSync(providerDownloadRoot, { recursive: true });
    service = new VideoAssetService({
      pluginConfig: api.pluginConfig,
      logger: api.logger
    });
    // REN-02: one base path drives routes, the session cookie Path and the workbench mount.
    const basePath = resolveBasePath(api.pluginConfig ?? {});
    paths = createBasePathHelpers(basePath);
    if (basePath !== DEFAULT_BASE_PATH) {
      api.logger.warn?.(
        `[video-assets] basePath is ${basePath}; the prebuilt workbench bundle in ui-dist was compiled for ${DEFAULT_BASE_PATH}, so it must be rebuilt for this prefix (build: ui-src, see README).`
      );
    }
    security = new SecurityManager({ pluginConfig: api.pluginConfig, basePath });
    service.init();
    // The adapter is attached *after* init: it needs the live service (for the provider gateway,
    // ingest and writeback), and the queue is the object that receives it.
    if (providerAdapterEnabled) {
      service.setGenerationJobAdapter(createDreaminaCliJobAdapter({
        service,
        executable: generationJobsConfig.dreaminaCliPath ?? null,
        downloadRoot: providerDownloadRoot,
        pollIntervalMs: Number.isFinite(Number(generationJobsConfig.pollIntervalMs)) ? Number(generationJobsConfig.pollIntervalMs) : 5000,
        pollTimeoutMs: Number.isFinite(Number(generationJobsConfig.pollTimeoutMs)) ? Number(generationJobsConfig.pollTimeoutMs) : 300000,
        logger: api.logger
      }));
    }
    // REN-06: the service owns the upload store and gate, so the streaming route and the legacy staging
    // helper are bounded by the SAME policy instance. Deriving them here instead would create a second
    // copy of the limits, and a second copy is a bypass waiting to happen.
    uploadStore = service.uploadStore;
    uploadGate = service.uploadGate;
    uploadHandlers = createUploadHandlers({
      service,
      security,
      store: uploadStore,
      gate: uploadGate,
      policy: service.uploadPolicy
    });
    uploadStore.init().catch((error) => api.logger.warn?.(`[video-assets] upload store init failed: ${error?.message ?? error}`));
    if (!security.isConfigured()) {
      api.logger.warn?.("[video-assets] plugin auth is enabled but adminPasswordHash is not configured; HTTP login will reject requests.");
    }

    registerServiceLifecycle(api);
    service.setCanvasWidgetRuntimeSupport(registerNativeWidgetResource(api));
    toolSurfaceIdentity = describeToolFactorySupport(api);
    if (toolSurfaceIdentity.supported) {
      api.logger.info?.(
        `[video-assets] tool-factory seam in use (signal=${toolSurfaceIdentity.signal}, registerTool arity=${toolSurfaceIdentity.register_tool_arity}, registrationMode=${toolSurfaceIdentity.registration_mode ?? "n/a"}); every tool call carries the host-supplied run context`
      );
    } else {
      api.logger.warn?.(
        `[video-assets] host does not expose the tool-factory seam (signal=${toolSurfaceIdentity.signal}, registerTool arity=${toolSurfaceIdentity.register_tool_arity}, registrationMode=${toolSurfaceIdentity.registration_mode ?? "n/a"}); tools are registered statically and the tool surface stays unattributed`
      );
    }
    registerTools(api);
    registerRpc(api);
    registerConfigReloadPolicy(api);
    registerSecurityRoutes(api);
    registerUiApiRoute(api);
    registerSecureFileRoutes(api);
    registerUploadRoute(api);
    registerUiRoutes(api);
    assertManifestContracts(api);
    assertGenerationPolicyCoverage(api, toolSurfaceInUse());
    if (toolSurfaceInUse() === "contract") assertContractProviderParity(api);
  }
});

/**
 * Release host-owned resources held by the previous registration generation.
 * Without this, a host reload that reuses the plugin module instance would keep the old
 * SQLite handle open and would keep accepting plugin session cookies minted before the reload.
 */
function disposePreviousPluginState(reason, logger) {
  const hadState = Boolean(service || security);
  let closedRepository = false;
  let droppedSessions = null;
  try {
    if (service) {
      service.close?.();
      closedRepository = true;
    }
  } catch (error) {
    logger?.warn?.(`[video-assets] previous repository close failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    if (security) droppedSessions = security.disposeSessions?.() ?? null;
  } catch (error) {
    logger?.warn?.(`[video-assets] previous session disposal failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (hadState) {
    recordDisposal(PLUGIN_ID, reason);
    // Operator-visible release marker. Reload correctness otherwise has no observable signal at all,
    // which is exactly how a leaked repository handle or a surviving plugin session goes unnoticed.
    logger?.info?.(
      `[video-assets] released previous generation state (${reason}): repository_closed=${closedRepository} sessions_dropped=${droppedSessions?.sessions ?? 0} login_counters_dropped=${droppedSessions?.loginAttempts ?? 0}`
    );
  }
  service = undefined;
  security = undefined;
  return hadState;
}

/**
 * Service lifecycle registration.
 *
 * `reload.configPrefixes` is the host contract that lets a config edit under
 * plugins.entries.video-assets.config restart just this service instead of the gateway
 * (dist/config-reload-plan-U04DB8yk.mjs:228-231,255-261).
 */
function registerServiceLifecycle(api) {
  requireRegistration("service", "video-assets-repository");
  api.registerService({
    id: "video-assets-repository",
    reload: { configPrefixes: ["plugins.entries.video-assets.config"] },
    async start(ctx) {
      ctx.logger.info?.(`[video-assets] repository ready: ${service.root}`);
    },
    async stop() {
      service?.close();
    }
  });
}

/**
 * Declare how config changes affecting this plugin should be handled.
 * The host rejects an entirely empty registration (dist/loader-runtime-load-*.mjs:3127-3130),
 * so at least one prefix list must be non-empty.
 */
function registerConfigReloadPolicy(api) {
  if (typeof api?.registerReload !== "function") return;
  requireRegistration("reload-policy", "video-assets");
  api.registerReload({
    hotPrefixes: ["plugins.entries.video-assets.config"],
    restartPrefixes: [],
    noopPrefixes: []
  });
}

/**
 * Runtime gate: the manifest's contracts.tools is an admission list, not documentation —
 * the host silently skips any tool that is not declared (dist/loader-runtime-load-*.mjs:3923-3937).
 * Fail loudly at load instead.
 */
function assertManifestContracts(api) {
  const manifest = readOwnManifest();
  if (!manifest) {
    api.logger.warn?.("[video-assets] openclaw.plugin.json unreadable; contracts.tools coverage check skipped");
    return;
  }
  const coverage = validateContractsCoverage({
    declaredNames: manifest.contracts?.tools ?? [],
    registeredNames: [...registeredToolNames]
  });
  if (!coverage.ok) {
    api.logger.error?.(`[video-assets] ${coverage.error.message}`);
    throw coverage.error;
  }
  const secretPaths = manifest.configContracts?.secretInputs?.paths ?? [];
  const secretCheck = validateSecretInputDeclarations({ configSchema: manifest.configSchema, declaredPaths: secretPaths });
  if (!secretCheck.ok) {
    api.logger.error?.(
      `[video-assets] SecretRef metadata drift: ${secretCheck.problems.join("; ")}. SecretRef resolution may silently stop working; fix manifest configContracts/SecretRef schema together.`
    );
    compatReport = { ...compatReport, secretInputDeclaration: { ok: false, problems: secretCheck.problems } };
  } else if (compatReport) {
    compatReport = { ...compatReport, secretInputDeclaration: { ok: true, declared: secretCheck.declared } };
  }
  api.logger.info?.(`[video-assets] contracts.tools coverage ok: ${coverage.registered} tools`);
}

/**
 * REN-02: fail loudly when a registered tool or gateway method is not declared in the authoritative
 * census (`src/generation-registry.js`). The census replaced the earlier naming heuristic, which
 * only WARNED and therefore could not stop a new paid entry point whose name the regex missed
 * (review round 2, issue 4). Registration now stops on: an unclassified registered name, a
 * provider operation pointing at an unknown entry, an entry with no provider or no entry point, an
 * ambiguous name, or a mismatch between the census and the entry tables.
 */
function assertGenerationPolicyCoverage(api, surface = "legacy") {
  const matrix = generationCoverageMatrix({
    toolNames: [...registeredToolNames],
    rpcNames: Object.keys(allRpc()),
    surface
  });
  const fatal = [
    ...matrix.unclassified_names.map((name) => `unclassified registered name: ${name}`),
    ...matrix.entries_without_provider.map((entry) => `entry without provider: ${entry}`),
    ...matrix.ambiguous_names.map((item) => `name maps to several entries: ${item.name} -> ${item.entries.join(", ")}`),
    ...matrix.cross_check.map((item) => `census/entry mismatch: ${item}`)
  ];
  if (fatal.length > 0) {
    const error = new Error(`generation policy coverage is incomplete or ambiguous: ${fatal.join("; ")}`);
    api.logger.error?.(`[video-assets] ${error.message}`);
    throw error;
  }
  api.logger.info?.(
    `[video-assets] generation policy coverage ok (${surface} surface): ${matrix.entries.length} entries / ${matrix.provider_operations.length} provider operations (${matrix.classified_tools} tools, ${matrix.classified_rpc} rpc classified)`
  );
}

/**
 * REN-04: paid-path parity for the reduced surface.
 *
 * The contract census table is hand-written, so it could drift from the adapter. This derives the reachable
 * paid entry points from the adapter's own dispatch table and requires them to match the legacy provider
 * names exactly: merging seven generation tools into `video_generate` must not lose a paid path nor invent
 * one. Registration fails loudly on a mismatch, so the reduced surface cannot ship with a paid path
 * unaccounted for.
 */
function assertContractProviderParity(api) {
  const parity = assertContractProviderParityCore({ adapterTargets: allAdapterTargets() });
  if (!parity.ok) {
    const error = new Error(`contract paid-path parity failed: ${parity.problems.join("; ")}`);
    api.logger.error?.(`[video-assets] ${error.message}`);
    throw error;
  }
  api.logger.info?.(
    `[video-assets] contract paid-path parity ok: ${parity.reachable_provider_names.length} paid tool name(s) reachable across ${parity.reachable_entries.length} generation entry/entries`
  );
}

/**
 * Security diagnostics surfaced through the existing read-only dashboard RPC (no new route or RPC
 * method, so the REN-01 surface counts stay frozen). Contains no tokens, hashes or credentials.
 */
function securityDiagnostics() {
  const originPolicy = security?.originPolicy;
  return {
    base_path: paths.basePath,
    auth: security?.describe?.() ?? null,
    origin_policy_summary: originPolicy
      ? {
          mode: originPolicy.settings.mode,
          declared_origins: originPolicy.configuredOrigins().origins,
          declared_origin_source: originPolicy.configuredOrigins().source,
          derive_from_host: originPolicy.settings.deriveOriginFromHost,
          note: "declared_origins is the fixed allowlist; a request Host never adds to it (src/request-security.js declaredOrigins)"
        }
      : null,
    tool_surface_identity: toolSurfaceIdentity,
    generation: service?.providerGatewayStats?.() ?? null,
    recent_denials: (service?.providerGatewayDenials?.() ?? []).slice(-5).map((record) => ({
      at: record.at,
      entry: record.entry,
      surface: record.surface,
      code: record.code,
      actor_id: record.attribution?.actor_id ?? "unattributed",
      actor_source: record.attribution?.source ?? "unattributed"
    }))
  };
}

function readOwnManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    return null;
  }
}

/** Exposed for tests and diagnostics: last host compatibility report. */
export function getCompatReport() {
  return compatReport ?? null;
}

/** Exposed for tests and diagnostics: registration ledger snapshot (generations, counts). */
export function getRegistrationLedgerSnapshot() {
  return describeRegistrationLedger(PLUGIN_ID);
}

/** Exposed for tests and diagnostics: the live service instance of this registration generation.
 *  Read-only handle so an out-of-process check can observe the provider gateway (spy counting) without
 *  needing to re-create the plugin's service or touch any production configuration. */
export function getPluginService() {
  return service ?? null;
}

/** Exposed for tests and diagnostics: does this host expose the tool-factory identity seam? */
export function getToolSurfaceIdentity() {
  return toolSurfaceIdentity ?? null;
}

function registerToolDefinition(api, definition) {
  const check = validateToolRegistration({ name: definition.name, tool: definition, seenNames: registeredToolNames });
  if (!check.ok) {
    api.logger.error?.(`[video-assets] ${check.error.message}`);
    throw check.error;
  }
  requireRegistration("tool", definition.name);
  registeredToolNames.add(definition.name);
  // REN-02: register a FACTORY so the host supplies the trusted run context
  // (`OpenClawPluginToolContext`: agentId / sessionKey / sessionId / requesterSenderId /
  // senderIsOwner). The host resolves factories per run (`dist/tools-ch1s-pbT.mjs:124-125`), so the
  // identity attached to `execute` comes from the runtime, not from the model's arguments.
  if (supportsToolFactory(api)) {
    api.registerTool(
      (toolContext) => ({
        ...definition,
        execute: (toolCallId, args, signal, onUpdate) => definition.execute(toolCallId, args, signal, onUpdate, toolContext)
      }),
      { name: definition.name }
    );
    return;
  }
  api.registerTool(definition);
}

/**
 * Does this host accept a tool factory?
 *
 * The host API is `registerTool: (tool: AnyAgentTool | OpenClawPluginToolFactory, opts?)
 * => void` (`dist/agent-harness-runtime-BwRgV0uy.d.ts:14339`) and the loader resolves it with
 * `const factory = typeof tool === "function" ? tool : (_ctx) => tool`
 * (`dist/loader-runtime-load-BgaHcThS.mjs:3929`). Two runtime signals are checked here: the
 * function exists, and it accepts the options argument that a factory needs in order to supply its
 * name (for a function tool the host takes names from `opts.name`/`opts.names`, line 3927-3930).
 * When the signal is absent the plain tool is registered and the tool surface stays explicitly
 * unattributed - the degradation is logged, never silent. The end-to-end proof that the host really
 * populates the factory context is the isolated daemon scenario in `host-smoke/` (S15/S16).
 */
function supportsToolFactory(api) {
  if (typeof api?.registerTool !== "function") return false;
  // (tool, opts) hosts: unambiguous.
  if (api.registerTool.length >= 2) return true;
  // MEASURED 2026-09-21 in the isolated lane against this host: `api.registerTool.length === 0`
  // because the host exposes the registrar through a rest-args adapter, even though its loader DOES
  // resolve function tools per run
  // (`dist/loader-runtime-load-BgaHcThS.mjs:3929` -> `const factory = typeof tool === "function" ?
  // tool : (_ctx) => tool`, and the factory is invoked per run in `dist/tools-ch1s-pbT.mjs:124`).
  // The bundled browser plugin registers the factory form with no options argument at all.
  // Arity is therefore NOT a capability signal: requiring `>= 2` silently downgraded every real tool
  // call to `unattributed` (observed in run 20260921-g5-tool-identity-v4).
  //
  // The signal used instead is the modern plugin API surface that ships with that loader:
  // `registrationMode` (the api-builder that binds the factory-accepting registrar always sets it) or
  // the `registerToolMetadata` registrar. A host exposing neither keeps the static registration path.
  return typeof api?.registrationMode === "string" || typeof api?.registerToolMetadata === "function";
}

/** Records WHICH signal decided support, so the evidence names the reason and not just the verdict. */
function toolFactorySupportSignal(api, arity) {
  if (typeof api?.registerTool !== "function") return "no-registerTool";
  if (arity >= 2) return "registerTool-arity";
  if (typeof api?.registrationMode === "string") return "registrationMode";
  if (typeof api?.registerToolMetadata === "function") return "registerToolMetadata";
  return "none";
}

function describeToolFactorySupport(api) {
  const arity = typeof api?.registerTool === "function" ? api.registerTool.length : null;
  return {
    supported: supportsToolFactory(api),
    signal: toolFactorySupportSignal(api, arity),
    register_tool_arity: arity,
    registration_mode: typeof api?.registrationMode === "string" ? api.registrationMode : null,
    register_tool_metadata: typeof api?.registerToolMetadata === "function",
    evidence: "dist/agent-harness-runtime-BwRgV0uy.d.ts:14339 + dist/loader-runtime-load-BgaHcThS.mjs:3927-3930 (factory resolution) + dist/tools-ch1s-pbT.mjs:124 (per-run invocation); arity is measured, not assumed"
  };
}

/**
 * Build the trusted context for one tool call.
 *
 * The factory context is the only identity source on this surface. If the host did not populate it
 * (older host, or a call path without a run context), the call is reported as unattributed instead of
 * borrowing `params.actor_id`.
 */
function trustedContextForToolCall(toolContext) {
  if (!toolContext || typeof toolContext !== "object") return TOOL_SURFACE_CONTEXT;
  const hasIdentity = (typeof toolContext.agentId === "string" && toolContext.agentId.trim() !== "") ||
    (typeof toolContext.requesterSenderId === "string" && toolContext.requesterSenderId.trim() !== "");
  if (!hasIdentity) return TOOL_SURFACE_CONTEXT;
  return toolContextToTrustedContext(toolContext, { surface: "tool" });
}

function registerHttpRouteChecked(api, params) {
  const check = validateRouteRegistration({ path: params.path, auth: params.auth, match: params.match });
  if (!check.ok) {
    api.logger.error?.(`[video-assets] ${check.error.message}`);
    throw check.error;
  }
  requireRegistration("http-route", `${params.match ?? "exact"} ${params.path}`);
  api.registerHttpRoute(params);
}

function registerNativeWidgetResource(api) {
  const attemptedApis = [];
  requireRegistration("widget-resource", "canvas-widget");
  const diagnostics = [];
  const html = readNativeWidgetHtml();
  const candidates = [
    { name: "registerAppResource", build: () => [{ uri: VIDEO_ASSETS_WIDGET_URI, mimeType: "text/html", text: html }] },
    { name: "registerResource", build: () => [{ uri: VIDEO_ASSETS_WIDGET_URI, mimeType: "text/html", text: html }] },
    { name: "registerUiResource", build: () => [{ uri: VIDEO_ASSETS_WIDGET_URI, mimeType: "text/html", text: html }] },
    { name: "registerWidgetResource", build: () => [{ uri: VIDEO_ASSETS_WIDGET_URI, mimeType: "text/html", text: html }] }
  ];

  for (const candidate of candidates) {
    const register = api?.[candidate.name];
    if (typeof register !== "function") continue;
    attemptedApis.push(candidate.name);
    try {
      register.apply(api, candidate.build());
      api.logger.info?.(`[video-assets] native canvas widget resource registered through ${candidate.name}: ${VIDEO_ASSETS_WIDGET_URI}`);
      return {
        nativeResource: true,
        resourceRegistration: candidate.name,
        fallback: "protected_workbench_route",
        resourceUri: VIDEO_ASSETS_WIDGET_URI,
        fallbackUrl: VIDEO_ASSETS_WORKBENCH_URL,
        attemptedApis,
        diagnostics
      };
    } catch (error) {
      diagnostics.push(`${candidate.name}: ${error instanceof Error ? error.message : String(error)}`);
      api.logger.warn?.(`[video-assets] native widget resource registration failed through ${candidate.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!attemptedApis.length) diagnostics.push("No registerAppResource/registerResource/registerUiResource/registerWidgetResource function was exposed by the current OpenClaw plugin API.");
  return {
    nativeResource: false,
    resourceRegistration: "not_available_in_current_openclaw_plugin_api",
    fallback: "protected_workbench_route",
    resourceUri: VIDEO_ASSETS_WIDGET_URI,
    fallbackUrl: VIDEO_ASSETS_WORKBENCH_URL,
    attemptedApis,
    diagnostics
  };
}

function readNativeWidgetHtml() {
  const indexPath = path.join(UI_DIST_DIR, "index.html");
  if (!fs.existsSync(indexPath)) {
    return [
      "<!doctype html>",
      "<html><head><meta charset=\"UTF-8\"><title>视频资产画布</title></head>",
      "<body><p>视频资产画布界面构建缺失，请打开受保护的工作台备用界面。</p></body></html>"
    ].join("");
  }
  return fs.readFileSync(indexPath, "utf8");
}

// 工具注册名是插件契约，必须保持英文；这里统一规范工具发现、说明与汇报层的中文名称。
const TOOL_DISPLAY_NAMES = {
  video_asset_ingest: "素材入库",
  video_asset_search: "搜索素材",
  video_asset_get: "读取素材详情",
  video_asset_update_metadata: "更新素材元数据",
  video_asset_update_rights: "更新授权与风险",
  video_asset_create_version: "创建素材版本",
  video_asset_create_branch: "创建素材分支",
  video_asset_save_copy: "保存受管副本",
  video_asset_lineage: "查看素材谱系",
  video_asset_register_derived_file: "登记派生文件",
  video_asset_generate_derived_file: "生成派生文件",
  video_asset_derived_files: "列出派生文件",
  video_asset_integrity_scan: "扫描素材库完整性",
  video_asset_classify: "标注素材分类",
  video_asset_get_classification: "读取素材分类",
  video_asset_taxonomy_report: "生成分类连续性报告",
  video_entity_create: "创建制作实体",
  video_entity_search: "搜索制作实体",
  video_entity_link_asset: "关联实体与素材",
  video_asset_annotate: "添加素材批注",
  video_asset_annotations: "列出素材批注",
  video_asset_update_annotation: "更新素材批注",
  video_project_create: "创建视频项目",
  video_project_update_spec: "更新项目规格",
  video_project_add_asset_ref: "添加项目素材引用",
  video_project_update_asset_ref: "更新项目素材引用",
  video_project_remove_asset_ref: "移除项目素材引用",
  video_project_refs: "列出项目素材引用",
  video_project_asset_report: "生成项目素材报告",
  video_project_continuity_report: "生成项目连续性报告",
  video_canvas_create: "创建制作画布",
  video_canvas_search: "搜索制作画布",
  video_canvas_apply_production_template: "套用制作画布模板",
  video_canvas_get: "读取制作画布",
  video_canvas_save_snapshot: "保存画布快照",
  video_canvas_upsert_shape: "创建或更新画布卡片",
  video_canvas_create_generation_slot: "创建画布生成槽",
  video_canvas_update_generation_slot: "更新画布生成槽",
  video_canvas_delete_shape: "移除画布卡片",
  video_canvas_link_shapes: "连接画布卡片",
  video_canvas_unlink_shapes: "取消画布连接",
  video_canvas_agent_context: "读取画布协作上下文",
  video_canvas_widget_context: "读取画布组件上下文",
  render_video_assets_canvas_widget: "渲染视频资产画布",
  video_canvas_save_selection: "保存画布选择",
  video_canvas_get_selection: "读取画布选择",
  video_canvas_save_view_state: "保存画布视图",
  video_canvas_get_view_state: "读取画布视图",
  video_canvas_generation_package: "生成准备包",
  video_canvas_generation_handoff: "生成交接包",
  video_canvas_export_annotation_brief: "导出批注简报",
  video_canvas_register_review_annotation: "登记审片批注",
  video_canvas_create_revision_card: "创建返修卡",
  video_canvas_update_revision_card_status: "更新返修卡状态",
  video_canvas_insert_generated_asset: "插入生成资产",
  video_canvas_fill_generation_slot: "填入画布生成槽",
  video_audio_doubao_plan: "生成豆包音频请求计划",
  video_audio_doubao_generate: "执行豆包音频生成",
  video_canvas_doubao_audio_plan: "生成画布豆包音频计划",
  video_canvas_doubao_audio_generate: "执行画布豆包音频生成",
  video_audio_kie_suno_plan: "生成 KIE Suno 请求计划",
  video_audio_kie_suno_generate: "执行 KIE Suno 生成",
  video_canvas_kie_suno_audio_plan: "生成画布 KIE Suno 计划",
  video_canvas_kie_suno_audio_generate: "执行画布 KIE Suno 生成",
  video_canvas_dreamina_cli_plan: "生成即梦命令计划",
  video_canvas_dreamina_cli_generate_video: "执行即梦视频生成",
  video_canvas_dreamina_cli_generate_image: "执行即梦图像生成",
  video_canvas_dreamina_cli_upscale_image: "执行即梦图像放大",
  video_canvas_lint: "检查画布生产就绪度"
};

const TOOL_DESCRIPTIONS_ZH = {
  video_asset_ingest: "将本地文件导入视频资产库。",
  video_asset_search: "按文本和基础筛选条件搜索视频素材。",
  video_asset_get: "读取素材、版本和分支详情。",
  video_asset_update_metadata: "修订素材标题、描述和标签，不改动媒体文件或版本谱系。",
  video_asset_update_rights: "更新素材授权状态、风险等级并追加来源证据。",
  video_asset_create_version: "基于变更说明创建新的素材版本。",
  video_asset_create_branch: "从指定素材版本创建分支。",
  video_asset_save_copy: "从既有素材版本保存受管副本。",
  video_asset_lineage: "查看素材分支、版本和上下游关系。",
  video_asset_register_derived_file: "登记缩略图、代理文件、转码、字幕或其他派生文件。",
  video_asset_generate_derived_file: "生成缩略图或代理文件并登记为派生文件。",
  video_asset_derived_files: "列出素材或素材版本的派生文件。",
  video_asset_integrity_scan: "扫描素材元数据、源文件、派生文件和项目引用完整性。",
  video_asset_classify: "使用受控生产分类体系标注素材或素材版本。",
  video_asset_get_classification: "读取素材分类和实体关联。",
  video_asset_taxonomy_report: "扫描素材库中的分类、实体关联和关键批注缺口。",
  video_entity_create: "创建角色、场景、服装、道具等制作实体。",
  video_entity_search: "按键名、名称、别名、类型或项目搜索制作实体。",
  video_entity_link_asset: "把素材或素材版本关联到制作实体。",
  video_asset_annotate: "向素材、素材版本、实体或项目引用添加结构化批注。",
  video_asset_annotations: "列出指定对象的结构化批注。",
  video_asset_update_annotation: "更新既有批注或调整批注状态。",
  video_project_create: "创建视频项目记录。",
  video_project_update_spec: "更新项目输出规格，供画布生成交接使用。",
  video_project_add_asset_ref: "向项目添加素材版本引用。",
  video_project_update_asset_ref: "更新既有项目素材引用。",
  video_project_remove_asset_ref: "软移除项目素材引用。",
  video_project_refs: "列出项目素材引用。",
  video_project_asset_report: "生成项目素材依赖和风险报告。",
  video_project_continuity_report: "检查项目分类、实体关联和批注连续性风险。",
  video_canvas_create: "创建项目制作画布。",
  video_canvas_search: "搜索项目制作画布。",
  video_canvas_apply_production_template: "套用包含阶段分区、项目引用、实体和生成槽的制作模板。",
  video_canvas_get: "读取制作画布及其卡片和连线。",
  video_canvas_save_snapshot: "保存画布视口或文档快照。",
  video_canvas_upsert_shape: "创建或更新画布卡片，不改动底层素材。",
  video_canvas_create_generation_slot: "创建带目标尺寸、比例、时长和必需参考的画布生成槽。",
  video_canvas_update_generation_slot: "更新画布生成槽的目标规格或流程状态。",
  video_canvas_delete_shape: "从画布移除卡片，不删除素材库资产。",
  video_canvas_link_shapes: "创建或更新两个画布卡片之间的关系连线。",
  video_canvas_unlink_shapes: "删除画布关系连线。",
  video_canvas_agent_context: "返回可供协作方读取的画布上下文、可见卡片、离屏分组和检查问题。",
  video_canvas_widget_context: "返回画布组件可用的上下文、选择状态和视图状态。",
  render_video_assets_canvas_widget: "返回视频资产无限画布的原生组件渲染描述。",
  video_canvas_save_selection: "保存临时画布选择状态，不创建审计提交。",
  video_canvas_get_selection: "读取当前临时画布选择状态。",
  video_canvas_save_view_state: "保存临时画布视口状态，不创建审计提交。",
  video_canvas_get_view_state: "读取当前临时画布视口状态。",
  video_canvas_generation_package: "从制作画布构建生成准备输入包。",
  video_canvas_generation_handoff: "从制作画布构建可执行的生成交接包。",
  video_canvas_export_annotation_brief: "从画布卡片构建审片批注或返修规划简报。",
  video_canvas_register_review_annotation: "在选中素材、版本、实体或项目引用上登记画布审片批注。",
  video_canvas_create_revision_card: "基于审片批注或生成输出谱系创建画布返修卡。",
  video_canvas_update_revision_card_status: "更新画布返修卡流程状态，不改动来源批注或输出谱系。",
  video_canvas_insert_generated_asset: "导入生成文件，加入项目，并写回到生成槽旁边。",
  video_canvas_fill_generation_slot: "按先入库再写回的默认策略，用生成文件填入画布生成槽。",
  video_audio_doubao_plan: "构建豆包音频生成 1.0 标准请求包，不调用模型，不消耗成本。",
  video_audio_doubao_generate: "执行豆包音频生成，平台审核通过后入库（授权默认 unknown）",
  video_canvas_doubao_audio_plan: "从画布音频生成槽构建豆包音频请求包，不调用模型。",
  video_canvas_doubao_audio_generate: "从画布音频生成槽执行豆包音频生成，入库后写回画布。",
  video_audio_kie_suno_plan: "构建 KIE Suno API 音乐/歌曲生成请求包，不提交任务。",
  video_audio_kie_suno_generate: "执行 KIE Suno API 音乐/歌曲生成，下载后按授权未知状态入库。",
  video_canvas_kie_suno_audio_plan: "从画布音频生成槽构建 KIE Suno 请求包，不提交任务。",
  video_canvas_kie_suno_audio_generate: "从画布音频生成槽执行 KIE Suno 生成，入库后写回画布。",
  video_canvas_dreamina_cli_plan: "从画布交接包构建即梦命令执行计划，不消耗积分。",
  video_canvas_dreamina_cli_generate_video: "依据画布交接包执行即梦视频生成，并严格校验视频模型参数。",
  video_canvas_dreamina_cli_generate_image: "依据画布交接包执行即梦图像生成（含 Seedream 5.0Pro），并严格校验图像模型参数。",
  video_canvas_dreamina_cli_upscale_image: "对指定素材版本执行即梦图像放大（image_upscale，2k/4k/8k），可选写回画布。",
  video_canvas_lint: "检查画布绑定缺口和生产就绪度警告。"
};

function localizedToolDescription(name, fallback) {
  const displayName = TOOL_DISPLAY_NAMES[name];
  const description = TOOL_DESCRIPTIONS_ZH[name] ?? fallback;
  return displayName ? `${displayName}：${description}` : description;
}

function doubaoAudioToolSchema({ includeCanvas }) {
  return {
    project_id: { type: "string" },
    ...(includeCanvas ? {
      canvas_id: { type: "string" },
      slot_shape_id: { type: "string" }
    } : {}),
    prompt_text: { type: "string" },
    video_linkage_block: { type: "string" },
    purpose: { type: "string" },
    model_id: { type: "string" },
    api_model_id: { type: "string" },
    adapter_version: { type: "string" },
    language: { type: "string" },
    char_limit: { type: "number" },
    duration_seconds: { type: "number" },
    output_format: { type: "string", enum: ["wav", "mp3", "pcm", "ogg_opus"] },
    sample_rate: { type: "number" },
    speech_rate: { type: "number" },
    loudness_rate: { type: "number" },
    pitch_rate: { type: "number" },
    enable_subtitle: { type: "boolean" },
    channels: { type: "number" },
    seed: { type: "number" },
    backend: { type: "string", enum: ["mock", "api"] },
    execute: { type: "boolean" },
    accept_cost: { type: "boolean" },
    accept_credit_spend: { type: "boolean" },
    timeout_ms: { type: "number" },
    output_dir: { type: "string" },
    download_outputs: { type: "boolean" },
    ingest_outputs: { type: "boolean" },
    writeback_canvas: { type: "boolean" },
    output_title: { type: "string" },
    title: { type: "string" },
    kind: { type: "string", enum: ["raw", "working"] },
    tags: { type: "array", items: { type: "string" } },
    voices: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true
      }
    },
    timeline: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true
      }
    },
    sound_layers: { type: "object", additionalProperties: true },
    references: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          speaker: { type: "string" },
          audio_data: { type: "string" },
          audio_url: { type: "string" },
          image_data: { type: "string" },
          image_url: { type: "string" }
        }
      }
    },
    audio_config: {
      type: "object",
      additionalProperties: false,
      properties: {
        format: { type: "string", enum: ["wav", "mp3", "pcm", "ogg_opus"] },
        sample_rate: { type: "number" },
        speech_rate: { type: "number" },
        loudness_rate: { type: "number" },
        pitch_rate: { type: "number" },
        enable_subtitle: { type: "boolean" }
      }
    },
    watermark: {
      type: "object",
      additionalProperties: false,
      properties: {
        aigc_watermark: { type: "boolean" },
        aigc_metadata: {
          type: "object",
          additionalProperties: false,
          properties: {
            enable: { type: "boolean" },
            content_producer: { type: "string" },
            produce_id: { type: "string" },
            content_propagator: { type: "string" },
            propagate_id: { type: "string" }
          }
        }
      }
    },
    provider_parameters: { type: "object", additionalProperties: true },
    classification: { type: "object", additionalProperties: true },
    project_ref: { type: "object", additionalProperties: true },
    actor_id: { type: "string" },
    actor_type: { type: "string" }
  };
}

function kieSunoToolSchema({ includeCanvas }) {
  return {
    project_id: { type: "string" },
    ...(includeCanvas ? {
      canvas_id: { type: "string" },
      slot_shape_id: { type: "string" }
    } : {}),
    endpoint: { type: "string" },
    intent: { type: "string" },
    slug: { type: "string" },
    stage: { type: "string" },
    scene: { type: "string" },
    shot_id: { type: "string" },
    timecode: { type: "string" },
    target_duration: { type: "string" },
    duration_seconds: { type: "number" },
    platform: { type: "string" },
    model: { type: "string", enum: ["V4", "V4_5", "V4_5PLUS", "V4_5ALL", "V5", "V5_5"] },
    customMode: { type: "boolean" },
    instrumental: { type: "boolean" },
    prompt: { type: "string" },
    lyrics: { type: "string" },
    style: { type: "string" },
    title: { type: "string" },
    output_title: { type: "string" },
    negativeTags: { type: "string" },
    negative_tags: { type: "string" },
    callBackUrl: { type: "string" },
    callback_url: { type: "string" },
    vocalGender: { type: "string", enum: ["m", "f"] },
    track_role: { type: "string", enum: ["music", "song", "instrumental", "vocal", "stem", "wav", "lyrics", "mv", "reference", "test"] },
    dialogue_priority: { type: "string" },
    mix_priority: { type: "string" },
    downstream_target: { type: "string" },
    review_notes: { type: "string" },
    input_rights: { type: "string", enum: ["unknown", "cleared", "restricted", "rejected"] },
    output_rights: { type: "string", enum: ["unknown", "cleared", "restricted", "rejected"] },
    speaker_or_voice_consent: { type: "string" },
    rights_notes: { type: "string" },
    backend: { type: "string", enum: ["mock", "api"] },
    execute: { type: "boolean" },
    accept_cost: { type: "boolean" },
    accept_credit_spend: { type: "boolean" },
    timeout_ms: { type: "number" },
    poll_result: { type: "boolean" },
    poll_interval_seconds: { type: "number" },
    output_dir: { type: "string" },
    download_outputs: { type: "boolean" },
    ingest_outputs: { type: "boolean" },
    writeback_canvas: { type: "boolean" },
    kind: { type: "string", enum: ["raw", "working"] },
    tags: { type: "array", items: { type: "string" } },
    classification: { type: "object", additionalProperties: true },
    project_ref: { type: "object", additionalProperties: true },
    provider_parameters: { type: "object", additionalProperties: true },
    actor_id: { type: "string" },
    actor_type: { type: "string" }
  };
}

function registerTools(api) {
  // ----------------------------------------------------------------------------------------------
  // REN-04: reduced contract surface.
  //
  // When the tool surface is configured as "contract", the plugin registers the 16 typed domain
  // operations from src/contract/contract-surface-core.js instead of the 69 original registrations below.
  // The registration runs against THIS same `service` instance, so the reduced surface shares the
  // repository handle, the security manager, the HTTP routes, the RPC registration and the identity /
  // generation-registry logic that live inside the service methods - it is not a parallel stub registry.
  //
  // Default is "legacy", so the REN-02 security candidate keeps its exact original behaviour unless the
  // contract surface is explicitly selected, and the legacy registrations below stay the rollback path.
  // ----------------------------------------------------------------------------------------------
  // The surface DEFAULTS to whatever the packaged manifest declares. openclaw.plugin.json is a runtime
  // admission list whose path is fixed per package (src/index.js:61), so a package ships ONE surface; and
  // assertManifestContracts() throws on any registered/declared disagreement (measured: selecting the
  // contract surface against the 69-tool manifest produced "0 registered-but-undeclared, 69
  // declared-but-unregistered"). Deriving the default from the manifest therefore removes the desync class
  // entirely, while an explicit toolSurface still can force a surface - and then fails loudly rather than
  // silently exposing the wrong tool list.
  const declaredToolNames = readOwnManifest()?.contracts?.tools ?? [];
  const manifestWantsContract =
    declaredToolNames.length === CONTRACT_TOOL_NAMES.length &&
    CONTRACT_TOOL_NAMES.every((n) => declaredToolNames.includes(n));
  const configuredSurface = api.pluginConfig?.toolSurface ?? (manifestWantsContract ? "contract" : "legacy");
  activeToolSurface = configuredSurface;

  if (configuredSurface === "contract") {
    // Register through the SAME path the legacy tools use: `tool()` builds the definition (input validation,
    // trusted-context plumbing, structured failure envelope) and `registerToolDefinition` performs the
    // admission checks, records the name in registeredToolNames (which the manifest coverage check and the
    // generation census both read) and registers a FACTORY so the host supplies the trusted run context.
    //
    // The first attempt registered raw `{ handler }` objects straight onto api.registerTool, which skipped
    // all of that: the probe showed 16 registrations with execute_count=0 and factory_count=0, the name set
    // stayed empty, and the trusted identity was never carried.
    const specs = buildOperationSpecs(service);
    for (const spec of specs) {
      const definition = tool(spec.name, spec.description, spec.properties, spec.handler, spec.required);
      // catalogMode is declared on the tool definition, not passed sideways, so the resident operations
      // stay directly visible while the on-demand ones remain catalog-discoverable.
      registerToolDefinition(api, spec.resident ? { ...definition, catalogMode: "direct-only" } : definition);
    }
    api.logger.info?.(
      `[video-assets] toolSurface=contract: ${specs.length} operations registered through registerToolDefinition; ${Object.keys(LEGACY_ALIAS).length} legacy tool name(s) remain callable through the migration adapter (contract ${CONTRACT_VERSION})`
    );
    return;
  }
  if (configuredSurface !== "legacy") {
    // Unknown value: refuse to guess which surface to expose. Registering the wrong surface silently would
    // be worse than failing loudly, because the tool list is the model's whole view of this plugin.
    api.logger.error?.(`[video-assets] unknown toolSurface "${configuredSurface}"; expected "legacy" or "contract". Registering no tools.`);
    return;
  }
  registerToolDefinition(api, tool("video_asset_ingest", "Import a local file into the video asset repository.", {
    file_path: { type: "string" },
    kind: { type: "string", enum: ["raw", "working"] },
    title: { type: "string", minLength: 1, maxLength: 512 },
    description: { type: "string", maxLength: 65536 },
    tags: { type: "array", maxItems: 64, items: { type: "string", maxLength: 128 } },
    source: {
      type: "object",
      additionalProperties: false,
      properties: {
        source_type: { type: "string" },
        url: { type: "string" },
        notes: { type: "string" }
      }
    }
  }, (args) => service.ingestAsset(args)));

  registerToolDefinition(api, tool("video_asset_search", "Search video assets by text and basic filters.", {
    query: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    offset: { type: "integer", minimum: 0, maximum: 100000 }
  }, (args) => service.searchAssets(args)));

  registerToolDefinition(api, tool("video_asset_get", "Get an asset with versions and branches.", {
    asset_id: { type: "string" }
  }, (args) => service.getAsset(args)));

  registerToolDefinition(api, tool("video_asset_update_metadata", "Update asset title, description, and tags without changing media versions.", {
    asset_id: { type: "string" },
    title: { type: "string", minLength: 1, maxLength: 512 },
    description: { type: "string", maxLength: 65536 },
    tags: { type: "array", maxItems: 64, items: { type: "string", maxLength: 128 } },
    notes: { type: "string" }
  }, (args) => service.updateAssetMetadata(args), ["asset_id"]));

  registerToolDefinition(api, tool("video_asset_update_rights", "Update asset license/risk status and append source rights evidence.", {
    asset_id: { type: "string" },
    license_status: { type: "string", enum: ["unknown", "cleared", "restricted", "rejected"] },
    risk_level: { type: "string", enum: ["unknown", "low", "medium", "high"] },
    notes: { type: "string" },
    source: {
      type: "object",
      additionalProperties: false,
      properties: {
        source_type: { type: "string" },
        url: { type: "string" },
        captured_at: { type: "string" },
        original_author: { type: "string" },
        license_hint: { type: "string" },
        retrieval_method: { type: "string" },
        notes: { type: "string" }
      }
    }
  }, (args) => service.updateAssetRights(args)));

  registerToolDefinition(api, tool("video_asset_create_version", "Create a new asset version. change_items is required.", {
    asset_id: { type: "string" },
    file_path: { type: "string" },
    change_summary: { type: "string" },
    change_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: { type: "string" },
          summary: { type: "string" },
          before: {},
          after: {},
          tool: { type: "string" },
          parameters: { type: "object", additionalProperties: true }
        }
      }
    },
    branch_id: { type: "string" },
    parent_version_id: { type: "string" },
    set_as_default: { type: "boolean" }
  }, (args) => service.createVersion(args)));

  registerToolDefinition(api, tool("video_asset_create_branch", "Create a branch from an asset version.", {
    asset_id: { type: "string" },
    base_version_id: { type: "string" },
    name: { type: "string" },
    description: { type: "string" }
  }, (args) => service.createBranch(args)));

  registerToolDefinition(api, tool("video_asset_save_copy", "Save a managed copy from an existing asset version.", {
    source_asset_id: { type: "string" },
    source_version_id: { type: "string" },
    copy_type: { type: "string", enum: ["snapshot_copy", "working_copy", "project_copy", "export_copy"] },
    target_project_id: { type: "string" },
    title: { type: "string" },
    reason: { type: "string" }
  }, (args) => service.saveCopy(args)));

  registerToolDefinition(api, tool("video_asset_lineage", "Inspect asset lineage: branches, versions, incoming and outgoing relations.", {
    asset_id: { type: "string" }
  }, (args) => service.lineage(args)));

  registerToolDefinition(api, tool("video_asset_register_derived_file", "Register a thumbnail, proxy, transcode, subtitle, or other derived file for an asset version.", {
    asset_id: { type: "string" },
    asset_version_id: { type: "string" },
    file_path: { type: "string" },
    derivative_type: { type: "string", enum: ["thumbnail", "proxy", "transcode", "audio_proxy", "subtitle", "waveform", "contact_sheet", "metadata", "other"] },
    profile: { type: "string" },
    metadata: { type: "object", additionalProperties: true }
  }, (args) => service.registerDerivedFile(args)));

  registerToolDefinition(api, tool("video_asset_generate_derived_file", "Generate a thumbnail or proxy from an asset version and register it as a derived file.", {
    asset_id: { type: "string" },
    asset_version_id: { type: "string" },
    derivative_type: { type: "string", enum: ["thumbnail", "proxy", "transcode"] },
    profile: { type: "string" },
    width: { type: "number" },
    crf: { type: "number" },
    preset: { type: "string", enum: ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"] },
    seek_seconds: { type: "number" },
    max_duration_seconds: { type: "number" },
    metadata: { type: "object", additionalProperties: true }
  }, (args) => service.generateDerivedFile(args)));

  registerToolDefinition(api, tool("video_asset_derived_files", "List registered derived files for an asset or asset version.", {
    asset_id: { type: "string" },
    asset_version_id: { type: "string" },
    derivative_type: { type: "string", enum: ["thumbnail", "proxy", "transcode", "audio_proxy", "subtitle", "waveform", "contact_sheet", "metadata", "other"] },
    include_inactive: { type: "boolean" }
  }, (args) => service.listDerivedFiles(args)));

  registerToolDefinition(api, tool("video_asset_integrity_scan", "Scan repository metadata, source objects, derived files, and project refs for integrity issues.", {
    deep: { type: "boolean" }
  }, (args) => service.integrityScan(args)));

  registerToolDefinition(api, tool("video_asset_classify", "Classify an asset or asset version with controlled production taxonomy.", {
    asset_id: { type: "string" },
    asset_version_id: { type: "string" },
    domain: { type: "string", enum: ["character", "scene", "costume", "prop", "audio", "reference", "prompt", "document", "delivery", "other"] },
    type: { type: "string" },
    subtype: { type: "string" },
    confidence: { type: "string", enum: ["confirmed", "candidate", "inferred"] },
    source: { type: "string", enum: ["manual", "agent", "import", "migration"] }
  }, (args) => service.classifyAsset(args)));

  registerToolDefinition(api, tool("video_asset_get_classification", "Get asset taxonomy classifications and entity links.", {
    asset_id: { type: "string" },
    asset_version_id: { type: "string" }
  }, (args) => service.getAssetClassification(args)));

  registerToolDefinition(api, tool("video_asset_taxonomy_report", "Scan the asset library for missing taxonomy, entity links, and key annotations.", {
    include_archived: { type: "boolean" },
    limit: { type: "number" }
  }, (args) => service.assetTaxonomyReport(args)));

  registerToolDefinition(api, tool("video_entity_create", "Create a production entity such as a character, scene, costume, or prop.", {
    entity_key: { type: "string" },
    entity_type: { type: "string", enum: ["character", "scene", "costume", "prop", "organization", "style", "other"] },
    canonical_name: { type: "string" },
    aliases: { type: "array", items: { type: "string" } },
    description: { type: "string" },
    project_id: { type: "string" },
    status: { type: "string", enum: ["draft", "active", "locked", "archived"] }
  }, (args) => service.createEntity(args)));

  registerToolDefinition(api, tool("video_entity_search", "Search production entities by key, name, alias, type, or project.", {
    query: { type: "string" },
    entity_type: { type: "string" },
    project_id: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    offset: { type: "integer", minimum: 0, maximum: 100000 }
  }, (args) => service.searchEntities(args)));

  registerToolDefinition(api, tool("video_entity_link_asset", "Link an asset or asset version to a production entity.", {
    asset_id: { type: "string" },
    asset_version_id: { type: "string" },
    entity_id: { type: "string" },
    entity_key: { type: "string" },
    relation_type: { type: "string", enum: ["depicts", "costume_for", "prop_for", "scene_for", "style_for", "voice_for", "reference_for"] },
    confidence: { type: "string", enum: ["confirmed", "candidate", "inferred"] },
    notes: { type: "string" }
  }, (args) => service.linkEntityAsset(args)));

  registerToolDefinition(api, tool("video_asset_annotate", "Add a structured annotation to an asset, asset version, entity, or project reference.", {
    target_type: { type: "string", enum: ["asset", "asset_version", "entity", "project_ref"] },
    target_id: { type: "string" },
    annotation_type: { type: "string", enum: ["character_profile", "scene_concept", "costume_spec", "prop_function", "visual_continuity", "source_rights", "production_note", "review_note", "prompt_note", "other"] },
    title: { type: "string" },
    body: { type: "string" },
    structured: { type: "object", additionalProperties: true },
    visibility: { type: "string", enum: ["internal", "project", "public_summary"] }
  }, (args) => service.annotateAsset(args)));

  registerToolDefinition(api, tool("video_asset_annotations", "List annotations for an asset, asset version, entity, or project reference.", {
    target_type: { type: "string", enum: ["asset", "asset_version", "entity", "project_ref"] },
    target_id: { type: "string" },
    include_archived: { type: "boolean" }
  }, (args) => service.listAnnotations(args)));

  registerToolDefinition(api, tool("video_asset_update_annotation", "Update an existing annotation or change its status.", {
    annotation_id: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    structured: { type: "object", additionalProperties: true },
    status: { type: "string", enum: ["draft", "active", "superseded", "resolved", "archived"] },
    visibility: { type: "string", enum: ["internal", "project", "public_summary"] }
  }, (args) => service.updateAnnotation(args)));

  registerToolDefinition(api, tool("video_project_create", "Create a video project record.", {
    title: { type: "string" },
    description: { type: "string" },
    target_platforms: { type: "array", items: { type: "string" } },
    aspect_ratio: { type: "string" },
    resolution: { type: "string" },
    fps: { type: "number" }
  }, (args) => service.createProject(args)));

  registerToolDefinition(api, tool("video_project_update_spec", "Update project output targets used by canvas generation handoff.", {
    project_id: { type: "string" },
    target_platforms: { type: "array", items: { type: "string" } },
    aspect_ratio: { type: "string" },
    resolution: { type: "string" },
    fps: { type: "number" }
  }, (args) => service.updateProjectSpec(args)));

  registerToolDefinition(api, tool("video_project_add_asset_ref", "Add an asset version reference to a project.", {
    project_id: { type: "string" },
    asset_id: { type: "string" },
    asset_version_id: { type: "string" },
    role: { type: "string" },
    usage_scope: { type: "string" },
    pin_mode: { type: "string", enum: ["pinned", "follow_latest", "candidate"] },
    required: { type: "boolean" },
    notes: { type: "string" }
  }, (args) => service.addProjectRef(args), ["project_id", "asset_id"]));

  registerToolDefinition(api, tool("video_project_update_asset_ref", "Update an existing project asset reference.", {
    reference_id: { type: "string" },
    asset_id: { type: "string" },
    asset_version_id: { type: "string" },
    role: { type: "string" },
    usage_scope: { type: "string" },
    pin_mode: { type: "string", enum: ["pinned", "follow_latest", "candidate"] },
    required: { type: "boolean" },
    notes: { type: "string" }
  }, (args) => service.updateProjectRef(args), ["reference_id"]));

  registerToolDefinition(api, tool("video_project_remove_asset_ref", "Soft-remove a project asset reference.", {
    reference_id: { type: "string" }
  }, (args) => service.removeProjectRef(args)));

  registerToolDefinition(api, tool("video_project_refs", "List project asset references.", {
    project_id: { type: "string" }
  }, (args) => service.listProjectRefs(args)));

  registerToolDefinition(api, tool("video_project_asset_report", "Generate a project asset dependency and risk report.", {
    project_id: { type: "string" }
  }, (args) => service.projectReport(args)));

  registerToolDefinition(api, tool("video_project_continuity_report", "Check project taxonomy, entity-link, and annotation continuity risks.", {
    project_id: { type: "string" },
    stage: { type: "string", enum: ["research", "production", "review", "delivery"] }
  }, (args) => service.projectContinuityReport(args)));

  registerToolDefinition(api, tool("video_canvas_create", "Create a project infinite canvas.", {
    project_id: { type: "string" },
    title: { type: "string" },
    viewport: { type: "object", additionalProperties: true },
    document: { type: "object", additionalProperties: true }
  }, (args) => service.createCanvas(args)));

  registerToolDefinition(api, tool("video_canvas_search", "Search project canvases.", {
    project_id: { type: "string" },
    query: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 200 },
    offset: { type: "integer", minimum: 0, maximum: 100000 }
  }, (args) => service.searchCanvases(args)));

  registerToolDefinition(api, tool("video_canvas_apply_production_template", "Apply a production pilot canvas template with stage sections, project refs, entities, and generation slots.", {
    canvas_id: { type: "string" },
    project_id: { type: "string" },
    title: { type: "string" },
    viewport: { type: "object", additionalProperties: true },
    actor_id: { type: "string" },
    actor_type: { type: "string" }
  }, (args) => service.applyProductionCanvasTemplate(args)));

  registerToolDefinition(api, tool("video_canvas_get", "Get an infinite canvas with shapes and edges.", {
    canvas_id: { type: "string" }
  }, (args) => service.getCanvas(args)));

  registerToolDefinition(api, tool("video_canvas_save_snapshot", "Save a canvas viewport/document snapshot.", {
    canvas_id: { type: "string" },
    viewport: { type: "object", additionalProperties: true },
    document: { type: "object", additionalProperties: true },
    document_mode: {
      type: "string",
      enum: ["merge", "replace"],
      description: "文档写入模式。默认 merge；replace 必须同时传 confirm_document_replace=true。"
    },
    confirm_document_replace: { type: "boolean" },
    expected_updated_at: { type: "string", description: "可选乐观锁；必须与画布当前 updated_at 完全一致。" },
    state: { type: "object", additionalProperties: true }
  }, (args) => service.saveCanvasSnapshot(args), ["canvas_id"]));

  registerToolDefinition(api, tool("video_canvas_upsert_shape", "Create or update a canvas card/shape without modifying the underlying asset.", {
    canvas_id: { type: "string" },
    shape_id: { type: "string" },
    shape_type: { type: "string", enum: ["project_card", "asset_card", "entity_card", "reference_card", "note", "section"] },
    subject_type: { type: "string", enum: ["project", "asset", "asset_version", "project_ref", "entity", "note", "section"] },
    subject_id: { type: "string" },
    title: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    width: { type: "number" },
    height: { type: "number" },
    rotation: { type: "number" },
    z_index: { type: "number" },
    props: { type: "object", additionalProperties: true }
  }, (args) => service.upsertCanvasShape(args)));

  registerToolDefinition(api, tool("video_canvas_create_generation_slot", "Create a production generation slot with target size, ratio, duration, and required references.", {
    canvas_id: { type: "string" },
    slot: { type: "string", enum: ["main_reference", "character_reference", "scene_reference", "motion_reference", "style_reference", "video_clip", "audio", "subtitle", "project_config", "draft_output"] },
    generation_type: { type: "string", enum: ["image", "image_to_video", "text_to_video", "multimodal_to_video", "edit", "voice", "subtitle", "cover", "export"] },
    target_width: { type: "number" },
    target_height: { type: "number" },
    target_aspect_ratio: { type: "string" },
    duration_seconds: { type: "number" },
    replace_policy: { type: "string", enum: ["insert_beside", "replace_slot", "new_revision", "append_timeline"] },
    required_refs: {
      type: "array",
      description: "生成前必须存在的输入槽 key，不是资产 ID 或画布卡片 ID。",
      items: { type: "string", enum: ["main_reference", "character_reference", "scene_reference", "motion_reference", "style_reference", "video_clip", "audio", "subtitle", "project_config"] }
    },
    status: { type: "string", enum: ["empty", "ready", "generating", "filled", "blocked"] },
    title: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    width: { type: "number" },
    height: { type: "number" }
  }, (args) => service.createGenerationSlot(args), ["canvas_id"]));

  registerToolDefinition(api, tool("video_canvas_update_generation_slot", "Update a production generation slot target spec or workflow state.", {
    shape_id: { type: "string" },
    slot: { type: "string", enum: ["main_reference", "character_reference", "scene_reference", "motion_reference", "style_reference", "video_clip", "audio", "subtitle", "project_config", "draft_output"] },
    generation_type: { type: "string", enum: ["image", "image_to_video", "text_to_video", "multimodal_to_video", "edit", "voice", "subtitle", "cover", "export"] },
    target_width: { type: "number" },
    target_height: { type: "number" },
    target_aspect_ratio: { type: "string" },
    duration_seconds: { type: "number" },
    replace_policy: { type: "string", enum: ["insert_beside", "replace_slot", "new_revision", "append_timeline"] },
    required_refs: {
      type: "array",
      description: "生成前必须存在的输入槽 key，不是资产 ID 或画布卡片 ID。",
      items: { type: "string", enum: ["main_reference", "character_reference", "scene_reference", "motion_reference", "style_reference", "video_clip", "audio", "subtitle", "project_config"] }
    },
    status: { type: "string", enum: ["empty", "ready", "generating", "filled", "blocked"] },
    title: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    width: { type: "number" },
    height: { type: "number" }
  }, (args) => service.updateGenerationSlot(args), ["shape_id"]));

  registerToolDefinition(api, tool("video_canvas_delete_shape", "Remove a card from a canvas without deleting repository assets.", {
    shape_id: { type: "string" }
  }, (args) => service.deleteCanvasShape(args)));

  registerToolDefinition(api, tool("video_canvas_link_shapes", "Create or update a relationship edge between two canvas shapes.", {
    canvas_id: { type: "string" },
    edge_id: { type: "string" },
    source_shape_id: { type: "string" },
    target_shape_id: { type: "string" },
    relation_type: { type: "string", enum: ["uses", "depends_on", "references", "derived_from", "revises", "replaces", "continues", "belongs_to", "appears_in", "blocks", "contains", "related_to"] },
    label: { type: "string" },
    props: { type: "object", additionalProperties: true }
  }, (args) => service.linkCanvasShapes(args)));

  registerToolDefinition(api, tool("video_canvas_unlink_shapes", "Delete a canvas relationship edge.", {
    edge_id: { type: "string" }
  }, (args) => service.unlinkCanvasShapes(args)));

  registerToolDefinition(api, tool("video_canvas_agent_context", "Return Agent-readable canvas context, visible shapes, offscreen clusters, and lint issues.", {
    canvas_id: { type: "string" },
    viewport: { type: "object", additionalProperties: true }
  }, (args) => service.canvasAgentContext(args)));

  registerToolDefinition(api, tool("video_canvas_widget_context", "Return native-widget-ready canvas context with selection and view state.", {
    canvas_id: { type: "string" },
    viewport: { type: "object", additionalProperties: true }
  }, (args) => service.canvasWidgetContext(args)));

  registerToolDefinition(api, rawTool("render_video_assets_canvas_widget", "Return a Cowart-style native widget render descriptor for the Video Assets infinite canvas.", {
    canvas_id: { type: "string" },
    project_id: { type: "string" },
    title: { type: "string" },
    display_mode: { type: "string", enum: ["inline", "fullscreen", "pip"] },
    viewport: { type: "object", additionalProperties: true }
  }, (args) => service.renderCanvasWidget(args)));

  registerToolDefinition(api, tool("video_canvas_save_selection", "Save transient canvas widget selection without creating an audit commit.", {
    canvas_id: { type: "string" },
    selected_shape_ids: { type: "array", items: { type: "string" } },
    primary_shape_id: { type: "string" },
    source: { type: "string" }
  }, (args) => service.saveCanvasSelection(args)));

  registerToolDefinition(api, tool("video_canvas_get_selection", "Get the current transient canvas widget selection.", {
    canvas_id: { type: "string" }
  }, (args) => service.getCanvasSelection(args)));

  registerToolDefinition(api, tool("video_canvas_save_view_state", "Save transient canvas widget viewport state without creating an audit commit.", {
    canvas_id: { type: "string" },
    viewport: { type: "object", additionalProperties: true },
    source: { type: "string" }
  }, (args) => service.saveCanvasViewState(args)));

  registerToolDefinition(api, tool("video_canvas_get_view_state", "Get the current transient canvas widget viewport state.", {
    canvas_id: { type: "string" }
  }, (args) => service.getCanvasViewState(args)));

  registerToolDefinition(api, tool("video_canvas_generation_package", "Build a generation-prep input package from a production canvas.", {
    canvas_id: { type: "string" },
    generation_type: { type: "string", enum: ["image", "image_to_video", "text_to_video", "multimodal_to_video", "edit", "voice", "subtitle", "cover", "export"] }
  }, (args) => service.canvasGenerationPackage(args)));

  registerToolDefinition(api, tool("video_canvas_generation_handoff", "Build an executable generation handoff package from a production canvas.", {
    canvas_id: { type: "string" },
    generation_type: { type: "string", enum: ["image", "image_to_video", "text_to_video", "multimodal_to_video", "edit", "voice", "subtitle", "cover", "export"] }
  }, (args) => service.canvasGenerationHandoff(args)));

  registerToolDefinition(api, tool("video_canvas_export_annotation_brief", "Build a review brief from a canvas shape for annotation or revision planning.", {
    canvas_id: { type: "string" },
    shape_id: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    severity: { type: "string" },
    requested_change: { type: "string" },
    screenshot_asset_version_id: { type: "string" },
    annotation_type: { type: "string", enum: ["review_note", "prompt_note", "visual_continuity", "production_note", "other"] },
    visibility: { type: "string", enum: ["internal", "project", "public_summary"] }
  }, (args) => service.canvasReviewBrief(args)));

  registerToolDefinition(api, tool("video_canvas_register_review_annotation", "Register a canvas review note on the selected asset, version, entity, or project reference.", {
    canvas_id: { type: "string" },
    shape_id: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    severity: { type: "string" },
    requested_change: { type: "string" },
    screenshot_asset_version_id: { type: "string" },
    annotation_type: { type: "string", enum: ["review_note", "prompt_note", "visual_continuity", "production_note", "other"] },
    visibility: { type: "string", enum: ["internal", "project", "public_summary"] },
    structured: { type: "object", additionalProperties: true }
  }, (args) => service.registerCanvasReviewAnnotation(args)));

  registerToolDefinition(api, tool("video_canvas_create_revision_card", "Create a canvas revision card from a review annotation or generated output lineage.", {
    canvas_id: { type: "string" },
    source_shape_id: { type: "string" },
    shape_id: { type: "string" },
    annotation_id: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    requested_change: { type: "string" },
    severity: { type: "string" },
    status: { type: "string" },
    screenshot_asset_version_id: { type: "string" },
    stage: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    width: { type: "number" },
    height: { type: "number" }
  }, (args) => service.createCanvasRevisionCard(args)));

  registerToolDefinition(api, tool("video_canvas_update_revision_card_status", "Update a canvas revision card workflow status without changing its source annotation or output lineage.", {
    shape_id: { type: "string" },
    status: { type: "string", enum: ["open", "in_progress", "resolved", "rejected"] },
    status_note: { type: "string" },
    title: { type: "string" }
  }, (args) => service.updateCanvasRevisionCardStatus(args)));

  registerToolDefinition(api, tool("video_canvas_insert_generated_asset", "Ingest a generated file, add it to the project, and write it back beside a generation slot.", {
    canvas_id: { type: "string" },
    slot_shape_id: { type: "string" },
    file_path: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    kind: { type: "string", enum: ["raw", "working"] },
    tags: { type: "array", items: { type: "string" } },
    license_status: { type: "string", enum: ["unknown", "cleared", "restricted", "rejected"] },
    risk_level: { type: "string", enum: ["unknown", "low", "medium", "high"] },
    source: { type: "object", additionalProperties: true },
    classification: { type: "object", additionalProperties: true },
    project_ref: { type: "object", additionalProperties: true },
    writeback: { type: "object", additionalProperties: true },
    idempotency_key: { type: "string", description: "可选幂等键；相同键复用既有生成写回。" },
    slot_status: { type: "string", enum: ["empty", "ready", "generating", "filled", "blocked"] }
  }, (args) => service.insertGeneratedAsset(args)));

  registerToolDefinition(api, tool("video_canvas_fill_generation_slot", "Fill a generation slot with a generated file using ingest-first asset writeback defaults.", {
    canvas_id: { type: "string" },
    slot_shape_id: { type: "string" },
    file_path: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    kind: { type: "string", enum: ["raw", "working"] },
    tags: { type: "array", items: { type: "string" } },
    license_status: { type: "string", enum: ["unknown", "cleared", "restricted", "rejected"] },
    risk_level: { type: "string", enum: ["unknown", "low", "medium", "high"] },
    rights_notes: { type: "string" },
    source: { type: "object", additionalProperties: true },
    classification: { type: "object", additionalProperties: true },
    project_ref: { type: "object", additionalProperties: true },
    writeback: { type: "object", additionalProperties: true },
    idempotency_key: { type: "string", description: "可选幂等键；相同键复用既有生成写回。" },
    slot_status: { type: "string", enum: ["empty", "ready", "generating", "filled", "blocked"] }
  }, (args) => service.fillGenerationSlot(args)));

  registerToolDefinition(api, tool("video_audio_doubao_plan", "Build a Doubao Audio 1.0 request package without executing generation.", doubaoAudioToolSchema({
    includeCanvas: false
  }), (args) => service.doubaoAudioPlan(args)));

  registerToolDefinition(api, tool("video_audio_doubao_generate", "Run Doubao Audio 1.0 generation and ingest outputs. Platform review is a content review only and does not authorise rights: outputs default to license_status=unknown unless the caller passes an evidenced rights value.", doubaoAudioToolSchema({
    includeCanvas: false
  }), (args) => service.doubaoAudioGenerate(args)));

  registerToolDefinition(api, tool("video_canvas_doubao_audio_plan", "Build a Doubao Audio 1.0 request package from a canvas audio generation slot.", doubaoAudioToolSchema({
    includeCanvas: true
  }), (args) => service.canvasDoubaoAudioPlan(args)));

  registerToolDefinition(api, tool("video_canvas_doubao_audio_generate", "Run Doubao Audio 1.0 generation from a canvas audio slot and write outputs back to canvas.", doubaoAudioToolSchema({
    includeCanvas: true
  }), (args) => service.canvasDoubaoAudioGenerate(args)));

  registerToolDefinition(api, tool("video_audio_kie_suno_plan", "Build a KIE Suno API music request package without submitting a task.", kieSunoToolSchema({
    includeCanvas: false
  }), (args) => service.kieSunoPlan(args)));

  registerToolDefinition(api, tool("video_audio_kie_suno_generate", "Run KIE Suno API music generation and ingest downloaded outputs as rights-unknown assets.", kieSunoToolSchema({
    includeCanvas: false
  }), (args) => service.kieSunoGenerate(args)));

  registerToolDefinition(api, tool("video_canvas_kie_suno_audio_plan", "Build a KIE Suno request package from a canvas audio generation slot.", kieSunoToolSchema({
    includeCanvas: true
  }), (args) => service.canvasKieSunoPlan(args)));

  registerToolDefinition(api, tool("video_canvas_kie_suno_audio_generate", "Run KIE Suno generation from a canvas audio slot and write outputs back to canvas.", kieSunoToolSchema({
    includeCanvas: true
  }), (args) => service.canvasKieSunoGenerate(args)));

  registerToolDefinition(api, tool("video_canvas_dreamina_cli_plan", "Build a Dreamina CLI execution plan from a canvas handoff without consuming credits.", {
    canvas_id: { type: "string" },
    generation_type: { type: "string", enum: ["image", "image_to_video", "text_to_video", "multimodal_to_video", "edit", "voice", "subtitle", "cover", "export"] },
    model_version: { type: "string" },
    resolution_type: { type: "string", enum: videoSchema.imageResolutionTypes },
    generate_num: { type: "number" },
    ratio: { type: "string" }
  }, (args) => service.canvasDreaminaCliPlan(args)));

  registerToolDefinition(api, tool("video_canvas_dreamina_cli_generate_video", `Run Dreamina CLI video generation from a canvas handoff with strict video model parameter validation. model_version enum is derived from the capability registry (src/capability-registry.js); legacy values stay accepted for backward compatibility while read-only history values are rejected for new requests.`, {
    canvas_id: { type: "string" },
    generation_type: { type: "string", enum: ["image_to_video", "text_to_video", "multimodal_to_video"] },
    prompt: { type: "string" },
    model_version: { type: "string", enum: videoSchema.modelVersion },
    duration: { type: "number" },
    video_resolution: { type: "string", enum: videoSchema.videoResolution },
    ratio: { type: "string", enum: imageSchema.ratio },
    poll: { type: "number" },
    session: { type: "number" },
    output_dir: { type: "string" },
    execute: { type: "boolean" },
    accept_credit_spend: { type: "boolean" },
    run_preflight: { type: "boolean" },
    download_outputs: { type: "boolean" },
    ingest_outputs: { type: "boolean" },
    writeback_canvas: { type: "boolean" },
    output_title: { type: "string" },
    license_status: { type: "string", enum: ["unknown", "cleared", "restricted", "rejected"] },
    risk_level: { type: "string", enum: ["unknown", "low", "medium", "high"] },
    timeout_ms: { type: "number" },
    actor_id: { type: "string" },
    actor_type: { type: "string" }
  }, (args) => service.canvasDreaminaCliGenerateVideo(args)));

  registerToolDefinition(api, tool("video_canvas_dreamina_cli_generate_image", "Run Dreamina CLI image generation from a canvas handoff with strict image model parameter validation. model_version enum is derived from the capability registry; 5.0Pro keeps the CLI's original spelling.", {
    canvas_id: { type: "string" },
    generation_type: { type: "string", enum: ["image", "cover", "edit"] },
    prompt: { type: "string" },
    model_version: { type: "string", enum: imageSchema.modelVersion },
    resolution_type: { type: "string", enum: imageSchema.resolutionType },
    ratio: { type: "string", enum: imageSchema.ratio },
    generate_num: { type: "number" },
    width: { type: "number" },
    height: { type: "number" },
    poll: { type: "number" },
    output_dir: { type: "string" },
    execute: { type: "boolean" },
    accept_credit_spend: { type: "boolean" },
    run_preflight: { type: "boolean" },
    download_outputs: { type: "boolean" },
    ingest_outputs: { type: "boolean" },
    writeback_canvas: { type: "boolean" },
    output_title: { type: "string" },
    license_status: { type: "string", enum: ["unknown", "cleared", "restricted", "rejected"] },
    risk_level: { type: "string", enum: ["unknown", "low", "medium", "high"] },
    timeout_ms: { type: "number" },
    actor_id: { type: "string" },
    actor_type: { type: "string" }
  }, (args) => service.canvasDreaminaCliGenerateImage(args)));

  registerToolDefinition(api, tool("video_canvas_dreamina_cli_upscale_image", "Run Dreamina CLI image upscale (2k/4k/8k) on a given asset version, optionally writing output back to canvas.", {
    asset_version_id: { type: "string" },
    canvas_id: { type: "string" },
    resolution_type: { type: "string", enum: imageSchema.upscaleResolution },
    poll: { type: "number" },
    output_dir: { type: "string" },
    execute: { type: "boolean" },
    accept_credit_spend: { type: "boolean" },
    run_preflight: { type: "boolean" },
    download_outputs: { type: "boolean" },
    ingest_outputs: { type: "boolean" },
    writeback_canvas: { type: "boolean" },
    output_title: { type: "string" },
    license_status: { type: "string", enum: ["unknown", "cleared", "restricted", "rejected"] },
    risk_level: { type: "string", enum: ["unknown", "low", "medium", "high"] },
    timeout_ms: { type: "number" },
    actor_id: { type: "string" },
    actor_type: { type: "string" }
  }, (args) => service.canvasDreaminaCliUpscaleImage(args)));

  registerToolDefinition(api, tool("video_canvas_lint", "Lint a canvas for missing bindings and production readiness warnings.", {
    canvas_id: { type: "string" }
  }, (args) => service.lintCanvas(args)));
}

/**
 * REN-06: the streaming upload route.
 *
 * One route, prefix-matched, dispatching internally by method and sub-path. One rather than several
 * because the REN-01 registration contract counts routes and each additional registration is another
 * thing that can drift from the single base-path source; the sub-path grammar is documented in
 * upload-routes.js and exercised by the acceptance checks.
 *
 * Uploads can NOT go through the `rpc` route: that handler reads the whole request body into memory as
 * JSON, so a 200 MiB file would need a ~270 MiB base64 body buffer on the server. Streaming is the
 * requirement, so the transport has to accept a raw body - which is what this route is for.
 */
function registerUploadRoute(api) {
  const prefix = paths.prefix(ROUTE_SEGMENTS.upload);
  registerHttpRouteChecked(api, {
    path: prefix,
    auth: "plugin",
    match: "prefix",
    handler: async (req, res) => {
      if (!uploadHandlers) return sendJson(res, 503, { ok: false, code: "UPLOAD_NOT_READY", error: "the upload subsystem is not initialised" });
      let relativePath = "/";
      try {
        const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        // Strip the SEGMENT (".../upload"), not the whole registered prefix. Slicing by the prefix length
        // while holding a base-path-relative string mixed two coordinate systems and silently produced the
        // collection branch for item URLs, so every chunk request answered 405. The segment root is the
        // single source of truth, so it is what gets removed.
        const relative = paths.relative(pathname);
        const segmentRoot = `/${ROUTE_SEGMENTS.upload}`;
        relativePath = relative.startsWith(segmentRoot) ? relative.slice(segmentRoot.length) : "/";
        if (relativePath.startsWith("/")) relativePath = relativePath.slice(1);
      } catch {
        return sendJson(res, 400, { ok: false, code: "UPLOAD_PATH_INVALID", error: "the request path is not under the upload route" });
      }
      return uploadHandlers.handle(req, res, relativePath);
    }
  });
}

function registerSecurityRoutes(api) {
  registerHttpRouteChecked(api, {
    path: paths.exact(ROUTE_SEGMENTS.authLogin),
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" });
      // Login is exempt from the missing-Origin rule: the caller has no session yet, so there is no
      // ambient credential to abuse, and a supplied foreign Origin is still rejected.
      const gate = security.checkRequest(req, { method: req.method, isLoginRoute: true });
      if (!gate.ok) return sendJson(res, gate.status, { ok: false, error: gate.error, code: gate.code });
      try {
        const body = await readJsonBody(req);
        const client = security.resolveClient(req);
        const result = await security.login({
          password: body.password,
          ip: client.address,
          address: client.address,
          addressSource: client.address_source,
          userAgent: String(req.headers["user-agent"] ?? "")
        });
        if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
        const cookie = security.cookieOptions(req);
        setSessionCookie(res, result.token, security.sessionTtlMs, cookie);
        return sendJson(res, 200, { ok: true, session: result.session ?? null, cookie: { secure: cookie.secure, path: cookie.path } });
      } catch (error) {
        return sendJson(res, error.status ?? 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  });

  registerHttpRouteChecked(api, {
    path: paths.exact(ROUTE_SEGMENTS.authLogout),
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      // The route count and RPC surface are frozen by the REN-01 contract checks, so the operator
      // session surface lives on this existing path: POST = log out this session, DELETE = revoke
      // every session, GET = token-free session inventory + the effective security posture.
      if (req.method === "GET" || req.method === "HEAD") {
        const gate = security.checkRequest(req, { method: req.method ?? "GET" });
        if (!gate.ok) return sendJson(res, gate.status, { ok: false, error: gate.error, code: gate.code });
        const auth = security.authenticateRequest(req);
        if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
        return sendJson(res, 200, {
          ok: true,
          sessions: security.listSessions(),
          describe: security.describe(),
          decisions: security.recentDecisions(10)
        });
      }
      if (req.method !== "POST" && req.method !== "DELETE") return sendJson(res, 405, { ok: false, error: "method not allowed" });
      const gate = security.checkRequest(req, { method: req.method });
      if (!gate.ok) return sendJson(res, gate.status, { ok: false, error: gate.error, code: gate.code });
      const auth = security.authenticateRequest(req);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
      if (req.method === "DELETE") {
        const result = security.revokeAllSessions("operator-revoke-all");
        clearSessionCookie(res, security.cookieOptions(req));
        return sendJson(res, 200, { ok: true, revoked: result.dropped });
      }
      security.revokeSession(getRequestToken(req), "logout");
      clearSessionCookie(res, security.cookieOptions(req));
      return sendJson(res, 200, { ok: true });
    }
  });

  registerHttpRouteChecked(api, {
    path: paths.exact(ROUTE_SEGMENTS.authStatus),
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      const gate = security.checkRequest(req, { method: req.method ?? "GET" });
      if (!gate.ok) return sendJson(res, gate.status, { ok: false, error: gate.error, code: gate.code });
      const auth = security.authenticateRequest(req);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
      return sendJson(res, 200, { ok: true, actor_id: auth.actor_id, actor_source: auth.source ?? "plugin-session", session_id: auth.session_id ?? null });
    }
  });
}

function registerUiApiRoute(api) {
  registerHttpRouteChecked(api, {
    path: paths.prefix(ROUTE_SEGMENTS.rpc),
    auth: "plugin",
    match: "prefix",
    handler: async (req, res) => {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" });
      const gate = security.checkRequest(req, { method: req.method });
      if (!gate.ok) return sendJson(res, gate.status, { ok: false, error: gate.error, code: gate.code });
      const auth = security.authenticateRequest(req);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
      try {
        const body = await readJsonBody(req, 120 * 1024 * 1024);
        const method = String(body.method ?? "");
        const handler = uiBrowserRpc()[method];
        if (!handler) return sendJson(res, 404, { ok: false, error: `unknown ui rpc method: ${method}` });
        // The only trusted identity on this surface is the plugin session that just authenticated.
        // The session exists because someone supplied the admin password, so it carries the operator
        // scope - the generation policy therefore sees a real identity AND a real scope instead of
        // relying on a surface grant.
        const context = buildTrustedContext({
          surface: "browser",
          actorId: auth.actor_id,
          actorType: "human",
          trusted: true,
          source: auth.source ?? "plugin-session",
          scopes: ["operator.admin"]
        });
        return sendJson(res, 200, { ok: true, result: await handler(withTrustedContext(body.params ?? {}, context)) });
      } catch (error) {
        return sendJson(res, error.status ?? 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  });
}

function registerSecureFileRoutes(api) {
  // /file/ keeps its DOWNLOAD semantics by default and serves the same object INLINE when asked
  // with ?disposition=inline, which is the URL a player uses. The split is a query parameter
  // rather than a new route because the file route already owns that URL, and a second route
  // for the same object would duplicate its authentication and range handling. (REN-06 does add
  // ONE route - the streaming upload endpoint - declared in ROUTE_SEGMENTS and named, with its
  // reason, in the registration contract test.)
    registerHttpRouteChecked(api, {
    path: paths.prefix(ROUTE_SEGMENTS.file),
    auth: "plugin",
    match: "prefix",
    handler: async (req, res) => handleVersionFileRequest(req, res, paths.prefix(ROUTE_SEGMENTS.file), DISPOSITION_ATTACHMENT)
  });
  registerHttpRouteChecked(api, {
    path: paths.prefix(ROUTE_SEGMENTS.thumb),
    auth: "plugin",
    match: "prefix",
    handler: async (req, res) => handleDerivedFileRequest(req, res, paths.prefix(ROUTE_SEGMENTS.thumb), ["thumbnail", "contact_sheet"], "thumbnail")
  });
  registerHttpRouteChecked(api, {
    path: paths.prefix(ROUTE_SEGMENTS.proxy),
    auth: "plugin",
    match: "prefix",
    handler: async (req, res) => handleDerivedFileRequest(req, res, paths.prefix(ROUTE_SEGMENTS.proxy), ["proxy", "transcode", "audio_proxy"], "proxy")
  });
}

function registerUiRoutes(api) {
  registerHttpRouteChecked(api, {
    path: paths.prefix(ROUTE_SEGMENTS.workbench),
    auth: "plugin",
    match: "prefix",
    handler: async (req, res) => handleUiAssetRequest(req, res)
  });
}

async function handleUiAssetRequest(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { ok: false, error: "method not allowed" });
  }
  const gate = security.checkRequest(req, { method: req.method });
  if (!gate.ok) return sendJson(res, gate.status, { ok: false, error: gate.error, code: gate.code });
  try {
    const url = new URL(req.url ?? paths.prefix(ROUTE_SEGMENTS.workbench), "http://127.0.0.1");
    const workbenchPrefix = paths.prefix(ROUTE_SEGMENTS.workbench);
    let relativePath = decodeURIComponent(url.pathname.slice(workbenchPrefix.length));
    if (!relativePath || relativePath.endsWith("/")) relativePath = `${relativePath}index.html`;
    let filePath = safeResolveUiPath(relativePath);
    if (!fs.existsSync(filePath) || (await fs.promises.stat(filePath)).isDirectory()) {
      filePath = safeResolveUiPath("index.html");
    }
    const stat = await fs.promises.stat(filePath);
    applySecurityHeaders(res, { contentSecurityPolicy: UI_CONTENT_SECURITY_POLICY });
    res.statusCode = 200;
    res.setHeader("content-type", contentTypeFor(filePath));
    res.setHeader("content-length", String(stat.size));
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    return sendJson(res, error.status ?? 404, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function safeResolveUiPath(relativePath) {
  const cleaned = String(relativePath ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (path.isAbsolute(relativePath) || cleaned.split("/").includes("..")) {
    throw new Error("invalid ui path");
  }
  const filePath = path.resolve(UI_DIST_DIR, cleaned);
  const relative = path.relative(UI_DIST_DIR, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("invalid ui path");
  return filePath;
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp"
  }[ext] ?? "application/octet-stream";
}

async function handleVersionFileRequest(req, res, prefix, defaultDisposition = DISPOSITION_ATTACHMENT) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { ok: false, error: "method not allowed" });
  }
  const gate = security.checkRequest(req, { method: req.method });
  if (!gate.ok) return sendJson(res, gate.status, { ok: false, error: gate.error, code: gate.code });
  const auth = security.authenticateRequest(req);
  if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });

  // The route decides the disposition, and a query parameter may ask for inline explicitly. It may
  // NOT ask for anything else: an unknown disposition value falls back to the route default rather
  // than being echoed into the header.
  const requested = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("disposition");
  const disposition = requested === "inline" ? DISPOSITION_INLINE : defaultDisposition;

  try {
    // The prefix comes from the route that matched, so the identifier is always sliced out of the
    // segment this handler was registered for.
    const assetVersionId = extractRouteId(req.url, prefix);
    const file = service.resolveVersionFile(assetVersionId);
    applySecurityHeaders(res, { contentSecurityPolicy: null });
    return await sendMedia(req, res, descriptorFromResolved(file, { disposition }));
  } catch (error) {
    // A refusal must not describe the filesystem: the fixed sentences below keep a caller from
    // learning object-store paths, and the JSON error envelope is produced by sendStreamError.
    if (error?.code === "MEDIA_OBJECT_MISSING" || error?.code === "ENOENT") {
      return sendStreamError(res, 404, "MEDIA_OBJECT_MISSING", "the media object is missing");
    }
    if (/not found/i.test(String(error?.message ?? ""))) {
      return sendStreamError(res, 404, "MEDIA_NOT_FOUND", "no media object is registered for that identifier");
    }
    if (/invalid route/i.test(String(error?.message ?? ""))) {
      return sendStreamError(res, 400, "MEDIA_ROUTE_INVALID", "the media route identifier is invalid");
    }
    return sendStreamError(res, error?.status ?? 500, "MEDIA_UNAVAILABLE", "the media object could not be served");
  }
}

async function handleDerivedFileRequest(req, res, prefix, allowedTypes, label) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { ok: false, error: "method not allowed" });
  }
  const gate = security.checkRequest(req, { method: req.method });
  if (!gate.ok) return sendJson(res, gate.status, { ok: false, error: gate.error, code: gate.code });
  const auth = security.authenticateRequest(req);
  if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });

  try {
    const identifier = extractRouteId(req.url, prefix);
    const file = service.resolveDerivedFile(identifier, allowedTypes);
    applySecurityHeaders(res, { contentSecurityPolicy: null });
    // Thumbnails and proxies are playback/display surfaces, so they are inline and range-capable.
    return await sendMedia(req, res, descriptorFromResolved(file, { disposition: DISPOSITION_INLINE }));
  } catch (error) {
    if (/not one of/i.test(String(error?.message ?? ""))) {
      return sendStreamError(res, 404, "DERIVATIVE_TYPE_MISMATCH", `no ${label} is registered for that identifier`);
    }
    if (/not found/i.test(String(error?.message ?? ""))) {
      return sendStreamError(res, 404, "DERIVATIVE_NOT_FOUND", `no ${label} is registered for that identifier`);
    }
    if (/invalid route/i.test(String(error?.message ?? ""))) {
      return sendStreamError(res, 400, "MEDIA_ROUTE_INVALID", "the media route identifier is invalid");
    }
    return sendStreamError(res, error?.status ?? 500, "MEDIA_UNAVAILABLE", `the ${label} object could not be served`);
  }
}

function extractRouteId(rawUrl, prefix) {
  const url = new URL(rawUrl ?? prefix, "http://127.0.0.1");
  if (!url.pathname.startsWith(prefix)) throw new Error("invalid route");
  const id = decodeURIComponent(url.pathname.slice(prefix.length));
  if (!/^[A-Za-z0-9_:-]+$/.test(id)) throw new Error("invalid route id");
  return id;
}

function sanitizeDownloadName(name) {
  return path.basename(String(name)).replace(/["\r\n]/g, "_") || "asset.bin";
}

function registerRpc(api) {
  const rpc = allRpc();

  for (const [name, definition] of Object.entries(rpc)) {
    const scopeCheck = validateGatewayScope(definition.scope);
    if (!scopeCheck.ok) {
      api.logger.error?.(`[video-assets] ${scopeCheck.error.message}`);
      throw scopeCheck.error;
    }
    requireRegistration("gateway-method", name, { detail: definition.scope });
    api.registerGatewayMethod(name, createGatewayRpcHandler(definition), { scope: definition.scope });
  }
}

function allRpc() {
  return {
    "videoAssets.asset.search": read((params) => service.searchAssets(params)),
    // Gate 3: server-side filter + sort + total, so the workbench never truncates a large repository.
    "videoAssets.asset.browse": read((params) => service.browseAssets(params)),
    "videoAssets.asset.get": read((params) => service.getAsset(params)),
    "videoAssets.asset.updateMetadata": write((params) => service.updateAssetMetadata(params)),
    "videoAssets.asset.updateRights": write((params) => service.updateAssetRights(params)),
    "videoAssets.asset.create": write((params) => service.ingestAsset(params)),
    "videoAssets.asset.createVersion": write((params) => service.createVersion(params)),
    "videoAssets.asset.createBranch": write((params) => service.createBranch(params)),
    "videoAssets.asset.saveCopy": write((params) => service.saveCopy(params)),
    "videoAssets.asset.lineage": read((params) => service.lineage(params)),
    "videoAssets.asset.registerDerivedFile": write((params) => service.registerDerivedFile(params)),
    "videoAssets.asset.generateDerivedFile": write((params) => service.generateDerivedFile(params)),
    "videoAssets.asset.derivedFiles": read((params) => service.listDerivedFiles(params)),
    "videoAssets.asset.integrityScan": read((params) => service.integrityScan(params)),
    "videoAssets.asset.classify": write((params) => service.classifyAsset(params)),
    "videoAssets.asset.getClassification": read((params) => service.getAssetClassification(params)),
    "videoAssets.asset.taxonomyReport": read((params) => service.assetTaxonomyReport(params)),
    "videoAssets.entity.create": write((params) => service.createEntity(params)),
    "videoAssets.entity.search": read((params) => service.searchEntities(params)),
    "videoAssets.entity.linkAsset": write((params) => service.linkEntityAsset(params)),
    "videoAssets.annotation.create": write((params) => service.annotateAsset(params)),
    "videoAssets.annotation.list": read((params) => service.listAnnotations(params)),
    "videoAssets.annotation.update": write((params) => service.updateAnnotation(params)),
    "videoAssets.project.create": write((params) => service.createProject(params)),
    "videoAssets.project.updateSpec": write((params) => service.updateProjectSpec(params)),
    "videoAssets.project.search": read((params) => service.searchProjects(params)),
    "videoAssets.project.get": read((params) => service.getProjectDetail(params)),
    "videoAssets.project.addRef": write((params) => service.addProjectRef(params)),
    "videoAssets.project.updateRef": write((params) => service.updateProjectRef(params)),
    "videoAssets.project.removeRef": write((params) => service.removeProjectRef(params)),
    "videoAssets.project.listRefs": read((params) => service.listProjectRefs(params)),
    "videoAssets.project.report": read((params) => service.projectReport(params)),
    "videoAssets.project.continuityReport": read((params) => service.projectContinuityReport(params)),
    "videoAssets.canvas.create": write((params) => service.createCanvas(params)),
    "videoAssets.canvas.search": read((params) => service.searchCanvases(params)),
    "videoAssets.canvas.applyProductionTemplate": write((params) => service.applyProductionCanvasTemplate(params)),
    "videoAssets.canvas.get": read((params) => service.getCanvas(params)),
    "videoAssets.canvas.saveSnapshot": write((params) => service.saveCanvasSnapshot(params)),
    "videoAssets.canvas.upsertShape": write((params) => service.upsertCanvasShape(params)),
    "videoAssets.canvas.createGenerationSlot": write((params) => service.createGenerationSlot(params)),
    "videoAssets.canvas.updateGenerationSlot": write((params) => service.updateGenerationSlot(params)),
    "videoAssets.canvas.deleteShape": write((params) => service.deleteCanvasShape(params)),
    "videoAssets.canvas.linkShapes": write((params) => service.linkCanvasShapes(params)),
    "videoAssets.canvas.unlinkShapes": write((params) => service.unlinkCanvasShapes(params)),
    "videoAssets.canvas.agentContext": read((params) => service.canvasAgentContext(params)),
    "videoAssets.canvas.widgetContext": read((params) => service.canvasWidgetContext(params)),
    "videoAssets.canvas.saveSelection": write((params) => service.saveCanvasSelection(params)),
    "videoAssets.canvas.getSelection": read((params) => service.getCanvasSelection(params)),
    "videoAssets.canvas.saveViewState": write((params) => service.saveCanvasViewState(params)),
    "videoAssets.canvas.getViewState": read((params) => service.getCanvasViewState(params)),
    "videoAssets.canvas.generationPackage": read((params) => service.canvasGenerationPackage(params)),
    "videoAssets.canvas.generationHandoff": read((params) => service.canvasGenerationHandoff(params)),
    "videoAssets.canvas.reviewBrief": read((params) => service.canvasReviewBrief(params)),
    "videoAssets.canvas.registerReviewAnnotation": write((params) => service.registerCanvasReviewAnnotation(params)),
    "videoAssets.canvas.createRevisionCard": write((params) => service.createCanvasRevisionCard(params)),
    "videoAssets.canvas.updateRevisionCardStatus": write((params) => service.updateCanvasRevisionCardStatus(params)),
    "videoAssets.canvas.insertGeneratedAsset": write((params) => service.insertGeneratedAsset(params)),
    "videoAssets.canvas.fillGenerationSlot": write((params) => service.fillGenerationSlot(params)),
    "videoAssets.audio.doubaoPlan": read((params) => service.doubaoAudioPlan(params)),
    "videoAssets.audio.doubaoGenerate": write((params) => service.doubaoAudioGenerate(params)),
    "videoAssets.canvas.doubaoAudioPlan": read((params) => service.canvasDoubaoAudioPlan(params)),
    "videoAssets.canvas.doubaoAudioGenerate": write((params) => service.canvasDoubaoAudioGenerate(params)),
    "videoAssets.audio.kieSunoPlan": read((params) => service.kieSunoPlan(params)),
    "videoAssets.audio.kieSunoGenerate": write((params) => service.kieSunoGenerate(params)),
    "videoAssets.canvas.kieSunoAudioPlan": read((params) => service.canvasKieSunoPlan(params)),
    "videoAssets.canvas.kieSunoAudioGenerate": write((params) => service.canvasKieSunoGenerate(params)),
    "videoAssets.canvas.dreaminaCliPlan": read((params) => service.canvasDreaminaCliPlan(params)),
    "videoAssets.canvas.dreaminaCliGenerateVideo": write((params) => service.canvasDreaminaCliGenerateVideo(params)),
    "videoAssets.canvas.lint": read((params) => service.lintCanvas(params)),
    // REN-08: the editable canvas. THREE methods, not one per gesture, because every gesture is the same operation
    // with a different payload: apply a command against a revision. Adding drag/connect/delete/copy/undo as separate
    // RPCs would multiply the concurrency question by the number of gestures and leave each one to answer it alone.
    "videoAssets.canvas.getRevision": read((params) => service.getCanvasRevision(params)),
    "videoAssets.canvas.applyCommand": write((params) => service.applyCanvasCommand(params)),
    "videoAssets.canvas.listCommands": read((params) => service.listCanvasCommands(params)),
    "videoAssets.generationJob.create": write((params) => service.createGenerationJob(params)),
    "videoAssets.generationJob.get": read((params) => service.getGenerationJob(params)),
    "videoAssets.generationJob.list": read((params) => service.listGenerationJobs(params)),
    "videoAssets.generationJob.events": read((params) => service.generationJobEvents(params)),
    "videoAssets.generationJob.process": write((params) => service.processGenerationJob(params)),
    "videoAssets.generationJob.reconcile": write((params) => service.reconcileGenerationJob(params)),
    "videoAssets.generationJob.resume": write((params) => service.resumeGenerationJob(params)),
    "videoAssets.generationJob.cancel": write((params) => service.cancelGenerationJob(params)),
    "videoAssets.file.roots": read(() => service.fileRoots()),
    "videoAssets.file.list": read((params) => service.listFiles(params)),
    "videoAssets.file.inspect": read((params) => service.inspectFile(params)),
    "videoAssets.file.search": read((params) => service.searchFiles(params)),
    "videoAssets.staging.upload": write((params) => service.uploadStagingFile(params)),
    "videoAssets.staging.ingest": write((params) => service.ingestStagingFile(params)),
    "videoAssets.staging.reject": write((params) => service.rejectStagingFile(params)),
    "videoAssets.audit.commits": read((params) => service.listCommits(params)),
    "videoAssets.ui.dashboardSummary": read((params) => ({ ...service.uiDashboardSummary(), security: securityDiagnostics() })),
  };
}

function uiBrowserRpc() {
  const methods = allRpc();
  const browserWriteAllowlist = new Set([
    "videoAssets.staging.upload",
    "videoAssets.staging.ingest",
    "videoAssets.staging.reject",
    "videoAssets.project.updateSpec",
    "videoAssets.project.addRef",
    "videoAssets.project.updateRef",
    "videoAssets.project.removeRef",
    "videoAssets.asset.updateRights",
    "videoAssets.asset.classify",
    "videoAssets.annotation.create",
    "videoAssets.annotation.update",
    "videoAssets.canvas.create",
    "videoAssets.canvas.applyProductionTemplate",
    "videoAssets.canvas.saveSnapshot",
    "videoAssets.canvas.saveSelection",
    "videoAssets.canvas.saveViewState",
    "videoAssets.canvas.upsertShape",
    "videoAssets.canvas.createGenerationSlot",
    "videoAssets.canvas.updateGenerationSlot",
    "videoAssets.canvas.registerReviewAnnotation",
    "videoAssets.canvas.createRevisionCard",
    "videoAssets.canvas.updateRevisionCardStatus",
    "videoAssets.canvas.insertGeneratedAsset",
    "videoAssets.canvas.fillGenerationSlot",
    "videoAssets.audio.kieSunoGenerate",
    "videoAssets.canvas.kieSunoAudioGenerate",
    "videoAssets.canvas.deleteShape",
    "videoAssets.canvas.linkShapes",
    "videoAssets.canvas.unlinkShapes",
    // REN-08: the editor's own write path. It is on the allowlist because the workbench IS the editing surface -
    // the browser is where a person drags a card, and it reaches the service with the same session identity as
    // every other browser write. The two read methods need no entry: operator.read is allowlisted by scope.
    "videoAssets.canvas.applyCommand",
    "videoAssets.generationJob.create",
    "videoAssets.generationJob.process",
    "videoAssets.generationJob.reconcile",
    "videoAssets.generationJob.resume",
    "videoAssets.generationJob.cancel"
  ]);
  const browserMethods = Object.entries(methods)
    .filter(([name, definition]) => definition.scope === "operator.read" || browserWriteAllowlist.has(name))
    .map(([name, definition]) => [name, definition.handler]);
  const map = Object.fromEntries(browserMethods);
  // Add short aliases (strip "videoAssets." prefix) for browser UI convenience
  for (const [name, handler] of browserMethods) {
    if (name.startsWith("videoAssets.")) {
      const short = name.slice("videoAssets.".length);
      if (!(short in map)) map[short] = handler;
    }
  }
  return map;
}

function read(handler) {
  return { scope: "operator.read", handler };
}

function write(handler) {
  return { scope: "operator.write", handler };
}

function tool(name, description, properties, handler, required = []) {
  const localizedDescription = localizedToolDescription(name, description);
  const definition = {
    name,
    description: localizedDescription,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties,
      ...(required.length > 0 ? { required } : {})
    },
    async execute(toolCallId, args, signal, onUpdate, toolContext) {
      const validation = validateToolInput({ name, parameters: definition.parameters, args });
      if (!validation.ok) {
        return toToolFailure(validation.error, validation.skipped);
      }
      try {
        // REN-02: the trusted identity comes from the host tool factory context, never from args.
        const context = trustedContextForToolCall(toolContext);
        const result = await handler(withTrustedContext(args ?? {}, context), { toolCallId, signal, onUpdate, toolContext, context });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return toToolFailure(error);
      }
    }
  };
  return definition;
}

function rawTool(name, description, properties, handler) {
  const localizedDescription = localizedToolDescription(name, description);
  const definition = {
    name,
    description: localizedDescription,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties
    },
    async execute(toolCallId, args, signal, onUpdate, toolContext) {
      const validation = validateToolInput({ name, parameters: definition.parameters, args });
      if (!validation.ok) {
        return toToolFailure(validation.error, validation.skipped);
      }
      try {
        const context = trustedContextForToolCall(toolContext);
        return await handler(withTrustedContext(args ?? {}, context), { toolCallId, signal, onUpdate, toolContext, context });
      } catch (error) {
        return toToolFailure(error);
      }
    }
  };
  return definition;
}

/**
 * Tool failure shape.
 * `content[0].text` keeps the historical `ERROR: <message>` prefix that existing callers
 * and transcripts pattern-match on; the structured code/retryable detail rides along in
 * `details` so a newer client can branch on it without a contract break.
 */
function toToolFailure(error, skipped = []) {
  const { envelope, isStructured, hint } = toStructuredError(error);
  const text = isStructured ? `ERROR: ${envelope.code}: ${envelope.message}` : `ERROR: ${envelope.message}`;
  return {
    content: [{ type: "text", text }],
    details: {
      ok: false,
      error: envelope,
      ...(hint ? { hint } : {}),
      ...(skipped.length > 0 ? { validationSkipped: skipped } : {})
    },
    isError: true
  };
}
