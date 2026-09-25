/*
 * The single place the interface reads its own build information from.
 *
 * Every component that shows a version imports from here, so there is exactly one source and the audit's
 * "v1.5 vs v1.3 in the same app" cannot recur by someone adding another literal. The values are injected by
 * vite.config.ts at build time from package.json and the git commit.
 */

/** Build information as injected at build time. Falls back to explicit placeholders when the bundle was built without them. */
export const buildInfo = {
  /** e.g. "1.0.0-p0" */
  appVersion: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev",
  /** short git commit, or "unknown" when built outside a checkout */
  commit: typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : "unknown",
} as const;

/** Short label for chrome/footers, e.g. "workbench v1.0.0-p0". */
export const buildLabel = `workbench v${buildInfo.appVersion}`;

/** Full label including the commit, for the diagnostics surface. */
export const buildLabelDetailed = `${buildLabel} · ${buildInfo.commit}`;
