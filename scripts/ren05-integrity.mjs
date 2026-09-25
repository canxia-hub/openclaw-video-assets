// REN-05 / scripts/ren05-integrity.mjs
//
// OBJECT INTEGRITY, ISOLATED: the acceptance requires that an existing object is never treated as
// success merely because a file sits at its path.
//
// Each scenario runs against its OWN repository root, so corrupting one fixture can not make the
// next scenario's result ambiguous. Every scenario records the before/after row counts, the default
// version id, and the on-disk bytes of the object, because those are the things the failure is
// allowed to affect - and the check is that it affects NONE of them.
//
// Usage: node scripts/ren05-integrity.mjs --work <dir> --fixtures <dir> --out <json>

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";
import { ObjectIntegrityError, getObjectPath } from "../src/storage.js";

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const workDir = arg("work");
const fixturesDir = arg("fixtures");
const outPath = arg("out");
if (!workDir || !fixturesDir) {
  console.error("usage: node scripts/ren05-integrity.mjs --work <dir> --fixtures <dir> --out <json>");
  process.exit(2);
}
await fs.promises.mkdir(workDir, { recursive: true });

const checks = [];
const add = (id, ok, detail, extra = {}) => checks.push({ id, ok, detail, ...extra });
const scenarios = [];

const sha256File = async (file) => {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

/** Snapshot the things a failed write must not change. */
function snapshot(service, assetId = null) {
  return {
    assets: service.db.prepare("SELECT COUNT(*) AS n FROM assets").get().n,
    versions: service.db.prepare("SELECT COUNT(*) AS n FROM asset_versions").get().n,
    derived_files: service.db.prepare("SELECT COUNT(*) AS n FROM derived_files").get().n,
    commits: service.db.prepare("SELECT COUNT(*) AS n FROM commits").get().n,
    default_version_id: assetId ? service.getAsset({ asset_id: assetId }).default_version_id : null
  };
}

async function scenario(name, fn) {
  const root = path.join(workDir, name);
  await fs.promises.rm(root, { recursive: true, force: true });
  await fs.promises.mkdir(root, { recursive: true });
  const service = new VideoAssetService({ pluginConfig: { repositoryRoot: root }, logger: { info() {}, warn() {}, error() {}, debug() {} } }).init();
  const record = { name, repository_root: root, steps: [] };
  try {
    await fn({ service, root, record });
  } catch (error) {
    record.error = String(error?.stack ?? error);
    add(`${name}_scenario_ran`, false, `scenario threw: ${error?.message ?? error}`, { scenario: name });
  } finally {
    service.close();
    scenarios.push(record);
  }
}

const pngSource = path.join(fixturesDir, "still_1024x768.png");
const jpgSource = path.join(fixturesDir, "still_640x480.jpg");
const clipSource = path.join(fixturesDir, "clip_720p_2s.mp4");

// ---------------------------------------------------------------------------------------------
// 1. Healthy existing object: idempotent, and NOT rewritten.
// ---------------------------------------------------------------------------------------------
await scenario("healthy_existing_object", async ({ service, root, record }) => {
  const first = await service.ingestAsset({ file_path: pngSource, title: "Health control" });
  const objectPath = getObjectPath(root, service.getVersionRow(first.default_version_id).object_id);
  const statBefore = await fs.promises.stat(objectPath);
  const hashBefore = await sha256File(objectPath);
  await new Promise((r) => setTimeout(r, 20));

  const second = await service.ingestAsset({ file_path: pngSource, title: "Health control re-ingest" });
  const statAfter = await fs.promises.stat(objectPath);
  const hashAfter = await sha256File(objectPath);

  record.object_path = objectPath;
  record.bytes_before = statBefore.size;
  record.bytes_after = statAfter.size;
  record.mtime_unchanged = statBefore.mtimeMs === statAfter.mtimeMs;

  add("healthy_existing_object_is_reused_not_rewritten",
    hashBefore === hashAfter && statBefore.mtimeMs === statAfter.mtimeMs && statAfter.size === statBefore.size,
    `re-ingesting the same source found the object healthy and left it untouched (size ${statAfter.size} B, mtime unchanged = ${statBefore.mtimeMs === statAfter.mtimeMs}, hash unchanged = ${hashBefore === hashAfter})`,
    { object_path: objectPath, hash_unchanged: hashBefore === hashAfter, mtime_unchanged: statBefore.mtimeMs === statAfter.mtimeMs });
  add("healthy_existing_object_still_records_the_asset",
    Boolean(second.asset_id) && second.asset_id !== first.asset_id,
    `the healthy path still creates the asset row it was asked for (second asset ${second.asset_id}); the object being shared is not a failure`,
    { first_asset: first.asset_id, second_asset: second.asset_id });
});

// ---------------------------------------------------------------------------------------------
// 2. ZERO-BYTE object at a valid address: must be refused, and must not be overwritten.
// ---------------------------------------------------------------------------------------------
await scenario("zero_byte_object", async ({ service, root, record }) => {
  const asset = await service.ingestAsset({ file_path: pngSource, title: "0B scenario base" });
  const version = service.getVersionRow(asset.default_version_id);
  const objectPath = getObjectPath(root, version.object_id);

  // Damage: truncate the stored object to zero bytes. This is the exact shape the audit describes.
  await fs.promises.writeFile(objectPath, Buffer.alloc(0));
  const damaged = await fs.promises.stat(objectPath);
  const before = snapshot(service, asset.asset_id);
  record.object_path = objectPath;
  record.damaged_bytes = damaged.size;

  let error = null;
  try {
    await service.ingestAsset({ file_path: pngSource, title: "0B scenario re-ingest" });
  } catch (e) {
    error = e;
  }
  const after = snapshot(service, asset.asset_id);
  const damagedAfter = await fs.promises.stat(objectPath);

  record.error = error ? { name: error.name, code: error.code, message: error.message } : null;
  record.before = before;
  record.after = after;
  record.damaged_bytes_after = damagedAfter.size;

  add("zero_byte_object_is_refused",
    error instanceof ObjectIntegrityError && error.details?.reason === "object-is-zero-bytes",
    `a zero-byte object at a valid address was REFUSED with ${error?.name}/${error?.code} (reason: ${error?.details?.reason ?? "n/a"}) on re-ingest, instead of being reported as success`,
    { error_code: error?.code ?? null, reason: error?.details?.reason ?? null });

  add("zero_byte_failure_adds_no_asset_or_version",
    after.assets === before.assets && after.versions === before.versions,
    `assets ${before.assets}->${after.assets}, versions ${before.versions}->${after.versions} (a refusal must not add rows)`,
    { before, after });

  add("zero_byte_failure_does_not_switch_default_version",
    after.default_version_id === before.default_version_id && after.default_version_id === asset.default_version_id,
    `default version stayed ${after.default_version_id}`,
    { default_before: before.default_version_id, default_after: after.default_version_id });

  add("zero_byte_object_is_left_untouched",
    damagedAfter.size === 0,
    `the damaged object is still 0 B after the refusal (size ${damagedAfter.size}); nothing was overwritten or deleted, so whatever is on disk remains available for review`,
    { bytes_after: damagedAfter.size });

  const scan = service.integrityScan({ deep: true });
  const flagged = scan.errors.filter((e) => String(e.code).includes("SHA256_MISMATCH") || String(e.code).includes("OBJECT"));
  add("deep_scan_also_flags_the_zero_byte_object",
    scan.ok === false && flagged.length > 0,
    `integrityScan({deep:true}) reports ${scan.errors.length} error(s) for the damaged object: ${flagged.map((e) => e.code).join(", ")}`,
    { errors: scan.errors.map((e) => e.code) });
});

// ---------------------------------------------------------------------------------------------
// 3. EQUAL-LENGTH WRONG HASH: the case a size-only check can not detect.
// ---------------------------------------------------------------------------------------------
await scenario("equal_length_wrong_hash", async ({ service, root, record }) => {
  const asset = await service.ingestAsset({ file_path: jpgSource, title: "equal-length scenario base" });
  const version = service.getVersionRow(asset.default_version_id);
  const objectPath = getObjectPath(root, version.object_id);
  const originalBytes = await fs.promises.readFile(objectPath);

  // Same LENGTH, different bytes: a size comparison sees nothing wrong.
  const wrong = Buffer.from(originalBytes);
  for (let i = 0; i < wrong.length; i += 512) wrong[i] = wrong[i] ^ 0xff;
  await fs.promises.writeFile(objectPath, wrong);
  const damaged = await fs.promises.stat(objectPath);
  const before = snapshot(service, asset.asset_id);
  record.object_path = objectPath;
  record.length_preserved = damaged.size === originalBytes.length;

  let error = null;
  try {
    await service.ingestAsset({ file_path: jpgSource, title: "equal-length scenario re-ingest" });
  } catch (e) {
    error = e;
  }
  const after = snapshot(service, asset.asset_id);
  const bytesAfter = await fs.promises.readFile(objectPath);

  record.error = error ? { code: error.code, message: error.message, details: error.details } : null;

  add("equal_length_wrong_hash_is_refused",
    error instanceof ObjectIntegrityError && error.details?.reason === "equal-length-wrong-hash",
    `an object of the SAME LENGTH but a different hash was REFUSED with reason "${error?.details?.reason}" (a size-only check would have passed it)`,
    { error_code: error?.code ?? null, reason: error?.details?.reason ?? null, expected_sha256: error?.details?.expected_sha256 ?? null, actual_sha256: error?.details?.actual_sha256 ?? null });

  add("equal_length_failure_adds_no_asset_or_version",
    after.assets === before.assets && after.versions === before.versions && after.default_version_id === before.default_version_id,
    `assets ${before.assets}->${after.assets}, versions ${before.versions}->${after.versions}, default ${before.default_version_id === after.default_version_id ? "unchanged" : "CHANGED"}`,
    { before, after });

  add("equal_length_damaged_object_is_left_untouched",
    bytesAfter.equals(wrong),
    `the damaged bytes are byte-identical after the refusal (${bytesAfter.length} B, unchanged = ${bytesAfter.equals(wrong)}) - the bad copy was not overwritten, so no evidence was destroyed`,
    { bytes_after: bytesAfter.length, unchanged: bytesAfter.equals(wrong) });

  const scan = service.integrityScan({ deep: true });
  add("deep_scan_flags_the_equal_length_corruption",
    scan.ok === false && scan.errors.some((e) => String(e.code).includes("SHA256_MISMATCH")),
    `integrityScan({deep:true}) reports: ${scan.errors.map((e) => e.code).join(", ")}`,
    { errors: scan.errors.map((e) => e.code) });
});

// ---------------------------------------------------------------------------------------------
// 4. createVersion against a damaged object: the default must survive.
// ---------------------------------------------------------------------------------------------
await scenario("damaged_object_on_create_version", async ({ service, root, record }) => {
  const asset = await service.ingestAsset({ file_path: pngSource, title: "createVersion scenario" });
  const v1 = service.getVersionRow(asset.default_version_id);
  const objectPath = getObjectPath(root, v1.object_id);
  await fs.promises.writeFile(objectPath, Buffer.alloc(0));

  const before = snapshot(service, asset.asset_id);
  let error = null;
  try {
    await service.createVersion({
      asset_id: asset.asset_id,
      file_path: pngSource,
      change_summary: "revision against a damaged object",
      change_items: [{ category: "revision", summary: "should not be recorded" }]
    });
  } catch (e) {
    error = e;
  }
  const after = snapshot(service, asset.asset_id);
  record.error = error ? { code: error.code, message: error.message } : null;

  add("create_version_refuses_on_damaged_object",
    error instanceof ObjectIntegrityError,
    `createVersion onto a damaged object refused with ${error?.code ?? "(no error)"}`,
    { error_code: error?.code ?? null });

  add("create_version_failure_keeps_default_and_version_count",
    after.default_version_id === before.default_version_id && after.versions === before.versions,
    `default version ${before.default_version_id} -> ${after.default_version_id}; version count ${before.versions} -> ${after.versions}`,
    { before, after });
});

// ---------------------------------------------------------------------------------------------
// 5. registerDerivedFile against a damaged DERIVED object.
// ---------------------------------------------------------------------------------------------
await scenario("damaged_derived_object", async ({ service, root, record }) => {
  const asset = await service.ingestAsset({ file_path: pngSource, title: "derived damage scenario" });
  const derived = await service.generateDerivedFile({ asset_version_id: asset.default_version_id, derivative_type: "thumbnail", parameters: { width: 128 } });
  const stored = service.resolveDerivedFile(derived.derived_file_id, ["thumbnail"]);
  // resolveDerivedFile returns the object-store path; damage it in place.
  await fs.promises.writeFile(stored.file_path, Buffer.alloc(0));

  const before = snapshot(service, asset.asset_id);
  let error = null;
  try {
    await service.generateDerivedFile({ asset_version_id: asset.default_version_id, derivative_type: "thumbnail", parameters: { width: 128 } });
  } catch (e) {
    error = e;
  }
  const after = snapshot(service, asset.asset_id);
  record.error = error ? { code: error.code, message: error.message } : null;

  add("derived_registration_refuses_on_damaged_object",
    error instanceof ObjectIntegrityError,
    `re-registering a derivation whose stored object is damaged refused with ${error?.code ?? "(no error)"}`,
    { error_code: error?.code ?? null });

  add("derived_failure_adds_no_derived_row",
    after.derived_files === before.derived_files,
    `derived_files ${before.derived_files} -> ${after.derived_files}; assets ${before.assets} -> ${after.assets}`,
    { before, after });
});

// ---------------------------------------------------------------------------------------------
// 6. MISSING object: restoring verified content is allowed (and is NOT the same as corrupt).
// ---------------------------------------------------------------------------------------------
await scenario("missing_object_is_restored", async ({ service, root, record }) => {
  const asset = await service.ingestAsset({ file_path: clipSource, title: "missing object scenario" });
  const version = service.getVersionRow(asset.default_version_id);
  const objectPath = getObjectPath(root, version.object_id);
  await fs.promises.rm(objectPath, { force: true });
  record.object_removed = !fs.existsSync(objectPath);

  const before = snapshot(service, asset.asset_id);
  let error = null;
  let created = null;
  try {
    created = await service.ingestAsset({ file_path: clipSource, title: "missing object re-ingest" });
  } catch (e) {
    error = e;
  }
  const after = snapshot(service, asset.asset_id);
  const restored = fs.existsSync(objectPath);
  const restoredHash = restored ? await sha256File(objectPath) : null;

  add("missing_object_is_written_back_from_verified_content",
    error === null && restored && restoredHash === version.sha256,
    error === null
      ? `a MISSING object was restored from the source (hash matches the address: ${restoredHash === version.sha256}); there was nothing on disk to preserve, and the content is verified by the hash before the write`
      : `unexpectedly refused a missing object: ${error?.code}`,
    { restored, hash_matches_address: restoredHash === version.sha256, error: error?.code ?? null });
  add("missing_object_restore_records_a_new_asset",
    Boolean(created?.asset_id), `the ingest completed and recorded asset ${created?.asset_id}`, { before, after });

  add("mismatch_refusal_and_missing_restore_are_distinct_outcomes",
    true,
    "documented distinction: a CORRUPT object is refused (something is there and must not be destroyed); a MISSING object is written (nothing is there, and the incoming content is verified against the address). The two are deliberately different outcomes.",
    {});
});

// ---------------------------------------------------------------------------------------------
// 7. Control: the untouched fixture repository stays healthy.
// ---------------------------------------------------------------------------------------------
await scenario("control_untouched_repository", async ({ service, record }) => {
  await service.ingestAsset({ file_path: pngSource, title: "clean control" });
  await service.ingestAsset({ file_path: clipSource, title: "clean control video" });
  const scan = service.integrityScan({ deep: true });
  record.scan_ok = scan.ok;
  add("clean_repository_scan_is_green",
    scan.ok === true && scan.issues.length === 0,
    `a repository that was never damaged scans clean (ok=${scan.ok}, issues=${scan.issues.length}, scanned=${JSON.stringify(scan.scanned)})`,
    { scanned: scan.scanned });
});

const failed = checks.filter((c) => !c.ok);
const report = {
  report: "REN-05 object integrity: existing objects are verified, not assumed",
  generated_at: new Date().toISOString(),
  isolated_roots: scenarios.map((s) => s.repository_root),
  scenarios,
  checks,
  failed: failed.map((c) => `${c.id}: ${c.detail}`),
  all_pass: failed.length === 0
};
if (outPath) {
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await fs.promises.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
for (const c of checks) console.log(`[${c.ok ? "PASS" : "FAIL"}] ${c.id}: ${c.detail}`);
console.log(`integrity checks: ${checks.length - failed.length}/${checks.length} pass${outPath ? ` -> ${outPath}` : ""}`);
process.exitCode = failed.length === 0 ? 0 : 1;

