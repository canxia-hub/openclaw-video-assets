# Video Canvas Tool Contract

This reference gives field-level examples for operating OpenClaw video project canvases. Prefer first-class canvas tools when available; use gateway RPC or local service fallback only when the current runtime has not refreshed a newly installed tool.

## Read Before Editing

```json
{ "canvas_id": "canvas_xxx", "viewport": { "x": 0, "y": 0, "width": 1600, "height": 1000 } }
```

Use this with `video_canvas_agent_context`. Then call `video_canvas_lint` with the same `canvas_id`.

## Apply Production Template

```json
{
  "canvas_id": "canvas_xxx",
  "project_id": "project_xxx",
  "title": "Production Pilot Canvas",
  "actor_id": "agent:tuan",
  "actor_type": "agent"
}
```

Use the template when stage sections are missing or production stage gaps need deterministic repair.

## Upsert A Production Card

```json
{
  "canvas_id": "canvas_xxx",
  "shape_type": "reference_card",
  "subject_type": "project_ref",
  "subject_id": "ref_xxx",
  "title": "Character Reference",
  "x": 240,
  "y": 160,
  "width": 260,
  "height": 160,
  "props": {
    "stage": "characters",
    "slot": "character_reference",
    "role": "production_input"
  }
}
```

Common shape bindings:

- `subject_type=project_ref`: preferred production input card.
- `subject_type=asset`: broad asset card when no pinned version is required.
- `subject_type=asset_version`: exact media version card.
- `subject_type=entity`: character, scene, prop, or style concept card.
- `subject_type=note`: planning note only.

## Link Cards

```json
{
  "canvas_id": "canvas_xxx",
  "source_shape_id": "shape_section_characters",
  "target_shape_id": "shape_character_ref",
  "relation_type": "contains",
  "label": "contains"
}
```

Useful relation types: `contains`, `references`, `appears_in`, `uses`, `depends_on`, `derived_from`, `related_to`.

## Build Generation Package

```json
{ "canvas_id": "canvas_xxx", "generation_type": "image_to_video" }
```

Expected output fields:

- `slots`: grouped generation inputs.
- `inputs`: flattened input list with subject context.
- `production_stage_gaps`: missing stage content.
- `gates.ok`: whether the requested generation type can proceed structurally.
- `gates.errors`: blocking issues.
- `gates.warnings`: non-blocking risks or missing specs.

## Local Fallback Shape

If tool registration has not refreshed in the current session, validate through the plugin service after confirming the same `canvas_id`:

```js
import { VideoAssetService } from "./plugin/src/service.js";
const svc = new VideoAssetService({});
await svc.init();
const pack = svc.canvasGenerationPackage({ canvas_id: "canvas_xxx", generation_type: "image_to_video" });
await svc.close();
```

Do not use fallback code to bypass asset safety rules or to mutate unrelated projects.
