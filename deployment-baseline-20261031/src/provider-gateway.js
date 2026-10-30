/**
 * REN-02: the single chokepoint that may reach a paid provider.
 *
 * Every generation adapter (Dreamina CLI, Doubao audio, KIE Suno) is executed through this gateway
 * and nowhere else, so:
 *   * authorize-then-invoke is structural, not a convention: `invokeAdapter` refuses to run without
 *     a LIVE authorization for the same entry, provider and actor;
 *   * every attempt is auditable (entry, surface, attribution, cost estimate, budget outcome,
 *     per-call duration, provider result summary) without recording credentials or prompt bodies;
 *   * tests can substitute zero-cost spy adapters and assert `provider_invocations === 0` for
 *     unauthorized / unbudgeted calls.
 *
 * REN-12 finding F3 fixed here (the contract half):
 *   * the authorized audit RECORD now carries `calls_max` (and the `provider_calls_max` alias). The
 *     adapter read `audit.audit.calls_max`, never found it, fell back to 1 and force-rotated into a
 *     fresh authorization on every provider call of a phase - which is why one job was debited the
 *     estimate once per call.
 *   * `authorize({..., budget_scope})` accepts an explicit, plugin-supplied reservation scope and
 *     passes it to the ledger, so one job's chain of calls holds one reservation. A scope that is
 *     present but malformed is recorded (`budget_scope_rejected`) and ignored, which can only
 *     over-reserve.
 *   * every provider call is classified `paid` / `read_only` from its own argv against the
 *     server-side list, and the counters are reported separately. The class never grants permission:
 *     a read-only call still needs a live authorization bound to the same entry, provider and actor.
 *   * a `read_only` budget scope is a RECOVERY grant, and it is checked twice. At authorization time the
 *     ledger must PROVE (from the queue's durable row) that the provider accepted the job the scope
 *     names and that the row belongs to this entry and actor; at execution time every call under the
 *     grant must be a read whose target is exactly that submission. A paid or unrecognised call is
 *     refused before the adapter is reached, so a read-only grant can neither spend nor read another job.
 *
 * Review round 2 fixed three defects here:
*   1. Record ids were `pgen-${records.length + 1}` on a TRIMMED array, so ids were reused as soon
 *      as `auditLimit` was reached and `#find` could resolve an id to an OLD, unrelated record. Ids
 *      are now a per-gateway instance prefix plus a monotonic counter that is never reused. Live
 *      authorizations also live in their own map, so trimming the audit trail cannot resurrect or
 *      orphan an authorization.
 *   2. `invokeAdapter` ignored the caller-supplied `provider` and never compared it with the
 *      authorized provider, and it flipped the record to `succeeded` on the FIRST adapter call while
 *      the comment claimed one authorization covers several CLI calls - so the Dreamina
 *      credit -> generate -> credit chain was refused on its second call. The provider is now
 *      validated, the authorization stays live for `provider_calls_max` calls, each call is
 *      recorded separately, and the authorization is consumed when the budget of calls is used up
 *      or when it expires (stale-authorization replay is refused with a structured code).
 *   3. A monitor-mode policy authorized real submissions. Monitor now observes and refuses: the
 *      shadow decision is recorded, no authorization id is minted, and no configuration value turns
 *      monitoring into an execution bypass.
 *
 * The gateway holds no credentials. Adapters receive whatever payload the caller supplies.
 */
import { randomBytes } from "node:crypto";
import {
  GENERATION_ENTRY_POLICY,
  GENERATION_DENIAL_CODES,
  PROVIDER_CALL_CLASS,
  TRUSTED_CONTEXT,
  authorizeGeneration,
  classifyProviderCall,
  describeAttribution,
  evaluateReadOnlyGrantCall,
  BUDGET_SCOPE_INTENT,
  normalizeBudgetScope,
  resolveBudgetLedger,
  resolveGenerationPolicy
} from "./generation-policy.js";

export const PROVIDER_IDS = Object.freeze({
  DREAMINA_CLI: "dreamina_cli",
  DOUBAO_AUDIO: "doubao_audio",
  KIE_SUNO: "kie_suno"
});

/** Re-exported so ingress layers import the trusted-context seam from one place. */
export { TRUSTED_CONTEXT } from "./generation-policy.js";

export class ProviderGateway {
  /**
   * @param {object} options
   * @param {object} [options.config] `security.generation` policy block
   * @param {Record<string, Function>} [options.adapters] provider id -> adapter(payload)
   * @param {object|null} [options.ledger] budget ledger port
   * @param {() => number} [options.clock]
   * @param {number} [options.auditLimit] how many records the observable trail keeps
   * @param {string} [options.instanceId] stable id for this gateway instance (defaults to random)
   * @param {{ warn?: Function, error?: Function, info?: Function }} [options.logger]
   */
  constructor({ config = {}, adapters = {}, ledger = null, clock = () => Date.now(), auditLimit = 200, instanceId = null, logger = null } = {}) {
    this.policy = resolveGenerationPolicy(config);
    this.adapters = { ...adapters };
    this.ledger = resolveBudgetLedger(this.policy, { ledger });
    this.clock = clock;
    this.auditLimit = auditLimit;
    this.instanceId = instanceId ?? randomBytes(4).toString("hex");
    this.logger = logger;
    /** Observable audit trail (trimmed). Never authoritative for live authorizations. */
    this.records = [];
    /** Live authorizations: id -> authorization. Removed only by consumption, expiry or finalize. */
    this.authorizations = new Map();
    /**
     * Bounded record of recently closed authorizations, so a refusal can say WHY the authorization
     * is gone (consumed / expired / closed) instead of a generic "unknown". Diagnostic only: nothing
     * executable is kept here.
     */
    this.closedAuthorizations = new Map();
    this.closedLimit = 100;
    this.recordSeq = 0;
    this.counters = { attempts: 0, allowed: 0, denied: 0, provider_invocations: 0, provider_failures: 0, authorization_refusals: 0, paid_calls: 0, read_only_calls: 0, read_only_refusals: 0 };
  }

  registerAdapter(providerId, adapter) {
    if (typeof adapter !== "function") throw new Error(`adapter for ${providerId} must be a function`);
    this.adapters[providerId] = adapter;
    return this;
  }

  setLedger(ledger) {
    this.ledger = ledger;
    return this;
  }

  setPolicy(config) {
    this.policy = resolveGenerationPolicy(config);
    if (!this.ledger) this.ledger = resolveBudgetLedger(this.policy);
    return this;
  }

  entryProvider(entry) {
    return GENERATION_ENTRY_POLICY[entry]?.provider ?? null;
  }

  entryProviderCallsMax(entry) {
    const value = Number(GENERATION_ENTRY_POLICY[entry]?.provider_calls_max);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  /**
   * Authorize one paid generation operation. No provider side effect happens here.
   * @param {object} request
   * @param {string} request.entry
   * @param {"tool"|"gateway"|"browser"} request.surface
   * @param {object|null} [request.context] trusted caller context (never model-supplied)
   * @param {object} [request.params] caller parameters (confirmation flag only)
   * @param {{key:string,kind:string}|null} [request.budget_scope] trusted reservation scope
   * @returns {{allowed:boolean, code?:string, error?:string, details?:object, audit_id:string|null, audit:object}}
   */
  authorize({ entry, surface, context = null, params = {}, budget_scope = null }) {
    const provider = this.entryProvider(entry);
    const callsMax = this.entryProviderCallsMax(entry);
    // Every authorization gets a scope, so every reservation has a durable identity. A caller that names
    // one (the queue's adapter, with the job's ledger row) keeps it; otherwise the gateway mints one from
    // the record id, which is unique per gateway instance and never reused. That is what makes the
    // ordinary tool surface a first-class citizen of the durable ledger instead of an unkeyed
    // reservation the ledger has to refuse.
    const recordSeqForScope = this.recordSeq + 1;
    const declaredScope = normalizeBudgetScope(budget_scope);
    const scopeRejected = budget_scope !== null && budget_scope !== undefined && declaredScope === null;
    const scope = declaredScope ?? { key: `authorization:${this.instanceId}:${recordSeqForScope}`, kind: "authorization", intent: "paid" };
    this.counters.attempts += 1;
    // A `read_only` scope is a RECOVERY grant: it may reuse an existing reservation without re-checking
    // today's caps, so the gateway demands durable proof that the provider accepted the job the scope
    // names. The proof comes from the LEDGER's durable view (the queue's own row), never from the scope
    // the caller passed and never from the mere existence of a budget row. A malformed or unverifiable
    // read-only scope is a refusal, not an over-reservation: this is the one place where dropping the
    // caller's declaration would not fail safe.
    const decision = authorizeGeneration({
      entry,
      surface,
      context,
      params,
      policy: this.policy,
      ledger: this.ledger,
      budget_scope: scope,
      verify_read_only: scope.intent === "read_only"
        ? ({ scope: requested }) => (typeof this.ledger?.verifyReadOnlyBinding === "function"
          ? this.ledger.verifyReadOnlyBinding({
            key: requested?.key ?? null,
            entry,
            actor_id: describeAttribution(context).actor_id ?? null
          })
          : {
            ok: false,
            code: GENERATION_DENIAL_CODES.READ_ONLY_BINDING_REQUIRED,
            reason: `the ledger in use (${this.ledger?.kind ?? "none"}) cannot verify that a provider accepted this job`
          })
        : null
    });

    if (!decision.allowed) {
      this.counters.denied += 1;
      const record = this.#record({
        status: "denied",
        code: decision.code,
        error: decision.error,
        details: decision.details,
        entry,
        provider,
        surface,
        attribution: describeAttribution(context),
        estimate: decision.audit?.cost ?? null,
        shadow: decision.audit?.shadow ?? null
      });
      this.logger?.warn?.(`[video-assets] generation denied entry=${entry} surface=${surface} code=${decision.code} actor=${record.attribution.actor_id}`);
      return { allowed: false, code: decision.code, error: decision.error, details: decision.details, audit_id: null, audit: record, authority: decision };
    }

    if (!provider || typeof this.adapters[provider] !== "function") {
      this.counters.denied += 1;
      const record = this.#record({
        status: "denied",
        code: GENERATION_DENIAL_CODES.ENTRY_UNKNOWN,
        error: `no adapter is registered for provider ${String(provider)}`,
        details: { entry, provider, adapters: Object.keys(this.adapters) },
        entry,
        provider,
        surface,
        attribution: describeAttribution(context),
        estimate: decision.audit?.cost ?? null
      });
      this.logger?.warn?.(`[video-assets] generation denied entry=${entry}: no adapter for provider ${String(provider)}`);
      return { allowed: false, code: record.code, error: record.error, details: record.details, audit_id: null, audit: record, authority: decision };
    }

    this.counters.allowed += 1;
    const record = this.#record({
      status: "authorized",
      code: "OK",
      entry,
      provider,
      surface,
      attribution: decision.audit?.attribution ?? describeAttribution(context),
      estimate: decision.audit?.cost ?? null,
      budget: decision.audit?.budget ?? null,
      mode: decision.mode ?? this.policy.mode,
      // The provider-call allowance the authorization below is created with. Publishing it here is the
      // contract fix: the adapter's rotation depends on reading the SAME number the gateway enforces.
      calls_max: callsMax,
      provider_calls_max: callsMax,
      budget_scope: scope,
      budget_scope_rejected: scopeRejected,
      read_only_binding: decision.read_only_binding ?? null
    });
    // The live authorization is the authority for execution; the audit record is a projection of it.
    const authorization = {
      id: record.id,
      entry,
      provider,
      surface,
      attribution: record.attribution,
      estimate: record.estimate,
      budget: record.budget,
      mode: this.policy.mode,
      calls_max: callsMax,
      calls: [],
      // The leased scope: reusable by every call of this authorization, settled when it closes.
      budget_scope: scope,
      // The ACCEPTED submission a read-only grant is bound to (null for a paid grant). Every call under a
      // read-only grant is checked against it, so the grant cannot be walked off the job it recovers.
      read_only_binding: decision.read_only_binding ?? null,
      // Calls actually made under this authorization, so the close path can tell "nothing was spent"
      // (release the reservation) from "a provider call happened" (commit it).
      invocation_count: 0,
      created_at: this.clock(),
      expires_at: this.clock() + this.policy.authorizationTtlSeconds * 1000
    };
    this.authorizations.set(record.id, authorization);
    return { allowed: true, code: "OK", audit_id: record.id, audit: record, authority: decision };
  }

  /**
   * Execute one provider adapter call under a live authorization.
   *
   * Refusals are structured and audited (never thrown away silently): unknown/expired/exhausted
   * authorization, provider mismatch, actor mismatch, monitor-mode execution. A refusal never
   * reaches the adapter, which is what keeps "denied => provider not called" a property of the code.
   */
  async invokeAdapter({ audit_id, provider = null, payload = {}, context = null }) {
    const id = String(audit_id ?? "");
    const authorization = this.authorizations.get(id);
    if (!authorization) {
      const closed = this.closedAuthorizations.get(id);
      if (closed) return this.#refuse(id, closed.code, `provider call refused: authorization ${id} is no longer live (${closed.reason})`, closed.details, null);
      return this.#refuse(id, GENERATION_DENIAL_CODES.AUTHORIZATION_UNKNOWN, "provider call refused: unknown or no-longer-live authorization", { provider: provider ?? null });
    }
    if (this.clock() > authorization.expires_at) {
      this.#close(id, "expired");
      return this.#refuse(id, GENERATION_DENIAL_CODES.AUTHORIZATION_EXPIRED, "provider call refused: the authorization has expired", {
        expired_at: new Date(authorization.expires_at).toISOString(),
        ttl_seconds: this.policy.authorizationTtlSeconds
      }, authorization);
    }
    if (provider !== null && provider !== undefined && provider !== authorization.provider) {
      return this.#refuse(id, GENERATION_DENIAL_CODES.PROVIDER_MISMATCH, `provider call refused: authorization ${id} is for provider ${authorization.provider}, not ${String(provider)}`, {
        authorized_provider: authorization.provider,
        requested_provider: String(provider)
      }, authorization);
    }
    if (authorization.calls.length >= authorization.calls_max) {
      this.#close(id, "exhausted");
      return this.#refuse(id, GENERATION_DENIAL_CODES.AUTHORIZATION_EXHAUSTED, `provider call refused: authorization ${id} already used its ${authorization.calls_max} provider call(s)`, {
        calls_max: authorization.calls_max,
        calls: authorization.calls.length
      }, authorization);
    }
    const caller = describeAttribution(context);
    const bound = authorization.attribution ?? describeAttribution(null);
    if (bound.actor_id !== "unattributed" && caller.actor_id !== bound.actor_id) {
      return this.#refuse(id, GENERATION_DENIAL_CODES.ACTOR_MISMATCH, `provider call refused: authorization ${id} belongs to ${bound.actor_id}, not ${caller.actor_id}`, {
        authorized_actor: bound.actor_id,
        caller_actor: caller.actor_id
      }, authorization);
    }
    const adapter = this.adapters[authorization.provider];
    if (typeof adapter !== "function") {
      return this.#refuse(id, GENERATION_DENIAL_CODES.ENTRY_UNKNOWN, `provider call refused: no adapter for ${String(authorization.provider)}`, { provider: authorization.provider }, authorization);
    }

    const callClass = classifyProviderCall({ provider: authorization.provider, payload });
    // A read-only grant authorizes COLLECTION of one accepted submission, and the check is made here, on
    // the call itself - the first implementation only classified the call and never asked whether THIS
    // grant was allowed to make it, which is how a scope minted with `intent: "read_only"` executed a
    // paid generation. The decision is refused before the adapter is reached and before the call is
    // recorded against the grant's allowance, so a refused call neither spends credits nor eats the
    // allowance of the recovery grant that is still being used to collect the accepted result.
    if (authorization.budget_scope?.intent === BUDGET_SCOPE_INTENT.READ_ONLY) {
      const verdict = evaluateReadOnlyGrantCall({ provider: authorization.provider, payload, binding: authorization.read_only_binding });
      if (!verdict.ok) {
        this.counters.read_only_refusals += 1;
        return this.#refuse(id, verdict.code, `provider call refused: the read-only grant for authorization ${id} does not cover this call (${verdict.details?.subcommand ?? "no subcommand"})`, {
          ...verdict.details,
          scope_key: authorization.budget_scope?.key ?? null,
          bound_submission: authorization.read_only_binding?.provider_request_id ?? null,
          calls_recorded: authorization.calls.length
        }, authorization);
      }
    }
    const call = { n: authorization.calls.length + 1, provider: authorization.provider, at: new Date(this.clock()).toISOString(), status: "invoked", call_class: callClass, duration_ms: null, provider_status: null, error: null };
    authorization.calls.push(call);
    authorization.invocation_count = authorization.calls.length;
    this.counters.provider_invocations += 1;
    if (callClass === PROVIDER_CALL_CLASS.READ_ONLY) this.counters.read_only_calls += 1;
    else this.counters.paid_calls += 1;
    this.#syncCallCount(id, authorization);
    this.logger?.info?.(
      `[video-assets] generation invoked entry=${authorization.entry} provider=${authorization.provider} surface=${authorization.surface} actor=${bound.actor_id} class=${callClass} call=${call.n}/${authorization.calls_max}`
    );
    const startedAt = this.clock();
    try {
      const result = await adapter(payload);
      call.status = "succeeded";
      call.duration_ms = this.clock() - startedAt;
      call.provider_status = summarizeProviderResult(result);
      this.#update(id, { provider_status: call.provider_status, adapter_calls: authorization.calls.length });
      if (authorization.calls.length >= authorization.calls_max) this.#close(id, "consumed");
      return result;
    } catch (error) {
      call.status = "failed";
      call.duration_ms = this.clock() - startedAt;
      call.error = error instanceof Error ? error.message : String(error);
      this.counters.provider_failures += 1;
      this.#update(id, { provider_status: { status: "failed", error: call.error }, adapter_calls: authorization.calls.length });
      this.#close(id, "failed");
      this.logger?.error?.(`[video-assets] generation failed entry=${authorization.entry} provider=${authorization.provider}: ${call.error}`);
      throw error;
    }
  }

  /** Convenience: authorize and, when allowed, run a zero-argument thunk through the adapter. */
  async invoke({ entry, surface, context = null, params = {}, run }) {
    const decision = this.authorize({ entry, surface, context, params });
    if (!decision.allowed) return { allowed: false, code: decision.code, error: decision.error, details: decision.details, audit: decision.audit };
    if (typeof run !== "function") throw new Error("provider gateway requires a run function when allowed");
    const result = await this.invokeAdapter({
      audit_id: decision.audit_id,
      provider: decision.audit.provider,
      context,
      payload: run({ entry, provider: decision.audit.provider, estimate: decision.audit.estimate, audit_id: decision.audit_id })
    });
    return { allowed: true, result, audit: this.#find(decision.audit_id) };
  }

  /** Explicitly close one live authorization (service calls this when a generation method ends). */
  finalize(audit_id, { outcome = "completed" } = {}) {
    const id = String(audit_id ?? "");
    if (!this.authorizations.has(id)) return { closed: false, reason: "not live" };
    this.#close(id, outcome);
    return { closed: true, outcome };
  }

  /**
   * Close the reservation lease of one authorization.
   *
   * A reservation is not the same thing as a spend: an authorization that never reached the provider
   * reserved credits for nothing, so its scope is RELEASED and the pool gets the amount back. One that
   * did reach the provider is COMMITTED, with `actual_credits` left NULL unless there is evidence for a
   * number. The settle is delegated to the ledger (`settle`), which knows whether the scope is a job row
   * it must not touch or a scope record it owns.
   */
  #settleScope(authorization, outcome) {
    if (!authorization || typeof this.ledger?.settle !== "function") return { settled: false, reason: "no ledger settle port" };
    const scope = authorization.budget_scope;
    if (!scope?.key) return { settled: false, reason: "the authorization holds no scope" };
    const invocations = Number(authorization.invocation_count ?? authorization.calls?.length ?? 0);
    const state = invocations > 0 ? "committed" : "released";
    try {
      return this.ledger.settle(scope.key, { state, actual_credits: null });
    } catch (error) {
      this.logger?.warn?.(`[video-assets] settling budget scope ${scope.key} failed: ${error instanceof Error ? error.message : String(error)}`);
      return { settled: false, reason: "settle threw", error: String(error?.message ?? error) };
    }
  }

  /** Close a scope explicitly (used when an authorization is abandoned without a provider call). */
  settleScope(audit_id, { state = null } = {}) {
    const authorization = this.authorizations.get(String(audit_id ?? ""));
    if (!authorization) return { settled: false, reason: "not live" };
    return this.#settleScope(authorization, state ?? "released");
  }

  /** Audit trail (newest last). Contains no credentials and no prompt bodies. */
  recordsFor() {
    return this.records.map((record) => ({ ...record }));
  }

  /** Live authorizations (for diagnostics/tests; never contains credentials). */
  liveAuthorizations() {
    return [...this.authorizations.values()].map((authorization) => ({
      id: authorization.id,
      entry: authorization.entry,
      provider: authorization.provider,
      surface: authorization.surface,
      actor_id: authorization.attribution?.actor_id ?? "unattributed",
      calls: authorization.calls.length,
      calls_max: authorization.calls_max,
      expires_at: new Date(authorization.expires_at).toISOString(),
      mode: authorization.mode,
      scope_intent: authorization.budget_scope?.intent ?? null,
      scope_key: authorization.budget_scope?.key ?? null,
      read_only_bound_submission: authorization.read_only_binding?.provider_request_id ?? null
    }));
  }

  stats() {
    return {
      ...this.counters,
      audit_records: this.records.length,
      live_authorizations: this.authorizations.size,
      policy: {
        mode: this.policy.mode,
        allow_surfaces: this.policy.allowSurfaces,
        allow_actors: this.policy.allowActors,
        unattributed_policy: this.policy.unattributedPolicy,
        require_budget: this.policy.requireBudget,
        require_confirmation: this.policy.requireConfirmation,
        require_operator_scope: this.policy.requireOperatorScope,
        authorization_ttl_seconds: this.policy.authorizationTtlSeconds,
        ledger: this.ledger?.kind ?? "none",
        budget: this.ledger?.snapshot?.() ?? null
      },
      adapters: Object.keys(this.adapters),
      recent: this.records.slice(-10).map((record) => ({
        at: record.at,
        entry: record.entry,
        surface: record.surface,
        status: record.status,
        code: record.code,
        actor_id: record.attribution?.actor_id ?? "unattributed",
        actor_source: record.attribution?.source ?? "unattributed"
      }))
    };
  }

  denials() {
    return this.records.filter((record) => record.status === "denied" || record.status === "refused").map((record) => ({ ...record }));
  }

  #record(partial) {
    this.recordSeq += 1;
    const record = {
      id: `pgen-${this.instanceId}-${this.recordSeq}`,
      at: new Date(this.clock()).toISOString(),
      duration_ms: null,
      budget: null,
      details: null,
      error: null,
      provider_status: null,
      adapter_calls: 0,
      calls: [],
      shadow: null,
      calls_max: null,
      provider_calls_max: null,
      budget_scope: null,
      budget_scope_rejected: false,
      ...partial
    };
    this.records.push(record);
    if (this.records.length > this.auditLimit) {
      // Trim oldest-first, but never drop a record whose authorization is still live: an audit trail
      // that silently loses a live authorization would lose the bookkeeping of its provider calls.
      const kept = [];
      let budget = this.auditLimit;
      for (let index = this.records.length - 1; index >= 0; index -= 1) {
        const candidate = this.records[index];
        if (this.authorizations.has(candidate.id)) {
          kept.push(candidate);
          continue;
        }
        if (budget > 0) {
          kept.push(candidate);
          budget -= 1;
        }
      }
      this.records = kept.reverse();
    }
    return record;
  }

  #update(id, patch) {
    const record = this.#find(id);
    if (record) Object.assign(record, patch);
    return record;
  }

  /** Search from the newest record: ids are unique, but the newest hit is the live one by definition. */
  #find(id) {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      if (this.records[index].id === id) return this.records[index];
    }
    return null;
  }

  #syncCallCount(id, authorization) {
    this.#update(id, { adapter_calls: authorization.calls.length, calls: authorization.calls.map((call) => ({ ...call })) });
  }

  #close(id, outcome) {
    const authorization = this.authorizations.get(id);
    // Settle the reservation the moment the authorization stops being live, in every close path
    // (consumed / exhausted / expired / failed / explicit finalize). A scope that is never settled is a
    // permanent reservation against the pool, which is the opposite of accounting.
    const settled = this.#settleScope(authorization, outcome);
    this.authorizations.delete(id);
    if (!authorization) return null;
    const reason = outcome;
    const code = reason === "expired"
      ? GENERATION_DENIAL_CODES.AUTHORIZATION_EXPIRED
      : reason === "consumed" || reason === "exhausted"
        ? GENERATION_DENIAL_CODES.AUTHORIZATION_EXHAUSTED
        : GENERATION_DENIAL_CODES.AUTHORIZATION_CLOSED;
    this.closedAuthorizations.set(id, {
      reason,
      code,
      at: new Date(this.clock()).toISOString(),
      details: { reason, entry: authorization.entry, provider: authorization.provider, calls: authorization.calls.length, calls_max: authorization.calls_max, scope_settled: settled?.state ?? null }
    });
    if (this.closedAuthorizations.size > this.closedLimit) {
      const oldest = this.closedAuthorizations.keys().next().value;
      this.closedAuthorizations.delete(oldest);
    }
    this.#update(id, {
      authorization_state: outcome,
      authorization_closed_at: new Date(this.clock()).toISOString(),
      adapter_calls: authorization.calls.length,
      budget_scope_settled: settled?.state ?? null,
      calls: authorization.calls.map((call) => ({ ...call }))
    });
    return authorization;
  }

  #refuse(id, code, error, details, authorization = null) {
    this.counters.authorization_refusals += 1;
    this.counters.denied += 1;
    const record = this.#record({
      status: "refused",
      code,
      error,
      details,
      entry: authorization?.entry ?? null,
      provider: authorization?.provider ?? details?.provider ?? null,
      surface: authorization?.surface ?? null,
      attribution: authorization?.attribution ?? describeAttribution(null),
      authorization_id: id
    });
    this.logger?.warn?.(`[video-assets] provider call refused code=${code} authorization=${id}: ${error}`);
    return { refused: true, code, error, details, audit: record, audit_id: null };
  }
}

/**
 * True when a thrown error is a generation-policy REFUSAL (budget, authorization, identity, scope,
 * quota, monitor mode) rather than a transient provider/transport failure.
 *
 * Adapters use this to decide whether an error is a DECISION that must be surfaced (a refusal will be
 * refused the same way again) or a transient failure that may be retried inside a bounded budget.
 * Prefix matching is deliberate: a denial code added to `generation-policy.js` must not be silently
 * downgraded to "transient" just because nobody updated a list here.
 */
export function isGenerationRefusal(error) {
  const code = String(error?.code ?? "");
  if (!code) return false;
  if (Object.values(GENERATION_DENIAL_CODES).includes(code)) return true;
  // The adapter-level denial (a refusal raised by `beginGeneration` before any provider call).
  if (code === "GENERATION_PROVIDER_AUTHORIZATION_DENIED") return true;
  // `GENERATION_PROVIDER_MISMATCH` is the gateway's own provider-binding refusal; the CLI/transport
  // codes (`GENERATION_PROVIDER_CLI_FAILED` and friends) stay transient.
  if (code === "GENERATION_PROVIDER_MISMATCH") return true;
  return /^GENERATION_(BUDGET|AUTHORIZATION|ACTOR|UNATTRIBUTED|SURFACE|SCOPE|MONITOR)_/.test(code);
}

function summarizeProviderResult(result) {
  if (!result || typeof result !== "object") return { status: typeof result };
  return {
    status: result.status ?? null,
    provider: result.provider ?? null,
    task_id: result.task_id ?? null,
    gen_status: result.gen_status ?? null,
    output_count: Array.isArray(result.outputs) ? result.outputs.length : null
  };
}

/**
 * Build the trusted context object the ingress layers attach to a service call.
 * Kept here so every surface produces the same shape.
 */
export function buildTrustedContext({ surface, actorId = null, actorType = null, trusted = false, source = "unattributed", scopes = undefined } = {}) {
  return {
    surface,
    actor_id: actorId ?? "unattributed",
    actor_type: actorType ?? "unknown",
    trusted: trusted === true,
    source,
    scopes: Array.isArray(scopes) ? [...scopes] : undefined,
    attached_at: new Date().toISOString()
  };
}

/**
 * Map a host-supplied tool context (`OpenClawPluginToolContext`) to the trusted context.
 *
 * This is the seam that gives the tool surface a real identity: the host builds the context from the
 * active run (agent id, session, requester, owner bit) and hands it to the tool factory, so the
 * values never come from model-supplied arguments. Anything the host does not supply is reported as
 * `unattributed` rather than guessed.
 */
export function toolContextToTrustedContext(ctx, { surface = "tool" } = {}) {
  const host = ctx && typeof ctx === "object" ? ctx : {};
  const agentId = typeof host.agentId === "string" && host.agentId.trim() ? host.agentId.trim() : null;
  const requester = typeof host.requesterSenderId === "string" && host.requesterSenderId.trim() ? host.requesterSenderId.trim() : null;
  const actorId = agentId ? `agent:${agentId}` : requester ? `user:${requester}` : null;
  const scopes = [];
  if (host.senderIsOwner === true) scopes.push("operator.admin");
  return buildTrustedContext({
    surface,
    actorId,
    actorType: agentId ? "agent" : requester ? "human" : null,
    trusted: actorId !== null,
    source: actorId ? "host-tool-factory" : "unattributed",
    scopes
  });
}

/** Attach a trusted context to a service input object without going through JSON. */
export function withTrustedContext(input, context) {
  const target = input && typeof input === "object" ? { ...input } : {};
  Object.defineProperty(target, TRUSTED_CONTEXT, { value: context, enumerable: false, configurable: true });
  return target;
}

export function trustedContextOf(input) {
  if (input && typeof input === "object" && input[TRUSTED_CONTEXT]) return input[TRUSTED_CONTEXT];
  return null;
}
