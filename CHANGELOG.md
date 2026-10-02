# Changelog

## 0.2.0 - 2026-10-03

### Fixed

- OpenClaw 2026.9.7 host compatibility: every tool schema now declares an explicit `required` array; enum value lists hoisted to frozen shared constants.
- `verifiedHosts` now includes 2026.9.7.
- Manifest adds `toolSurface` (legacy|contract) and `basePath` fallback config; ui-dist rebuilt with `RELEASE.json`.

## 1.5.0 - 2026-09-26

### Added

- Vendor-neutral cloud object storage guidance: migrate `asset-repo/objects/` to any S3-compatible bucket (COS/OSS/S3/R2/MinIO) via an rclone disk-mode mount plus a Junction/symlink, with no plugin code changes; `metadata/` and `cache/` must stay local. See README “云端对象存储接入”.
- `repositoryRoot` config description now documents the cloud-storage wiring and constraints.
- Native Dreamina/Seedance drive from the canvas: seedance2.5 (text/image/multimodal-to-video, 480p-1080p, 4-30s) and Seedream 5.0Pro images, plus `video_canvas_dreamina_cli_generate_image` and `video_canvas_dreamina_cli_upscale_image` (2k/4k/8k). Model capabilities consolidated into single spec tables (`DREAMINA_VIDEO_MODEL_SPECS` / `DREAMINA_IMAGE_MODEL_SPECS`).
- Generation jobs subsystem: submit/poll/reconcile phases persisted across restarts (`pending_phase`), bounded download retries, slot-column tracking, crash-restart and recovery-reentry suites.
- Security/domain hardening: scoped auth for uploads/file/thumb/proxy, CSRF origin policy, Range/206/416 media serving, ETag/Last-Modified, session cookie flags, logout invalidation, proxy trust controls, generation policy gates with fail-closed authorization.
- Audio lanes: Doubao Seed audio 1.0 plan/generate with cleared-marking discipline; KIE Suno plan/generate (authorization defaults to unknown).
- npm packaging for 2026.9.5 host preload: explicit `files` whitelist including `openclaw.plugin.json`, reproducible `build:ui`/`prepack`, root `package-lock.json`, manifest version aligned to package version; tarball verified to load on OpenClaw 2026.9.3 and 2026.9.5 (69 tools / 89 gateway methods / 9 http routes, zero duplicate registration across 3 cold rounds each).

### Fixed

- Canvas generation gate no longer treats `draft_output` write-back cards as inputs; handoff now forwards `model_version` so multimodal limits are validated against the requested model.
- QC judges the run's own derived spec (no fixture-constant expectations); burn-in probe selects the first cue with a measurable gap.
- Dreamina CLI uploads materialize content-addressed `.blob` files with correct extensions before handing them to the CLI.

### Changed

- Registration surface: 69 tools declared in `contracts.tools` (was 45 at v1.4.x).

## 1.4.2 - 2026-08-13

### Fixed

- Gateway RPC callback contract now uses `respond(ok, payload, error, meta)`; the previous single-argument object form could make CLI calls time out even when the plugin completed the work.
- Asset, project, canvas, entity, and commit search now applies query filters on the full dataset before pagination, with stable secondary sort keys and uniform offset/limit boundary validation.
- `video_asset_ingest` and `video_asset_update_metadata` now share strict metadata validation before any file copy or database write (title 1–512 chars, description up to 65536 chars, up to 64 tags of 128 chars each), and failures leave no partial writes.
- Workbench selection restore from the backend now runs once per selection version key, so clicking an edge is no longer immediately overwritten back to the primary shape.

### Added

- New regression and robustness suites: `asset-metadata-test`, `gateway-rpc-contract-test`, `robustness-regression-test`, `extended-robustness-regression-test`, `canvas-governance-regression-test`, `localization-regression-test`, plus CDP UI verification scripts (`cdp-check-p4`, `cdp-eval`, `ui-screenshot`).

## 1.4.1 - 2026-08-08

### Changed

- Added the MIT License for public reuse and distribution.
- Updated package and plugin manifest versions to `1.4.1`.
- Updated README licensing language to point at the checked-in `LICENSE` file.

## 1.4.0 - 2026-08-08

### Added

- New Workbench v1.4 frontend: Vite 6, React 18, TypeScript, Tailwind CSS 4, TanStack Query, Zustand, React Router, and React Flow.
- Eight Workbench pages: dashboard, projects, assets, canvas, generation, staging, audit, and settings.
- Project and asset inspectors with warning/error badges.
- Read-only React Flow production canvas visualization.
- Generation preparation page with slot matching, preflight gates, and JSON package preview.
- Staging drag-and-drop upload flow.
- Cross-page command palette with keyboard navigation.
- Public release packaging for the plugin and three companion OpenClaw skills.

### Changed

- Replaced the legacy single-file frontend with the v1.4 Workbench.
- Updated package and plugin manifest versions to `1.4.0`.
- Sanitized public-release references to local machine paths and internal planning documents.

### Included companion skills

- `video-assets-project-material`
- `video-asset-taxonomy`
- `video-canvas-operator`
