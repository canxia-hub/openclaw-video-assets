/**
 * REN-02 (review round 2, issue 4): the AUTHORITATIVE census of every registered tool and gateway
 * RPC, and the explicit statement of what each one may do.
 *
 * Why this file exists
 * --------------------
 * The first implementation tried to find "generation-looking" names with a naming heuristic
 * (`/(^|_)(generate|upscale)($|_)/`) and only WARNED about the names it found. That is a
 * review-only signal wearing a hard-failure costume: a new paid entry point whose name the regex
 * does not match (`..._submitTask`, `..._render`, a localised name) would have escaped the gate
 * silently, while the report claimed "a new generation tool cannot escape".
 *
 * This file replaces the heuristic with a closed-world declaration:
 *   * every tool and every gateway RPC the plugin registers MUST appear here;
 *   * a name declared `provider-operation` MUST name a canonical generation entry, and that entry
 *     MUST exist in `GENERATION_ENTRY_POLICY` (which in turn carries the provider id);
 *   * a name declared non-provider MUST say so explicitly, per name - no inference;
 *   * registration FAILS (throws) when a registered name is missing from the census, when a
 *     provider-operation points at an unknown entry, or when an entry has no entry point.
 *
 * A new paid entry point therefore cannot be added without editing this table, and editing this
 * table for a paid operation without a policy entry is itself a hard failure. That is the property
 * the previous round claimed but did not have.
 *
 * Value grammar: `"<kind>"` or `"<kind> <entry-id>"`.
 *   provider-operation  - may reach a paid provider; REQUIRES an entry id
 *   provider-orchestration - durable REN-10 job worker; provider/entry are bound in the persisted job and
 *                            rechecked by the job authority before execution
 *   plan                - builds a request/handoff package; never executes a provider call
 *   local-derivative    - creates or ingests a file locally (ffmpeg copy/thumbnail, writeback of an
 *                         already-generated file); reaches no provider
 *   local-write         - mutates the local repository/canvas
 *   local-read          - reads the local repository/canvas
 *   ui-bridge           - serves the browser workbench surface
 */

import { NARRATIVE_CLASSIFICATIONS } from "./narrative-contract.js";

export const CLASSIFICATION_KINDS = Object.freeze([
  "provider-operation",
  "provider-orchestration",
  "plan",
  "local-derivative",
  "local-write",
  "local-read",
  "ui-bridge"
]);

/** Tool name (as registered) -> classification. Closed world: 69 tools, no wildcards. */
export const TOOL_CLASSIFICATION = Object.freeze({
  ...NARRATIVE_CLASSIFICATIONS.tools,
  // --- paid provider operations (the only names that may reach a provider) ----------------------
  video_canvas_dreamina_cli_generate_video: "provider-operation dreamina.video.generate",
  video_canvas_dreamina_cli_generate_image: "provider-operation dreamina.image.generate",
  video_canvas_dreamina_cli_upscale_image: "provider-operation dreamina.image.upscale",
  video_audio_doubao_generate: "provider-operation audio.doubao.generate",
  video_canvas_doubao_audio_generate: "provider-operation audio.doubao.canvas.generate",
  video_audio_kie_suno_generate: "provider-operation audio.kie.generate",
  video_canvas_kie_suno_audio_generate: "provider-operation audio.kie.canvas.generate",

  // --- plans / packages: build a request, never execute ------------------------------------------
  video_audio_doubao_plan: "plan",
  video_canvas_doubao_audio_plan: "plan",
  video_audio_kie_suno_plan: "plan",
  video_canvas_kie_suno_audio_plan: "plan",
  video_canvas_dreamina_cli_plan: "plan",
  video_canvas_generation_package: "plan",
  video_canvas_generation_handoff: "plan",

  // --- local file work: ffmpeg derivatives and writeback of already-produced files ----------------
  video_asset_register_derived_file: "local-derivative",
  video_asset_generate_derived_file: "local-derivative",
  video_canvas_fill_generation_slot: "local-derivative",
  video_canvas_insert_generated_asset: "local-derivative",

  // --- repository / canvas writes -----------------------------------------------------------------
  video_asset_ingest: "local-write",
  video_asset_update_metadata: "local-write",
  video_asset_update_rights: "local-write",
  video_asset_create_version: "local-write",
  video_asset_create_branch: "local-write",
  video_asset_save_copy: "local-write",
  video_asset_classify: "local-write",
  video_entity_create: "local-write",
  video_entity_link_asset: "local-write",
  video_asset_annotate: "local-write",
  video_asset_update_annotation: "local-write",
  video_project_create: "local-write",
  video_project_update_spec: "local-write",
  video_project_add_asset_ref: "local-write",
  video_project_update_asset_ref: "local-write",
  video_project_remove_asset_ref: "local-write",
  video_canvas_create: "local-write",
  video_canvas_apply_production_template: "local-write",
  video_canvas_save_snapshot: "local-write",
  video_canvas_upsert_shape: "local-write",
  video_canvas_create_generation_slot: "local-write",
  video_canvas_update_generation_slot: "local-write",
  video_canvas_delete_shape: "local-write",
  video_canvas_link_shapes: "local-write",
  video_canvas_unlink_shapes: "local-write",
  video_canvas_save_selection: "local-write",
  video_canvas_save_view_state: "local-write",
  video_canvas_register_review_annotation: "local-write",
  video_canvas_create_revision_card: "local-write",
  video_canvas_update_revision_card_status: "local-write",

  // --- reads --------------------------------------------------------------------------------------
  video_asset_search: "local-read",
  video_asset_get: "local-read",
  video_asset_lineage: "local-read",
  video_asset_derived_files: "local-read",
  video_asset_integrity_scan: "local-read",
  video_asset_get_classification: "local-read",
  video_asset_taxonomy_report: "local-read",
  video_entity_search: "local-read",
  video_asset_annotations: "local-read",
  video_project_refs: "local-read",
  video_project_asset_report: "local-read",
  video_project_continuity_report: "local-read",
  video_canvas_search: "local-read",
  video_canvas_get: "local-read",
  video_canvas_agent_context: "local-read",
  video_canvas_export_annotation_brief: "local-read",
  video_canvas_lint: "local-read",
  video_canvas_get_selection: "local-read",
  video_canvas_get_view_state: "local-read",

  // --- browser widget bridge ----------------------------------------------------------------------
  render_video_assets_canvas_widget: "ui-bridge",
  video_canvas_widget_context: "ui-bridge"
});

/** Gateway RPC name -> classification. Closed world: 77 methods, no wildcards. */
export const RPC_CLASSIFICATION = Object.freeze({
  ...NARRATIVE_CLASSIFICATIONS.rpc,
  // paid provider operations
  "videoAssets.canvas.dreaminaCliGenerateVideo": "provider-operation dreamina.video.generate",
  "videoAssets.audio.doubaoGenerate": "provider-operation audio.doubao.generate",
  "videoAssets.canvas.doubaoAudioGenerate": "provider-operation audio.doubao.canvas.generate",
  "videoAssets.audio.kieSunoGenerate": "provider-operation audio.kie.generate",
  "videoAssets.canvas.kieSunoAudioGenerate": "provider-operation audio.kie.canvas.generate",

  // plans
  "videoAssets.audio.doubaoPlan": "plan",
  "videoAssets.canvas.doubaoAudioPlan": "plan",
  "videoAssets.audio.kieSunoPlan": "plan",
  "videoAssets.canvas.kieSunoAudioPlan": "plan",
  "videoAssets.canvas.dreaminaCliPlan": "plan",
  "videoAssets.canvas.generationPackage": "plan",
  "videoAssets.canvas.generationHandoff": "plan",

  // local file work
  "videoAssets.asset.registerDerivedFile": "local-derivative",
  "videoAssets.asset.generateDerivedFile": "local-derivative",
  "videoAssets.canvas.fillGenerationSlot": "local-derivative",
  "videoAssets.canvas.insertGeneratedAsset": "local-derivative",
  "videoAssets.staging.ingest": "local-derivative",
  "videoAssets.staging.reject": "local-derivative",
  "videoAssets.staging.upload": "local-derivative",

  // writes
  "videoAssets.asset.updateMetadata": "local-write",
  "videoAssets.asset.updateRights": "local-write",
  "videoAssets.asset.create": "local-write",
  "videoAssets.asset.createVersion": "local-write",
  "videoAssets.asset.createBranch": "local-write",
  "videoAssets.asset.saveCopy": "local-write",
  "videoAssets.asset.classify": "local-write",
  "videoAssets.entity.create": "local-write",
  "videoAssets.entity.linkAsset": "local-write",
  "videoAssets.annotation.create": "local-write",
  "videoAssets.annotation.update": "local-write",
  "videoAssets.project.create": "local-write",
  "videoAssets.project.updateSpec": "local-write",
  "videoAssets.project.addRef": "local-write",
  "videoAssets.project.updateRef": "local-write",
  "videoAssets.project.removeRef": "local-write",
  "videoAssets.canvas.create": "local-write",
  "videoAssets.canvas.applyProductionTemplate": "local-write",
  "videoAssets.canvas.saveSnapshot": "local-write",
  "videoAssets.canvas.upsertShape": "local-write",
  "videoAssets.canvas.createGenerationSlot": "local-write",
  "videoAssets.canvas.updateGenerationSlot": "local-write",
  "videoAssets.canvas.deleteShape": "local-write",
  "videoAssets.canvas.linkShapes": "local-write",
  "videoAssets.canvas.unlinkShapes": "local-write",
  "videoAssets.canvas.saveSelection": "local-write",
  "videoAssets.canvas.saveViewState": "local-write",
  // REN-08: the editable canvas' single write path. Classified as a local write because it is exactly that - it
  // edits canvas rows in the local SQLite repository and can reach no provider and no cost. It carries the same
  // classification as the per-gesture canvas writes it replaces (upsertShape / deleteShape / linkShapes /
  // unlinkShapes) BECAUSE it is the same kind of work: classifying it differently would assert a difference that
  // does not exist, and the census exists to make this a decision rather than an omission.
  "videoAssets.canvas.applyCommand": "local-write",
  "videoAssets.generationJob.create": "local-write",
  "videoAssets.generationJob.process": "provider-orchestration",
  "videoAssets.generationJob.reconcile": "provider-orchestration",
  "videoAssets.generationJob.resume": "local-derivative",
  "videoAssets.generationJob.cancel": "provider-orchestration",
  "videoAssets.canvas.registerReviewAnnotation": "local-write",
  "videoAssets.canvas.createRevisionCard": "local-write",
  "videoAssets.canvas.updateRevisionCardStatus": "local-write",

  // reads
  "videoAssets.asset.search": "local-read",
  "videoAssets.asset.browse": "local-read",
  "videoAssets.asset.get": "local-read",
  "videoAssets.asset.lineage": "local-read",
  "videoAssets.asset.derivedFiles": "local-read",
  "videoAssets.asset.integrityScan": "local-read",
  "videoAssets.asset.getClassification": "local-read",
  "videoAssets.asset.taxonomyReport": "local-read",
  "videoAssets.entity.search": "local-read",
  "videoAssets.annotation.list": "local-read",
  "videoAssets.project.get": "local-read",
  "videoAssets.project.search": "local-read",
  "videoAssets.project.listRefs": "local-read",
  "videoAssets.project.report": "local-read",
  "videoAssets.project.continuityReport": "local-read",
  "videoAssets.canvas.search": "local-read",
  "videoAssets.canvas.get": "local-read",
  "videoAssets.canvas.agentContext": "local-read",
  "videoAssets.canvas.reviewBrief": "local-read",
  "videoAssets.canvas.lint": "local-read",
  "videoAssets.canvas.getSelection": "local-read",
  "videoAssets.canvas.getViewState": "local-read",
  // REN-08: read side of the editable canvas - the revision and the command log. Both are local repository reads.
  "videoAssets.canvas.getRevision": "local-read",
  "videoAssets.canvas.listCommands": "local-read",
  "videoAssets.generationJob.get": "local-read",
  "videoAssets.generationJob.list": "local-read",
  "videoAssets.generationJob.events": "local-read",
  "videoAssets.audit.commits": "local-read",
  "videoAssets.ui.dashboardSummary": "local-read",

  // staging + file surface (local filesystem, no provider)
  "videoAssets.file.inspect": "local-read",
  "videoAssets.file.list": "local-read",
  "videoAssets.file.roots": "local-read",
  "videoAssets.file.search": "local-read",

  // browser widget bridge
  "videoAssets.canvas.widgetContext": "ui-bridge"
});

/**
 * Parse one census value. Exported so the checks can assert the grammar independently of the
 * registration path.
 * @returns {{kind:string, entry:string|null, valid:boolean, error:string|null}}
 */
export function parseClassification(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { kind: null, entry: null, entries: [], valid: false, error: "empty classification" };
  const [kind, entrySpec] = raw.split(/\s+/);
  if (!CLASSIFICATION_KINDS.includes(kind)) {
    return { kind: kind ?? null, entry: entrySpec ?? null, entries: [], valid: false, error: `unknown kind "${String(kind)}"` };
  }
  if (kind === "provider-operation") {
    if (!entrySpec) return { kind, entry: null, entries: [], valid: false, error: "provider-operation requires an entry id" };
    // A merged operation can reach several canonical generation entries (video_generate fronts both the
    // dreamina CLI entries and the audio/music ones). Such a name declares them comma-separated so the
    // census states the truth instead of pretending one paid path exists where there are seven.
    const entries = entrySpec.split(",").map((s) => s.trim()).filter(Boolean);
    if (entries.length === 0) return { kind, entry: null, entries: [], valid: false, error: "provider-operation requires at least one entry id" };
    return { kind, entry: entries[0], entries, valid: true, error: null };
  }
  if (entrySpec) {
    return { kind, entry: entrySpec, entries: [], valid: false, error: `${kind} must not carry an entry id` };
  }
  return { kind, entry: null, entries: [], valid: true, error: null };
}

/**
 * Authoritative coverage check for one registration generation.
 *
 * @param {{toolNames: string[], rpcNames: string[], entries: Record<string, object>}} args
 * @returns {{fatal: string[], provider_operations: Array<{name:string, entry:string, surface:string}>, unclassified: string[]}}
 */
export function classifyRegistration({ toolNames = [], rpcNames = [], entries = {}, surface = "legacy" }) {
  const fatal = [];
  const unclassified = [];
  const providerOperations = [];
  const toolTable = surface === "contract" ? TOOL_CLASSIFICATION_CONTRACT : TOOL_CLASSIFICATION;

  const check = (name, s) => {
    const table = s === "tool" ? toolTable : RPC_CLASSIFICATION;
    const value = table[name];
    if (value === undefined) {
      unclassified.push(`${s}:${name}`);
      return;
    }
    const parsed = parseClassification(value);
    if (!parsed.valid) {
      fatal.push(`${s} ${name}: ${parsed.error}`);
      return;
    }
    if (parsed.kind === "provider-operation") {
      for (const entry of parsed.entries) {
        if (!entries[entry]) {
          fatal.push(`${s} ${name}: provider-operation points at unknown generation entry "${String(entry)}"`);
          continue;
        }
        providerOperations.push({ name, entry, surface: s });
      }
    }
  };

  for (const name of toolNames) check(name, "tool");
  for (const name of rpcNames) check(name, "rpc");

  if (unclassified.length > 0) {
    fatal.push(
      `unclassified ${unclassified.length} registered name(s); every tool/RPC must be declared in src/generation-registry.js: ${unclassified.join(", ")}`
    );
  }

  // Reverse direction: a declared provider-operation that is not registered is also a defect (it
  // would mean the census drifted away from the plugin surface). Skipped when the caller supplied no
  // names at all (a partial classification call is not a registration). Checked against the SAME surface's
  // table, so the contract surface is not asked to register the legacy names it deliberately replaces.
  if (toolNames.length > 0) {
    for (const [name, value] of Object.entries(toolTable)) {
      const parsed = parseClassification(value);
      if (parsed.valid && parsed.kind === "provider-operation" && !toolNames.includes(name)) {
        fatal.push(`census declares tool ${name} as a provider operation but the plugin does not register it`);
      }
    }
  }
  if (rpcNames.length > 0) {
    for (const [name, value] of Object.entries(RPC_CLASSIFICATION)) {
      const parsed = parseClassification(value);
      if (parsed.valid && parsed.kind === "provider-operation" && !rpcNames.includes(name)) {
        fatal.push(`census declares RPC ${name} as a provider operation but the plugin does not register it`);
      }
    }
  }

  return { fatal, provider_operations: providerOperations, unclassified };
}

/**
 * Contract-surface classification: the 16 reduced operations (REN-04).
 *
 * Same closed-world discipline as TOOL_CLASSIFICATION: registration stops on any name missing from this
 * table, so a name cannot be added to the reduced surface without declaring whether it may reach a paid
 * provider. This is not optional bookkeeping - the first attempt shipped the reduced surface WITHOUT it and
 * the host refused to register: "unclassified registered name" for 12 of the 16.
 *
 * `video_generate` fronts seven canonical generation entries at once (the dreamina CLI entries plus the
 * audio and music ones), so it declares all seven. The parity check below verifies, from the adapter itself,
 * that exactly those paid paths - and no others - remain reachable.
 */
export const TOOL_CLASSIFICATION_CONTRACT = Object.freeze({
  ...NARRATIVE_CLASSIFICATIONS.tools,
  // --- may reach a paid provider ----------------------------------------------------------------
  video_generate:
    "provider-operation dreamina.video.generate,dreamina.image.generate,dreamina.image.upscale," +
    "audio.doubao.generate,audio.doubao.canvas.generate,audio.kie.generate,audio.kie.canvas.generate",

  // --- migration-window compatibility entry ---------------------------------------------------
  // It fronts the same adapters, so it declares every paid entry those legacy names belong to.
  video_legacy_dispatch:
    "provider-operation dreamina.video.generate,dreamina.image.generate,dreamina.image.upscale," +
    "audio.doubao.generate,audio.doubao.canvas.generate,audio.kie.generate,audio.kie.canvas.generate",

  // --- unchanged names shared with the legacy surface (same classification, no wildcard) ---------
  video_asset_ingest: "local-write",
  video_asset_classify: "local-write",
  video_asset_update_rights: "local-write",
  video_entity_search: "local-read",

  // --- reads ------------------------------------------------------------------------------------
  video_asset_read: "local-read",
  video_project_read: "local-read",
  video_canvas_read: "local-read",
  video_canvas_handoff: "local-read",

  // --- writes and local derivatives -------------------------------------------------------------
  video_asset_write: "local-write",
  video_project_write: "local-write",
  video_entity_manage: "local-write",
  video_canvas_slot: "local-write",
  video_canvas_board_write: "local-write",
  video_canvas_review_write: "local-write",

  // --- UI bridge --------------------------------------------------------------------------------
  video_canvas_widget: "ui-bridge",
});

/**
 * Paid-path parity between the reduced surface and the legacy surface.
 *
 * The census above is a hand-written table; this check derives the answer from the ADAPTER, so the two must
 * agree. Given the paid entry points the reduced surface reaches via its dispatch targets, it asserts:
 *   - every legacy provider name is still reachable through the adapter (no paid path was lost in the merge)
 *   - the adapter reaches no legacy name the census does not already declare as a provider operation
 *     (no new paid path appeared)
 *   - every entry the contract surface declares is one of the entries those legacy names belong to
 */
export function assertContractProviderParity({ adapterTargets = [], censusToolClassification = TOOL_CLASSIFICATION } = {}) {
  const legacyProviderNames = new Set(
    Object.entries(censusToolClassification)
      .map(([name, value]) => ({ name, parsed: parseClassification(value) }))
      .filter((item) => item.parsed.kind === "provider-operation")
      .map((item) => item.name)
  );
  const reachable = new Set(adapterTargets.map((t) => t.legacy));
  const problems = [];

  for (const name of legacyProviderNames) {
    if (!reachable.has(name)) problems.push(`paid entry point ${name} is no longer reachable through the reduced surface`);
  }
  // Every paid entry the contract surface declares must actually be reachable through the adapter, computed from
  // the compatibility entry's declared enum as well as from video_generate's dispatch table.
  const declaredEntries = new Set();
  for (const value of Object.values(TOOL_CLASSIFICATION_CONTRACT)) {
    const parsed = parseClassification(value);
    if (parsed.kind === "provider-operation") for (const e of parsed.entries) declaredEntries.add(e);
  }
  const reachableProviderEntries = new Set();
  for (const name of reachable) {
    const parsed = parseClassification(censusToolClassification[name]);
    if (parsed.kind === "provider-operation") for (const e of parsed.entries) reachableProviderEntries.add(e);
  }
  for (const entry of declaredEntries) {
    if (!reachableProviderEntries.has(entry)) problems.push(`declared entry ${entry} is not reachable through the adapter`);
  }
  for (const entry of reachableProviderEntries) {
    if (!declaredEntries.has(entry)) problems.push(`adapter reaches undeclared entry ${entry}`);
  }
  return {
    ok: problems.length === 0,
    legacy_provider_names: [...legacyProviderNames].sort(),
    reachable_provider_names: [...reachable].filter((n) => legacyProviderNames.has(n)).sort(),
    declared_entries: [...declaredEntries].sort(),
    reachable_entries: [...reachableProviderEntries].sort(),
    problems,
  };
}

/** Names the census marks as paid provider operations, for reports and coverage cross-checks. */
export function censusProviderNames() {
  const tools = Object.entries(TOOL_CLASSIFICATION)
    .map(([name, value]) => ({ name, parsed: parseClassification(value) }))
    .filter((item) => item.parsed.kind === "provider-operation")
    .map((item) => ({ name: item.name, entry: item.parsed.entry }));
  const rpc = Object.entries(RPC_CLASSIFICATION)
    .map(([name, value]) => ({ name, parsed: parseClassification(value) }))
    .filter((item) => item.parsed.kind === "provider-operation")
    .map((item) => ({ name: item.name, entry: item.parsed.entry }));
  return { tools, rpc };
}
