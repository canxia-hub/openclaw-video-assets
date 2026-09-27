# video-assets npm package artifact (0.1.0)

This directory carries the clean npm-package file set produced from the 2026-09-27 REN line schema hardening:

- runtime entry: `src/index.js`
- manifest: `openclaw.plugin.json`
- package files whitelist: `package.json` (`files`: `src/`, `ui-dist/`, `openclaw.plugin.json`, `README.md`)
- built UI: `ui-dist/`

Validation evidence (kept outside this repo branch): full local `npm run check` exit=0, installed-artifact probe 69 tools / 56 required-bearing, zero-cost generation gates blocked, package secrets scan 0 hits.

This branch is intentionally non-destructive: repository `main` remains at public v1.4.2 while the REN/npm line is staged here for review.
