/**
 * Shared path resolution for the REN-11 verification scripts.
 *
 * The output root is deliberately *not* inside the repository: rendered media, run state and
 * evidence belong to the project's `output/projects/<project>/ren11` tree, while this repository
 * only ever holds code. Resolution order:
 *   1. explicit argv (the scripts keep accepting one),
 *   2. `REN11_OUTPUT_ROOT`,
 *   3. the workspace-relative default derived from this file's location.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_SLUG = "video-platform-renewal-20260920";

// scriptDir = <workspace>/projects/<slug>/implementation/REN-11/repo/video-assets/scripts, so seven
// levels up is the workspace root.
const WORKSPACE_UP = ["..", "..", "..", "..", "..", "..", ".."];

export function resolveOutputRoot(argvValue = null) {
  if (argvValue) return path.resolve(argvValue);
  if (process.env.REN11_OUTPUT_ROOT) return path.resolve(process.env.REN11_OUTPUT_ROOT);
  return path.resolve(scriptDir, ...WORKSPACE_UP, "output", "projects", PROJECT_SLUG, "ren11");
}

export function resolveAssetRoot() {
  return path.resolve(scriptDir, ...WORKSPACE_UP, "assets", "bundles", "project-specific", PROJECT_SLUG, "ren11");
}

export const PROJECT_SLUG_EXPORT = PROJECT_SLUG;
