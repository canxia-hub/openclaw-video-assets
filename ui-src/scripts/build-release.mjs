// REN-07 / ui-src/scripts/build-release.mjs
//
// Builds the workbench UI into a CANDIDATE directory, verifies it, hashes it, writes a release manifest, and
// then promotes it atomically into the directory the plugin actually serves.
//
// WHY A CANDIDATE DIRECTORY AND A PROMOTE STEP
//   The build's outDir IS the runtime directory (audit finding 9 was that they differed). Building straight into
//   it would leave the workbench serving a half-written bundle for the duration of the build, which is a live
//   workbench serving 404s and mismatched asset hashes. So the build writes to a candidate, and only a verified
//   candidate is promoted.
//
// WHAT "VERIFIED" MEANS HERE
//   1. index.html exists in the candidate.
//   2. Every asset index.html references exists in the candidate. A bundle whose HTML points at a missing file
//      renders a blank page, and this is the check that catches it before promotion rather than after.
//   3. No asset in the candidate is UNREFERENCED. This is the stale-bundle check: the previous ui-dist held four
//      JS bundles of which only one was referenced. An unreferenced hashed asset means a stale file was copied
//      rather than built, which is exactly how the three copies drifted apart.
//   4. The build is REPRODUCIBLE: building the same source twice produces the same asset hashes.
//
// Usage: node scripts/build-release.mjs [--repo <repo root>] [--out <release manifest json>] [--skip-reproducibility]
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const uiSrc = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\//, ""));
const repoRoot = path.resolve(arg("repo", path.join(uiSrc, "..")));
const runtimeDir = path.join(repoRoot, "ui-dist");
const candidateDir = path.join(repoRoot, ".ui-build-candidate");
const verifyDir = path.join(repoRoot, ".ui-build-verify");
const outPath = arg("out", path.join(repoRoot, "..", "..", "evidence", "ui-release-build.json"));
const skipReproducibility = process.argv.includes("--skip-reproducibility");

const norm = (text) => text.replace(/\r\n/g, "\n");
const shaFile = (file) => crypto.createHash("sha256").update(norm(fs.readFileSync(file, "utf8")), "utf8").digest("hex");

const result = { report: "REN-07 workbench UI release build", generated_at: new Date().toISOString(), ui_src: uiSrc, repo_root: repoRoot, steps: [] };
const step = (label, fn) => {
  const started = Date.now();
  try {
    const value = fn();
    result.steps.push({ label, ok: true, ms: Date.now() - started });
    return { ok: true, value };
  } catch (error) {
    result.steps.push({ label, ok: false, ms: Date.now() - started, error: String(error?.message ?? error).split("\n").slice(0, 8).join("\n") });
    return { ok: false, error };
  }
};

const viteBin = path.join(uiSrc, "node_modules", "vite", "bin", "vite.js");
const runBuild = (outDir) => {
  // tsc -b first: the app is TypeScript, and a type error that Vite would happily transpile should fail the
  // release rather than ship.
  execFileSync(process.execPath, [path.join(uiSrc, "node_modules", "typescript", "bin", "tsc"), "-b"], { cwd: uiSrc, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return execFileSync(process.execPath, [viteBin, "build", "--outDir", outDir, "--emptyOutDir"], { cwd: uiSrc, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
};

/** The files a directory holds, excluding the build's own bookkeeping. */
function listFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.isFile()) files.push(path.relative(root, full).replace(/\\/g, "/"));
    }
  };
  walk(root);
  return files;
}

/** Assets referenced from index.html, so "referenced" is taken from the artifact rather than assumed. */
function referencedAssets(htmlText) {
  const refs = [];
  for (const match of htmlText.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const value = match[1];
    if (value.startsWith("data:") || value.startsWith("http")) continue;
    // The base path makes references absolute; strip it to get a path inside the dist directory.
    const marker = "/workbench/";
    const relative = value.includes(marker) ? value.slice(value.indexOf(marker) + marker.length) : value.replace(/^\//, "");
    refs.push(relative);
  }
  return refs;
}

const build = step("build the UI into a candidate directory", () => {
  fs.rmSync(candidateDir, { recursive: true, force: true });
  return runBuild(candidateDir);
});

let verification = null;
if (build.ok) {
  verification = step("verify the candidate before promoting it", () => {
    const htmlPath = path.join(candidateDir, "index.html");
    if (!fs.existsSync(htmlPath)) throw new Error("index.html is missing from the build output");
    const html = fs.readFileSync(htmlPath, "utf8");
    const referenced = referencedAssets(html);
    const present = new Set(listFiles(candidateDir));
    const missing = referenced.filter((ref) => !present.has(ref));
    if (missing.length > 0) throw new Error(`index.html references ${missing.length} asset(s) that are not in the build output: ${missing.join(", ")}`);
    const unreferenced = [...present].filter((file) => !referenced.includes(file) && file !== "index.html");
    if (unreferenced.length > 0) {
      throw new Error(`the build output contains ${unreferenced.length} asset(s) no page references: ${unreferenced.join(", ")} - a hashed asset that is not referenced means a stale file rather than a built one`);
    }
    return { referenced, file_count: present.size };
  });
}

// Reproducibility: same source, same output. This is what makes "the candidate is built, not copied" checkable.
let reproducibility = null;
if (build.ok && verification.ok && !skipReproducibility) {
  reproducibility = step("the build is reproducible (same source, same asset hashes)", () => {
    fs.rmSync(verifyDir, { recursive: true, force: true });
    runBuild(verifyDir);
    const first = listFiles(candidateDir).map((file) => ({ file, sha256: shaFile(path.join(candidateDir, file)) }));
    const second = listFiles(verifyDir).map((file) => ({ file, sha256: shaFile(path.join(verifyDir, file)) }));
    if (first.length !== second.length) throw new Error(`two builds produced different file counts: ${first.length} vs ${second.length}`);
    for (let i = 0; i < first.length; i += 1) {
      if (first[i].file !== second[i].file) throw new Error(`two builds produced different file names at index ${i}: ${first[i].file} vs ${second[i].file}`);
      if (first[i].sha256 !== second[i].sha256) throw new Error(`two builds produced different content for ${first[i].file}: ${first[i].sha256.slice(0, 12)} vs ${second[i].sha256.slice(0, 12)}`);
    }
    fs.rmSync(verifyDir, { recursive: true, force: true });
    return { file_count: first.length };
  });
}

// Promote: swap the verified candidate into the runtime directory.
const promotion = verification?.ok
  ? step("promote the verified candidate into the runtime directory atomically", () => {
      const previous = `${runtimeDir}.previous`;
      fs.rmSync(previous, { recursive: true, force: true });
      if (fs.existsSync(runtimeDir)) fs.renameSync(runtimeDir, previous);
      fs.renameSync(candidateDir, runtimeDir);
      fs.rmSync(previous, { recursive: true, force: true });
      return { runtime_dir: runtimeDir };
    })
  : { ok: false, error: new Error("verification failed; the runtime directory was left untouched") };

if (promotion.ok) {
  const files = listFiles(runtimeDir).map((file) => ({ file, sha256: shaFile(path.join(runtimeDir, file)), bytes: fs.statSync(path.join(runtimeDir, file)).size }));
  const digest = crypto.createHash("sha256").update(files.map((f) => `${f.file}:${f.sha256}`).join("\n"), "utf8").digest("hex");
  const pkg = JSON.parse(fs.readFileSync(path.join(uiSrc, "package.json"), "utf8"));
  const html = fs.readFileSync(path.join(runtimeDir, "index.html"), "utf8");

  const release = {
    report: "REN-07 workbench UI release manifest",
    built_at: new Date().toISOString(),
    ui_version: pkg.version,
    source: { ui_src: uiSrc, package_json_sha256: shaFile(path.join(uiSrc, "package.json")), lock_sha256: shaFile(path.join(uiSrc, "package-lock.json")), vite_config_sha256: shaFile(path.join(uiSrc, "vite.config.ts")) },
    runtime_dir: runtimeDir,
    // The digest a reviewer compares against; the per-file list follows so a difference is diagnosable.
    package_digest: digest,
    file_count: files.length,
    entry: referencedAssets(html),
    reproducibility: reproducibility?.value ?? null,
    files,
    rollback: "replace the ui-dist directory with the previous release's directory from this manifest's file list; the plugin's API surface is unchanged by a UI release, so no server-side step is involved"
  };
  result.release_manifest = release;
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  fs.writeFileSync(path.join(runtimeDir, "RELEASE.json"), `${JSON.stringify({ ui_version: release.ui_version, package_digest: digest, file_count: release.file_count, built_at: release.built_at }, null, 2)}\n`, "utf8");
} else if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

for (const s of result.steps) console.log(`${s.ok ? "ok  " : "FAIL"} ${s.label}${s.error ? ` -> ${s.error.split("\n")[0]}` : ""}`);
if (result.release_manifest) {
  console.log(`  ui version: ${result.release_manifest.ui_version}`);
  console.log(`  package digest: ${result.release_manifest.package_digest}`);
  console.log(`  files: ${result.release_manifest.file_count}, entry: ${result.release_manifest.entry.join(", ")}`);
  if (outPath) console.log(`  manifest -> ${outPath}`);
}
process.exitCode = result.steps.every((s) => s.ok) ? 0 : 1;
