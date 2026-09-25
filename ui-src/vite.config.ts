import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/*
 * REN-07 build configuration.
 *
 * FIXED HERE (audit finding 9): `outDir` was `../ui-dist-next` while the plugin serves `../ui-dist`, with no
 * copy step. So a build never reached the running workbench - someone copied the files by hand, and `ui-dist`
 * accumulated four stale bundles, two of which no page referenced. Three copies (project source, project
 * release package, running release package) drifted apart because nothing connected them.
 *
 * `outDir` is now the directory the plugin actually serves, so the artifact that is built is the artifact that
 * runs. The release script (`scripts/build-release.mjs`) still builds into a CANDIDATE directory and promotes it
 * atomically, because writing straight into the live directory would leave the workbench serving a half-written
 * bundle while the build runs.
 */
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

/** The commit the bundle was built from, so a running workbench can be traced to source. */
function buildId() {
  try {
    return execFileSync("git", ["-C", new URL("..", import.meta.url).pathname.replace(/^\//, ""), "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/__openclaw__/video-assets/workbench/",
  build: {
    // Unified with the runtime. See the note above.
    outDir: "../ui-dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  define: {
    // Version injection: the UI used to hard-code contradictory version strings (v1.5 and v1.3 in the same
    // app). Both values now come from build inputs, so the interface cannot disagree with the package it is
    // part of, and a stale bundle is detectable by comparing what the UI reports with the release manifest.
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_COMMIT__: JSON.stringify(buildId())
  },
  server: {
    port: 5199,
    proxy: {
      "/__openclaw__/video-assets": {
        target: "http://127.0.0.1:33979",
        changeOrigin: false,
      },
    },
  },
});
