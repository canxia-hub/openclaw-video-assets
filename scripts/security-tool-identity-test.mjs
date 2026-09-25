/**
 * REN-02 check (review round 2, issue 1): the TOOL surface has a real, host-supplied identity.
 *
 * The previous round claimed "the host passes no identity" and pushed the tool surface onto an
 * `unattributedPolicy=allow-with-surface-grant` grant. That claim was wrong for this host: the public
 * plugin API accepts a tool FACTORY
 * (`registerTool: (tool: AnyAgentTool | OpenClawPluginToolFactory, opts?)`, type at
 * `dist/agent-harness-runtime-BwRgV0uy.d.ts:14339`), the loader resolves it per run
 * (`const factory = typeof tool === "function" ? tool : (_ctx) => tool`,
 * `dist/loader-runtime-load-BgaHcThS.mjs:3929`), and the factory receives an
 * `OpenClawPluginToolContext` (agent id, session, requester, owner bit - same file, lines 1966-2023).
 *
 * This check proves, in-process and with zero provider cost:
 *   * all 69 tools are registered through the factory seam (no plain-object registration left);
 *   * a tool call made under a host context carries `agent:<id>` / `host-tool-factory` into the
 *     generation audit trail, while a call without one is reported as `unattributed`;
 *   * `params.actor_id` cannot create identity;
 *   * the identity + operator-scope path is enforced (owner bit grants the scope; a non-owner does
 *     not; `requireOperatorScope=false` is the documented loosening);
 *   * the provider is NEVER reached here: the stub config deliberately has no budget ledger, so every
 *     allowed-looking call still stops at the gate. The positive path that reaches a provider runs in
 *     the isolated daemon harness against a zero-cost CLI spy (`host-smoke/`).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as loaderApi from "node:module";

const { installSdkAliasHooks } = await import("./fixtures/sdk-alias-hooks.mjs");
installSdkAliasHooks(loaderApi);
process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = "2026.9.3";
const { createHostApiStub } = await import("./fixtures/host-api-stub.mjs");
const { getToolSurfaceIdentity } = await import("../src/index.js");
const { GENERATION_DENIAL_CODES } = await import("../src/generation-policy.js");

const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-ren02-tool-identity-"));
const pluginEntry = (await import("../src/index.js")).default;

const HOST_CTX = { agentId: "tuan", sessionKey: "agent:tuan:main", sessionId: "sess-tool-identity", senderIsOwner: false, workspaceDir: tmp };

async function registerPlugin(pluginConfig) {
  const api = createHostApiStub({ pluginConfig: { repositoryRoot: path.join(tmp, `repo-${Math.random().toString(36).slice(2, 8)}`), ...pluginConfig }, registrationMode: "full" });
  await pluginEntry.register(api);
  return api;
}

/** Resolve a registered tool under a specific host context (what the host does per run). */
function resolveTool(api, name, hostContext) {
  const record = api.tools.find((tool) => tool.definition?.name === name);
  assert.ok(record, `tool ${name} must be registered`);
  assert.equal(typeof record.factory, "function", `tool ${name} must be registered through the factory seam`);
  return record.factory(hostContext);
}

/** Read the plugin's own security/generation diagnostics through the existing dashboard RPC. */
async function dashboardSummary(api) {
  const method = api.gatewayMethods.find((entry) => entry.method === "videoAssets.ui.dashboardSummary");
  assert.ok(method, "the dashboard summary RPC must exist");
  let captured = null;
  await method.handler({ params: {}, respond: (ok, body) => { captured = { ok, body }; } });
  assert.ok(captured?.ok, `the dashboard summary must respond ok, got ${JSON.stringify(captured?.body ?? null)}`);
  return captured.body.result.security;
}

/** A minimal ready canvas, built through the plugin's own tools (no provider involved). */
async function buildReadyCanvas(api, hostContext) {
  const source = path.join(tmp, `ref-${Math.random().toString(36).slice(2, 8)}.png`);
  await fs.promises.writeFile(source, Buffer.from(png1x1, "base64"));
  const call = async (name, args) => {
    const tool = resolveTool(api, name, hostContext);
    const result = await tool.execute(`call-${name}`, args);
    const text = result?.content?.[0]?.text ?? JSON.stringify(result);
    return JSON.parse(text);
  };
  const project = await call("video_project_create", { title: "tool identity fixture" });
  await call("video_project_update_spec", { project_id: project.project_id, target_platforms: ["douyin"], aspect_ratio: "16:9", resolution: "1920x1080", fps: 24 });
  const asset = await call("video_asset_ingest", { file_path: source, title: "Main Reference", kind: "working" });
  await call("video_asset_update_rights", { asset_id: asset.asset_id, license_status: "cleared", risk_level: "low", source: { source_type: "internal_fixture", license_hint: "test fixture" } });
  await call("video_asset_classify", { asset_id: asset.asset_id, asset_version_id: asset.default_version_id, domain: "reference", type: "main_reference", confidence: "confirmed", source: "agent" });
  const ref = await call("video_project_add_asset_ref", { project_id: project.project_id, asset_id: asset.asset_id, asset_version_id: asset.default_version_id, role: "reference", usage_scope: "tool identity fixture", pin_mode: "pinned", required: true });
  const canvas = await call("video_canvas_create", { project_id: project.project_id, title: "tool identity canvas" });
  await call("video_canvas_upsert_shape", {
    canvas_id: canvas.canvas_id,
    shape_type: "reference_card",
    subject_type: "project_ref",
    subject_id: ref.reference_id,
    title: "Bound image reference",
    x: 0,
    y: 0,
    width: 260,
    height: 140,
    props: { generation_slot: "main_reference", stage: "shots", role: "project_ref" }
  });
  return canvas;
}

// ------------------------------------------------------------------------------------------------
// 1. host capability + factory registration
// ------------------------------------------------------------------------------------------------
const api = await registerPlugin({});
assert.equal(api.tools.length, 69, "the 69-tool contract must be preserved");
assert.equal(api.tools.filter((tool) => typeof tool.factory === "function").length, 69, "every tool must be registered through the factory seam");
assert.equal(api.tools.filter((tool) => tool.definition.execute === undefined).length, 0, "every resolved tool must still expose execute");
const identity = getToolSurfaceIdentity();
assert.ok(identity, "the plugin must record its tool-identity evidence");
assert.equal(identity.supported, true, "this host must be recognised as exposing the factory seam");
assert.equal(identity.register_tool_arity, 2, "registerTool(tool, opts) must be the observed shape");
assert.match(identity.evidence, /loader-runtime-load/, "the evidence must point at the host implementation");

// ------------------------------------------------------------------------------------------------
// 1b. the REAL host shape: the registrar is exposed through a rest-args adapter (arity 0)
//     Measured 2026-09-21 in the isolated lane: `api.registerTool.length === 0` on this host, while
//     the loader still resolves function tools per run. The earlier arity>=2 guard made every real
//     tool call unattributed; these two cases keep that regression out.
// ------------------------------------------------------------------------------------------------
const apiRealShape = createHostApiStub({ pluginConfig: { repositoryRoot: path.join(tmp, "repo-real-shape") }, restArgsRegisterTool: true, registrationMode: "discovery" });
await pluginEntry.register(apiRealShape);
const realIdentity = getToolSurfaceIdentity();
assert.equal(apiRealShape.tools.length, 69, "the 69-tool contract must be preserved on the real host shape");
assert.equal(apiRealShape.tools.filter((tool) => typeof tool.factory === "function").length, 69, "the rest-args host shape must still register every tool through the factory seam");
assert.equal(realIdentity.register_tool_arity, 0, "the rest-args adapter must be measured as arity 0");
assert.equal(realIdentity.supported, true, "arity alone must not disqualify a host whose loader resolves factories");
assert.equal(realIdentity.signal, "registrationMode", "the deciding signal must be recorded");

// a legacy host that advertises neither modern signal keeps the static path (fail-closed, no identity)
const apiLegacy = createHostApiStub({ pluginConfig: { repositoryRoot: path.join(tmp, "repo-legacy") }, restArgsRegisterTool: true, noRegistrationMode: true });
await pluginEntry.register(apiLegacy);
const legacyIdentity = getToolSurfaceIdentity();
assert.equal(legacyIdentity.supported, false, "a host without the modern API surface must not be assumed to support factories");
assert.equal(legacyIdentity.signal, "none");
assert.equal(apiLegacy.tools.length, 69, "the tool contract must survive the static path");
assert.equal(apiLegacy.tools.filter((tool) => typeof tool.factory === "function").length, 0, "the static path must not pass a function as a tool definition");
assert.equal(apiLegacy.tools.filter((tool) => typeof tool.definition?.execute === "function").length, 69, "every statically registered tool must still be executable");

// ------------------------------------------------------------------------------------------------
// 2. the host context becomes the trusted generation identity (and the provider is never reached)
// ------------------------------------------------------------------------------------------------
const canvasForOwner = await buildReadyCanvas(api, HOST_CTX);
const generateTool = resolveTool(api, "video_canvas_dreamina_cli_generate_video", HOST_CTX);
const blocked = JSON.parse((await generateTool.execute("call-generate", {
  canvas_id: canvasForOwner.canvas_id,
  generation_type: "image_to_video",
  execute: true,
  run_preflight: false,
  ingest_outputs: false,
  accept_credit_spend: true
})).content[0].text);
assert.equal(blocked.status, "blocked", "the default policy must still block the call");
const afterIdentified = await dashboardSummary(api);
const identified = afterIdentified.generation.recent.at(-1);
assert.equal(identified.actor_id, "agent:tuan", "the tool call must carry the HOST agent identity into the audit trail");
assert.equal(identified.actor_source, "host-tool-factory", "the identity provenance must be the host tool factory, not a request parameter");
assert.equal(afterIdentified.generation.provider_invocations, 0, "no provider may be reached from a unit test");

// ------------------------------------------------------------------------------------------------
// 3. without a host context the same call is unattributed - and params cannot fix that
// ------------------------------------------------------------------------------------------------
const apiBare = await registerPlugin({});
const canvasBare = await buildReadyCanvas(apiBare, null);
const bareTool = resolveTool(apiBare, "video_canvas_dreamina_cli_generate_video", null);
const bareResult = JSON.parse((await bareTool.execute("call-generate-bare", {
  canvas_id: canvasBare.canvas_id,
  generation_type: "image_to_video",
  execute: true,
  run_preflight: false,
  accept_credit_spend: true,
  actor_id: "agent:tuan",
  actor_type: "agent"
})).content[0].text);
assert.equal(bareResult.status, "blocked");
assert.equal(bareResult.authorization.actor.actor_id, "unattributed", "a claimed actor_id must not become identity");
const bareSummary = await dashboardSummary(apiBare);
const bare = bareSummary.generation.recent.at(-1);
assert.equal(bare.actor_id, "unattributed", "a tool call without a host context must be recorded as unattributed");
assert.equal(bare.actor_source, "unattributed");
assert.equal(bareSummary.generation.provider_invocations, 0);
assert.equal((await dashboardSummary(api)).tool_surface_identity.supported, true, "the diagnostics must expose the seam evidence");

// ------------------------------------------------------------------------------------------------
// 4. identity + operator scope decide: owner bit grants the scope, a plain agent does not
// ------------------------------------------------------------------------------------------------
// allowActors grants the actor, but the scope gate still applies (the host owner bit is the only
// source of an operator scope). No ledger is configured, so the allowed-looking path stops at the
// budget gate - which is exactly what keeps this check zero-cost.
const apiScoped = await registerPlugin({
  security: {
    generation: {
      allowSurfaces: ["tool"],
      allowActors: ["agent:tuan"],
      ledger: "none",
      budget: { estimates: { "dreamina.video.generate": 10 } }
    }
  }
});
const canvasScoped = await buildReadyCanvas(apiScoped, HOST_CTX);
const nonOwner = JSON.parse((await resolveTool(apiScoped, "video_canvas_dreamina_cli_generate_video", HOST_CTX).execute("call-non-owner", {
  canvas_id: canvasScoped.canvas_id,
  generation_type: "image_to_video",
  execute: true,
  run_preflight: false,
  accept_credit_spend: true
})).content[0].text);
assert.equal(nonOwner.authorization.code, GENERATION_DENIAL_CODES.SCOPE_REQUIRED, "the host owner bit is required for the operator scope");
const owner = JSON.parse((await resolveTool(apiScoped, "video_canvas_dreamina_cli_generate_video", { ...HOST_CTX, senderIsOwner: true }).execute("call-owner", {
  canvas_id: canvasScoped.canvas_id,
  generation_type: "image_to_video",
  execute: true,
  run_preflight: false,
  accept_credit_spend: true
})).content[0].text);
assert.equal(owner.authorization.code, GENERATION_DENIAL_CODES.BUDGET_LEDGER_MISSING, "an identified, scoped owner must reach the budget gate - and stop there without a ledger");
assert.equal((await dashboardSummary(apiScoped)).generation.provider_invocations, 0, "the provider must never be reached from this check");

// an actor outside the allowlist is refused even with the owner bit
const otherAgent = JSON.parse((await resolveTool(apiScoped, "video_canvas_dreamina_cli_generate_video", { ...HOST_CTX, agentId: "someone-else", senderIsOwner: true }).execute("call-other", {
  canvas_id: canvasScoped.canvas_id,
  generation_type: "image_to_video",
  execute: true,
  run_preflight: false,
  accept_credit_spend: true
})).content[0].text);
assert.equal(otherAgent.authorization.code, GENERATION_DENIAL_CODES.ACTOR_NOT_ALLOWED, "the actor allowlist must be enforced against the trusted identity");

// and the documented loosening still keeps the allowlist in charge
const apiLoosened = await registerPlugin({
  security: {
    generation: {
      allowSurfaces: ["tool"],
      allowActors: ["agent:tuan"],
      requireOperatorScope: false,
      ledger: "none",
      budget: { estimates: { "dreamina.video.generate": 10 } }
    }
  }
});
const canvasLoosened = await buildReadyCanvas(apiLoosened, HOST_CTX);
const loosenedAllowed = JSON.parse((await resolveTool(apiLoosened, "video_canvas_dreamina_cli_generate_video", HOST_CTX).execute("call-loosened", {
  canvas_id: canvasLoosened.canvas_id,
  generation_type: "image_to_video",
  execute: true,
  run_preflight: false,
  accept_credit_spend: true
})).content[0].text);
assert.equal(loosenedAllowed.authorization.code, GENERATION_DENIAL_CODES.BUDGET_LEDGER_MISSING, "requireOperatorScope=false must let the allowlisted actor through to the budget gate");
const loosenedOther = JSON.parse((await resolveTool(apiLoosened, "video_canvas_dreamina_cli_generate_video", { ...HOST_CTX, agentId: "someone-else" }).execute("call-loosened-other", {
  canvas_id: canvasLoosened.canvas_id,
  generation_type: "image_to_video",
  execute: true,
  run_preflight: false,
  accept_credit_spend: true
})).content[0].text);
assert.equal(loosenedOther.authorization.code, GENERATION_DENIAL_CODES.ACTOR_NOT_ALLOWED, "the allowlist must still govern when the scope gate is off");

for (const service of api.services ?? []) await service?.stop?.();
for (const service of apiRealShape.services ?? []) await service?.stop?.();
for (const service of apiLegacy.services ?? []) await service?.stop?.();
for (const service of apiBare.services ?? []) await service?.stop?.();
for (const service of apiScoped.services ?? []) await service?.stop?.();
for (const service of apiLoosened.services ?? []) await service?.stop?.();
await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => {});
console.log("REN-02 tool-surface identity check passed");
process.exit(0);
