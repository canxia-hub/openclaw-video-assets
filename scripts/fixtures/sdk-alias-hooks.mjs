/**
 * Test-only ESM resolve hook that reproduces the host's plugin SDK alias contract.
 *
 * The real host installs a native resolver that maps `openclaw/plugin-sdk/<subpath>` to the
 * packaged SDK module for every subpath present in the installed package's `exports` map
 * (dist/sdk-alias-CWDvPGug.mjs:236). Plugin test processes outside the gateway need the same
 * mapping; this hook provides it so tests import the REAL installed public SDK module instead
 * of a hand-written SDK stub.
 *
 * SDK root resolution order:
 *   1. OPENCLAW_SDK_DIST          (absolute path to <openclaw>/dist)
 *   2. <dir of the running node executable>/node_modules/openclaw/dist
 *   3. <parent of that>/node_modules/openclaw/dist
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PREFIX = "openclaw/plugin-sdk/";

function fileExists(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveSdkDist() {
  const explicit = process.env.OPENCLAW_SDK_DIST;
  if (explicit && fileExists(path.join(explicit, "plugin-sdk", "plugin-entry.js"))) return explicit;
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, "node_modules", "openclaw", "dist"),
    path.join(path.dirname(nodeDir), "node_modules", "openclaw", "dist")
  ];
  return candidates.find((candidate) => fileExists(path.join(candidate, "plugin-sdk", "plugin-entry.js"))) ?? null;
}

/**
 * @returns {{url:string, shortCircuit:true}|null} null when the specifier is not an SDK alias
 */
export function mapSdkSpecifier(specifier) {
  if (!specifier.startsWith(PREFIX)) return null;
  const subpath = specifier.slice(PREFIX.length);
  if (!/^[A-Za-z0-9._-]+$/.test(subpath)) return null;
  const sdkDist = resolveSdkDist();
  if (!sdkDist) {
    throw new Error(`sdk-alias-hooks: cannot locate the installed OpenClaw dist; set OPENCLAW_SDK_DIST (requested ${specifier})`);
  }
  const target = path.join(sdkDist, "plugin-sdk", `${subpath}.js`);
  if (!fileExists(target)) throw new Error(`sdk-alias-hooks: no packaged SDK module for ${specifier} (looked for ${target})`);
  return { url: pathToFileURL(target).href, shortCircuit: true };
}

/** Synchronous hook used with node:module registerHooks(). */
export function resolveSync(specifier, context, nextResolve) {
  return mapSdkSpecifier(specifier) ?? nextResolve(specifier, context);
}

/** Async hook used with node:module register() (worker-thread hooks). */
export async function resolve(specifier, context, nextResolve) {
  return mapSdkSpecifier(specifier) ?? nextResolve(specifier, context);
}

/**
 * Install the alias hook in this process, preferring in-thread sync hooks.
 * @returns {"registerHooks"|"register"}
 */
export function installSdkAliasHooks(moduleApi) {
  const hooksUrl = pathToFileURL(path.join(import.meta.dirname, "sdk-alias-hooks.mjs")).href;
  if (typeof moduleApi.registerHooks === "function") {
    moduleApi.registerHooks({ resolve: resolveSync });
    return "registerHooks";
  }
  moduleApi.register(hooksUrl, pathToFileURL(`${import.meta.dirname}${path.sep}`));
  return "register";
}
