# Changelog

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
