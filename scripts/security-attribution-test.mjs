/**
 * REN-02 check: trusted actor attribution.
 *
 * Acceptance: "actor attribution must come from a trusted call context; a model-supplied actor_id has
 * no authentication value". This check proves that with the real service and the real gateway RPC
 * adapter:
 *   * a trusted context wins over `params.actor_id` (including an attempt to impersonate the admin);
 *   * without a trusted context, the model-supplied value is preserved but labelled
 *     `request-param`, and it cannot authorize generation;
 *   * the gateway RPC handler reads identity/scopes from the host context only.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { VideoAssetService } = await import("../src/service.js");
const { TRUSTED_CONTEXT, buildTrustedContext, withTrustedContext, trustedContextOf } = await import("../src/provider-gateway.js");
const { createGatewayRpcHandler } = await import("../src/gateway-rpc.js");
const { WRITE_SCOPE, READ_SCOPE } = await import("../src/sdk-compat.js");

const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-ren02-attr-"));
const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: path.join(tmp, "repo") }, logger: { warn() {}, info() {}, error() {}, debug() {} } }).init();
const source = path.join(tmp, "asset.png");
await fs.promises.writeFile(source, Buffer.from(png1x1, "base64"));
const asset = await svc.ingestAsset({ file_path: source, title: "Attribution fixture", kind: "working" });

// 1. symbol-keyed context cannot be produced by JSON request bodies
const roundTripped = JSON.parse(JSON.stringify(withTrustedContext({ a: 1 }, buildTrustedContext({ surface: "tool" }))));
assert.equal(roundTripped[TRUSTED_CONTEXT], undefined, "a JSON round-trip must not be able to produce a trusted context");
assert.equal(typeof TRUSTED_CONTEXT, "symbol");
assert.equal(trustedContextOf(withTrustedContext({}, buildTrustedContext({ surface: "browser", actorId: "agent:tuan", trusted: true, source: "plugin-session" })))?.actor_id, "agent:tuan");

// 2. attribution resolution
{
  const untrusted = svc.resolveRequestActor({ actor_id: "human:plugin-admin", actor_type: "human" });
  assert.equal(untrusted.actor_id, "human:plugin-admin");
  assert.equal(untrusted.trusted, false);
  assert.equal(untrusted.actor_source, "request-param", "a wire value must be labelled as unverified provenance");

  const unattributed = svc.resolveRequestActor({});
  assert.equal(unattributed.actor_id, "agent:unknown");
  assert.equal(unattributed.actor_source, "default-unattributed");

  const trusted = svc.resolveRequestActor(withTrustedContext({ actor_id: "human:plugin-admin" }, buildTrustedContext({ surface: "browser", actorId: "agent:tuan", actorType: "agent", trusted: true, source: "plugin-session" })));
  assert.equal(trusted.actor_id, "agent:tuan", "the trusted context must win over the wire value");
  assert.equal(trusted.trusted, true);
  assert.equal(trusted.actor_source, "plugin-session");
}

// 3. the trusted actor is what reaches the commits table
{
  svc.classifyAsset({ asset_id: asset.asset_id, asset_version_id: asset.default_version_id, domain: "reference", type: "main_reference", confidence: "confirmed", source: "agent", actor_id: "human:plugin-admin" });
  const first = svc.listCommits({ target_id: asset.asset_id, scope: "asset", action: "asset.classify" });
  assert.equal(first.length, 1);
  assert.equal(first[0].actor_id, "human:plugin-admin", "without a trusted context the legacy wire value is still recorded (compatibility)");

  svc.classifyAsset(withTrustedContext({ asset_id: asset.asset_id, asset_version_id: asset.default_version_id, domain: "reference", type: "image_reference", confidence: "confirmed", source: "agent", actor_id: "human:plugin-admin" }, buildTrustedContext({ surface: "gateway", actorId: "agent:tuan", actorType: "agent", trusted: true, source: "host-context" })));
  const commits = svc.listCommits({ target_id: asset.asset_id, scope: "asset", action: "asset.classify" });
  assert.equal(commits.length, 2);
  assert.equal(commits[0].actor_id, "agent:tuan", "a trusted context must override an admin impersonation attempt");
  assert.equal(commits[1].actor_id, "human:plugin-admin", "the earlier unattributed commit must stay as recorded");
}

// 4. gateway RPC: identity and scopes come from the host context only
{
  const seen = [];
  const handler = createGatewayRpcHandler({
    scope: WRITE_SCOPE,
    handler: (params) => {
      seen.push(trustedContextOf(params));
      return { ok: true };
    }
  });

  const respond = (ok, payload) => seen.push({ respond: ok, payload });
  await handler({ params: { asset_id: asset.asset_id }, respond, trustedScopes: [WRITE_SCOPE], actorId: "agent:tuan" });
  assert.equal(seen[0].surface, "gateway");
  assert.equal(seen[0].actor_id, "agent:tuan");
  assert.equal(seen[0].trusted, true);
  assert.deepEqual(seen[0].scopes, [WRITE_SCOPE]);
  assert.equal(seen[1].respond, true, "an authorized gateway call must succeed");

  seen.length = 0;
  await handler({ params: { asset_id: asset.asset_id, actor_id: "human:plugin-admin", scope: "operator.admin" }, respond });
  assert.equal(seen[0].actor_id, "unattributed", "a missing host identity must stay unattributed, not adopt the wire value");
  assert.equal(seen[0].trusted, true, "the surface is still a trusted host call, but with no actor");
  assert.equal(seen[0].scopes, undefined);

  seen.length = 0;
  await handler({ params: { asset_id: asset.asset_id }, respond, trustedScopes: [READ_SCOPE], actorId: "agent:reader" });
  assert.equal(seen[0].respond, false, "insufficient trusted scope must be refused");
  assert.equal(seen[0].payload.code, "VIDEO_ASSETS_FORBIDDEN");
}

// 5. a wire-supplied actor/permission cannot authorize paid generation
{
  const serviceWithSpy = new VideoAssetService({
    pluginConfig: {
      repositoryRoot: path.join(tmp, "repo-spy"),
      security: { generation: { allowSurfaces: ["tool"] } }
    },
    providerAdapters: {},
    logger: { warn() {}, info() {}, error() {}, debug() {} }
  }).init();
  const decision = serviceWithSpy.beginGeneration({
    entry: "audio.kie.generate",
    input: { actor_id: "human:plugin-admin", actor_type: "human", scope: "operator.admin", scopes: ["operator.admin"], trusted: true, accept_cost: true }
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.public.code, "GENERATION_UNATTRIBUTED");
  assert.equal(decision.public.actor.trusted, false);
  assert.equal(decision.public.actor.source, "unattributed");
  serviceWithSpy.close();
}

svc.close();
await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => {});
console.log("REN-02 attribution check passed");
process.exit(0);
