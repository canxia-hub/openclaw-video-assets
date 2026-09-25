/**
 * REN-02 check: generation authorization, cost gate and the provider chokepoint.
 *
 * Layers (all zero-cost: no provider is ever contacted, adapters are spies):
 *   * unit: the ProviderGateway decision matrix - every canonical entry across every surface, the
 *     denial codes, and the structural rule that an adapter cannot run without a live allow
 *     decision;
 *   * review round 2: audit-id uniqueness under audit-trail trimming, stale-authorization replay,
 *     per-provider call budget, provider/actor binding, duplicate submission;
 *   * budget semantics: one shared pool across entries, per-entry caps, finite non-negative costs,
 *     and "no evidence => unknown cost => deny";
 *   * monitor mode: observes and refuses (no configuration turns it into an execution bypass);
 *   * end-to-end: the real service method (a real canvas, exactly like the REN-01 regression test).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { VideoAssetService } = await import("../src/service.js");
const {
  GENERATION_ENTRY_POLICY,
  GENERATION_DENIAL_CODES,
  GENERATION_SERVICE_ENTRIES,
  createMemoryBudgetLedger,
  estimateGenerationCost,
  generationEntryKeys,
  resolveBudgetLedger,
  resolveGenerationEntriesByName,
  resolveGenerationPolicy
} = await import("../src/generation-policy.js");
const {
  ProviderGateway,
  PROVIDER_IDS,
  buildTrustedContext,
  toolContextToTrustedContext,
  withTrustedContext
} = await import("../src/provider-gateway.js");

const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-ren02-authz-"));

function spyAdapters({ throwOnCall = true, result = { status: "ok" } } = {}) {
  const calls = [];
  const adapter = (provider) => async (payload) => {
    calls.push({ provider, payload });
    if (throwOnCall) throw new Error(`SPY_PROVIDER_CALLED:${provider}`);
    return { ...result, provider };
  };
  return {
    calls,
    adapters: {
      [PROVIDER_IDS.DREAMINA_CLI]: adapter(PROVIDER_IDS.DREAMINA_CLI),
      [PROVIDER_IDS.DOUBAO_AUDIO]: adapter(PROVIDER_IDS.DOUBAO_AUDIO),
      [PROVIDER_IDS.KIE_SUNO]: adapter(PROVIDER_IDS.KIE_SUNO)
    }
  };
}

/** Isolated, fully granted policy used by the focused behaviour tests (still zero-cost). */
const grantedConfig = (overrides = {}) => ({
  generation: {
    allowSurfaces: ["tool", "gateway", "browser"],
    // Trusted callers need an explicit actor grant (an empty allowlist denies every trusted actor);
    // the untrusted-path grant below is what the fail-closed tests switch off.
    allowActors: ["*"],
    unattributedPolicy: "allow-with-surface-grant",
    unattributedSurfaces: ["tool", "gateway", "browser"],
    ledger: "memory",
    budget: { totalCredits: 10_000, estimates: Object.fromEntries(generationEntryKeys().map((entry) => [entry, 10])), ...(overrides.budget ?? {}) },
    ...overrides
  }
});

// ------------------------------------------------------------------------------------------------
// 1. registry integrity + alias resolution (aliases cannot dodge the policy)
// ------------------------------------------------------------------------------------------------
assert.deepEqual(generationEntryKeys().sort(), Object.keys(GENERATION_SERVICE_ENTRIES).sort(), "every policy entry must map to a service method");
for (const [entry, definition] of Object.entries(GENERATION_ENTRY_POLICY)) {
  assert.equal(typeof definition.provider, "string", `${entry} needs a provider`);
  assert.ok(definition.tools.length + definition.rpc.length + definition.browser.length > 0, `${entry} needs at least one entry point`);
  assert.ok(Number.isInteger(definition.provider_calls_max) && definition.provider_calls_max > 0, `${entry} needs a provider call budget`);
  assert.equal(definition.cost_evidence, "unverified-reference", `${entry} reference pricing must be labelled unverified`);
  for (const name of [...definition.tools, ...definition.rpc, ...definition.browser, ...definition.browser_aliases]) {
    assert.deepEqual(resolveGenerationEntriesByName(name), [entry], `${name} must resolve to exactly ${entry}`);
  }
}
assert.deepEqual(resolveGenerationEntriesByName("videoAssets.audio.kieSunoGenerate"), ["audio.kie.generate"]);
assert.deepEqual(resolveGenerationEntriesByName("audio.kieSunoGenerate"), ["audio.kie.generate"], "the browser short alias must resolve to the same entry");
assert.deepEqual(resolveGenerationEntriesByName("video_canvas_kie_suno_audio_generate"), ["audio.kie.canvas.generate"]);
assert.deepEqual(resolveGenerationEntriesByName("videoAssets.canvas.dreaminaCliUpscaleImage"), [], "an unknown alias resolves to no entry (and the guard still lives inside the method)");
assert.deepEqual(resolveGenerationEntriesByName("video_asset_generate_derived_file"), [], "local derivative generation is intentionally outside the paid-generation policy");

// ------------------------------------------------------------------------------------------------
// 2. decision matrix across all entries and surfaces (no adapter call at all)
// ------------------------------------------------------------------------------------------------
{
  const { adapters } = spyAdapters();
  const gateway = new ProviderGateway({ config: {}, adapters });
  const codes = new Set();
  for (const entry of generationEntryKeys()) {
    for (const surface of ["tool", "gateway", "browser"]) {
      const decision = gateway.authorize({ entry, surface, params: { accept_credit_spend: true } });
      assert.equal(decision.allowed, false, `${entry}/${surface} must be denied with the fail-closed default`);
      codes.add(decision.code);
    }
  }
  assert.deepEqual([...codes], [GENERATION_DENIAL_CODES.SURFACE_NOT_ALLOWED], "the default denial must be the surface grant");
  assert.equal(gateway.stats().provider_invocations, 0, "authorization must never touch a provider");

  const unknown = await gateway.invokeAdapter({ audit_id: "pgen-does-not-exist", provider: PROVIDER_IDS.DREAMINA_CLI, payload: {} });
  assert.equal(unknown.refused, true, "an adapter call without a live authorization must be refused");
  assert.equal(unknown.code, GENERATION_DENIAL_CODES.AUTHORIZATION_UNKNOWN);
  const deniedCall = await gateway.invokeAdapter({ audit_id: "pgen-x", provider: null, payload: {} });
  assert.equal(deniedCall.refused, true);
  const denied = gateway.authorize({ entry: "dreamina.video.generate", surface: "tool" });
  assert.equal(denied.audit_id, null, "a denied decision must not mint an authorization id");
  const deniedReplay = await gateway.invokeAdapter({ audit_id: denied.audit.id, provider: PROVIDER_IDS.DREAMINA_CLI, payload: {} });
  assert.equal(deniedReplay.refused, true, "a denied audit record must not be usable to run an adapter");
  assert.equal(gateway.stats().provider_invocations, 0);
}

// ------------------------------------------------------------------------------------------------
// 3. review round 2 / issue 2: audit identity, replay, call budget, provider and actor binding
// ------------------------------------------------------------------------------------------------
{
  const { adapters } = spyAdapters({ throwOnCall: false });
  const gateway = new ProviderGateway({ config: grantedConfig(), adapters, auditLimit: 4 });
  // (a) ids stay unique once the observable trail starts trimming (the old scheme reused
  // `pgen-${records.length + 1}`, so ids repeated as soon as the trail reached auditLimit)
  const ids = [];
  for (let index = 0; index < 12; index += 1) {
    const decision = gateway.authorize({ entry: "dreamina.image.generate", surface: "tool", params: { accept_credit_spend: true } });
    assert.equal(decision.allowed, true);
    ids.push(decision.audit_id);
  }
  assert.equal(new Set(ids).size, ids.length, "authorization ids must never repeat after auditLimit trimming");
  assert.equal(ids.length, 12);
  assert.equal(gateway.recordsFor().length, 12, "live authorizations are never trimmed out of the trail");

  // (b) an OLD authorization id must never resolve to a NEWER record. Under the old scheme this was
  // exactly the failure mode: the recycled id `pgen-1` matched the newest record and a stale caller
  // would have been able to drive a live authorization.
  for (const id of ids) gateway.finalize(id, { outcome: "completed" });
  const fresh = gateway.authorize({ entry: "dreamina.image.generate", surface: "tool", params: { accept_credit_spend: true } });
  assert.equal(gateway.recordsFor().length <= 5, true, `the closed trail must trim to auditLimit (got ${gateway.recordsFor().length})`);
  assert.notEqual(fresh.audit_id, ids[0], "a new authorization must not reuse an older id");
  const stale = await gateway.invokeAdapter({ audit_id: ids[0], provider: PROVIDER_IDS.DREAMINA_CLI, payload: {} });
  assert.equal(stale.refused, true, "a closed authorization must not be replayable");
  assert.equal(stale.code, GENERATION_DENIAL_CODES.AUTHORIZATION_CLOSED, "a closed authorization must be reported as closed, not silently resolved to another record");

  // (c) a live authorization keeps its own bookkeeping even when the trail is small
  const live = await gateway.invokeAdapter({ audit_id: fresh.audit_id, provider: PROVIDER_IDS.DREAMINA_CLI, payload: {} });
  assert.equal(live.provider, PROVIDER_IDS.DREAMINA_CLI, "a closed-then-trimmed gateway must still serve its live authorization");
  const updated = gateway.recordsFor().find((record) => record.id === fresh.audit_id);
  assert.equal(updated.adapter_calls, 1, "the newest authorization must receive its own call bookkeeping");
  assert.equal(gateway.recordsFor().filter((record) => record.id === ids[0]).length, 0, "the old record is gone, and was not the one updated");
}

{
  const { adapters } = spyAdapters({ throwOnCall: false });
  const gateway = new ProviderGateway({ config: grantedConfig(), adapters });
  // (a) one Dreamina operation may issue exactly the calls its entry declares: credit-preflight +
  // asynchronously-submitted generate + up to five read-only convergence queries + credit-recheck
  // (REN-11 fix round: async submit replaced the unreliable blocking `--poll`, so the bounded
  // convergence queries are part of one operation's call sequence). The bound is read from the policy
  // so the budget cannot drift away from what the operation really needs - and it is asserted to stay
  // within a declared ceiling, so raising it is a deliberate, reviewed act rather than a silent edit.
  const entryPolicy = GENERATION_ENTRY_POLICY["dreamina.video.generate"];
  const budget = entryPolicy.provider_calls_max;
  assert.equal(Number.isInteger(budget) && budget > 0, true, "the entry must declare a positive integer call budget");
  assert.equal(budget <= 9, true, `the Dreamina call budget must stay within the reviewed ceiling (got ${budget})`);
  const decision = gateway.authorize({ entry: "dreamina.video.generate", surface: "tool", params: { accept_credit_spend: true } });
  for (let call = 1; call <= budget; call += 1) {
    const result = await gateway.invokeAdapter({ audit_id: decision.audit_id, provider: PROVIDER_IDS.DREAMINA_CLI, payload: { call } });
    assert.equal(result.provider, PROVIDER_IDS.DREAMINA_CLI, `provider call ${call} must reach the adapter`);
  }
  // ... and (b) the next call is refused because the authorization is consumed by its last allowed call
  const exhausted = await gateway.invokeAdapter({ audit_id: decision.audit_id, provider: PROVIDER_IDS.DREAMINA_CLI, payload: { call: budget + 1 } });
  assert.equal(exhausted.refused, true);
  assert.equal(exhausted.code, GENERATION_DENIAL_CODES.AUTHORIZATION_EXHAUSTED, "the provider call budget must bound one authorization");
  const stats = gateway.stats();
  assert.equal(stats.provider_invocations, budget, `exactly the ${budget} authorized calls reached the provider`);
  assert.equal(stats.authorization_refusals, 1);
}

{
  const { adapters } = spyAdapters({ throwOnCall: false });
  let now = 1_000;
  const gateway = new ProviderGateway({ config: grantedConfig({ authorizationTtlSeconds: 5 }), adapters, clock: () => now });
  const decision = gateway.authorize({ entry: "audio.kie.generate", surface: "tool", params: { accept_credit_spend: true } });
  now += 6_000;
  const expired = await gateway.invokeAdapter({ audit_id: decision.audit_id, provider: PROVIDER_IDS.KIE_SUNO, payload: {} });
  assert.equal(expired.refused, true);
  assert.equal(expired.code, GENERATION_DENIAL_CODES.AUTHORIZATION_EXPIRED, "a stale authorization must not be replayable");
  assert.equal(gateway.stats().provider_invocations, 0, "an expired authorization must not reach the provider");
  assert.ok(gateway.denials().some((record) => record.code === GENERATION_DENIAL_CODES.AUTHORIZATION_EXPIRED), "the refusal must be audited");
}

{
  const { adapters } = spyAdapters({ throwOnCall: false });
  const gateway = new ProviderGateway({ config: grantedConfig(), adapters });
  const decision = gateway.authorize({ entry: "audio.kie.generate", surface: "tool", params: { accept_credit_spend: true } });
  // provider binding: the caller cannot redirect the authorization to another provider
  const mismatch = await gateway.invokeAdapter({ audit_id: decision.audit_id, provider: PROVIDER_IDS.DREAMINA_CLI, payload: {} });
  assert.equal(mismatch.refused, true);
  assert.equal(mismatch.code, GENERATION_DENIAL_CODES.PROVIDER_MISMATCH, "the authorized provider must be enforced");
  assert.equal(gateway.stats().provider_invocations, 0);
  // actor binding: a trusted authorization cannot be replayed by a different actor
  const other = buildTrustedContext({ surface: "tool", actorId: "agent:someone-else", trusted: true, source: "host-tool-factory", scopes: ["operator.admin"] });
  const bound = gateway.authorize({ entry: "audio.kie.generate", surface: "tool", context: buildTrustedContext({ surface: "tool", actorId: "agent:tuan", trusted: true, source: "host-tool-factory", scopes: ["operator.admin"] }), params: { accept_credit_spend: true } });
  assert.equal(bound.allowed, true);
  const actorMismatch = await gateway.invokeAdapter({ audit_id: bound.audit_id, provider: PROVIDER_IDS.KIE_SUNO, payload: {}, context: other });
  assert.equal(actorMismatch.refused, true);
  assert.equal(actorMismatch.code, GENERATION_DENIAL_CODES.ACTOR_MISMATCH, "the issuing actor must be enforced");
  const sameActor = await gateway.invokeAdapter({
    audit_id: bound.audit_id,
    provider: PROVIDER_IDS.KIE_SUNO,
    payload: {},
    context: buildTrustedContext({ surface: "tool", actorId: "agent:tuan", trusted: true, source: "host-tool-factory", scopes: ["operator.admin"] })
  });
  assert.equal(sameActor.provider, PROVIDER_IDS.KIE_SUNO, "the issuing actor must still be able to use the authorization");
}

{
  const { adapters } = spyAdapters({ throwOnCall: false });
  const gateway = new ProviderGateway({ config: grantedConfig(), adapters });
  // duplicate submission: an audio entry allows exactly one provider call, and concurrent use of the
  // same authorization cannot exceed it
  const decision = gateway.authorize({ entry: "audio.doubao.generate", surface: "tool", params: { accept_credit_spend: true } });
  const results = await Promise.all([
    gateway.invokeAdapter({ audit_id: decision.audit_id, provider: PROVIDER_IDS.DOUBAO_AUDIO, payload: { n: 1 } }),
    gateway.invokeAdapter({ audit_id: decision.audit_id, provider: PROVIDER_IDS.DOUBAO_AUDIO, payload: { n: 2 } })
  ]);
  const ran = results.filter((result) => result?.refused !== true);
  const refused = results.filter((result) => result?.refused === true);
  assert.equal(ran.length, 1, "only one of two concurrent calls may use a single-call authorization");
  assert.equal(refused.length, 1);
  assert.equal(refused[0].code, GENERATION_DENIAL_CODES.AUTHORIZATION_EXHAUSTED);
  assert.equal(gateway.stats().provider_invocations, 1);
  // explicit close (the service does this when a generation method ends)
  const finalizeDecision = gateway.authorize({ entry: "audio.kie.generate", surface: "tool", params: { accept_credit_spend: true } });
  assert.equal(gateway.finalize(finalizeDecision.audit_id, { outcome: "completed" }).closed, true);
  const afterFinalize = await gateway.invokeAdapter({ audit_id: finalizeDecision.audit_id, provider: PROVIDER_IDS.KIE_SUNO, payload: {} });
  assert.equal(afterFinalize.refused, true, "a closed authorization must not be replayable");
  assert.equal(afterFinalize.code, GENERATION_DENIAL_CODES.AUTHORIZATION_CLOSED, "the refusal must say the authorization was closed, not that it never existed");
}

// ------------------------------------------------------------------------------------------------
// 4. trusted identity: the tool factory context, and what a model may NOT influence
// ------------------------------------------------------------------------------------------------
{
  const trusted = toolContextToTrustedContext({ agentId: "tuan", sessionKey: "agent:tuan:main", senderIsOwner: true });
  assert.equal(trusted.trusted, true);
  assert.equal(trusted.actor_id, "agent:tuan");
  assert.equal(trusted.source, "host-tool-factory");
  assert.deepEqual(trusted.scopes, ["operator.admin"], "the host owner bit is what grants the operator scope");
  const nonOwner = toolContextToTrustedContext({ agentId: "tuan" });
  assert.deepEqual(nonOwner.scopes, [], "without the host owner bit no operator scope is invented");
  const requesterOnly = toolContextToTrustedContext({ requesterSenderId: "ou_owner" });
  assert.equal(requesterOnly.actor_id, "user:ou_owner");
  assert.equal(requesterOnly.actor_type, "human");
  const empty = toolContextToTrustedContext({});
  assert.equal(empty.trusted, false, "an empty host context must stay unattributed");
  assert.equal(empty.actor_id, "unattributed");

  const { adapters } = spyAdapters();
  const gateway = new ProviderGateway({
    config: { generation: { allowSurfaces: ["tool"], allowActors: ["agent:tuan"], ledger: "memory", budget: { totalCredits: 100, estimates: { "audio.kie.generate": 10 } } } },
    adapters
  });
  assert.equal(gateway.authorize({ entry: "audio.kie.generate", surface: "tool", context: trusted, params: { accept_credit_spend: true, actor_id: "agent:someone-else" } }).allowed, true);
  const wrongActor = toolContextToTrustedContext({ agentId: "other", senderIsOwner: true });
  const wrongActorDecision = gateway.authorize({ entry: "audio.kie.generate", surface: "tool", context: wrongActor, params: { accept_credit_spend: true } });
  assert.equal(wrongActorDecision.allowed, false);
  assert.equal(wrongActorDecision.code, GENERATION_DENIAL_CODES.ACTOR_NOT_ALLOWED);
  const readOnly = buildTrustedContext({ surface: "tool", actorId: "agent:tuan", trusted: true, source: "host-tool-factory", scopes: ["operator.read"] });
  const scopeDecision = gateway.authorize({ entry: "audio.kie.generate", surface: "tool", context: readOnly, params: { accept_credit_spend: true } });
  assert.equal(scopeDecision.allowed, false, "a trusted context without an operator scope must be refused");
  assert.equal(scopeDecision.code, GENERATION_DENIAL_CODES.SCOPE_REQUIRED);
  const noScopes = gateway.authorize({
    entry: "audio.kie.generate",
    surface: "tool",
    context: buildTrustedContext({ surface: "tool", actorId: "agent:tuan", trusted: true, source: "host-tool-factory" }),
    params: { accept_credit_spend: true }
  });
  assert.equal(noScopes.code, GENERATION_DENIAL_CODES.SCOPE_REQUIRED, "a missing scope list is a missing scope, not a wildcard");
  // a model-supplied identity/permission inside params carries no authority
  const spoofed = gateway.authorize({
    entry: "audio.kie.generate",
    surface: "tool",
    context: readOnly,
    params: { accept_credit_spend: true, actor_id: "human:plugin-admin", scope: "operator.admin", scopes: ["operator.admin"], permission_granted: true }
  });
  assert.equal(spoofed.allowed, false, "params must never grant identity or permission");
  assert.equal(spoofed.code, GENERATION_DENIAL_CODES.SCOPE_REQUIRED);
  // requireOperatorScope=false is the documented loosening for a host that cannot supply scopes
  const loosened = new ProviderGateway({
    config: { generation: { allowSurfaces: ["tool"], allowActors: ["agent:tuan"], requireOperatorScope: false, ledger: "memory", budget: { totalCredits: 100, estimates: { "audio.kie.generate": 10 } } } },
    adapters
  });
  assert.equal(loosened.authorize({ entry: "audio.kie.generate", surface: "tool", context: toolContextToTrustedContext({ agentId: "tuan" }), params: { accept_credit_spend: true } }).allowed, true);
  assert.equal(
    loosened.authorize({ entry: "audio.kie.generate", surface: "tool", context: toolContextToTrustedContext({ agentId: "other" }), params: { accept_credit_spend: true } }).code,
    GENERATION_DENIAL_CODES.ACTOR_NOT_ALLOWED,
    "the actor allowlist still governs when the scope gate is off"
  );
}

// ------------------------------------------------------------------------------------------------
// 5. budget semantics: shared pool, per-entry caps, cost evidence, invalid costs
// ------------------------------------------------------------------------------------------------
{
  const ledger = createMemoryBudgetLedger({ budgets: { "*": 100 } });
  assert.equal(ledger.reserve("entry.a", 80).ok, true);
  const sharedView = ledger.remaining("entry.b");
  assert.equal(sharedView.shared.remaining, 20, "a second entry must see the shared pool, not a fresh full budget");
  const denied = ledger.reserve("entry.b", 30);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, GENERATION_DENIAL_CODES.BUDGET_EXCEEDED);
  assert.equal(denied.details.scope, "shared", "cross-entry over-spend must be attributed to the shared pool");
  assert.equal(ledger.reserve("entry.b", 20).ok, true, "the shared pool must still allow spending what is left");
  assert.equal(ledger.snapshot().find((row) => row.key === "*").used, 100);
  assert.equal(ledger.reserve("entry.c", 1).ok, false, "the shared pool is exhausted for every entry");
}

{
  const ledger = createMemoryBudgetLedger({ budgets: { "*": 1000, capped: 5 } });
  assert.equal(ledger.reserve("capped", 5).ok, true);
  const perEntry = ledger.reserve("capped", 1);
  assert.equal(perEntry.ok, false);
  assert.equal(perEntry.details.scope, "entry", "a per-entry cap must be enforced on top of the shared pool");
  assert.equal(ledger.snapshot().find((row) => row.key === "*").used, 5, "only the accepted reservation is debited");
  assert.equal(ledger.reserve("uncapped", 100).ok, true, "an entry without a cap uses the shared pool only");
}

{
  const ledger = createMemoryBudgetLedger({ budgets: { "*": 100 } });
  for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY, "abc", null]) {
    const result = ledger.reserve("entry.a", bad);
    assert.equal(result.ok, false, `credits=${String(bad)} must be refused`);
    assert.equal(result.code, GENERATION_DENIAL_CODES.BUDGET_INVALID_COST);
  }
  assert.equal(ledger.remaining("entry.a").shared.used, 0, "an invalid cost must not move the accounting");
  assert.equal(ledger.reserve("entry.a", 0).ok, true, "a zero cost is a valid reservation");
}

{
  // A negative configured estimate is dropped, so the entry falls back to "unknown cost" instead of
  // gaining budget (a negative number previously increased the remaining budget).
  const policy = resolveGenerationPolicy({ generation: { ledger: "memory", budget: { totalCredits: 100, estimates: { "audio.kie.generate": -50 } } } });
  const cost = estimateGenerationCost("audio.kie.generate", {}, policy);
  assert.equal(cost.credits, null);
  assert.equal(cost.source, "unknown-cost");
  assert.equal(cost.reference_credits, 30, "the unverified reference figure is reported, never charged");
  const ledger = resolveBudgetLedger(policy);
  const { adapters } = spyAdapters();
  const gateway = new ProviderGateway({ config: { generation: { allowSurfaces: ["tool"], unattributedPolicy: "allow-with-surface-grant", unattributedSurfaces: ["tool"], ledger: "memory", budget: { totalCredits: 100 } } }, adapters, ledger });
  const decision = gateway.authorize({ entry: "audio.kie.generate", surface: "tool", params: { accept_credit_spend: true } });
  assert.equal(decision.code, GENERATION_DENIAL_CODES.BUDGET_UNKNOWN_COST, "an unverified reference price is not budget evidence");
  assert.equal(decision.details.reference_credits, 30);
  assert.equal(decision.details.reference_evidence, "unverified-reference");
}

{
  // Cost evidence and the ledger are independent gates: configured estimates without a ledger are
  // still refused, which is what keeps real payment disabled until REN-10 lands the persistent one.
  const { adapters } = spyAdapters();
  const noLedger = new ProviderGateway({
    config: { generation: { allowSurfaces: ["tool"], unattributedPolicy: "allow-with-surface-grant", unattributedSurfaces: ["tool"], budget: { estimates: { "dreamina.image.generate": 8 } } } },
    adapters
  });
  const decision = noLedger.authorize({ entry: "dreamina.image.generate", surface: "tool", params: { accept_credit_spend: true } });
  assert.equal(decision.code, GENERATION_DENIAL_CODES.BUDGET_LEDGER_MISSING, "without a ledger no paid generation may run");
  assert.equal(noLedger.stats().provider_invocations, 0);
  const exceeded = new ProviderGateway({
    config: { generation: { allowSurfaces: ["tool"], unattributedPolicy: "allow-with-surface-grant", unattributedSurfaces: ["tool"], ledger: "memory", budget: { totalCredits: 100, estimates: { "dreamina.image.upscale": 9999 } } } },
    adapters
  });
  assert.equal(exceeded.authorize({ entry: "dreamina.image.upscale", surface: "tool", params: { accept_credit_spend: true } }).code, GENERATION_DENIAL_CODES.BUDGET_EXCEEDED);
}

// ------------------------------------------------------------------------------------------------
// 6. monitor mode observes and refuses (review round 2, issue 6)
// ------------------------------------------------------------------------------------------------
{
  const { adapters, calls } = spyAdapters({ throwOnCall: false });
  const gateway = new ProviderGateway({
    config: {
      generation: {
        mode: "monitor",
        allowSurfaces: ["tool"],
        unattributedPolicy: "allow-with-surface-grant",
        unattributedSurfaces: ["tool"],
        ledger: "memory",
        budget: { totalCredits: 100, estimates: { "audio.kie.generate": 10 } }
      }
    },
    adapters
  });
  const decision = gateway.authorize({ entry: "audio.kie.generate", surface: "tool", params: { accept_credit_spend: true } });
  assert.equal(decision.allowed, false, "monitor mode must not authorize a provider submission");
  assert.equal(decision.code, GENERATION_DENIAL_CODES.MONITOR_OBSERVE_ONLY);
  assert.equal(decision.audit.shadow.allowed, true, "the shadow decision must still show what enforcement would have done");
  assert.equal(decision.audit_id, null, "monitor mode must not mint an executable authorization");
  assert.equal(calls.length, 0);
  assert.equal(gateway.stats().live_authorizations, 0, "monitor mode must leave nothing executable behind");
  // Even a direct call with a fabricated id cannot reach the adapter: there is no live authorization.
  const forced = await gateway.invokeAdapter({ audit_id: "pgen-anything", provider: PROVIDER_IDS.KIE_SUNO, payload: {} });
  assert.equal(forced.refused, true);
  assert.equal(forced.code, GENERATION_DENIAL_CODES.AUTHORIZATION_UNKNOWN);
  assert.equal(calls.length, 0, "monitor mode must never submit to a provider");
  // And there is no config value that fixes it: mode is the only monitor switch, and it refuses.
  const monitoresEque = gateway.setPolicy({ generation: { mode: "monitor", allowSurfaces: ["tool"], unattributedPolicy: "allow-with-surface-grant", unattributedSurfaces: ["tool"], ledger: "memory", budget: { totalCredits: 100, estimates: { "audio.kie.generate": 10 } } } });
  assert.ok(monitoresEque, "setPolicy returns the gateway");
  assert.equal(gateway.authorize({ entry: "audio.kie.generate", surface: "tool", params: { accept_credit_spend: true } }).allowed, false);
  assert.equal(calls.length, 0);
}

// ------------------------------------------------------------------------------------------------
// 7. end-to-end through the real service method
// ------------------------------------------------------------------------------------------------
async function buildCanvasService(tag, securityConfig) {
  const repo = path.join(tmp, `repo-${tag}`);
  const source = path.join(tmp, `main-${tag}.png`);
  await fs.promises.writeFile(source, Buffer.from(png1x1, "base64"));
  const spies = spyAdapters();
  const svc = new VideoAssetService({
    pluginConfig: securityConfig ? { repositoryRoot: repo, security: securityConfig } : { repositoryRoot: repo },
    providerAdapters: spies.adapters,
    logger: { warn() {}, info() {}, error() {}, debug() {} }
  }).init();
  const project = svc.createProject({ title: `REN-02 authz ${tag}` });
  svc.updateProjectSpec({ project_id: project.project_id, target_platforms: ["douyin"], aspect_ratio: "16:9", resolution: "1920x1080", fps: 24 });
  const asset = await svc.ingestAsset({ file_path: source, title: "Main Reference", kind: "working" });
  svc.updateAssetRights({ asset_id: asset.asset_id, license_status: "cleared", risk_level: "low", source: { source_type: "internal_fixture", license_hint: "test fixture" } });
  svc.classifyAsset({ asset_id: asset.asset_id, asset_version_id: asset.default_version_id, domain: "reference", type: "main_reference", confidence: "confirmed", source: "agent" });
  const ref = svc.addProjectRef({
    project_id: project.project_id,
    asset_id: asset.asset_id,
    asset_version_id: asset.default_version_id,
    role: "reference",
    usage_scope: "REN-02 authz fixture",
    pin_mode: "pinned",
    required: true
  });
  const canvas = svc.createCanvas({ project_id: project.project_id, title: `REN-02 canvas ${tag}` });
  svc.upsertCanvasShape({
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
  return { svc, spies, canvas };
}

const generateArgs = (canvasId, extra = {}) => ({
  canvas_id: canvasId,
  generation_type: "image_to_video",
  execute: true,
  run_preflight: false,
  ingest_outputs: false,
  ...extra
});

// The fixture really reaches the gate: a dry run must be `ready` (no blockers) first.
{
  const { svc, spies, canvas } = await buildCanvasService("ready", null);
  const dry = await svc.canvasDreaminaCliGenerateVideo(generateArgs(canvas.canvas_id, { execute: false }));
  assert.equal(dry.status, "ready", `fixture must produce an unblocked plan so the gate is actually reached: ${JSON.stringify(dry.blockers ?? [])}`);
  assert.equal(spies.calls.length, 0, "a dry run must not touch a provider");
  svc.close();
}

// A: fail-closed default
{
  const { svc, spies, canvas } = await buildCanvasService("default", null);
  const result = await svc.canvasDreaminaCliGenerateVideo(generateArgs(canvas.canvas_id, { accept_credit_spend: true }));
  assert.equal(result.status, "blocked");
  assert.equal(result.authorization.code, GENERATION_DENIAL_CODES.SURFACE_NOT_ALLOWED);
  assert.equal(result.provider_invoked, false);
  assert.equal(spies.calls.length, 0, "an unauthorized call must not reach the provider adapter");
  assert.equal(svc.providerGatewayStats().provider_invocations, 0);
  assert.ok(svc.providerGatewayDenials().some((record) => record.code === GENERATION_DENIAL_CODES.SURFACE_NOT_ALLOWED));
  svc.close();
}

// B: surface granted but the caller is unattributed
{
  const { svc, spies, canvas } = await buildCanvasService("unattributed", { generation: { allowSurfaces: ["tool"] } });
  const result = await svc.canvasDreaminaCliGenerateVideo(generateArgs(canvas.canvas_id, { accept_credit_spend: true, actor_id: "human:plugin-admin", scope: "operator.admin" }));
  assert.equal(result.authorization.code, GENERATION_DENIAL_CODES.UNATTRIBUTED, "a model-supplied actor_id must not create identity");
  assert.equal(spies.calls.length, 0);
  svc.close();
}

// C: confirmation flag is required
{
  const { svc, spies, canvas } = await buildCanvasService("confirm", grantedConfig());
  const result = await svc.canvasDreaminaCliGenerateVideo(generateArgs(canvas.canvas_id));
  assert.equal(result.authorization.code, GENERATION_DENIAL_CODES.CONFIRMATION_REQUIRED);
  assert.equal(spies.calls.length, 0);
  svc.close();
}

// C2: without cost evidence the gate denies even a fully granted deployment
{
  const { svc, spies, canvas } = await buildCanvasService("no-evidence", {
    generation: { allowSurfaces: ["tool"], unattributedPolicy: "allow-with-surface-grant", unattributedSurfaces: ["tool"], ledger: "memory", budget: { totalCredits: 1000 } }
  });
  const result = await svc.canvasDreaminaCliGenerateVideo(generateArgs(canvas.canvas_id, { accept_credit_spend: true }));
  assert.equal(result.authorization.code, GENERATION_DENIAL_CODES.BUDGET_UNKNOWN_COST, "an unverified reference price is not budget evidence");
  assert.equal(spies.calls.length, 0);
  svc.close();
}

// D: authorized + budgeted -> the provider IS reached (spy throws, so the call fails visibly)
{
  const { svc, spies, canvas } = await buildCanvasService("allowed", grantedConfig());
  await assert.rejects(
    () => svc.canvasDreaminaCliGenerateVideo(generateArgs(canvas.canvas_id, { accept_credit_spend: true })),
    /SPY_PROVIDER_CALLED:dreamina_cli/,
    "an authorized call must reach the provider adapter"
  );
  assert.equal(spies.calls.length, 1);
  const stats = svc.providerGatewayStats();
  assert.equal(stats.provider_invocations, 1);
  assert.equal(stats.provider_failures, 1);
  assert.equal(stats.allowed, 1);
  assert.equal(stats.denied, 0);
  assert.equal(stats.live_authorizations, 0, "a failed operation must not leave a live authorization behind");
  svc.close();
}

// D2: the Dreamina multi-step chain (credit preflight -> generate -> credit re-check) is a REAL
// multi-call authorization: with the preflight enabled all three calls must reach the provider and
// the authorization must be consumed afterwards. The "provider" here is a zero-cost spy that speaks
// the CLI's JSON shape; nothing leaves the machine.
{
  const calls = [];
  const repo = path.join(tmp, "repo-multistep");
  const source = path.join(tmp, "main-multistep.png");
  await fs.promises.writeFile(source, Buffer.from(png1x1, "base64"));
  const svc = new VideoAssetService({
    pluginConfig: { repositoryRoot: repo, security: grantedConfig({ budget: { totalCredits: 10_000, estimates: { "dreamina.video.generate": 10 } } }) },
    providerAdapters: {
      dreamina_cli: async (payload) => {
        calls.push(payload);
        const argv = payload.argv ?? [];
        if (argv[0] === "user_credit") return { stdout: JSON.stringify({ credit: { remain: 999 }, data: { credit: 999 } }) };
        return { stdout: JSON.stringify({ gen_status: "success", submit_id: "spy-submit", videos: [] }) };
      }
    },
    logger: { warn() {}, info() {}, error() {}, debug() {} }
  }).init();
  const project = svc.createProject({ title: "REN-02 multistep" });
  svc.updateProjectSpec({ project_id: project.project_id, target_platforms: ["douyin"], aspect_ratio: "16:9", resolution: "1920x1080", fps: 24 });
  const asset = await svc.ingestAsset({ file_path: source, title: "Main Reference", kind: "working" });
  svc.updateAssetRights({ asset_id: asset.asset_id, license_status: "cleared", risk_level: "low", source: { source_type: "internal_fixture", license_hint: "test fixture" } });
  svc.classifyAsset({ asset_id: asset.asset_id, asset_version_id: asset.default_version_id, domain: "reference", type: "main_reference", confidence: "confirmed", source: "agent" });
  const ref = svc.addProjectRef({ project_id: project.project_id, asset_id: asset.asset_id, asset_version_id: asset.default_version_id, role: "reference", usage_scope: "REN-02 multistep fixture", pin_mode: "pinned", required: true });
  const canvas = svc.createCanvas({ project_id: project.project_id, title: "REN-02 multistep canvas" });
  svc.upsertCanvasShape({ canvas_id: canvas.canvas_id, shape_type: "reference_card", subject_type: "project_ref", subject_id: ref.reference_id, title: "Bound image reference", x: 0, y: 0, width: 260, height: 140, props: { generation_slot: "main_reference", stage: "shots", role: "project_ref" } });
  const result = await svc.canvasDreaminaCliGenerateVideo({
    canvas_id: canvas.canvas_id,
    generation_type: "image_to_video",
    execute: true,
    run_preflight: true,
    accept_credit_spend: true,
    download_outputs: false,
    ingest_outputs: false
  });
  assert.ok(result, "the generation method must return");
  assert.equal(calls.length, 3, `credit -> generate -> credit must be three provider calls, saw ${calls.length}`);
  assert.equal(calls[0].argv[0], "user_credit");
  assert.equal(calls[2].argv[0], "user_credit");
  assert.notEqual(calls[1].argv[0], "user_credit", "the middle call must be the generation command");
  assert.equal(svc.providerGatewayStats().provider_invocations, 3);
  assert.equal(svc.providerGatewayStats().live_authorizations, 0, "the authorization must be closed after the chain");
  assert.equal(svc.providerGatewayStats().authorization_refusals, 0, "the earlier implementation refused the second call of this chain");
  svc.close();
}

// E: budget exhausted
{
  const { svc, spies, canvas } = await buildCanvasService("budget", grantedConfig({ budget: { totalCredits: 10, estimates: { "dreamina.video.generate": 5000 } } }));
  const result = await svc.canvasDreaminaCliGenerateVideo(generateArgs(canvas.canvas_id, { accept_credit_spend: true }));
  assert.equal(result.authorization.code, GENERATION_DENIAL_CODES.BUDGET_EXCEEDED);
  assert.equal(result.authorization.estimated_credits, 5000, "the configured estimate must be used");
  assert.equal(spies.calls.length, 0, "an unbudgeted call must not reach the provider");
  svc.close();
}

// F: monitor mode never executes, even through the real service method
{
  const { svc, spies, canvas } = await buildCanvasService("monitor", {
    generation: { mode: "monitor", allowSurfaces: ["tool"], unattributedPolicy: "allow-with-surface-grant", unattributedSurfaces: ["tool"], ledger: "memory", budget: { totalCredits: 1000, estimates: { "dreamina.video.generate": 10 } } }
  });
  const result = await svc.canvasDreaminaCliGenerateVideo(generateArgs(canvas.canvas_id, { accept_credit_spend: true }));
  assert.equal(result.status, "blocked", "monitor mode must refuse the real submission");
  assert.equal(result.authorization.code, GENERATION_DENIAL_CODES.MONITOR_OBSERVE_ONLY);
  assert.equal(spies.calls.length, 0, "monitor mode must not reach a provider");
  assert.equal(svc.providerGatewayStats().provider_invocations, 0);
  svc.close();
}

// G: the ledger reserves budget per call, and the reservation is shared across entries
{
  const ledger = createMemoryBudgetLedger({ budgets: { "*": 150 } });
  const { adapters } = spyAdapters();
  const gateway = new ProviderGateway({
    config: { generation: { allowSurfaces: ["tool"], unattributedPolicy: "allow-with-surface-grant", unattributedSurfaces: ["tool"], budget: { estimates: { "dreamina.video.generate": 100, "audio.kie.generate": 60 } } } },
    adapters,
    ledger
  });
  const first = gateway.authorize({ entry: "dreamina.video.generate", surface: "tool", params: { accept_credit_spend: true } });
  assert.equal(first.allowed, true);
  assert.equal(first.audit.budget.remaining.shared, 50, "100 credits must be reserved from the shared 150");
  const second = gateway.authorize({ entry: "audio.kie.generate", surface: "tool", params: { accept_credit_spend: true } });
  assert.equal(second.code, GENERATION_DENIAL_CODES.BUDGET_EXCEEDED, "a second entry may not spend beyond the shared remainder");
  assert.equal(second.details.scope, "shared");
}

// H: a model-supplied confirmation flag does not bypass the budget, and the actor cannot be forged
{
  const { svc, spies, canvas } = await buildCanvasService("forged-actor", {
    generation: { allowSurfaces: ["tool"], allowActors: ["agent:trusted"], ledger: "memory", budget: { totalCredits: 1000, estimates: { "dreamina.video.generate": 10 } } }
  });
  const result = await svc.canvasDreaminaCliGenerateVideo(generateArgs(canvas.canvas_id, { accept_credit_spend: true, actor_id: "agent:trusted", actor_type: "agent" }));
  assert.equal(result.authorization.code, GENERATION_DENIAL_CODES.UNATTRIBUTED, "the allowlist applies to the TRUSTED actor, not to a claimed one");
  assert.equal(spies.calls.length, 0);
  svc.close();
}

await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => {});
console.log("REN-02 generation authorization/cost gate check passed");
process.exit(0);
