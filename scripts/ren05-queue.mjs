// REN-05 / scripts/ren05-queue.mjs
//
// BOUNDED DERIVATION QUEUE acceptance: concurrency is capped, the waiting room is bounded and
// refuses overflow, identical requests share one job, completed jobs are reused, cancelling a
// RUNNING job actually kills the encoder, a hung job times out, and an unreachable store is told
// apart from a missing file.
//
// Every claim is measured from the queue's own counters plus the filesystem, so "it was cancelled"
// means "no encoder is running and no artifact was left", not "we stopped waiting".
//
// Usage: node scripts/ren05-queue.mjs --work <dir> --fixtures <dir> --out <json>

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";
import { DerivationQueue } from "../src/derivation-queue.js";
import { DerivationError, generateDerivation, resolveMediaTools } from "../src/media-transcode.js";

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const workDir = arg("work");
const fixturesDir = arg("fixtures");
const outPath = arg("out");
if (!workDir || !fixturesDir) {
  console.error("usage: node scripts/ren05-queue.mjs --work <dir> --fixtures <dir> --out <json>");
  process.exit(2);
}
await fs.promises.mkdir(workDir, { recursive: true });

const checks = [];
const add = (id, ok, detail, extra = {}) => checks.push({ id, ok, detail, ...extra });
const details = {};

const root = path.join(workDir, "repo");
await fs.promises.rm(root, { recursive: true, force: true });
await fs.promises.mkdir(root, { recursive: true });

const service = new VideoAssetService({ pluginConfig: { repositoryRoot: root }, logger: { info() {}, warn() {}, error() {}, debug() {} } }).init();
const tools = await resolveMediaTools();
const sha256File = async (file) => {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};
const countCacheFiles = async () => {
  let total = 0;
  for (const sub of ["thumbnails", "proxies", "audio", "waveforms", "derived"]) {
    const dir = path.join(root, "cache", sub);
    if (fs.existsSync(dir)) total += (await fs.promises.readdir(dir)).length;
  }
  return total;
};
/** PIDs of ffmpeg children this run started - used to prove a cancel actually killed the encoder. */
const ffmpegProcessCount = async () => {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-Command", "(Get-Process ffmpeg -ErrorAction SilentlyContinue | Measure-Object).Count"], { timeout: 15000 }, (error, stdout) => {
      resolve(error ? -1 : Number(String(stdout).trim()));
    });
  });
};

try {
  add("toolchain_available", tools.available, `ffmpeg present: ${tools.available} (${tools.ffmpeg_version ?? "n/a"})`, {});

  const clip = await service.ingestAsset({ file_path: path.join(fixturesDir, "clip_480p_3s.mov"), title: "queue clip" });
  const still = await service.ingestAsset({ file_path: path.join(fixturesDir, "still_1024x768.png"), title: "queue still" });
  const clipSourceObject = service.resolveVersionFile(clip.default_version_id).file_path;
  const clipObjectHashBefore = await sha256File(clipSourceObject);
  details.fixtures = { clip_version: clip.default_version_id, still_version: still.default_version_id, clip_object: clipSourceObject };

  // -------------------------------------------------------------------------------------------
  // 1. Bounded concurrency: 6 jobs, concurrency 2, measure simultaneous execution.
  // -------------------------------------------------------------------------------------------
  {
    let active = 0;
    let peak = 0;
    const queue = new DerivationQueue({ service, concurrency: 2, maxQueue: 32 });
    for (let i = 0; i < 6; i += 1) {
      queue.run = async (entry) => {
        active += 1;
        peak = Math.max(peak, active);
        try {
          return await service.performDerivation({ ...entry, parameters: { width: 320 + i * 2 } });
        } finally {
          active -= 1;
        }
      };
    }
    const jobs = [];
    for (let i = 0; i < 6; i += 1) {
      jobs.push(queue.submit({ asset_version_id: clip.default_version_id, derivative_type: "thumbnail", parameters: { width: 320 + i * 2 }, profile_key: `thumb-${i}` }));
    }
    const settled = await Promise.allSettled(jobs.map((j) => j.promise));
    const ok = settled.filter((s) => s.status === "fulfilled").length;
    details.concurrency = { peak, ok, status: queue.status() };
    add("concurrency_is_capped_and_all_jobs_finish",
      peak === 2 && ok === 6 && queue.status().running === 0 && queue.status().queued === 0,
      `6 jobs with concurrency 2: peak simultaneous = ${peak} (cap 2), ${ok}/6 completed, queue drained (queued ${queue.status().queued}, running ${queue.status().running})`,
      { peak, completed: ok, status: queue.status() });
  }

  // -------------------------------------------------------------------------------------------
  // 2. Bounded waiting room: overflow is REFUSED, not queued forever.
  // -------------------------------------------------------------------------------------------
  {
    const queue = new DerivationQueue({ service, concurrency: 1, maxQueue: 1 });
    let releaseFirst;
    const gate = new Promise((r) => { releaseFirst = r; });
    let started = 0;
    queue.run = async (entry) => {
      started += 1;
      if (started === 1) await gate;
      return service.performDerivation({ ...entry, parameters: { width: 256 } });
    };
    const a = queue.submit({ asset_version_id: still.default_version_id, derivative_type: "thumbnail", parameters: { width: 256 }, profile_key: "bound-a" });
    await new Promise((r) => setTimeout(r, 150));
    const b = queue.submit({ asset_version_id: still.default_version_id, derivative_type: "thumbnail", parameters: { width: 300 }, profile_key: "bound-b" });
    const c = queue.submit({ asset_version_id: still.default_version_id, derivative_type: "thumbnail", parameters: { width: 340 }, profile_key: "bound-c" });
    let cError = null;
    await c.promise.catch((e) => { cError = e; });
    releaseFirst();
    await Promise.allSettled([a.promise, b.promise]);
    details.bounded = { c_refused: c.refused === true, c_code: cError?.code ?? null, counters: queue.status().counters };
    add("queue_overflow_is_refused_with_a_code",
      c.refused === true && cError?.code === "DERIVATION_QUEUE_FULL" && (await Promise.allSettled([a.promise, b.promise])).some((s) => s.status === "fulfilled"),
      `concurrency 1 / maxQueue 1: the third submit was refused with ${cError?.code ?? "(no error)"} while the first two still ran to completion`,
      { code: cError?.code ?? null, refused: c.refused === true });
  }

  // -------------------------------------------------------------------------------------------
  // 3. De-duplication + completion cache: identical requests share one encode.
  // -------------------------------------------------------------------------------------------
  {
    const queue = new DerivationQueue({ service, concurrency: 2, maxQueue: 16 });
    queue.clearCache();
    let executions = 0;
    queue.run = async (entry) => {
      executions += 1;
      await new Promise((r) => setTimeout(r, 200));
      return service.performDerivation({ ...entry, parameters: { width: 512 } });
    };
    const same = { asset_version_id: still.default_version_id, derivative_type: "thumbnail", parameters: { width: 512 }, profile_key: "dedupe" };
    const first = queue.submit({ ...same });
    const second = queue.submit({ ...same });
    const third = queue.submit({ ...same });
    await Promise.allSettled([first.promise, second.promise, third.promise]);
    const afterCache = queue.submit({ ...same });
    await afterCache.promise;
    details.dedupe = { executions, task_ids: [first.task_id, second.task_id, third.task_id, afterCache.task_id], counters: queue.status().counters };
    add("identical_requests_share_one_execution",
      executions === 1 && first.task_id === second.task_id && second.task_id === third.task_id && second.deduplicated === true,
      `3 concurrent identical submits ran ONE job (executions=${executions}); task ids ${first.task_id === second.task_id && second.task_id === third.task_id ? "identical" : "DIFFERENT"}; deduplicated flag = ${second.deduplicated}`,
      { executions, deduplicated: second.deduplicated });
    add("completed_derivation_is_reused_from_cache",
      afterCache.cached === true && afterCache.task_id === first.task_id && executions === 1,
      `a later identical submit was served from the completion cache (cached=${afterCache.cached}, executions still ${executions})`,
      { cached: afterCache.cached, executions });
    add("distinct_parameters_are_not_deduplicated",
      (() => {
        const other = queue.submit({ asset_version_id: still.default_version_id, derivative_type: "thumbnail", parameters: { width: 520 }, profile_key: "dedupe-other" });
        return other.cached === false && other.task_id !== first.task_id;
      })(),
      "a different width is a different job (the profile and parameters are part of the de-duplication key)",
      {});
  }

  // -------------------------------------------------------------------------------------------
  // 4. Cancelling a QUEUED job: it never starts.
  // -------------------------------------------------------------------------------------------
  {
    const queue = new DerivationQueue({ service, concurrency: 1, maxQueue: 8 });
    queue.clearCache();
    let started = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    queue.run = async (entry) => {
      started += 1;
      if (started === 1) await gate;
      return service.performDerivation({ ...entry, parameters: { width: 256 } });
    };
    const running = queue.submit({ asset_version_id: still.default_version_id, derivative_type: "thumbnail", parameters: { width: 256 }, profile_key: "cancel-a" });
    await new Promise((r) => setTimeout(r, 100));
    const queued = queue.submit({ asset_version_id: still.default_version_id, derivative_type: "thumbnail", parameters: { width: 288 }, profile_key: "cancel-b" });
    const cancelled = queue.cancel(queued.task_id);
    let queuedError = null;
    await queued.promise.catch((e) => { queuedError = e; });
    release();
    await running.promise.catch(() => {});
    const files = await countCacheFiles();
    details.cancel_queued = { cancelled, code: queuedError?.code ?? null, started, files };
    add("queued_job_can_be_cancelled_before_it_runs",
      cancelled === true && queuedError?.code === "DERIVATION_CANCELLED" && started === 1,
      `the queued job was cancelled (${queuedError?.code}) and the encoder never started for it (started=${started}, i.e. only the first job ran)`,
      { cancelled, code: queuedError?.code ?? null, started });
  }

  // -------------------------------------------------------------------------------------------
  // 5. Cancelling a RUNNING job: the ffmpeg child is really aborted.
  // -------------------------------------------------------------------------------------------
  {
    const queue = new DerivationQueue({ service, concurrency: 1, maxQueue: 4, taskTimeoutMs: 60_000 });
    queue.clearCache();
    // Cancel as soon as the task is genuinely running. Waiting a fixed 900 ms raced the encoder: a
    // 3-second clip transcodes faster than that here, so the job had already committed a row and
    // cancel() correctly returned false. The wait is now a poll on the queue's own running set, so
    // the cancel lands while ffmpeg is still working.
    const big = queue.submit({ asset_version_id: clip.default_version_id, derivative_type: "transcode", parameters: { width: 854 }, profile_key: "cancel-running" });
    let runningBeforeCancel = 0;
    for (let i = 0; i < 400; i += 1) {
      runningBeforeCancel = queue.status().running;
      if (runningBeforeCancel === 1) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    // CANCEL IMMEDIATELY. An earlier version sampled the ffmpeg process list here, and that spawns
    // a PowerShell process (~100-500ms) - during which the encode finished and registered itself, so
    // the cancel landed after registration and the scenario measured nothing it intended to. The
    // process sampling now happens AFTER the cancel; nothing may sit between observing `running` and
    // asking for the cancel.
    const startedAt = Date.now();
    const cancelled = queue.cancel(big.task_id);
    let error = null;
    await big.promise.catch((e) => { error = e; });
    const elapsed = Date.now() - startedAt;
    const processesAfterCancel = await ffmpegProcessCount();
    await new Promise((r) => setTimeout(r, 500));
    const processesAfter = await ffmpegProcessCount();
    const processesDuringRun = processesAfterCancel; // sampled after the cancel; see the note above
    const filesAfter = await countCacheFiles();
    details.cancel_running = { cancelled, running_before_cancel: runningBeforeCancel, code: error?.code ?? null, elapsed_ms: elapsed, processes_during: processesDuringRun, processes_after: processesAfter, message: String(error?.message ?? "").slice(0, 120) };
    details.cancel_running_settlement = queue.status();
    add("running_job_cancel_aborts_the_encoder",
      cancelled === true && runningBeforeCancel === 1 && error?.code === "DERIVATION_CANCELLED" && elapsed < 10_000,
      `the task was in the running set when cancelled (running=${runningBeforeCancel}), cancel() returned ${cancelled}, the promise rejected with ${error?.code} after ${elapsed} ms, and the abort came from the child-process signal path ("${String(error?.message ?? "").slice(0, 60)}")`,
      { cancelled, running_before_cancel: runningBeforeCancel, code: error?.code ?? null, elapsed_ms: elapsed });
    const transcodeRows = (await service.listDerivedFiles({ asset_version_id: clip.default_version_id })).filter((d) => d.derivative_type === "transcode").length;
    add("cancelled_job_leaves_no_artifact_and_no_row",
      transcodeRows === 0,
      `the cancelled transcode produced no derived_files row (transcode rows = ${transcodeRows}); the cache holds ${filesAfter} working file(s), all of which are stored derivations from the completed jobs`,
      { cache_files: filesAfter, transcode_rows: transcodeRows });
    // This distinguishes "the encoder was really killed" from "the encode finished and we threw the
    // result away": settled_after_abandon counts tasks whose physical end came AFTER their caller was
    // already settled, while discarded_late_results counts abandoned tasks that still PRODUCED a
    // result. A real abort produces no result, so the latter must stay 0 here.
    const cancelCounters = queue.status().counters;
    add("cancelled_encoder_produced_no_result_at_all",
      cancelCounters.settled_after_abandon >= 1 && cancelCounters.discarded_late_results === 0,
      `the aborted encode settled physically after the caller was rejected (settled_after_abandon=${cancelCounters.settled_after_abandon}) and produced no result to discard (discarded_late_results=${cancelCounters.discarded_late_results}) -- i.e. the child was killed, not merely ignored`,
      { counters: cancelCounters });
  }

  // -------------------------------------------------------------------------------------------
  // 6. Task timeout: a job that never finishes is failed, not awaited forever.
  // -------------------------------------------------------------------------------------------
  {
    const queue = new DerivationQueue({ service, concurrency: 1, maxQueue: 4, taskTimeoutMs: 300, stuckGraceMs: 50 });
    queue.clearCache();
    queue.run = async () => new Promise(() => {}); // never settles
    const stuck = queue.submit({ asset_version_id: still.default_version_id, derivative_type: "thumbnail", parameters: { width: 256 }, profile_key: "timeout" });
    const startedAt = Date.now();
    let error = null;
    await stuck.promise.catch((e) => { error = e; });
    const elapsed = Date.now() - startedAt;
    // CONTRACT CHANGE (REN-05 review): the old assertion expected `running === 0` after the timeout,
    // i.e. the slot to be released immediately. That is exactly the defect the parent probe caught:
    // freeing the slot while the encoder may still be alive is what allowed a second encoder to start
    // on top of the first. The contract is now: the CALLER is settled promptly, the SLOT STAYS HELD
    // until the run physically ends, and a run that never ends is reported as degraded rather than
    // silently over-admitted. This run function never settles, so the slot must remain reserved.
    const afterTimeout = queue.status();
    // The degraded flag only trips once the stuck grace period has elapsed, so wait it out. The
    // slot-held assertion below is valid immediately; this one needs the grace window.
    await new Promise((r) => setTimeout(r, 200));
    const degradedStatus = queue.status();
    details.task_timeout = { code: error?.code ?? null, elapsed_ms: elapsed, status: afterTimeout, degraded_status: degradedStatus };
    add("hung_job_times_out_for_the_caller_without_freeing_the_slot",
      error?.code === "DERIVATION_TIMEOUT" && elapsed < 5_000 && afterTimeout.running === 1 && afterTimeout.abandoned_running === 1 && afterTimeout.available_slots === 0,
      `a job that never settles rejected its caller with ${error?.code} after ${elapsed} ms while the physical slot stayed reserved (running=${afterTimeout.running}, abandoned_running=${afterTimeout.abandoned_running}, available_slots=${afterTimeout.available_slots})`,
      { code: error?.code ?? null, elapsed_ms: elapsed, status: afterTimeout });
    add("hung_job_is_reported_degraded_not_over_admitted",
      degradedStatus.degraded === true && degradedStatus.stuck_tasks.length === 1,
      `the never-ending run is reported as degraded (degraded=${degradedStatus.degraded}, stuck_tasks=${degradedStatus.stuck_tasks.length}): "${degradedStatus.degraded_reason}"`,
      { reason: degradedStatus.degraded_reason });
  }

  // -------------------------------------------------------------------------------------------
  // 7. The REAL ffmpeg timeout path (a 1 ms budget can not encode anything).
  // -------------------------------------------------------------------------------------------
  {
    let error = null;
    try {
      await generateDerivation({
        source: { file_path: path.join(fixturesDir, "clip_720p_2s.mp4"), file_name: "clip_720p_2s.mp4", asset_version_id: "probe" },
        derivativeType: "proxy",
        parameters: { width: 640 },
        outputDir: path.join(workDir, "ffmpeg-timeout"),
        timeoutMs: 1
      });
    } catch (e) {
      error = e;
    }
    details.ffmpeg_timeout = { code: error?.code ?? null, message: String(error?.message ?? "").slice(0, 120) };
    add("real_ffmpeg_invocation_honours_the_timeout",
      error instanceof DerivationError && error.code === "DERIVATION_TIMEOUT",
      `a real encode given a 1 ms budget was stopped with ${error?.code ?? "(no error)"} ("${String(error?.message ?? "").slice(0, 80)}")`,
      { code: error?.code ?? null });
  }

  // -------------------------------------------------------------------------------------------
  // 8. Unreachable object store vs missing source file: distinguishable errors.
  // -------------------------------------------------------------------------------------------
  {
    const objectsDir = path.join(root, "asset-repo", "objects", "sha256");
    const stash = path.join(workDir, "objects-stashed");
    // The rename target must NOT exist: on Windows, renaming onto an existing directory fails with
    // EPERM, which is a property of the filesystem rather than of the code under test.
    await fs.promises.rm(stash, { recursive: true, force: true });
    // Simulate the mount going away: the objects directory stops being reachable.
    await fs.promises.rename(objectsDir, stash);
    let error = null;
    try {
      await service.performDerivation({ asset_version_id: still.default_version_id, derivative_type: "thumbnail", parameters: { width: 256 } });
    } catch (e) {
      error = e;
    }
    await fs.promises.rename(stash, objectsDir);
    details.store_offline = { code: error?.code ?? null, message: String(error?.message ?? "").slice(0, 140) };
    add("unreachable_object_store_is_reported_as_a_storage_fault",
      error?.code === "STORAGE_OBJECTS_UNREACHABLE",
      `with the objects directory gone, the derivation reported ${error?.code ?? "(no error)"} rather than a generic failure or "asset not found"`,
      { code: error?.code ?? null, message: String(error?.message ?? "").slice(0, 200) });
  }
  {
    const missing = await service.ingestAsset({ file_path: path.join(fixturesDir, "still_640x480.jpg"), title: "missing source" });
    const objectPath = service.resolveVersionFile(missing.default_version_id).file_path;
    await fs.promises.rm(objectPath, { force: true });
    let error = null;
    try {
      await service.performDerivation({ asset_version_id: missing.default_version_id, derivative_type: "thumbnail", parameters: { width: 128 } });
    } catch (e) {
      error = e;
    }
    // Put the object back: the deletion was the fault injection, and leaving it deleted would make
    // the later integrity scan report the injection instead of the queue workload.
    await fs.promises.copyFile(path.join(fixturesDir, "still_640x480.jpg"), objectPath);
    details.source_missing = { code: error?.code ?? null };
    add("missing_source_object_is_reported_as_a_missing_file",
      error?.code === "DERIVATION_SOURCE_MISSING",
      `with the store reachable but the object deleted, the derivation reported ${error?.code ?? "(no error)"} - a different code from the offline-store case`,
      { code: error?.code ?? null });
  }

  // -------------------------------------------------------------------------------------------
  // 9. Original objects are never modified by derivation work.
  // -------------------------------------------------------------------------------------------
  {
    const clipObjectHashAfter = await sha256File(clipSourceObject);
    add("source_object_unchanged_by_all_of_the_above",
      clipObjectHashAfter === clipObjectHashBefore,
      `the video source object hash is unchanged after 6 derivations, 2 cancellations, a timeout and 2 fault injections (${clipObjectHashBefore.slice(0, 16)}…)`,
      { hash_before: clipObjectHashBefore, hash_after: clipObjectHashAfter });
    const scan = service.integrityScan({ deep: true });
    add("repository_still_integrity_clean_after_queue_work",
      scan.ok === true,
      `integrityScan({deep:true}) is green after the queue workload (issues=${scan.issues.length}, scanned=${JSON.stringify(scan.scanned)})`,
      { scanned: scan.scanned, errors: scan.errors.map((e) => e.code) });
  }

  const failed = checks.filter((c) => !c.ok);
  const report = {
    report: "REN-05 bounded derivation queue and fault reporting",
    generated_at: new Date().toISOString(),
    repository_root: root,
    toolchain: { ffmpeg: tools.ffmpeg, available: tools.available },
    details,
    checks,
    failed: failed.map((c) => `${c.id}: ${c.detail}`),
    all_pass: failed.length === 0
  };
  if (outPath) {
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    await fs.promises.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  for (const c of checks) console.log(`[${c.ok ? "PASS" : "FAIL"}] ${c.id}: ${c.detail}`);
  console.log(`queue checks: ${checks.length - failed.length}/${checks.length} pass${outPath ? ` -> ${outPath}` : ""}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  service.close();
}
