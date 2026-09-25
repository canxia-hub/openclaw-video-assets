/*
 * Ambient build-time constants injected by vite.config.ts.
 *
 * WHY `declare global` AND A .d.ts FILE
 *   tsconfig sets `moduleDetection: "force"`, which treats EVERY file as a module - including a .ts file that has
 *   no imports or exports. So a bare top-level `declare const` is module-scoped and invisible everywhere else;
 *   the first attempt at this did exactly that and tsc reported "Cannot find name '__APP_VERSION__'" in the file
 *   that used it. `declare global` inside a module is the form that works under `force`, and a .d.ts keeps the
 *   declarations out of the emitted bundle.
 *
 * These are BUILD INPUTS, not runtime globals: Vite replaces the identifiers literally at build time from
 * package.json and the git commit. Nothing reads them from `window`.
 */
declare global {
  /** The UI package version, injected from ui-src/package.json at build time. */
  const __APP_VERSION__: string;

  /** The commit the bundle was built from, injected at build time ("unknown" outside a git checkout). */
  const __BUILD_COMMIT__: string;
}

export {};
