/**
 * REN-02: single source of truth for "may this generation run reach a provider, and is there budget".
 *
 * Design decisions (full rationale in the package's `security/REN-02-security-report.md`):
 *
 * 1. The policy is keyed by a canonical ENTRY id owned by the service layer, never by the
 *    caller-supplied tool or RPC name. Aliases (browser short names, `videoAssets.` prefixes, the
 *    snake_case tool spelling) therefore cannot reach a different, laxer policy: the guard runs
 *    inside the generation method itself, so every entry point and every alias lands on the same
 *    decision. `GENERATION_ENTRY_POLICY` lists the known names per surface, and
 *    `src/generation-registry.js` declares, name by name, which names are provider operations at
 *    all (closed world - an unclassified registration is a hard failure).
 * 2. Authorization never reads identity or permission from model-supplied parameters. Identity and
 *    scopes come from a trusted host context only (`TRUSTED_CONTEXT`), attached by the ingress layer
 *    (tool factory context / gateway host context / plugin session) - never from `params.actor_id`,
 *    `params.scope` or a "permission" field in the request.
 * 3. The gate is fail-closed: with the default configuration every provider execution is denied.
 *    Deployment has to opt in explicitly (surfaces, actors, and a budget source).
 * 4. Real provider execution requires BOTH an authorization decision and a resolvable budget with
 *    EVIDENCE-BEARING cost estimates. The cost constants shipped with each entry are labelled
 *    reference figures, not budget evidence: without an operator-supplied estimate the entry is
 *    denied with `GENERATION_BUDGET_UNKNOWN_COST` rather than "estimated" from an unverified
 *    number. The persistent ledger belongs to REN-10; this package ships the ledger PORT plus a
 *    zero-cost in-memory implementation so the gate is provable today without spending credits.
 * 5. A dry run (`execute !== true`) never reaches the gate: planning is free and stays available
 *    even for an unconfigured deployment.
 * 6. `monitor` mode OBSERVES; it never authorizes a real provider submission. There is deliberately
 *    no configuration value that turns monitoring into an execution bypass: a monitoring deployment
 *    records what enforcement WOULD have decided (the shadow decision) and still refuses the call.
 *
 * REN-12 finding F3 fixed here (budget semantics per JOB, not per provider call):
 *   * One paid GENERATION costs one estimate. A job legitimately makes several provider calls
 *     (credit preflight -> generate -> credit recheck, then read-only `query_result` polling), and
 *     every one of them still needs a live, actor/TTL/provider/call-quota-bound authorization. What
 *     must NOT happen is one more reservation of the paid estimate per call: that made a grant sized
 *     as "one estimate per job" fail at the third call, and the refusal was swallowed as an unknown
 *     poll outcome.
 *   * `authorizeGeneration` therefore accepts an explicit `budget_scope` (`{key, kind}`) supplied by
 *     trusted plugin code - never by a request field. The ledger reuses an existing reservation for
 *     the same key instead of debiting again, so a job's chain of calls holds ONE reservation.
 *   * A provider call is classified `paid` or `read_only` from the payload's own subject against the
 *     server-side `READ_ONLY_PROVIDER_SUBCOMMANDS` list. No request parameter can declare a call
 *     free, and the classification never changes what is permitted - only how it is accounted.
 *   * A read-only grant (`intent: "read_only"`) is a RECOVERY aid, not a permission. It exists so an
 *     accepted submission can still be collected after the budget was lowered, and it is therefore
 *     gated twice: at authorization time it must name a job whose provider submission was ACCEPTED
 *     (proven from the queue's own durable row by `verifyReadOnlyBinding`, never from the caller's
 *     word or from the existence of a budget row), and at execution time every call under it must be
 *     a read that targets exactly that submission (`evaluateReadOnlyGrantCall`). A read-only grant
 *     can therefore neither reach a generation command nor read another job.
 *   * `ledger: "persistent"` implements the same ledger port over the queue's durable
 *     `generation_budget_ledger` table (REN-10's ledger), so the two layers read one authority and a
 *     restart cannot re-reserve a job that already reserved. Job reservations created by the queue are
 *     reused by ledger id; reservations with no durable job row (one-shot tool operations) are
 *     accounted in-process and reported as such.
 */

import { RPC_CLASSIFICATION, TOOL_CLASSIFICATION, classifyRegistration, censusProviderNames, parseClassification } from "./generation-registry.js";
import { acceptedSubmissionOfJobScope } from "./generation-jobs.js";

/** Trusted, model-invisible request context. A JSON body can never produce a Symbol key. */
export const TRUSTED_CONTEXT = Symbol.for("openclaw.video-assets.trusted-context");

export const GENERATION_SURFACES = Object.freeze(["tool", "gateway", "browser"]);

/**
 * Accounting class of one provider call. Derived from the payload against a server-side list, never
 * from a caller parameter: a request cannot declare its own call free.
 */
export const PROVIDER_CALL_CLASS = Object.freeze({ PAID: "paid", READ_ONLY: "read_only" });

/**
 * What a budget scope is FOR. `paid` is a new paid operation; `read_only` is collection of a result the
 * provider already accepted - the only intent allowed to reuse a reservation past a lowered cap.
 */
export const BUDGET_SCOPE_INTENT = Object.freeze({ PAID: "paid", READ_ONLY: "read_only" });

/**
 * Provider subcommands that read state and submit nothing.
 *
 * Kept deliberately short and provider-specific: an unrecognised subcommand is `paid` (fail-safe), so
 * adding one to this list is the only way to make it read-only, and a paid subcommand can never be
 * smuggled in as a read.
 */
export const READ_ONLY_PROVIDER_SUBCOMMANDS = Object.freeze({
  // Verified against the CLI's own help output: these query state (account credits, an existing
  // submission, the task list) and create no generation.
  dreamina_cli: Object.freeze(["user_credit", "query_result", "list_task", "session"])
});

/** First non-flag token of an argv: the CLI's subcommand. */
export function argvSubcommand(argv = []) {
  if (!Array.isArray(argv)) return null;
  const found = argv.find((item) => typeof item === "string" && item.trim() && !item.startsWith("-"));
  return found ? found.trim() : null;
}

/**
 * Classify one provider call for ACCOUNTING only.
 * @returns {"paid"|"read_only"}
 */
export function classifyProviderCall({ provider = null, payload = null } = {}) {
  const allowed = READ_ONLY_PROVIDER_SUBCOMMANDS[provider];
  if (!Array.isArray(allowed) || allowed.length === 0) return PROVIDER_CALL_CLASS.PAID;
  const subcommand = argvSubcommand(payload?.argv ?? []);
  if (subcommand && allowed.includes(subcommand)) return PROVIDER_CALL_CLASS.READ_ONLY;
  return PROVIDER_CALL_CLASS.PAID;
}

/**
 * Normalize a caller-supplied budget scope.
 *
 * A scope is a TRUSTED, plugin-supplied identity for one paid operation (`{key, kind, intent}`): the key names
 * the reservation, `kind` says which authority owns it (`job` = the queue's durable row, anything else = a
 * scope record the gateway mints), and `intent` says whether the authorization is about to make a NEW paid
 * submission or is collecting read-only results of an operation the provider already accepted.
 *
 * An invalid scope is NOT an error: dropping it means the authorization reserves on its own, which can only
 * over-reserve, never under-reserve. The gateway records the rejection so it is visible instead of silent.
 */
export function normalizeBudgetScope(value) {
  if (!value || typeof value !== "object") return null;
  const key = typeof value.key === "string" ? value.key.trim() : "";
  if (!key || key.length > 200) return null;
  const kind = typeof value.kind === "string" && value.kind.trim() ? value.kind.trim().slice(0, 32) : "unspecified";
  const intent = String(value.intent ?? "").toLowerCase() === "read_only" ? "read_only" : "paid";
  return { key, kind, intent };
}

/**
 * What a BOUND read-only grant is allowed to read, per provider.
 *
 * `account_scoped` reads state of the provider account itself (balance, session) and carry no
 * submission target. `submission_scoped` reads one submission and therefore MUST name the request id
 * the grant is bound to - that is the rule that stops a recovery grant for job A from reading job B.
 * Anything not listed here is refused under a read-only grant, including read subcommands that would
 * enumerate the account's other tasks: a grant bound to one job reads that job and the account's own
 * balance, nothing else.
 */
export const READ_ONLY_GRANT_RULES = Object.freeze({
  dreamina_cli: Object.freeze({
    account_scoped: Object.freeze(["user_credit", "session"]),
    submission_scoped: Object.freeze(["query_result"])
  })
});

/** The `--submit_id=<id>` (or `--submit_id <id>`) value of an argv, in either spelling. */
export function submissionIdOf(argv = []) {
  if (!Array.isArray(argv)) return null;
  for (let index = 0; index < argv.length; index += 1) {
    const item = typeof argv[index] === "string" ? argv[index].trim() : "";
    const inline = /^--submit_id=(.*)$/.exec(item);
    if (inline) return inline[1].trim() || null;
    if (item === "--submit_id") {
      const next = argv[index + 1];
      const value = typeof next === "string" ? next.trim() : "";
      // A flag followed by another flag (or by nothing) is a dangling argument, not an id.
      return value && !value.startsWith("-") ? value : null;
    }
  }
  return null;
}

/**
 * Execution-side decision for ONE provider call made under a read-only grant.
 *
 * This is the half the first implementation was missing: the grant was checked when it was minted and
 * then never again, so an authorization created for a read could execute any subcommand the caller
 * put in argv - including a paid generation, which is how a read-only grant became a way to spend
 * past the caps. Accounting (`classifyProviderCall`) says what a call IS; this says whether THIS grant
 * may make it.
 *
 * @param {{provider: string|null, payload: object, binding: object|null}} args
 * @returns {{ok: boolean, scope?: string, code?: string, details?: object}}
 */
export function evaluateReadOnlyGrantCall({ provider = null, payload = null, binding = null } = {}) {
  const subcommand = argvSubcommand(payload?.argv ?? []);
  const callClass = classifyProviderCall({ provider, payload });
  if (callClass !== PROVIDER_CALL_CLASS.READ_ONLY) {
    return {
      ok: false,
      code: GENERATION_DENIAL_CODES.READ_ONLY_WRITE_REFUSED,
      details: {
        provider,
        subcommand,
        call_class: callClass,
        reason: "a read-only grant authorizes collection of an accepted submission; it never authorizes a generation or an unrecognised subcommand"
      }
    };
  }
  if (!binding?.provider_request_id) {
    return {
      ok: false,
      code: GENERATION_DENIAL_CODES.READ_ONLY_BINDING_REQUIRED,
      details: { provider, subcommand, reason: "this read-only authorization holds no accepted submission binding" }
    };
  }
  const rules = READ_ONLY_GRANT_RULES[provider] ?? null;
  if (!rules) {
    return {
      ok: false,
      code: GENERATION_DENIAL_CODES.READ_ONLY_CALL_NOT_BOUND,
      details: { provider, subcommand, reason: "no read rule is declared for this provider, so no read is covered by the grant" }
    };
  }
  if (rules.account_scoped.includes(subcommand)) return { ok: true, scope: "account" };
  if (rules.submission_scoped.includes(subcommand)) {
    const requested = submissionIdOf(payload?.argv ?? []);
    if (!requested || requested !== String(binding.provider_request_id)) {
      return {
        ok: false,
        code: GENERATION_DENIAL_CODES.READ_ONLY_CALL_NOT_BOUND,
        details: {
          provider,
          subcommand,
          requested_submission: requested,
          bound_submission: String(binding.provider_request_id),
          reason: "a bound read-only grant may only read the submission it is bound to"
        }
      };
    }
    return { ok: true, scope: "submission" };
  }
  return {
    ok: false,
    code: GENERATION_DENIAL_CODES.READ_ONLY_CALL_NOT_BOUND,
    details: {
      provider,
      subcommand,
      account_scoped: [...rules.account_scoped],
      submission_scoped: [...rules.submission_scoped],
      reason: "this read is not covered by a read-only grant, which is bound to one submission plus the account's own state"
    }
  };
}

export const GENERATION_DENIAL_CODES = Object.freeze({
  ENTRY_UNKNOWN: "GENERATION_ENTRY_UNKNOWN",
  SURFACE_NOT_ALLOWED: "GENERATION_SURFACE_NOT_ALLOWED",
  ACTOR_NOT_ALLOWED: "GENERATION_ACTOR_NOT_ALLOWED",
  UNATTRIBUTED: "GENERATION_UNATTRIBUTED",
  SCOPE_REQUIRED: "GENERATION_SCOPE_REQUIRED",
  CONFIRMATION_REQUIRED: "GENERATION_CONFIRMATION_REQUIRED",
  BUDGET_LEDGER_MISSING: "GENERATION_BUDGET_LEDGER_MISSING",
  BUDGET_EXCEEDED: "GENERATION_BUDGET_EXCEEDED",
  BUDGET_UNKNOWN_COST: "GENERATION_BUDGET_UNKNOWN_COST",
  BUDGET_INVALID_COST: "GENERATION_BUDGET_INVALID_COST",
  BUDGET_SCOPE_REQUIRED: "GENERATION_BUDGET_SCOPE_REQUIRED",
  BUDGET_SCOPE_ENTRY_MISMATCH: "GENERATION_BUDGET_SCOPE_ENTRY_MISMATCH",
  BUDGET_SCOPE_UNKNOWN: "GENERATION_BUDGET_SCOPE_UNKNOWN",
  READ_ONLY_BINDING_REQUIRED: "GENERATION_READ_ONLY_BINDING_REQUIRED",
  READ_ONLY_WRITE_REFUSED: "GENERATION_READ_ONLY_WRITE_REFUSED",
  READ_ONLY_CALL_NOT_BOUND: "GENERATION_READ_ONLY_CALL_NOT_BOUND",
  MONITOR_OBSERVE_ONLY: "GENERATION_MONITOR_OBSERVE_ONLY",
  AUTHORIZATION_UNKNOWN: "GENERATION_AUTHORIZATION_UNKNOWN",
  AUTHORIZATION_CLOSED: "GENERATION_AUTHORIZATION_CLOSED",
  AUTHORIZATION_EXPIRED: "GENERATION_AUTHORIZATION_EXPIRED",
  AUTHORIZATION_EXHAUSTED: "GENERATION_AUTHORIZATION_EXHAUSTED",
  PROVIDER_MISMATCH: "GENERATION_PROVIDER_MISMATCH",
  ACTOR_MISMATCH: "GENERATION_AUTHORIZATION_ACTOR_MISMATCH"
});

/**
 * Canonical generation entries. `provider` is the adapter id used by the provider gateway.
 * `tools` / `rpc` / `browser` are the names each surface uses today; `browser_aliases` also lists
 * the short aliases the workbench UI uses (the `videoAssets.` prefix is stripped by the UI bridge).
 *
 * `reference_estimate_credits` is a REFERENCE figure carried over from operator notes; it is marked
 * `cost_evidence: "unverified-reference"` and is NOT accepted as budget evidence (see decision 4).
 * `provider_calls_max` bounds how many adapter calls one authorization may make: a Dreamina
 * operation legitimately issues credit-preflight + generate + credit-recheck, the audio providers
 * issue exactly one call.
 */
export const GENERATION_ENTRY_POLICY = Object.freeze({
  "novel.text.generate": Object.freeze({ provider: "novel_text", cost_unit: "currency", cost_evidence: "operator-price-snapshot", provider_calls_max: 1, description: "独立文本模型；叙事币种账本与动画积分完全分离", tools: ["video_novel_generate"], rpc: ["videoAssets.novel.generation.write"], browser: ["videoAssets.novel.generation.write"], browser_aliases: ["novel.generation.write"] }),
  "dreamina.video.generate": Object.freeze({
    provider: "dreamina_cli",
    cost_unit: "credit",
    reference_estimate_credits: 100,
    cost_evidence: "unverified-reference",
    // REN-11 fix round (D3): budget sized for the real tool-surface sequence of one paid operation -
    // credit preflight (1) + submit (1) + up to 5 read-only `query_result` convergence calls + credit
    // recheck (1). Without the headroom the convergence query would be refused as
    // GENERATION_AUTHORIZATION_EXHAUSTED, which would hide the submit id the convergence exists to keep.
    provider_calls_max: 9,
    description: "即梦/Seedance 视频生成（图生视频、文生视频、多模态视频）",
    tools: ["video_canvas_dreamina_cli_generate_video"],
    rpc: ["videoAssets.canvas.dreaminaCliGenerateVideo"],
    browser: [],
    browser_aliases: []
  }),
  "dreamina.image.generate": Object.freeze({
    provider: "dreamina_cli",
    cost_unit: "credit",
    reference_estimate_credits: 8,
    cost_evidence: "unverified-reference",
    provider_calls_max: 9,
    description: "即梦/Seedream 图像生成",
    tools: ["video_canvas_dreamina_cli_generate_image"],
    rpc: [],
    browser: [],
    browser_aliases: []
  }),
  "dreamina.image.upscale": Object.freeze({
    provider: "dreamina_cli",
    cost_unit: "credit",
    reference_estimate_credits: 8,
    cost_evidence: "unverified-reference",
    provider_calls_max: 9,
    description: "即梦图像放大（image_upscale）",
    tools: ["video_canvas_dreamina_cli_upscale_image"],
    rpc: [],
    browser: [],
    browser_aliases: []
  }),
  "audio.doubao.generate": Object.freeze({
    provider: "doubao_audio",
    cost_unit: "credit",
    reference_estimate_credits: 20,
    cost_evidence: "unverified-reference",
    provider_calls_max: 1,
    description: "豆包音频生成（项目级入口）",
    tools: ["video_audio_doubao_generate"],
    rpc: ["videoAssets.audio.doubaoGenerate"],
    browser: [],
    browser_aliases: []
  }),
  "audio.doubao.canvas.generate": Object.freeze({
    provider: "doubao_audio",
    cost_unit: "credit",
    reference_estimate_credits: 20,
    cost_evidence: "unverified-reference",
    provider_calls_max: 1,
    description: "豆包音频生成（画布入口）",
    tools: ["video_canvas_doubao_audio_generate"],
    rpc: ["videoAssets.canvas.doubaoAudioGenerate"],
    browser: [],
    browser_aliases: []
  }),
  "audio.kie.generate": Object.freeze({
    provider: "kie_suno",
    cost_unit: "credit",
    reference_estimate_credits: 30,
    cost_evidence: "unverified-reference",
    provider_calls_max: 1,
    description: "KIE Suno 音乐/歌曲生成（项目级入口）",
    tools: ["video_audio_kie_suno_generate"],
    rpc: ["videoAssets.audio.kieSunoGenerate"],
    browser: ["videoAssets.audio.kieSunoGenerate"],
    browser_aliases: ["audio.kieSunoGenerate"]
  }),
  "audio.kie.canvas.generate": Object.freeze({
    provider: "kie_suno",
    cost_unit: "credit",
    reference_estimate_credits: 30,
    cost_evidence: "unverified-reference",
    provider_calls_max: 1,
    description: "KIE Suno 音乐/歌曲生成（画布入口）",
    tools: ["video_canvas_kie_suno_audio_generate"],
    rpc: ["videoAssets.canvas.kieSunoAudioGenerate"],
    browser: ["videoAssets.canvas.kieSunoAudioGenerate"],
    browser_aliases: ["canvas.kieSunoAudioGenerate"]
  })
});

/** Entry ids owned by the service layer, mapped to their methods (used by the source-scan check). */
export const GENERATION_SERVICE_ENTRIES = Object.freeze({
  "dreamina.video.generate": "canvasDreaminaCliGenerateVideo",
  "dreamina.image.generate": "canvasDreaminaCliGenerateImage",
  "dreamina.image.upscale": "canvasDreaminaCliUpscaleImage",
  "audio.doubao.generate": "doubaoAudioGenerate",
  "audio.doubao.canvas.generate": "canvasDoubaoAudioGenerate",
  "audio.kie.generate": "kieSunoGenerate",
  "audio.kie.canvas.generate": "canvasKieSunoGenerate"
});

/** Normalize any caller-visible name to a comparable form (prefixes and separators removed). */
export function normalizeEntryName(name) {
  return String(name ?? "")
    .trim()
    .replace(/^videoAssets\./, "")
    .replace(/^video_/, "")
    .replace(/[.\s-]+/g, "_")
    .toLowerCase();
}

const NAME_INDEX = (() => {
  const index = new Map();
  for (const [entry, definition] of Object.entries(GENERATION_ENTRY_POLICY)) {
    const names = [entry, ...definition.tools, ...definition.rpc, ...definition.browser, ...definition.browser_aliases];
    for (const name of names) {
      const key = normalizeEntryName(name);
      if (!index.has(key)) index.set(key, []);
      if (!index.get(key).includes(entry)) index.get(key).push(entry);
    }
  }
  return index;
})();

/**
 * Resolve a caller-visible tool/RPC/alias name to canonical entries.
 * @returns {string[]} canonical entry ids (empty when the name is not a known generation surface)
 */
export function resolveGenerationEntriesByName(name) {
  return [...(NAME_INDEX.get(normalizeEntryName(name)) ?? [])];
}

export function generationEntryKeys() {
  return Object.keys(GENERATION_ENTRY_POLICY);
}

/**
 * Coverage matrix for reports and registration-time assertions.
 *
 * `provider_operations` and `unclassified` come from the authoritative census in
 * `src/generation-registry.js`, not from a naming heuristic. The registration path treats
 * `unclassified` as FATAL: a registered tool or gateway RPC that is not declared in the census
 * stops registration instead of producing a warning (review round 2, issue 4).
 *
 * `ambiguous_names` is also fatal: one name mapping to two entries would make the decision
 * order-dependent.
 */
export function generationCoverageMatrix({ toolNames = [], rpcNames = [], surface = "legacy" } = {}) {
  const classification = classifyRegistration({ toolNames, rpcNames, entries: GENERATION_ENTRY_POLICY, surface });
  const census = censusProviderNames();
  const ambiguous = [...NAME_INDEX.entries()].filter(([, entries]) => entries.length > 1).map(([name, entries]) => ({ name, entries }));
  const missingProvider = generationEntryKeys().filter((entry) => !GENERATION_ENTRY_POLICY[entry].provider);

  // Cross-check the two directions: every census provider operation must be reachable through its
  // entry's declared entry points, and every entry's declared entry points must be census provider
  // operations. A mismatch means one of the two tables was edited without the other.
  const crossCheck = [];
  for (const item of [...census.tools, ...census.rpc]) {
    if (!resolveGenerationEntriesByName(item.name).includes(item.entry)) {
      crossCheck.push(`${item.name} is declared for entry ${item.entry} but the entry does not list it as an entry point`);
    }
  }
  for (const entry of generationEntryKeys()) {
    const definition = GENERATION_ENTRY_POLICY[entry];
    const names = [...definition.tools, ...definition.rpc, ...definition.browser];
    for (const name of names) {
      const value = TOOL_CLASSIFICATION[name] ?? RPC_CLASSIFICATION[name];
      const parsed = parseClassification(value);
      if (parsed.kind !== "provider-operation" || parsed.entry !== entry) {
        crossCheck.push(`${name} is listed as an entry point of ${entry} but the census does not declare it (or declares it differently)`);
      }
    }
    if (definition.tools.length + definition.rpc.length + definition.browser.length === 0) {
      crossCheck.push(`entry ${entry} has no entry point`);
    }
    for (const name of definition.tools) {
      const parsed = parseClassification(TOOL_CLASSIFICATION[name]);
      if (parsed.entry !== entry) crossCheck.push(`tool ${name} is not declared as a provider operation for ${entry} in the census`);
    }
    for (const name of definition.rpc) {
      const parsed = parseClassification(RPC_CLASSIFICATION[name]);
      if (parsed.entry !== entry) crossCheck.push(`rpc ${name} is not declared as a provider operation for ${entry} in the census`);
    }
  }

  return {
    entries: generationEntryKeys().map((entry) => ({
      entry,
      provider: GENERATION_ENTRY_POLICY[entry].provider,
      provider_calls_max: GENERATION_ENTRY_POLICY[entry].provider_calls_max,
      reference_estimate_credits: GENERATION_ENTRY_POLICY[entry].reference_estimate_credits,
      cost_evidence: GENERATION_ENTRY_POLICY[entry].cost_evidence,
      tools: GENERATION_ENTRY_POLICY[entry].tools,
      rpc: GENERATION_ENTRY_POLICY[entry].rpc,
      browser: GENERATION_ENTRY_POLICY[entry].browser,
      browser_aliases: GENERATION_ENTRY_POLICY[entry].browser_aliases,
      service_method: GENERATION_SERVICE_ENTRIES[entry]
    })),
    provider_operations: classification.provider_operations,
    unclassified_names: classification.unclassified,
    census_provider_operations: census,
    entries_without_provider: missingProvider,
    ambiguous_names: ambiguous,
    cross_check: crossCheck,
    classified_tools: Object.keys(TOOL_CLASSIFICATION).length,
    classified_rpc: Object.keys(RPC_CLASSIFICATION).length
  };
}

/** Resolve the `security.generation` block with fail-closed defaults. */
export function resolveGenerationPolicy(config = {}) {
  const block = config?.generation && typeof config.generation === "object" ? config.generation : {};
  const budget = block.budget && typeof block.budget === "object" ? block.budget : {};
  const estimates = budget.estimates && typeof budget.estimates === "object" ? budget.estimates : {};
  const perEntry = budget.perEntry && typeof budget.perEntry === "object" ? budget.perEntry : {};
  const mode = String(block.mode ?? "enforce").toLowerCase() === "monitor" ? "monitor" : "enforce";
  return {
    mode,
    allowSurfaces: toArray(block.allowSurfaces),
    allowActors: toArray(block.allowActors),
    unattributedPolicy: String(block.unattributedPolicy ?? "deny").toLowerCase() === "allow-with-surface-grant" ? "allow-with-surface-grant" : "deny",
    unattributedSurfaces: toArray(block.unattributedSurfaces).length > 0 ? toArray(block.unattributedSurfaces) : ["tool"],
    requireConfirmation: block.requireConfirmation !== false,
    requireBudget: block.requireBudget !== false,
    /** Require the trusted context to carry an operator scope. Off = the actor allowlist alone decides. */
    requireOperatorScope: block.requireOperatorScope !== false,
    /** How long one authorization stays live (bounds replay of an already-returned audit id). */
    authorizationTtlSeconds: Number.isFinite(Number(block.authorizationTtlSeconds)) && Number(block.authorizationTtlSeconds) > 0 ? Number(block.authorizationTtlSeconds) : 900,
    ledger: normalizeLedgerMode(block.ledger),
    budget: {
      totalCredits: Number.isFinite(Number(budget.totalCredits)) ? Number(budget.totalCredits) : null,
      period: ["day", "session", "lifetime"].includes(String(budget.period)) ? String(budget.period) : "day",
      estimates: normalizeEstimateMap(estimates),
      perEntry: normalizeEstimateMap(perEntry)
    }
  };
}

function normalizeEstimateMap(value) {
  const out = {};
  for (const [key, raw] of Object.entries(value ?? {})) {
    const credits = Number(raw);
    if (Number.isFinite(credits) && credits >= 0) out[key] = credits;
  }
  return out;
}

function normalizeLedgerMode(value) {
  const mode = String(value ?? "none").toLowerCase();
  if (mode === "memory") return "memory";
  // The durable implementation over the queue's `generation_budget_ledger` table (REN-10's ledger).
  // Needs a database handle, so `VideoAssetService.init()` attaches it once the schema exists.
  if (mode === "persistent") return "persistent";
  return "none";
}

function toArray(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return [];
}

/** Glob-lite actor match: `*` matches any run of characters; exact match otherwise. */
export function actorMatches(pattern, actorId) {
  if (!pattern || !actorId) return false;
  const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(String(actorId));
}

/**
 * Cost estimate for one entry.
 *
 * Only an OPERATOR-SUPPLIED estimate (`security.generation.budget.estimates[entry]`) counts as
 * budget evidence. The per-entry reference constant is reported as `reference_credits` with
 * `evidence: "unverified-reference"` so a report can show it without it ever being mistaken for a
 * basis on which money may be spent (review round 2, issue 3).
 */
export function estimateGenerationCost(entry, params = {}, policy = resolveGenerationPolicy({})) {
  const configured = policy.budget.estimates?.[entry];
  if (Number.isFinite(Number(configured))) {
    return { credits: Number(configured), source: "config-estimate", evidence: "operator-provided" };
  }
  const definition = GENERATION_ENTRY_POLICY[entry];
  if (!definition) return { credits: null, source: "unknown-entry", evidence: "none" };
  return {
    credits: null,
    source: "unknown-cost",
    evidence: "none",
    reference_credits: Number.isFinite(Number(definition.reference_estimate_credits)) ? Number(definition.reference_estimate_credits) : null,
    reference_evidence: definition.cost_evidence ?? "unverified-reference",
    hint: "set security.generation.budget.estimates[<entry>] from measured provider pricing before enabling real execution"
  };
}

/**
 * Zero-cost, in-memory budget ledger (REN-02 ledger PORT implementation).
 *
 * Semantics that the first implementation got wrong (review round 2, issue 3):
 *   * `budgets["*"]` is the SHARED pool for every entry, not a per-entry total. The previous
 *     implementation read `budgets[key] ?? budgets["*"]` per key and tracked spend per key, so N
 *     entries each enjoyed the full total and the aggregate could exceed the configured limit.
 *     Here the shared pool is debited for every reservation and is the aggregate bound; a named
 *     `budgets[entry]` is an ADDITIONAL per-entry cap, checked in the same atomic step.
 *   * reservations must be finite, non-negative numbers. `NaN`, `Infinity` and negative credits are
 *     refused (`GENERATION_BUDGET_INVALID_COST`) instead of corrupting the accounting - a negative
 *     "cost" previously increased the remaining budget.
 *   * a reservation may name a SCOPE KEY (`reserve(entry, credits, {key})`). One key is one paid
 *     operation: the first call debits the estimate, later calls under the same key reuse the
 *     reservation instead of debiting again (REN-12 finding F3). Without a key the behaviour is
 *     unchanged - one reservation per call, which is what the single-authorization tool surface
 *     relies on.
 *   * the read-only recovery exemption (`intent: "read_only"`) is REFUSED here. It skips today's caps
 *     and is only legitimate for a submission a provider actually accepted, which is a durable fact an
 *     in-process ledger cannot hold. A deployment that needs the recovery path runs `ledger:
 *     "persistent"`, whose `verifyReadOnlyBinding` reads the queue's own row; this ledger answers the
 *     same question with "cannot be proven" rather than with a free reuse.
 *
 * The real, persistent cost ledger is REN-10. Until it exists, a deployment that sets
 * `ledger: "memory"` gets accounting that is correct in shape but lives only as long as the process
 * (and with it, no restart-resilience); `ledger: "persistent"` reads and writes REN-10's durable
 * `generation_budget_ledger` rows instead, which is what a queued job's accounting should use. The
 * package still keeps real payment disabled by default (`ledger: "none"` + no estimates).
 */
export function createMemoryBudgetLedger({ budgets = {}, now = () => Date.now() } = {}) {
  const spent = new Map();
  /**
   * key -> { entry, kind, credits, state, actual_credits, debited_shared, debited_entry }.
   *
   * The `debited_*` amounts are what makes settlement honest: a scope that was REUSED debited nothing,
   * so releasing it must give nothing back.
   */
  const reservedByKey = new Map();
  const periodStart = now();
  const SHARED = "*";

  const scopeKeyOf = (options) => (typeof options?.key === "string" && options.key.trim() ? options.key.trim() : null);
  const scopeKindOf = (options) => (typeof options?.kind === "string" && options.kind.trim() ? options.kind.trim().slice(0, 32) : "unspecified");
  const scopeIntentOf = (options) => (String(options?.intent ?? "").toLowerCase() === "read_only" ? "read_only" : "paid");

  /**
   * Acceptance evidence for a read-only grant. Always unavailable here, and that is the honest answer:
   * an in-process ledger has no durable queue row to read, so it cannot prove that a provider accepted
   * a submission - and without that proof the cap-free read-only exemption must not be granted.
   */
  const verifyReadOnlyBinding = () => ({
    ok: false,
    code: GENERATION_DENIAL_CODES.READ_ONLY_BINDING_REQUIRED,
    reason: "the in-process ledger holds no durable submission evidence; only the persistent ledger can prove that a provider accepted a job"
  });

  function limitOf(key) {
    const raw = budgets[key];
    if (raw === undefined || raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  function usedOf(key) {
    return spent.get(key) ?? 0;
  }

  function describe(key) {
    const limit = limitOf(key);
    const used = usedOf(key);
    return { key, limit, used, remaining: limit === null ? null : limit - used };
  }

  return {
    kind: "memory",
    periodStart,
    verifyReadOnlyBinding,
    /**
     * Remaining budget for an entry: the shared pool plus the entry cap, each with its own limit.
     * @returns {{shared:object, entry:object|null}}
     */
    remaining(entry) {
      return { shared: describe(SHARED), entry: entry === SHARED ? null : describe(entry) };
    },
    /** Aggregate view for reports/tests. */
    snapshot() {
      const keys = [...new Set([SHARED, ...Object.keys(budgets), ...spent.keys()])];
      return keys.map((key) => describe(key));
    },
    /** Scope-keyed reservations, so a report can show that one job holds one reservation. */
    reservations() {
      return [...reservedByKey.entries()].map(([key, value]) => ({
        key,
        entry: value.entry,
        kind: value.kind,
        credits: value.credits,
        state: value.state,
        actual_credits: value.actual_credits
      }));
    },
    /**
     * Reserve credits against the shared pool and (if configured) the per-entry cap.
     *
     * Rules (identical in both ledger implementations, so a report can compare them):
     *   1. a scope key is bound to ONE entry - borrowing another entry's reservation is refused;
     *   2. `intent: "read_only"` on an existing scope is collection of an operation the provider already
     *      accepted, so it reuses the reservation without re-checking today's caps: a lowered budget must
     *      not lose an accepted result. Because it skips the caps, it requires PROOF of that acceptance,
     *      which is a durable fact this ledger cannot hold - so it refuses here and the deployment must
     *      run the persistent ledger. An unproven read-only reuse is exactly the hole that let a
     *      read-only grant spend past a lowered cap;
     *   3. every PAID reservation must fit TODAY's limits, whether or not a reservation already exists.
     *      Because an over-cap reservation leaves a negative `remaining`, this is also what stops a
     *      pre-created reservation from being used to bypass a lowered cap;
     *   4. an unkeyed reservation is accounted per call (no reuse), which is why it cannot double-spend.
     */
    reserve(entry, credits, options = {}) {
      // Only a finite, non-negative NUMBER is a usable cost. Everything else (NaN, Infinity, negative,
      // null, a string) is refused instead of being coerced into the accounting.
      const requested = typeof credits === "number" ? credits : Number.NaN;
      if (!Number.isFinite(requested) || requested < 0) {
        return {
          ok: false,
          code: GENERATION_DENIAL_CODES.BUDGET_INVALID_COST,
          details: { entry, requested: typeof credits === "number" && Number.isFinite(credits) ? credits : String(credits), reason: "credits must be a finite, non-negative number" }
        };
      }
      const key = scopeKeyOf(options);
      const kind = scopeKindOf(options);
      const intent = scopeIntentOf(options);
      const existing = key ? reservedByKey.get(key) : undefined;
      // (1) one key, one entry.
      if (existing && existing.entry !== entry) {
        return {
          ok: false,
          code: GENERATION_DENIAL_CODES.BUDGET_SCOPE_ENTRY_MISMATCH,
          details: { entry, scope_key: key, reserved_entry: existing.entry, reason: "a budget scope belongs to the entry that reserved it; a different entry may not reuse or extend it" }
        };
      }
      // (2) bound read-only collection of an already-accepted operation. The exemption skips today's
      // caps, so it is available only with acceptance evidence - which this ledger cannot hold.
      if (existing && intent === "read_only") return verifyReadOnlyBinding({ key, entry });
      // (3) paid: today's limits apply, with or without an existing reservation.
      const heldAmount = existing ? existing.credits : 0;
      const amount = Math.max(0, requested - heldAmount);
      const shared = describe(SHARED);
      const entryBucket = describe(entry);
      const sharedConfigured = shared.limit !== null;
      const entryConfigured = entryBucket.limit !== null;
      if (!sharedConfigured && !entryConfigured) {
        return { ok: false, code: GENERATION_DENIAL_CODES.BUDGET_LEDGER_MISSING, details: { entry, budgets: Object.keys(budgets) } };
      }
      if (sharedConfigured && shared.remaining - amount < 0) {
        return {
          ok: false,
          code: GENERATION_DENIAL_CODES.BUDGET_EXCEEDED,
          details: { entry, scope: "shared", requested: amount, already_reserved: heldAmount, remaining: shared.remaining, limit: shared.limit, scope_key: key }
        };
      }
      if (entryConfigured && entryBucket.remaining - amount < 0) {
        return {
          ok: false,
          code: GENERATION_DENIAL_CODES.BUDGET_EXCEEDED,
          details: { entry, scope: "entry", requested: amount, already_reserved: heldAmount, remaining: entryBucket.remaining, limit: entryBucket.limit, scope_key: key }
        };
      }
      if (sharedConfigured) spent.set(SHARED, shared.used + amount);
      if (entryConfigured) spent.set(entry, entryBucket.used + amount);
      if (key) {
        reservedByKey.set(key, {
          entry,
          kind,
          credits: Math.max(requested, heldAmount),
          state: "reserved",
          actual_credits: null,
          debited_shared: (existing?.debited_shared ?? 0) + (sharedConfigured ? amount : 0),
          debited_entry: (existing?.debited_entry ?? 0) + (entryConfigured ? amount : 0)
        });
      }
      return {
        ok: true,
        reused: amount === 0 && Boolean(existing),
        reserved: amount,
        ...(key ? { scope_key: key, already_reserved: existing?.credits ?? 0 } : {}),
        scopes: [sharedConfigured ? "shared" : null, entryConfigured ? "entry" : null].filter(Boolean),
        remaining: {
          shared: sharedConfigured ? shared.remaining - amount : null,
          entry: entryConfigured ? entryBucket.remaining - amount : null
        }
      };
    },
    /**
     * Close a scope: `released` when nothing was spent (no provider call happened), `committed` otherwise.
     *
     * Only the amount THIS scope actually debited is given back, which is what keeps a reused scope's
     * release from refunding another scope's spend.
     */
    settle(key, { state = "committed", actual_credits = null } = {}) {
      const scopeKey = typeof key === "string" && key.trim() ? key.trim() : null;
      const held = scopeKey ? reservedByKey.get(scopeKey) : null;
      if (!held) return { settled: false, reason: "no reservation for that scope key" };
      const nextState = state === "released" ? "released" : "committed";
      if (nextState === "released") {
        if (held.debited_shared > 0) spent.set(SHARED, Math.max(0, usedOf(SHARED) - held.debited_shared));
        if (held.debited_entry > 0) spent.set(held.entry, Math.max(0, usedOf(held.entry) - held.debited_entry));
      }
      reservedByKey.set(scopeKey, { ...held, state: nextState, actual_credits: actual_credits ?? null, debited_shared: 0, debited_entry: 0 });
      return { settled: true, state: nextState, entry: held.entry, credits: held.credits };
    }
  };
}

/** Budget map derived from a resolved policy: the shared pool plus each per-entry cap. */
export function ledgerBudgetsFromPolicy(policy = {}) {
  const budgets = {};
  if (policy?.budget?.totalCredits !== null && policy?.budget?.totalCredits !== undefined) budgets["*"] = Number(policy.budget.totalCredits);
  for (const [entry, cap] of Object.entries(policy?.budget?.perEntry ?? {})) budgets[entry] = Number(cap);
  return budgets;
}

/**
 * The durable budget ledger: the same port, with TWO durable authorities.
 *
 *   * a JOB reservation lives in the queue's `generation_budget_ledger` row the queue created when the
 *     job was created (`budget_<job_id>`). The queue and the gateway therefore read and write ONE row,
 *     and a restarted process cannot re-reserve a job whose row already exists;
 *   * any other reservation (a tool-surface authorization, a one-shot operation) lives in
 *     `generation_budget_scopes`, keyed by the scope the gateway minted. That table exists because the
 *     queue's table cannot name a non-existent job (`job_id` is NOT NULL with a foreign key), and the
 *     first revision's answer - accept the reservation and record it nowhere - was a double-spend.
 *
 * Either way a reservation is a real durable row: an unkeyed reservation is refused rather than
 * silently accepted, and an unknown or foreign scope is refused rather than treated as free.
 */
export function createPersistentBudgetLedger({ db, budgets = {}, now = () => Date.now() } = {}) {
  if (!db) throw new Error("createPersistentBudgetLedger requires a db handle");
  const SHARED = "*";
  const periodStart = now();

  const limitOf = (key) => {
    const raw = budgets[key];
    if (raw === undefined || raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  // Job reservations: the rows the queue creates. `job_id IS NOT NULL` keeps this reader on exactly the
  // set the queue's admission check counts, so the two layers cannot drift apart.
  const durableUsed = (entry = null) => Number(db.prepare(
    `SELECT COALESCE(SUM(estimated_credits),0) AS n FROM generation_budget_ledger WHERE state IN ('reserved','committed') AND job_id IS NOT NULL${entry ? " AND entry = ?" : ""}`
  ).get(...(entry ? [entry] : [])).n);
  // Gateway-minted scopes: one durable record per authorization that reserved. The store is created by the
  // plugin's own schema on every init; a database that predates it (an older build, or a harness that only
  // creates the queue's table) must make this ledger REFUSE rather than throw - a raw SQL error would be an
  // unaccounted reservation in disguise.
  const hasScopeStore = (() => {
    try {
      return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='generation_budget_scopes'").get());
    } catch {
      return false;
    }
  })();
  const scopeUsed = (entry = null) => (!hasScopeStore ? 0 : Number(db.prepare(
    `SELECT COALESCE(SUM(reserved_credits),0) AS n FROM generation_budget_scopes WHERE state IN ('reserved','committed')${entry ? " AND entry = ?" : ""}`
  ).get(...(entry ? [entry] : [])).n));
  const usedOf = (entry = null) => durableUsed(entry) + scopeUsed(entry);
  const describe = (key) => {
    const limit = limitOf(key);
    const used = usedOf(key === SHARED ? null : key);
    return { key, limit, used, remaining: limit === null ? null : limit - used };
  };
  const durableRow = (key) => db.prepare(
    "SELECT ledger_id, job_id, entry, state, estimated_credits FROM generation_budget_ledger WHERE ledger_id = ? AND state IN ('reserved','committed')"
  ).get(key) ?? null;
  /**
   * Acceptance evidence for one read-only grant.
   *
   * This is the durable half of "a lowered cap must not lose an accepted result": the exemption is only
   * granted when the QUEUE's own row proves the provider accepted the submission, that the row belongs to
   * the entry being authorized and to the actor asking. The lookup fails closed (never throws) when the
   * database cannot answer - an older database or a harness that only carries the budget tables.
   */
  const verifyReadOnlyBinding = ({ key = null, entry = null, actor_id = null } = {}) => {
    const found = acceptedSubmissionOfJobScope(db, { key, entry, actor_id });
    if (!found.ok) {
      return {
        ok: false,
        code: GENERATION_DENIAL_CODES.READ_ONLY_BINDING_REQUIRED,
        scope_key: typeof key === "string" ? key : null,
        reason: found.reason
      };
    }
    return { ...found, code: "OK" };
  };
  /** A gateway-minted scope record: the durable authority for every reservation that is not a job. */
  const scopeRow = (key) => (!hasScopeStore ? null : db.prepare(
    "SELECT scope_key, scope_kind, entry, state, reserved_credits, actual_credits FROM generation_budget_scopes WHERE scope_key = ? AND state IN ('reserved','committed')"
  ).get(key) ?? null);

  return {
    kind: "persistent",
    durable: true,
    periodStart,
    verifyReadOnlyBinding,
    remaining(entry) {
      return { shared: describe(SHARED), entry: entry === SHARED ? null : describe(entry) };
    },
    snapshot() {
      const keys = [...new Set([SHARED, ...Object.keys(budgets), ...scopeEntries()])];
      return keys.map((key) => describe(key));
    },
    /** Which durable rows back the current accounting (diagnostics; no credentials). */
    durableReservations() {
      return db.prepare("SELECT ledger_id, job_id, entry, state, estimated_credits, actual_credits FROM generation_budget_ledger ORDER BY created_at").all();
    },
    /** Gateway-minted (non-job) scope records: one durable record per authorization that reserved. */
    scopeReservations() {
      if (!hasScopeStore) return [];
      return db.prepare("SELECT scope_key, scope_kind, entry, state, reserved_credits, actual_credits FROM generation_budget_scopes ORDER BY created_at").all()
        .map((row) => ({ ...row, reserved_credits: Number(row.reserved_credits) }));
    },
    /** True when this database can record a non-job reservation at all (the scope store exists). */
    durableScopeStore: hasScopeStore,
    /**
     * Compatibility diagnostic. Every reservation is durable now - job rows in the queue's table, everything
     * else in `generation_budget_scopes` - so there is nothing process-local to report and this is always
     * empty. The name survives because the earlier revision used a process-local map here as the fallback
     * store for keys with no job row, and readers (including the parent review's probe) still ask for it.
     */
    inProcessReservations() {
      return [];
    },
    /**
     * Reserve credits for one scope.
     *
     * The rules are the memory ledger's rules, plus the two things only a durable ledger can answer:
     *
     *   * **a key is required.** An unkeyed reservation in `persistent` mode would have no durable
     *     identity, and the first implementation accepted it twice against the same pool because it
     *     recorded nothing at all. It is now refused with `GENERATION_BUDGET_SCOPE_REQUIRED`; the
     *     gateway mints an `authorization:<audit id>` scope for callers that do not name one, so the
     *     ordinary tool path still records a real reservation.
     *   * **a job scope must really belong to that job.** `kind: "job"` is the queue's authority: the key
     *     is `budget_<job_id>` and the durable row must carry that same `job_id` and the reserving entry.
     *     A job kind with no row, a row belonging to another job, or a row for another entry is refused
     *     rather than treated as an existing reservation.
     *
     * Non-job reservations are written to `generation_budget_scopes` - a real durable record, not the
     * in-process map the earlier revision fell back to for keys with no job row.
     */
    reserve(entry, credits, options = {}) {
      const requested = typeof credits === "number" ? credits : Number.NaN;
      if (!Number.isFinite(requested) || requested < 0) {
        return {
          ok: false,
          code: GENERATION_DENIAL_CODES.BUDGET_INVALID_COST,
          details: { entry, requested: typeof credits === "number" && Number.isFinite(credits) ? credits : String(credits), reason: "credits must be a finite, non-negative number" }
        };
      }
      const key = typeof options?.key === "string" && options.key.trim() ? options.key.trim() : null;
      const declaredKind = typeof options?.kind === "string" && options.kind.trim() ? options.kind.trim().slice(0, 32) : "unspecified";
      // A key that NAMES a job row is a job scope whatever the caller declared. The alternative would let
      // `budget_<job_id>` be reinterpreted as a free-standing scope record, so the same key could name one
      // job's reservation and be accounted as another reservation entirely.
      const kind = /^budget_.+/.test(key ?? "") ? "job" : declaredKind;
      const intent = String(options?.intent ?? "").toLowerCase() === "read_only" ? "read_only" : "paid";
      if (!key) {
        return {
          ok: false,
          code: GENERATION_DENIAL_CODES.BUDGET_SCOPE_REQUIRED,
          details: {
            entry,
            reason: "a persistent budget ledger records one durable reservation per scope, so a reservation without a scope key cannot be accounted; pass a trusted {key, kind} scope (the gateway mints one for the tool surface)"
          }
        };
      }
      const jobKey = kind === "job" ? { job_id: key.replace(/^budget_/, "") } : null;
      const jobRow = jobKey ? durableRow(key) : null;
      const scope = jobKey ? null : scopeRow(key);
      if (jobKey && !jobRow) {
        return {
          ok: false,
          code: GENERATION_DENIAL_CODES.BUDGET_SCOPE_UNKNOWN,
          details: { entry, scope_key: key, reason: "a job budget scope must name the durable reservation the queue created when the job was created; no such row exists, so this is not an existing reservation" }
        };
      }
      if (jobRow && jobRow.job_id !== jobKey.job_id) {
        return {
          ok: false,
          code: GENERATION_DENIAL_CODES.BUDGET_SCOPE_UNKNOWN,
          details: { entry, scope_key: key, row_job_id: jobRow.job_id, expected_job_id: jobKey.job_id, reason: "the durable row named by this scope belongs to a different job" }
        };
      }
      const heldEntry = jobRow ? jobRow.entry : (scope ? scope.entry : null);
      if (heldEntry && heldEntry !== entry) {
        return {
          ok: false,
          code: GENERATION_DENIAL_CODES.BUDGET_SCOPE_ENTRY_MISMATCH,
          details: { entry, scope_key: key, reserved_entry: heldEntry, reason: "a budget scope belongs to the entry that reserved it; a different entry may not reuse or extend it" }
        };
      }
      const held = Number(jobRow?.estimated_credits ?? scope?.reserved_credits ?? 0);
      const hasHeld = Boolean(jobRow || scope);
      const reuse = () => ({
        ok: true,
        reused: true,
        reserved: 0,
        scope_key: key,
        already_reserved: held,
        durable: true,
        scope_kind: jobKey ? "job" : kind,
        scopes: [],
        remaining: { shared: describe(SHARED).remaining, entry: describe(entry).remaining }
      });
      // Bound read-only collection of an operation the provider already accepted. A lowered budget must
      // not lose an accepted result, and this is the ONLY path that skips today's caps - so it is the one
      // path that needs PROOF rather than a declaration: the durable job row must show that a provider
      // accepted the submission, and it must belong to this entry and this actor. Without that proof the
      // reservation is refused, never handed a cap-free reuse.
      if (hasHeld && intent === "read_only") {
        const binding = verifyReadOnlyBinding({ key, entry, actor_id: options?.actor_id ?? null });
        if (!binding.ok) {
          return {
            ok: false,
            code: binding.code,
            details: {
              entry,
              scope_key: key,
              intent,
              actor_id: options?.actor_id ?? null,
              reason: binding.reason,
              hint: "a read-only grant must name an ACCEPTED job submission (provider_submit_state=submitted with a provider request id) of this entry and actor; a budget row alone is not evidence of acceptance"
            }
          };
        }
        return {
          ...reuse(),
          read_only_binding: { job_id: binding.job_id, provider_request_id: binding.provider_request_id, provider_submit_state: binding.provider_submit_state }
        };
      }
      // Paid: today's limits apply, with or without an existing reservation. An over-cap reservation
      // leaves a negative `remaining`, so a pre-created row cannot be used to bypass a lowered cap.
      const amount = Math.max(0, requested - held);
      const shared = describe(SHARED);
      const entryBucket = describe(entry);
      const sharedConfigured = shared.limit !== null;
      const entryConfigured = entryBucket.limit !== null;
      if (!sharedConfigured && !entryConfigured) {
        return { ok: false, code: GENERATION_DENIAL_CODES.BUDGET_LEDGER_MISSING, details: { entry, budgets: Object.keys(budgets) } };
      }
      if (sharedConfigured && shared.remaining - amount < 0) {
        return { ok: false, code: GENERATION_DENIAL_CODES.BUDGET_EXCEEDED, details: { entry, scope: "shared", requested: amount, already_reserved: hasHeld ? held : 0, remaining: shared.remaining, limit: shared.limit, scope_key: key } };
      }
      if (entryConfigured && entryBucket.remaining - amount < 0) {
        return { ok: false, code: GENERATION_DENIAL_CODES.BUDGET_EXCEEDED, details: { entry, scope: "entry", requested: amount, already_reserved: hasHeld ? held : 0, remaining: entryBucket.remaining, limit: entryBucket.limit, scope_key: key } };
      }
      const at = new Date(now()).toISOString();
      if (jobRow) {
        // Top up the durable row the queue created for this job. The job's `estimated_credits` is the
        // server-side high-water mark, so a larger gateway estimate raises it instead of hiding it in a
        // second row the queue's admission check would never see.
        db.prepare("UPDATE generation_budget_ledger SET estimated_credits = ?, updated_at = ? WHERE ledger_id = ?")
          .run(Math.max(requested, held), at, key);
      } else if (!hasScopeStore) {
        // No durable place to put a non-job reservation: refuse it. Accepting it here (and recording
        // nothing, or only in memory) is exactly the double-spend the parent review measured.
        return {
          ok: false,
          code: GENERATION_DENIAL_CODES.BUDGET_LEDGER_MISSING,
          details: { entry, scope_key: key, reason: "this database has no generation_budget_scopes table, so a non-job reservation cannot be recorded durably; refusing instead of accounting it in memory" }
        };
      } else if (scope) {
        db.prepare("UPDATE generation_budget_scopes SET reserved_credits = ?, updated_at = ? WHERE scope_key = ?")
          .run(Math.max(requested, held), at, key);
      } else {
        db.prepare("INSERT INTO generation_budget_scopes (scope_key,scope_kind,entry,state,reserved_credits,actual_credits,created_at,updated_at) VALUES (?,?,?,'reserved',?,NULL,?,?)")
          .run(key, kind, entry, requested, at, at);
      }
      return {
        ok: true,
        reused: amount === 0 && hasHeld,
        reserved: amount,
        scope_key: key,
        already_reserved: hasHeld ? held : 0,
        durable: true,
        scope_kind: jobKey ? "job" : kind,
        scopes: [sharedConfigured ? "shared" : null, entryConfigured ? "entry" : null].filter(Boolean),
        remaining: {
          shared: sharedConfigured ? shared.remaining - amount : null,
          entry: entryConfigured ? entryBucket.remaining - amount : null
        }
      };
    },
    /**
     * Close a scope: `released` when the authorization never reached the provider, `committed` otherwise.
     *
     * A JOB scope is not settled here: its row belongs to the queue, which commits it on completion and
     * releases it on a local cancel. Settling it from the gateway would be a second writer on the queue's
     * authority, so this reports that instead of writing.
     */
    settle(key, { state = "committed", actual_credits = null } = {}) {
      const scopeKey = typeof key === "string" && key.trim() ? key.trim() : null;
      if (!scopeKey) return { settled: false, reason: "a settle needs a scope key" };
      const jobRow = durableRow(scopeKey);
      if (jobRow) return { settled: false, reason: "job reservations are owned by the queue; the gateway does not write them", scope_key: scopeKey, durable: true };
      const scope = scopeRow(scopeKey);
      if (!scope) {
        return hasScopeStore
          ? { settled: false, reason: "no reservation for that scope key" }
          : { settled: false, reason: "this database has no generation_budget_scopes table, so no scope reservation can exist here" };
      }
      const nextState = state === "released" ? "released" : "committed";
      db.prepare("UPDATE generation_budget_scopes SET state = ?, actual_credits = ?, updated_at = ? WHERE scope_key = ?")
        .run(nextState, actual_credits ?? null, new Date(now()).toISOString(), scopeKey);
      return { settled: true, state: nextState, entry: scope.entry, credits: Number(scope.reserved_credits), durable: true };
    }
  };

  /** Entries that hold a non-job reservation, so the snapshot can report their pools. */
  function scopeEntries() {
    if (!hasScopeStore) return [];
    return db.prepare("SELECT DISTINCT entry FROM generation_budget_scopes WHERE state IN ('reserved','committed')").all().map((row) => row.entry);
  }
}

/** Resolve the ledger implementation from policy config. */
export function resolveBudgetLedger(policy, { ledger = null } = {}) {
  if (ledger) return ledger;
  const budgets = ledgerBudgetsFromPolicy(policy);
  if (Object.keys(budgets).length === 0) return null;
  if (policy.ledger === "memory") return createMemoryBudgetLedger({ budgets });
  // `persistent` needs the database handle, which does not exist when the gateway is constructed:
  // returning null here keeps the gate fail-closed until `VideoAssetService.init()` attaches the
  // durable ledger through `ProviderGateway.setLedger`.
  return null;
}

/**
 * The authorization + cost decision.
 *
 * @param {object} args
 * @param {string} args.entry canonical entry id
 * @param {"tool"|"gateway"|"browser"} args.surface
 * @param {object|null} args.context trusted context attached by the ingress layer
 * @param {object} args.params caller parameters (used only for the confirmation flag, never identity)
 * @param {object} args.policy resolved `security.generation` policy
 * @param {object|null} args.ledger budget ledger port
 * @param {{key:string,kind:string}|null} [args.budget_scope] trusted, plugin-supplied reservation scope
 * @param {(args:{scope:object, attribution:object, entry:string, ledger:object|null}) => {ok:boolean, code?:string, reason?:string, details?:object, provider_request_id?:string, job_id?:string}} [args.verify_read_only]
 *        trusted acceptance check for an `intent: "read_only"` grant. It runs AFTER the identity/surface/
 *        confirmation gates (so a refusal still reports the identity verdict first) and BEFORE any
 *        reservation (so a rejected grant reserves nothing).
 */
export function authorizeGeneration({ entry, surface, context = null, params = {}, policy, ledger = null, budget_scope = null, verify_read_only = null }) {
  const definition = GENERATION_ENTRY_POLICY[entry];
  if (!definition) {
    return denial(GENERATION_DENIAL_CODES.ENTRY_UNKNOWN, `unknown generation entry: ${String(entry)}`, { entry, surface });
  }

  const attribution = describeAttribution(context);
  const audit = {
    entry,
    provider: definition.provider,
    surface,
    mode: policy.mode,
    attribution,
    budget_scope,
    cost: estimateGenerationCost(entry, params, policy)
  };

  const enforced = enforceGeneration({ entry, surface, attribution, params, policy, ledger, audit, budget_scope, verify_read_only });

  if (policy.mode === "monitor") {
    // Monitor observes. It records what enforcement WOULD have decided and still refuses: there is no
    // configuration that turns monitoring into a real-execution bypass (review round 2, issue 6).
    return {
      allowed: false,
      code: GENERATION_DENIAL_CODES.MONITOR_OBSERVE_ONLY,
      error: "generation policy is in monitor mode: the decision was recorded for observation, but no provider call is authorized",
      details: { entry, surface, mode: "monitor", would_allow: enforced.allowed === true, would_code: enforced.code ?? "OK", would_details: enforced.details ?? null },
      audit: { ...audit, shadow: { allowed: enforced.allowed === true, code: enforced.code ?? "OK", details: enforced.details ?? null, budget: enforced.audit?.budget ?? null } },
      shadow: enforced
    };
  }

  return enforced;
}

/** The enforcing decision: surfaces, actor, scope, confirmation, read-only binding, budget. */
function enforceGeneration({ entry, surface, attribution, params, policy, ledger, audit, budget_scope = null, verify_read_only = null }) {
  if (!policy.allowSurfaces.includes(surface)) {
    return denial(GENERATION_DENIAL_CODES.SURFACE_NOT_ALLOWED, `generation surface "${surface}" is not authorized for this deployment`, {
      entry,
      surface,
      allow_surfaces: policy.allowSurfaces
    }, audit);
  }

  if (attribution.trusted) {
    if (policy.allowActors.length === 0 || !policy.allowActors.some((pattern) => actorMatches(pattern, attribution.actor_id))) {
      return denial(GENERATION_DENIAL_CODES.ACTOR_NOT_ALLOWED, `actor "${attribution.actor_id}" is not authorized to run paid generation`, {
        entry,
        surface,
        actor_id: attribution.actor_id,
        allow_actors: policy.allowActors
      }, audit);
    }
    // Scope gate for trusted callers. An unattributed call has no scope to check at all - it is
    // governed by `unattributedPolicy` above - so the gate must not be applied to it, or the
    // documented unattributed grant could never be used.
    if (policy.requireOperatorScope) {
      const scopes = Array.isArray(attribution.scopes) ? attribution.scopes : [];
      if (!(scopes.includes("operator.admin") || scopes.includes("operator.write"))) {
        return denial(GENERATION_DENIAL_CODES.SCOPE_REQUIRED, "trusted caller scopes do not include operator.write", {
          entry,
          surface,
          actor_id: attribution.actor_id,
          trusted_scopes: scopes,
          hint: "security.generation.requireOperatorScope=false makes the actor allowlist the only identity gate; keep it true unless the host cannot supply scopes"
        }, audit);
      }
    }
  } else if (policy.unattributedPolicy !== "allow-with-surface-grant") {
    return denial(GENERATION_DENIAL_CODES.UNATTRIBUTED, "no trusted caller identity is available for this generation call", {
      entry,
      surface,
      hint: "the trusted identity normally comes from the host tool factory context / gateway host context; an unattributed call must be granted explicitly with security.generation.unattributedPolicy=allow-with-surface-grant and must be limited with unattributedSurfaces"
    }, audit);
  } else if (!policy.unattributedSurfaces.includes(surface)) {
    return denial(GENERATION_DENIAL_CODES.UNATTRIBUTED, `surface "${surface}" may not run unattributed generation`, {
      entry,
      surface,
      unattributed_surfaces: policy.unattributedSurfaces
    }, audit);
  }

  if (policy.requireConfirmation && !confirmationPresent(params)) {
    return denial(GENERATION_DENIAL_CODES.CONFIRMATION_REQUIRED, "paid generation requires an explicit cost confirmation flag", {
      entry,
      surface,
      accepted_flags: ["accept_credit_spend=true", "accept_cost=true", "confirm_cost=true"]
    }, audit);
  }

  // A read-only grant is the ONE grant that may skip today's caps, so it is the one grant that must be
  // bound to a durable fact instead of to the caller's declaration: the job whose submission a provider
  // actually accepted. This runs after the identity gates (a refused actor still reports ACTOR_NOT_ALLOWED)
  // and before the reservation (a refused binding reserves nothing). No verifier port means no proof, and
  // no proof means no cap-free read.
  let read_only_binding = null;
  if (budget_scope?.intent === "read_only") {
    if (typeof verify_read_only !== "function") {
      return denial(GENERATION_DENIAL_CODES.READ_ONLY_BINDING_REQUIRED, "a read-only grant cannot be verified in this deployment, so it is refused instead of granted a cap-free reuse", {
        entry,
        surface,
        scope_key: budget_scope?.key ?? null,
        ledger: ledger?.kind ?? "none",
        hint: "the acceptance proof comes from the queue's durable job row, which only the persistent ledger can read (security.generation.ledger: \"persistent\")"
      }, audit);
    }
    const verification = verify_read_only({ scope: budget_scope, attribution, entry, ledger }) ?? { ok: false, reason: "the acceptance check returned no verdict" };
    if (verification.ok !== true) {
      return denial(verification.code ?? GENERATION_DENIAL_CODES.READ_ONLY_BINDING_REQUIRED, "a read-only grant must name a job whose provider submission was accepted; the durable evidence does not support this grant", {
        entry,
        surface,
        scope_key: budget_scope?.key ?? null,
        actor_id: attribution.actor_id,
        ...(verification.details ?? {}),
        ...(verification.reason ? { reason: verification.reason } : {})
      }, audit);
    }
    read_only_binding = {
      job_id: verification.job_id ?? null,
      provider_request_id: verification.provider_request_id ?? null,
      entry: verification.entry ?? entry,
      actor_id: verification.actor_id ?? attribution.actor_id,
      provider_submit_state: verification.provider_submit_state ?? "submitted"
    };
  }

  if (policy.requireBudget) {
    if (!ledger) {
      return denial(GENERATION_DENIAL_CODES.BUDGET_LEDGER_MISSING, "no budget ledger is configured for paid generation", {
        entry,
        surface,
        hint: "REN-10 owns the persistent ledger; set security.generation.ledger to an available implementation with configured limits before enabling real execution"
      }, audit);
    }
    const estimate = audit.cost;
    if (estimate.credits === null) {
      return denial(GENERATION_DENIAL_CODES.BUDGET_UNKNOWN_COST, "the cost of this generation entry has no evidence: no operator-supplied estimate is configured", {
        entry,
        surface,
        reference_credits: estimate.reference_credits ?? null,
        reference_evidence: estimate.reference_evidence ?? null,
        hint: estimate.hint
      }, audit);
    }
    // A scope that carries a key is a reservation identity; `kind` says which authority owns it and
    // `intent` says whether this authorization is a NEW paid submission or collection of a read-only
    // result for an operation the provider already accepted. The ledger enforces the difference: a paid
    // reservation must fit today's limits (so a pre-created reservation cannot bypass a lowered cap),
    // while a bound read-only recovery may reuse what that scope already holds - and it re-verifies the
    // acceptance itself, so the exemption does not depend on this layer having done it.
    const reservation = ledger.reserve(entry, estimate.credits, {
      key: budget_scope?.key ?? null,
      kind: budget_scope?.kind ?? "unspecified",
      intent: budget_scope?.intent ?? "paid",
      actor_id: attribution.actor_id ?? null
    });
    if (!reservation.ok) {
      return denial(reservation.code, reservation.code === GENERATION_DENIAL_CODES.BUDGET_EXCEEDED ? "budget exhausted for this generation entry" : "budget ledger cannot authorize this generation entry", {
        entry,
        surface,
        estimate_credits: estimate.credits,
        ...reservation.details
      }, audit);
    }
    return { allowed: true, audit: { ...audit, budget: { ...reservation, ledger: ledger.kind ?? "unknown" }, read_only_binding }, reservation, read_only_binding };
  }

  return { allowed: true, audit, read_only_binding };
}

function confirmationPresent(params = {}) {
  return params?.accept_credit_spend === true || params?.accept_cost === true || params?.confirm_cost === true;
}

/**
 * Attribution resolver. A model-supplied `actor_id` is never treated as identity: it is reported as
 * `request-param` provenance so an operator can see that the value is untrusted.
 */
export function describeAttribution(context) {
  if (context && typeof context === "object") {
    const actorId = typeof context.actor_id === "string" && context.actor_id.trim() ? context.actor_id.trim() : null;
    return {
      actor_id: actorId ?? "unattributed",
      actor_type: typeof context.actor_type === "string" ? context.actor_type : "unknown",
      trusted: context.trusted === true,
      source: context.source ?? (context.trusted === true ? "host-context" : "unattributed"),
      scopes: Array.isArray(context.scopes) ? context.scopes : undefined
    };
  }
  return { actor_id: "unattributed", actor_type: "unknown", trusted: false, source: "unattributed", scopes: undefined };
}

function denial(code, error, details, audit = null) {
  return { allowed: false, code, error, details, audit };
}
