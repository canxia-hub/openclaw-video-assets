---
name: "video-canvas-operator"
description: "video-canvas 画布操作规范：槽位/生成/写回/审片/返修，适配 v1.4 工作台新前端"
---

# Video Canvas Operator

## Purpose

Use this skill when operating a `video-assets` / `video-canvas` production canvas as the control surface for multimedia work. The canvas is not a decorative board: it is a recoverable production map for project refs, assets, asset versions, entities, notes, generation slots, generated outputs, review annotations, revision cards, and lineage.

This skill matches the current canvas plugin capabilities together with the video-assets Workbench v1.4 frontend (2026-08-07, replacing the old Phase F fallback UI): a React Flow read-only canvas page (`/canvas`) with section/stage visualization, a generation-prep page (`/generate`) rendering generation-package slots, preflight gates and warnings, generation slot editing, generation package and handoff, Dreamina CLI planning and real video generation, ingest-first generated asset writeback, screenshot/review annotation, revision card flow, output lineage, edge relation semantics, idempotent writeback, and Chinese user-facing localization.

## Core Rules

1. Resolve the project and canvas before editing.
2. Treat every persistent output as an asset-chain object, not a loose file.
3. Use generation slots for planned generation work; do not use unstructured notes as substitutes for slots.
4. Use dry-run and handoff before real generation.
5. Execute real Dreamina generation only after explicit credit-spend acceptance.
6. Ingest generated files before writing them back to the canvas.
7. Keep generated tests as `license_status=unknown` and `risk_level=unknown` unless explicit evidence clears them.
8. Canvas card deletion never deletes underlying assets; avoid destructive operations unless explicitly authorized.
9. Do not claim final release readiness from canvas readiness alone.
10. Keep internal API/tool names intact; localize user-facing UI or report language without breaking plugin contracts.

## Current Tool Surface

Use the dynamic tools when available. Refresh tool discovery if a recently added tool is missing.

Read and context:

- `video_canvas_search`
- `video_canvas_get`
- `video_canvas_agent_context`
- `video_canvas_widget_context`
- `video_canvas_lint`
- `video_canvas_generation_package`
- `video_canvas_generation_handoff`
- `video_canvas_dreamina_cli_plan`

Canvas state and Workbench context:

- `video_canvas_save_selection`
- `video_canvas_get_selection`
- `video_canvas_save_view_state`
- `video_canvas_get_view_state`
- `video_canvas_save_snapshot`
- `render_video_assets_canvas_widget`

Canvas mutation:

- `video_canvas_apply_production_template`
- `video_canvas_upsert_shape`
- `video_canvas_delete_shape`
- `video_canvas_link_shapes`
- `video_canvas_unlink_shapes`
- `video_canvas_create_generation_slot`
- `video_canvas_update_generation_slot`

Review and revision:

- `video_canvas_export_annotation_brief`
- `video_canvas_register_review_annotation`
- `video_canvas_create_revision_card`
- `video_canvas_update_revision_card_status`

Generated output writeback:

- `video_canvas_insert_generated_asset`
- `video_canvas_fill_generation_slot`
- `video_canvas_dreamina_cli_generate_video`

Project spec:

- `video_project_update_spec`

## Standard Workflow

1. Resolve canvas.
   - Use `video_canvas_search` when only project title, slug, or canvas title is known.
   - Use `video_canvas_get` when `canvas_id` is known.
   - Prefer the existing live project canvas over creating duplicates.

2. Read context.
   - Run `video_canvas_agent_context` for shapes, bindings, stages, and action policy.
   - Run `video_canvas_lint` before edits.
   - If using Workbench state, read `video_canvas_widget_context`, selection, and view state.

3. Verify stage structure.
   - Use `video_canvas_apply_production_template` only when stage sections are missing or damaged.
   - Treat template reapplication as idempotent repair, not creative direction.

4. Create or update bound cards.
   - Use `project_ref`, `asset_card`, `asset_version`, `entity_card`, section, or note bindings appropriately.
   - Keep `props.stage`, `props.slot`, `props.role`, and `subject_type` explicit.
   - Use notes only for planning gaps, review instructions, or revision cards.

5. Link production meaning.
   - Use `contains` for section-to-content.
   - Use `references`, `depends_on`, `appears_in`, `uses`, `derived_from`, `revises`, `replaces`, or `continues` only when the relation helps later Agents choose or audit inputs.
   - Avoid decorative links.

6. Build generation readiness.
   - Use `video_canvas_generation_package` for target generation type.
   - Use `video_canvas_generation_handoff` before real generation.
   - Use `video_canvas_dreamina_cli_plan` for zero-cost Dreamina command planning.

7. Produce or ingest output.
   - For real generation, follow the Dreamina protocol below.
   - For existing local generated files, call `video_canvas_fill_generation_slot` or `video_canvas_insert_generated_asset`.
   - Prefer `fill_generation_slot` when a generation slot exists; use `insert_generated_asset` for direct placement beside a known slot or output.

8. Re-read and report.
   - Re-run `video_canvas_lint`.
   - Rebuild generation package/handoff to confirm slot status and target spec.
   - Report file, asset ids, version ids, project_ref, output shape, edge ids, lint results, and remaining risks.
   - Optional human-facing verification: open the canvas in Workbench `/canvas` (read-only React Flow view) and confirm node/edge counts via CDP DOM evidence; check slot readiness in `/generate`.

## Stage And Slot Rules

Production stages:

- `characters`: character refs, model sheets, expression refs, character entities.
- `scenes`: scene refs, location entities, background refs, environment concepts.
- `props`: props, equipment, wardrobe, reusable objects.
- `references`: style, motion, composition, and cleared external references.
- `audio`: voice, music, SFX, subtitles, transcripts.
- `shots`: shot notes, clip candidates, storyboard refs, generation slots.
- `delivery`: export settings, platform targets, covers, QA notes, generated test outputs.

Input slots:

- `main_reference`
- `character_reference`
- `scene_reference`
- `motion_reference`
- `style_reference`
- `video_clip`
- `audio`
- `subtitle`
- `project_config`

Output or working slots:

- `draft_output`
- `review_delivery`
- `generated_output`
- `revision_output`
- `replacement_output`
- `timeline_output`

Do not let output cards be mistaken for generation inputs unless they are explicitly reused as references.

## Generation Slot Contract

A production generation slot is usually a `note` shape with `props.role="generation_slot"`. Current supported fields include:

```json
{
  "role": "generation_slot",
  "stage": "shots",
  "slot": "draft_output",
  "generation_slot": "draft_output",
  "generation_type": "image_to_video",
  "target_width": 1280,
  "target_height": 720,
  "target_aspect_ratio": "16:9",
  "duration_seconds": 5,
  "replace_policy": "insert_beside",
  "required_refs": ["character_reference", "scene_reference"],
  "status": "ready"
}
```

Slot lifecycle:

- `empty`: planned but missing required references or spec.
- `ready`: generation package/handoff can use it.
- `generating`: generation has been submitted or is actively being worked.
- `filled`: generated output has been ingested and written back.
- `blocked`: missing input, rights, risk, or technical issue prevents progress.

Recommended slot setup:

1. Create with `video_canvas_create_generation_slot`.
2. Edit with `video_canvas_update_generation_slot` when target spec changes.
3. Verify with `video_canvas_generation_package`.
4. Run `video_canvas_generation_handoff`.
5. Run `video_canvas_dreamina_cli_plan`.
6. Execute only after credit approval.
7. Fill with `video_canvas_fill_generation_slot`.

## Generation Types

Use `generation_type` conservatively:

- `image_to_video`: one primary image-like anchor and a short motion test.
- `multimodal_to_video`: mixed image/video/audio references, especially Seedance 2.0 all-reference flows.
- `text_to_video`: prompt-driven output with no continuity anchor.
- `image`: still image generation or image validation.
- `edit`: image/video edit workflows.
- `voice`, `subtitle`, `cover`, `export`: downstream pipeline tasks.

For `image_to_video`, at least one image-like input should come from `main_reference`, `character_reference`, `scene_reference`, or `style_reference`. A text note alone is not a media input unless it is bound to a project ref or asset.

## Dreamina CLI Protocol

Default low-cost video test:

```json
{
  "canvas_id": "<canvas_id>",
  "generation_type": "image_to_video",
  "model_version": "seedance2.0fast",
  "duration": 5,
  "video_resolution": "720p",
  "ratio": "16:9",
  "execute": false,
  "accept_credit_spend": false,
  "download_outputs": false,
  "ingest_outputs": false,
  "writeback_canvas": false
}
```

Planning path:

1. `video_canvas_lint`
2. `video_canvas_generation_package`
3. `video_canvas_generation_handoff`
4. `video_canvas_dreamina_cli_plan`
5. `dreamina.exe user_credit`
6. Ask for explicit credit-spend acceptance if not already given.

Execution path:

1. Use `video_canvas_dreamina_cli_generate_video` when the dynamic tool can complete within runtime limits.
2. Set `execute=true` and `accept_credit_spend=true` only after explicit acceptance.
3. Set `download_outputs=true`, `ingest_outputs=true`, and `writeback_canvas=true` only when you want the tool to perform the full chain.
4. Use `output_dir` under the project output tree, not a temp directory.
5. Keep generated output as `kind=working`, `license_status=unknown`, and `risk_level=unknown` unless cleared.

Verified P4 real-generation pattern:

- `image_to_video`
- `seedance2.0fast`
- `720p`
- `5s`
- Result: 1280x720 MP4, about 5.09 seconds, 25 credits.
- After download, verify with `ffprobe`, then write back with `video_canvas_fill_generation_slot`.

## Dreamina Timeout And Recovery

OpenClaw dynamic tool RPC may time out before Dreamina generation completes. A timeout is not proof of failure.

Recovery procedure:

1. Do not immediately resubmit.
2. Check `dreamina.exe user_credit` for unexpected credit changes.
3. Read Dreamina logs under `%USERPROFILE%\.dreamina_cli\logs\dreamina.log.<date_hour>` (or the equivalent log directory for your Dreamina CLI installation).
4. Extract `submit_id` from `[SubmitTask]`, `[QueryResult]`, or upload errors.
5. Query with:

```powershell
<dreamina-cli-path>\dreamina.exe query_result --submit_id=<submit_id>
```

6. If successful, download with:

```powershell
<dreamina-cli-path>\dreamina.exe query_result --submit_id=<submit_id> --download_dir <project-output-dir>
```

7. Run `ffprobe` before ingestion.
8. Use `video_canvas_fill_generation_slot` to write back.

Known failure mode:

- Upload to `tos-d-hl.bytedancevod.com` may fail with `context deadline exceeded`.
- The failed task may show `querying` but have no output.
- Record the failed `submit_id` and do not treat it as a successful generation.

## Generated Asset Writeback

Use `video_canvas_fill_generation_slot` for normal slot completion. It should:

- Ingest the file as a `working` asset.
- Create a project ref.
- Create a canvas output card beside the generation slot.
- Link the slot to the output with `derived_from` or the requested semantic relation.
- Update slot status to `filled` when appropriate.
- Return asset ids, version ids, project ref, output shape, edge ids, and lint results.

Typical writeback metadata:

```json
{
  "kind": "working",
  "license_status": "unknown",
  "risk_level": "unknown",
  "slot_status": "filled",
  "classification": {
    "domain": "delivery",
    "type": "generation_validation_video",
    "subtype": "image_to_video_real_test",
    "confidence": "confirmed",
    "source": "agent"
  },
  "source": {
    "source_type": "dreamina_cli",
    "submit_id": "<submit_id>",
    "model_version": "seedance2.0fast",
    "video_resolution": "720p",
    "duration_seconds": 5
  },
  "writeback": {
    "semantic": "generated_output",
    "mode": "insert_beside",
    "source_slot_shape_id": "<slot_shape_id>"
  }
}
```

## Writeback Semantics And Lineage

Use the slot `replace_policy` or explicit `writeback` object to preserve meaning.

Common semantics:

- `insert_beside`: create a new generated output near the slot.
- `new_revision`: create revision output and lineage relation `revises` / asset relation `revision_of`.
- `replace_slot`: create replacement output and relation `replaces`.
- `append_timeline`: create timeline output and relation `continues`.

Generated output cards should include:

- `role`: `generated_output`, `revision_output`, `replacement_output`, or `timeline_output`.
- `writeback_policy`
- `writeback_semantic`
- `idempotency_key`
- `source_sha256`
- `lineage_key`
- `asset_id`
- `asset_version_id`
- `reference_id`
- previous shape / asset / version ids when relevant.

## Idempotency

The current plugin protects repeated generated-asset writeback. If the same slot, same file SHA256, and same semantic are submitted again, it should return `idempotent.reused=true` and reuse existing asset/project_ref/output card/edge/lineage instead of duplicating records.

Before repeating a writeback:

1. Check whether the previous call succeeded.
2. Re-read canvas and generation package.
3. Prefer idempotent retry over manual cleanup.
4. Do not delete assets to recover from duplicate cards unless explicitly authorized.

## Review Annotation Workflow

Use review annotations when a visual or generated result needs feedback.

1. Select a target card or provide `shape_id`.
2. Call `video_canvas_export_annotation_brief` to gather target context, lint issues, suggested target, and existing metadata.
3. Call `video_canvas_register_review_annotation` to persist feedback to asset annotations.
4. If a screenshot exists, include `screenshot_asset_version_id` and structured marks when supported.
5. Keep annotation status and visibility appropriate for project review.

Annotation types may include:

- `review_note`
- `visual_continuity`
- `character_profile`
- `scene_concept`
- `technical_issue`
- `rights_review`

## Revision Card Workflow

Use revision cards to turn review notes into trackable change requests.

Create a revision card when:

- A review annotation needs follow-up.
- A generated output needs a revision, replacement, or rejection decision.
- Output lineage needs an explicit reviewed-by relation.

Tools:

- `video_canvas_create_revision_card`
- `video_canvas_update_revision_card_status`

Revision card status values:

- `open`
- `in_progress`
- `resolved`
- `rejected`

A revision card should link back to its source review annotation or output card using a `references` edge with semantic `reviewed_by` when available. Do not alter the source annotation when merely changing workflow status.

## Workbench And Widget State

The native `ui://widget` resource route remains host-gated. Since 2026-08-07 the primary human-facing surface is the Workbench v1.4 frontend (not the old fallback UI):

- `/canvas` — React Flow read-only canvas visualization: stage sections, bound cards, relation edges, MiniMap; drag is not persisted, so all structure changes still go through `video_canvas_*` mutation tools.
- `/generate` — generation-prep view: generation type selector, slot matching groups, preflight gates (`gates.warnings`) and the full JSON package; use it to sanity-check what `video_canvas_generation_package` reports.
- Shape selection on `/canvas` opens the Shape inspector (right column) with bound subject info.

Use Workbench state tools for machine-readable operational context:

- `video_canvas_save_selection`
- `video_canvas_get_selection`
- `video_canvas_save_view_state`
- `video_canvas_get_view_state`
- `video_canvas_widget_context`

Selection/view state is operational context, not durable production truth. Do not treat it as final asset metadata. Frontend acceptance evidence should be DOM-first (CDP evaluation), with screenshots only as supporting archive.

## Chinese Localization Boundary

The Workbench user-facing UI is expected to be Chinese-localized. Keep visible labels, statuses, placeholders, enum display names, copy/export previews, and default review text in Chinese when presenting to the user.

Do not rename internal tool names, TypeScript types, RPC method names, manifest tool names, database fields, or backend data contracts. Translate for display, not for storage contracts.

## Lint And Risk Handling

Always report lint as errors, warnings, and infos.

- `errors`: block generation or writeback until fixed.
- `warnings`: may be accepted for tests, but must be named.
- `infos`: usually non-blocking, but can reveal isolated cards or missing relationships.

Common warnings:

- `ASSET_LICENSE_NOT_CLEARED`: keep output/internal status unless cleared.
- `ASSET_RISK_REVIEW`: risk needs review before final use.
- `MISSING_TAXONOMY`: classify before relying on the asset for production decisions.
- `ISOLATED_SHAPE`: connect card to stage or source if needed.

Never mark generated or external outputs as cleared without human/source evidence.

## Reporting Template

For any canvas operation, report:

- Canvas and project id.
- Main tool calls performed.
- Slot id and status if a generation slot is involved.
- Output file path and technical specs if media was produced.
- Asset id, asset version id, project ref, output shape, and edge id after writeback.
- Lint result after writeback.
- Whether output is a test sample or final candidate.
- Remaining warnings and next action.

## Done Criteria

A canvas operation is done when:

1. Target canvas has been re-read or otherwise verified after mutation.
2. Lint has been checked after the change.
3. Generation package/handoff status has been checked when relevant.
4. Media files have been verified with `ffprobe`, image metadata, or equivalent runtime checks.
5. Generated files have been ingested before canvas writeback.
6. Asset ids, version ids, project refs, shape ids, and edge ids are reported.
7. License/risk status is explicit.
8. Remaining warnings are named.
9. The next handoff is clear: review, revision card, more generation, rights cleanup, or final QA.

## When To Stop

Stop and report instead of continuing when:

- A tool reports lint errors that block generation.
- Required references are missing.
- Credit spend was not explicitly accepted.
- Dreamina logs show upload or submission failure and no successful `submit_id` exists.
- Generated media cannot be downloaded or verified.
- Rights/risk status is unknown and the user asks for final/public release.
- Native widget behavior is blocked by host API availability.
