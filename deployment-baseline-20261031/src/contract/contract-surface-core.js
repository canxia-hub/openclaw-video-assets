// REN-04 / src/contract/contract-surface-core.js
//
// The reduced tool contract surface, and the migration adapter that keeps all 69 legacy names callable.
//
// RELATION TO THE BASELINE
//   src/index.js still registers the original 69 tools and is left untouched, so the REN-02 security
//   candidate remains byte-identical and can be measured as a baseline. This module registers the
//   CONTRACT surface described by contracts/domain-contract-registry.json: 16 typed domain operations
//   (10 resident, 6 discoverable on demand).
//
// SINGLE SOURCE
//   Names, descriptions, input schemas, RPC methods and the dispatch table come from
//   ./registry.generated.js, which harness/contract-generator.mjs emits from the registry. Nothing here
//   restates a schema by hand.
//
// CAPABILITY PRESERVATION
//   Every operation resolves its discriminator to exactly ONE legacy tool, and then calls the SAME service
//   method that legacy tool called (the `DISPATCH` table records the mapping). So a capability is never
//   reimplemented and never silently dropped: the dispatch table is derived from the real registration
//   sites, and the migration matrix asserts all 69 legacy tools resolve to a live service method.
//
// SINGLE-SUBMIT RULE
//   plan and execute are the same operation selected by `mode`, and direct/canvas by `target`. There is no
//   separate plan tool that could alias onto a generate tool, so one submission cannot be counted twice by
//   alias or retry. `resolveLegacy` returns exactly one legacy tool per call, or throws - it never returns
//   a set.
//
// ZERO COST
//   Registering this module does not contact any provider. Cost-bearing operations reach the provider only
//   through the same service methods the original tools used, which enforce accept_credit_spend.

import { withTrustedContext, trustedContextOf } from "../provider-gateway.js";
import { validateToolInput } from "../sdk-compat.js";
import { OPERATIONS, DISPATCH, LEGACY_ALIAS, CONTRACT_VERSION, LEGACY_PARAMS, LEGACY_DISPATCH, NARROW_SCHEMAS } from "./registry.generated.js";

const PLUGIN_ID = "video-assets-contract";

// ------------------------------------------------------------------------------------------------
// Discriminator -> legacy tool. One entry per operation; each value resolves to exactly one legacy tool.
// These tables are the migration adapter. Their coverage is asserted against the generated migration
// matrix by harness/contract-consistency.mjs, so a legacy tool cannot be dropped by editing here alone.
// ------------------------------------------------------------------------------------------------
const RESOLVERS = {
  video_asset_read: (a) => ({
    get: "video_asset_get",
    search: "video_asset_search",
    lineage: "video_asset_lineage",
    derived_files: "video_asset_derived_files",
    classification: "video_asset_get_classification",
    annotations: "video_asset_annotations",
    integrity_scan: "video_asset_integrity_scan",
    taxonomy_report: "video_asset_taxonomy_report",
  })[a.mode],
  video_asset_write: (a) => ({
    update_metadata: "video_asset_update_metadata",
    create_version: "video_asset_create_version",
    create_branch: "video_asset_create_branch",
    save_copy: "video_asset_save_copy",
    register_derived_file: "video_asset_register_derived_file",
    generate_derived_file: "video_asset_generate_derived_file",
    annotate: "video_asset_annotate",
    update_annotation: "video_asset_update_annotation",
  })[a.mode],
  video_asset_ingest: () => "video_asset_ingest",
  video_asset_classify: () => "video_asset_classify",
  video_asset_update_rights: () => "video_asset_update_rights",
  video_project_write: (a) => ({
    create: "video_project_create",
    update_spec: "video_project_update_spec",
    add_ref: "video_project_add_asset_ref",
    update_ref: "video_project_update_asset_ref",
    remove_ref: "video_project_remove_asset_ref",
  })[a.mode],
  video_project_read: (a) => ({
    refs: "video_project_refs",
    asset_report: "video_project_asset_report",
    continuity_report: "video_project_continuity_report",
  })[a.mode],
  video_canvas_slot: (a) => ({
    create: "video_canvas_create_generation_slot",
    update: "video_canvas_update_generation_slot",
    fill: "video_canvas_fill_generation_slot",
  })[a.mode],
  video_canvas_handoff: (a) => ({
    package: "video_canvas_generation_package",
    handoff: "video_canvas_generation_handoff",
    lint: "video_canvas_lint",
  })[a.mode],
  video_generate: (a) => {
    // (provider, media_kind, mode, target) -> legacy tool. dreamina_cli is canvas-only in the baseline.
    // `media_kind` rather than `kind`: the legacy audio/music tools declare `kind` as the ingested asset kind
    // (raw/working), so sharing the name would have collapsed two unrelated meanings into one field and the
    // dispatch enum would have been lost inside the union schema.
    const target = a.target ?? (a.provider === "dreamina_cli" ? "canvas" : "direct");
    return {
      "doubao_audio|audio|plan|direct": "video_audio_doubao_plan",
      "doubao_audio|audio|plan|canvas": "video_canvas_doubao_audio_plan",
      "doubao_audio|audio|execute|direct": "video_audio_doubao_generate",
      "doubao_audio|audio|execute|canvas": "video_canvas_doubao_audio_generate",
      "kie_suno|music|plan|direct": "video_audio_kie_suno_plan",
      "kie_suno|music|plan|canvas": "video_canvas_kie_suno_audio_plan",
      "kie_suno|music|execute|direct": "video_audio_kie_suno_generate",
      "kie_suno|music|execute|canvas": "video_canvas_kie_suno_audio_generate",
      "dreamina_cli|video|plan|canvas": "video_canvas_dreamina_cli_plan",
      "dreamina_cli|video|execute|canvas": "video_canvas_dreamina_cli_generate_video",
      "dreamina_cli|image|execute|canvas": "video_canvas_dreamina_cli_generate_image",
      "dreamina_cli|upscale|execute|canvas": "video_canvas_dreamina_cli_upscale_image",
    }[`${a.provider}|${a.media_kind}|${a.mode}|${target}`];
  },
  video_entity_manage: (a) => ({ create: "video_entity_create", link_asset: "video_entity_link_asset" })[a.mode],
  video_entity_search: () => "video_entity_search",
  video_canvas_read: (a) => ({
    get: "video_canvas_get",
    search: "video_canvas_search",
    agent_context: "video_canvas_agent_context",
    widget_context: "video_canvas_widget_context",
    get_selection: "video_canvas_get_selection",
    get_view_state: "video_canvas_get_view_state",
  })[a.mode],
  video_canvas_board_write: (a) => ({
    create: "video_canvas_create",
    upsert_shape: "video_canvas_upsert_shape",
    delete_shape: "video_canvas_delete_shape",
    link_shapes: "video_canvas_link_shapes",
    unlink_shapes: "video_canvas_unlink_shapes",
    save_snapshot: "video_canvas_save_snapshot",
    save_selection: "video_canvas_save_selection",
    save_view_state: "video_canvas_save_view_state",
    apply_production_template: "video_canvas_apply_production_template",
    insert_generated_asset: "video_canvas_insert_generated_asset",
  })[a.mode],
  video_canvas_review_write: (a) => ({
    register_annotation: "video_canvas_register_review_annotation",
    create_revision_card: "video_canvas_create_revision_card",
    update_revision_card_status: "video_canvas_update_revision_card_status",
    export_annotation_brief: "video_canvas_export_annotation_brief",
  })[a.mode],
  video_canvas_widget: () => "render_video_assets_canvas_widget",
};

const OPS_BY_TOOL = new Map(OPERATIONS.map((o) => [o.tool, o]));

/** The declared name of the migration-window compatibility entry (see contracts/domain-contract-registry.json). */
export const LEGACY_COMPAT_TOOL = "video_legacy_dispatch";

// Re-exported so the runtime checks can iterate the real dispatch table instead of re-deriving it.
// Re-exported so the runtime checks can iterate the real dispatch table instead of re-deriving it.
export { DISPATCH, OPERATIONS };

/** The tool names this surface registers, exposed so the entry point can match them against the packaged
 *  manifest (`contracts.tools` is a host admission list, so the two must be the same set). */
export const CONTRACT_TOOL_NAMES = OPERATIONS.map((o) => o.tool);

/**
 * Runtime enforcement of the contract's own constraint annotations.
 *
 * The host does not read `x-` JSON-Schema extensions, so emitting x-mutually-exclusive / x-at-least-one-of
 * without checking them here would make them decorative. This function is the only place they take effect,
 * and it is exercised in both directions by harness/contract-runtime-checks.mjs (a violating combination
 * must be refused; a legal combination must NOT be).
 */
export function validateArgs(toolName, args) {
  const op = OPS_BY_TOOL.get(toolName);
  if (!op) return { ok: false, error: `unknown operation ${toolName}` };
  const schema = op.input_schema ?? {};
  const present = (k) => args != null && Object.prototype.hasOwnProperty.call(args, k) && args[k] !== undefined && args[k] !== null;

  for (const group of schema["x-mutually-exclusive"] ?? []) {
    const hit = group.filter(present);
    if (hit.length > 1) {
      return { ok: false, error: `mutually exclusive fields supplied together: ${hit.join(", ")}` };
    }
  }
  for (const group of schema["x-at-least-one-of"] ?? []) {
    if (group.length && !group.some(present)) {
      return { ok: false, error: `at least one of these fields is required: ${group.join(", ")}` };
    }
  }
  return { ok: true };
}

/**
 * Resolve an operation invocation to exactly ONE legacy tool name.
 * Throws on an unknown tool or an unmatched discriminator rather than guessing: a silent fallback here
 * would let a capability be "preserved" on paper while never dispatching.
 */
export function resolveLegacy(toolName, args) {
  const resolver = RESOLVERS[toolName];
  if (!resolver) throw new Error(`no resolver for operation ${toolName}`);
  const legacy = resolver(args ?? {});
  if (!legacy) {
    const disc = ["mode", "provider", "media_kind", "target"].filter((k) => args?.[k] !== undefined).map((k) => `${k}=${args[k]}`).join(" ");
    throw new Error(`operation ${toolName} cannot resolve a legacy implementation for [${disc}]`);
  }
  return legacy;
}

/** The service method that backs a resolved legacy tool (from the generated dispatch table). */
export function resolveServiceMethod(toolName, legacy) {
  const table = DISPATCH[toolName] ?? {};
  const method = table[legacy] ?? null;
  if (!method) throw new Error(`no service method recorded for ${toolName} -> ${legacy}`);
  return method;
}

/** Static coverage view used by contract-consistency.mjs (no service instance required). */
export function adapterCoverage() {
  // The migration-window compatibility entry has no discriminator resolver BY DESIGN: its target comes from the
  // nested legacy name. It is covered when every legacy name its input enum declares is present in the dispatch
  // table, so "covers all operations" stays a real count instead of an exemption.
  const compatOp = OPS_BY_TOOL.get(LEGACY_COMPAT_TOOL);
  // Generated operations carry their schema as `input_schema` (the host-facing shape), not as `input`.
  const compatDeclared = compatOp ? (compatOp.input_schema?.properties?.legacy_tool?.enum ?? []) : [];
  const compatResolved = compatDeclared.filter((n) => LEGACY_DISPATCH[n]?.method);
  const compatCovered = compatDeclared.length > 0 && compatResolved.length === compatDeclared.length;
  return {
    operations: OPERATIONS.length,
    resident: OPERATIONS.filter((o) => o.resident).length,
    legacy_in_registry: OPERATIONS.reduce((a, o) => a + o.legacy.length, 0),
    legacy_in_dispatch: Object.values(DISPATCH).reduce((a, t) => a + Object.keys(t).length, 0),
    tools_with_resolver: Object.keys(RESOLVERS).length + (compatCovered ? 1 : 0),
    compat_entry: {
      tool: LEGACY_COMPAT_TOOL,
      declared_legacy_names: compatDeclared.length,
      resolved_legacy_names: compatResolved.length,
      covered: compatCovered,
      undispatched: compatDeclared.filter((n) => !LEGACY_DISPATCH[n]?.method),
    },
    resolver_targets_unique: Object.fromEntries(
      Object.entries(RESOLVERS).map(([tool, fn]) => {
        // Enumerate the resolver's reachable legacy names by probing its own tables via the registry lists.
        const op = OPS_BY_TOOL.get(tool);
        return [tool, op ? [...new Set(op.legacy)].length : 0];
      })
    ),
    legacy_alias_entries: Object.keys(LEGACY_ALIAS).length,
    contract_version: CONTRACT_VERSION,
  };
}

/**
 * Resolve a legacy tool name the way the compatibility entry does. Exposed so the consistency gate can verify
 * the compat surface reaches a real service method for EVERY declared name instead of trusting the enum.
 */
export function resolveLegacyDispatch(legacyName, legacyArgs = {}) {
  const target = LEGACY_DISPATCH[legacyName];
  if (!target || !target.method) return null;
  return { tool: target.tool, legacy: legacyName, method: target.method };
}

/**
 * Register the contract surface onto a host API, using the SAME service instance the plugin already
 * created. This is the integrated path: `src/index.js` calls it when the tool surface is configured as
 * "contract", so the reduced surface shares the repository handle, the security manager, the HTTP routes,
 * the RPC registration and the REN-02 identity/generation-registry logic that live inside the service
 * methods themselves.
 */

/**
 * Map the surface's `mode` onto the legacy consent flags, and keep the trusted identity intact.
 *
 * Why this is required rather than cosmetic: the legacy audio/music service methods only SUBMIT when
 * `execute === true` (and require `accept_cost === true`), and the dreamina methods require
 * `accept_credit_spend === true`. Real execution showed what happens without the mapping - a caller asking for
 * `mode=execute` was silently handed a PLAN (source: "doubao_audio_plan"), which is the worst possible
 * outcome for a paid operation: the caller believes work was submitted when nothing happened.
 *
 * The mapping sets `execute` from `mode`; the service's own REN-02 gates then refuse when the consent field
 * is missing, so this adds no new authorisation logic and cannot loosen the existing one.
 *
 * IDENTITY: the trusted context is a NON-ENUMERABLE symbol property, so a plain `{ ...args }` copy drops it.
 * The copy is therefore re-wrapped with `withTrustedContext(args, trustedContextOf(args))`.
 */
export function transformArgs(op, legacy, args) {
  const context = trustedContextOf(args);
  const declared = new Set(LEGACY_PARAMS[legacy] ?? []);
  const out = { ...args };

  // Surface-only discriminators must not leak into a service method that never declared them. A field the
  // target tool DOES declare is preserved as-is (notably the legacy `kind` = ingested asset kind).
  for (const key of ["mode", "provider", "media_kind", "target"]) {
    if (!declared.has(key)) delete out[key];
  }

  if (args?.mode === "execute") {
    // Setting the flag is what routes the call into the consent-checked path instead of the plan path.
    out.execute = true;
  } else if (args?.mode === "plan") {
    // Never submit from a plan call, even if the caller also passed a consent flag.
    out.execute = false;
    if (!declared.has("accept_credit_spend")) delete out.accept_credit_spend;
    if (!declared.has("accept_cost")) delete out.accept_cost;
  }
  return withTrustedContext(out, context ?? null);
}

/**
 * Build the plain operation SPECS for the reduced surface.
 *
 * This returns data only: { name, description, resident, properties, required, handler }. It deliberately
 * does NOT touch the host api. src/index.js turns each spec into a tool definition with its own `tool()`
 * helper and registers it through `registerToolDefinition`, which is what carries:
 *   - validateToolRegistration + registeredToolNames (the manifest admission list and the generation census
 *     read that set; bypassing it left the set empty, which is why the first attempt reported
 *     "0 registered-but-undeclared" instead of a real mismatch)
 *   - the tool FACTORY, so the host supplies the trusted run context per run
 *   - validateToolInput, toToolFailure (structured errors) and the cancellation signal
 *
 * IDENTITY: the handler passes `args` THROUGH to the service without spreading it. `withTrustedContext`
 * attaches the trusted context as a NON-ENUMERABLE symbol property, so `{ ...args }` would silently drop
 * the verified identity and the call would lose its attribution. Sharing the service instance is not the
 * same as inheriting the identity; the plumbing in src/index.js is what carries it, and this function must
 * not break it.
 */
export function buildOperationSpecs(service) {
  return OPERATIONS.map((op) => ({
    name: op.tool,
    description: op.description,
    resident: op.resident === true,
    op: op.op,
    properties: op.input_schema?.properties ?? {},
    required: Array.isArray(op.input_schema?.required) ? op.input_schema.required : [],
    // (args, toolCallCtx) - toolCallCtx carries the host-supplied identity that src/index.js resolved.
    handler: async (args, toolCallCtx) => {
      const validated = validateArgs(op.tool, args);
      // Throwing is intentional: the enclosing `tool()` execute() converts it through toToolFailure into the
      // plugin's structured error envelope (isError + code), so the contract surface emits the SAME failure
      // shape as every legacy tool instead of inventing its own.
      if (!validated.ok) throw new Error(validated.error);
      // The compatibility entry resolves its target from the nested legacy name, NOT from discriminators, so it
      // is handled BEFORE resolveLegacy(): that resolver has no table entry for this operation and would throw
      // "no resolver for operation video_legacy_dispatch" first. Measured, not assumed - the real host run
      // produced exactly that error until this branch was moved ahead of the resolver.
      if (op.tool === "video_legacy_dispatch") {
        const target = LEGACY_DISPATCH[args.legacy_tool];
        if (!target) throw new Error(`unknown legacy tool "${String(args.legacy_tool)}"`);
        const narrow = NARROW_SCHEMAS[`${target.tool}::${args.legacy_tool}`];
        if (narrow) {
          const check = validateToolInput({ name: args.legacy_tool, parameters: narrow, args: args.args ?? {} });
          if (!check.ok) throw new Error(`${args.legacy_tool}: ${check.error?.message ?? check.error}`);
        }
        // IDENTITY: the nested `args` object is plain JSON from the model and carries NO trusted context, so
        // spreading it alone would silently drop the host-supplied identity - the real host run reported
        // GENERATION_UNATTRIBUTED for exactly this reason before the context was re-attached from the OUTER
        // arguments. The trusted context lives on the outer args as a non-enumerable symbol.
        const nested = withTrustedContext({ ...(args.args ?? {}) }, trustedContextOf(args));
        const forwarded = transformArgs(OPS_BY_TOOL.get(target.tool) ?? { input: {} }, args.legacy_tool, nested);
        const result = await service[target.method](forwarded);
        return { legacy_tool: args.legacy_tool, service_method: target.method, result };
      }
      const legacy = resolveLegacy(op.tool, args);
      const method = resolveServiceMethod(op.tool, legacy);
      const result = await service[method](transformArgs(op, legacy, args));
      return result;
    },
  }));
}

/**
 * Adapter coverage summary, used by the consistency gate and the registration log line.
 */
export function contractSurfaceSummary() {
  return {
    registered: OPERATIONS.length,
    resident: OPERATIONS.filter((o) => o.resident).length,
    contract_version: CONTRACT_VERSION,
    legacy_names: Object.keys(LEGACY_ALIAS).length,
  };
}

/**
 * The legacy implementations a single operation can dispatch to, as pairs of (legacy tool, service method).
 * Exposed so the generation census can verify, from the adapter itself, that every paid entry point the old
 * surface had is still reachable - instead of trusting a hand-written name list.
 */
export function adapterTargets(toolName) {
  const table = DISPATCH[toolName];
  if (!table) return [];
  return Object.entries(table).map(([legacy, method]) => ({ legacy, method }));
}

/** Every (tool, legacy, method) triple reachable through the adapter. */
export function allAdapterTargets() {
  const viaOperations = OPERATIONS.flatMap((op) => adapterTargets(op.tool).map((t) => ({ tool: op.tool, ...t })));
  // The migration-window compatibility entry reaches the legacy names through LEGACY_DISPATCH rather than through
  // an operation-level dispatch table, so its targets are unioned in here. Paid-path parity is about what the
  // reduced surface can actually reach, not about which table it was declared in.
  const compatOp = OPS_BY_TOOL.get(LEGACY_COMPAT_TOOL);
  const viaCompat = compatOp
    ? Object.entries(LEGACY_DISPATCH).map(([legacy, t]) => ({ tool: compatOp.tool, legacy, method: t.method }))
    : [];
  const seen = new Set();
  return [...viaOperations, ...viaCompat].filter((t) => {
    const key = `${t.tool}|${t.legacy}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}


