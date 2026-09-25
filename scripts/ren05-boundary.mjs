// REN-05 / scripts/ren05-boundary.mjs
//
// NEGATIVE CONTROLS for the two boundary defects the parent review reproduced, plus the legal
// `maxQueue: 0` setting and the no-late-writeback rule.
//
// Two independent styles are used on purpose:
//   * DETERMINISTIC deferred callbacks - a run function whose completion the test controls, so the
//     interleavings (timeout -> retry -> late finish) are exact and repeatable, with no timers or
//     child processes involved.
//   * REAL ffmpeg - actual child processes for the timeout/cancel cleanup paths, because a
//     deterministic stand-in can not prove that the encoder is really gone.
//
// Usage: node scripts/ren05-boundary.mjs --work <dir> --fixtures <dir> --out <json>

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DerivationQueue } from "../src/derivation-queue.js";
import { ifRangeMatches } from "../src/protected-stream.js";
import { VideoAssetService } from "../src/service.js";

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const workDir = arg("work");
const fixturesDir = arg("fixtures");
const outPath = arg("out");
if (!workDir || !fixturesDir) {
  console.error("usage: node scripts/ren05-boundary.mjs --work <dir> --fixtures <dir> --out <json>");
  process.exit(2);
}
await fs.promises.mkdir(workDir, { recursive: true });

const checks = [];
const add = (id, ok, detail, extra = {}) => checks.push({ id, ok, detail, ...extra });
const details = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

const clipFixture = path.join(fixturesDir, "clip_720p_2s.mp4");
const stillFixture = path.join(fixturesDir, "still_1024x768.png");

async function freshService(name) {
  const root = path.join(workDir, name);
  await fs.promises.rm(root, { recursive: true, force: true });
  await fs.promises.mkdir(root, { recursive: true });
  const service = new VideoAssetService({ pluginConfig: { repositoryRoot: root }, logger: { info() {}, warn() {}, error() {}, debug() {} } }).init();
  return { service, root };
}

async function countCacheArtifacts(root) {
  let total = 0;
  for (const sub of ["thumbnails", "proxies", "audio", "waveforms", "derived"]) {
    const dir = path.join(root, "cache", sub);
    if (fs.existsSync(dir)) total += (await fs.promises.readdir(dir)).length;
  }
  return total;
}

// ===============================================================================================
// PART A - If-Range date precision (function level)
// ===============================================================================================
{
  const secondMs = 1_000;
  const baseSecond = Date.parse("2026-09-23T00:00:00.000Z");

  // POSITIVE CONTROL: a file whose mtime carries a sub-second part, echoed exactly as the server
  // itself emitted it, must match. This is the case the parent probe found failing at 456ms.
  const positives = [];
  for (const ms of [0, 1, 456, 500, 999]) {
    const mtimeMs = baseSecond + ms;
    const emitted = new Date(mtimeMs).toUTCString();
    const matched = ifRangeMatches(emitted, { etag: '"test"', lastModified: mtimeMs });
    positives.push({ ms, emitted, matched });
  }
  add("date_current_control_matches_at_sub_second_mtimes",
    positives.every((p) => p.matched === true),
    `echoing the server's own Last-Modified back matches for mtimes with .000/.001/.456/.500/.999 ms: ${positives.map((p) => `.${String(p.ms).padStart(3, "0")}=${p.matched}`).join(" ")} (this is the exact case that reported false before the fix)`,
    { positives });

  // The comparison is TRUNCATION, not rounding: an mtime at .999 belongs to that same second, and a
  // date one second later is a different representation.
  const truncation = {
    same_second_within: ifRangeMatches(new Date(baseSecond).toUTCString(), { etag: '"t"', lastModified: baseSecond + 999 }),
    next_second: ifRangeMatches(new Date(baseSecond + secondMs).toUTCString(), { etag: '"t"', lastModified: baseSecond + 999 }),
    previous_second: ifRangeMatches(new Date(baseSecond - secondMs).toUTCString(), { etag: '"t"', lastModified: baseSecond + 456 })
  };
  add("date_comparison_truncates_rather_than_rounds",
    truncation.same_second_within === true && truncation.next_second === false && truncation.previous_second === false,
    `same second matches (${truncation.same_second_within}); the next second does not (${truncation.next_second}); the previous second does not (${truncation.previous_second})`,
    { truncation });

  // NEGATIVE CONTROLS
  const negatives = {
    stale_date_yesterday: ifRangeMatches(new Date(baseSecond - 86_400_000).toUTCString(), { etag: '"e"', lastModified: baseSecond + 456 }),
    future_date_tomorrow: ifRangeMatches(new Date(baseSecond + 86_400_000).toUTCString(), { etag: '"e"', lastModified: baseSecond + 456 }),
    strong_etag_exact: ifRangeMatches('"sha256:abc"', { etag: '"sha256:abc"', lastModified: baseSecond }),
    strong_etag_different: ifRangeMatches('"sha256:def"', { etag: '"sha256:abc"', lastModified: baseSecond }),
    // A weak validator must never satisfy If-Range, even when it wraps the CURRENT etag: it does not
    // identify a byte-identical representation, so the safe answer is a full response.
    weak_etag_wrapping_current: ifRangeMatches('W/"sha256:abc"', { etag: '"sha256:abc"', lastModified: baseSecond }),
    unparseable_date: ifRangeMatches("not-a-date", { etag: '"e"', lastModified: baseSecond }),
    date_but_no_last_modified: ifRangeMatches(new Date(baseSecond).toUTCString(), { etag: '"e"', lastModified: null })
  };
  add("stale_and_future_dates_do_not_match",
    negatives.stale_date_yesterday === false && negatives.future_date_tomorrow === false,
    `an older date does not match (${negatives.stale_date_yesterday}); a future date does not match (${negatives.future_date_tomorrow})`,
    { stale: negatives.stale_date_yesterday, future: negatives.future_date_tomorrow });
  add("strong_etag_matches_only_its_exact_value",
    negatives.strong_etag_exact === true && negatives.strong_etag_different === false,
    `the exact strong ETag matches (${negatives.strong_etag_exact}); a different one does not (${negatives.strong_etag_different})`,
    { exact: negatives.strong_etag_exact, different: negatives.strong_etag_different });
  add("weak_etag_never_satisfies_if_range",
    negatives.weak_etag_wrapping_current === false,
    `W/"sha256:abc" against the current strong ETag "sha256:abc" -> ${negatives.weak_etag_wrapping_current} (a weak validator must downgrade to a full 200, never a spliced 206)`,
    { weak: negatives.weak_etag_wrapping_current });
  add("unparseable_or_absent_validators_do_not_match",
    negatives.unparseable_date === false && negatives.date_but_no_last_modified === false && ifRangeMatches(null, { etag: '"e"', lastModified: baseSecond }) === true,
    `garbage date -> ${negatives.unparseable_date}; a date with no known Last-Modified -> ${negatives.date_but_no_last_modified}; no If-Range at all -> true (no condition to honour)`,
    { unparseable: negatives.unparseable_date, missing_last_modified: negatives.date_but_no_last_modified });

  details.date = { positives, truncation, negatives };
}

// ===============================================================================================
// PART B - queue: same-key retry after timeout, late finish, and real concurrency
// ===============================================================================================
{
  // Deterministic: the run callback pushes a resolver the test invokes by hand, so the interleaving
  // is exact. `active`/`peak` measure PHYSICAL concurrency.
  const callbacks = [];
  let active = 0;
  let peak = 0;
  let started = 0;
  const queue = new DerivationQueue({
    concurrency: 1,
    maxQueue: 4,
    taskTimeoutMs: 80,
    run: () => new Promise((resolve) => {
      started += 1;
      active += 1;
      peak = Math.max(peak, active);
      callbacks.push((value) => {
        active -= 1;
        resolve(value ?? { ok: true, started });
      });
    })
  });

  const same = { asset_version_id: "ver_boundary", derivative_type: "thumbnail", parameters: { width: 320 }, profile_key: "boundary" };
  const a = queue.submit({ ...same });
  const aError = await a.promise.catch((e) => e);

  add("timeout_settles_the_caller_promptly",
    aError?.code === "DERIVATION_TIMEOUT",
    `the first submit was rejected with ${aError?.code} at the timeout, without waiting for the run to end`,
    { code: aError?.code ?? null });

  const beforeLate = queue.status();
  add("timeout_keeps_the_physical_slot_reserved",
    beforeLate.running === 1 && beforeLate.abandoned_running === 1 && beforeLate.available_slots === 0,
    `after the timeout: running=${beforeLate.running} (slot still held by the abandoned run), abandoned_running=${beforeLate.abandoned_running}, available_slots=${beforeLate.available_slots} -- the slot is NOT freed while the run may still be encoding`,
    { status: beforeLate });

  // The retry must NOT join the abandoned task (its result will be discarded), and must not start
  // while the abandoned run still holds the only slot.
  const b = queue.submit({ ...same });
  const afterRetry = queue.status();
  add("same_key_retry_does_not_join_the_abandoned_task",
    b.task_id !== a.task_id && b.deduplicated === false,
    `the same-key retry got a NEW task (${b.task_id} != ${a.task_id}) instead of joining the abandoned one`,
    { retry_task: b.task_id, abandoned_task: a.task_id, deduplicated: b.deduplicated });
  add("same_key_retry_waits_instead_of_starting",
    started === 1 && afterRetry.queued === 1,
    `the retry is queued (queued=${afterRetry.queued}) and no second run started (started=${started}) while the abandoned run holds the slot`,
    { started, queued: afterRetry.queued });

  // A third submit with the same key de-duplicates onto the QUEUED retry.
  const c = queue.submit({ ...same });
  add("third_submit_dedupes_onto_the_queued_retry",
    c.task_id === b.task_id && c.deduplicated === true,
    `a third identical submit joined the queued retry (task ${c.task_id}, deduplicated=${c.deduplicated}) rather than creating another job`,
    { deduplicated: c.deduplicated });

  // The late finish of the abandoned run must not disturb the new owner.
  callbacks[0]();
  await tick();
  const afterLate = queue.status();
  add("late_finish_does_not_remove_the_new_owner",
    afterLate.running === 1 && afterLate.abandoned_running === 0,
    `after the abandoned run physically ended: running=${afterLate.running} (the retry now owns the slot), abandoned_running=${afterLate.abandoned_running}. Before the fix this read 0 because the late finisher deleted the new task's entry by key.`,
    { status: afterLate });

  // A different-key submit must queue, not over-admit.
  const d = queue.submit({ ...same, asset_version_id: "ver_boundary_2" });
  const afterFourth = queue.status();
  add("different_key_does_not_over_admit",
    afterFourth.running === 1 && afterFourth.queued === 1 && started === 2,
    `with the retry running, another job queued instead of starting: running=${afterFourth.running}, queued=${afterFourth.queued}, started=${started}`,
    { status: afterFourth });

  // Drain and confirm the physical concurrency never exceeded the cap.
  while (callbacks.length) {
    const fn = callbacks.shift();
    fn();
    await tick();
  }
  await Promise.allSettled([b.promise, d.promise]);
  const final = queue.status();
  add("physical_concurrency_never_exceeded_the_cap",
    peak === 1,
    `peak simultaneous runs = ${peak} with concurrency=1 (the parent probe measured 2 before the fix); started=${started} total, so the work was serialized rather than overlapped`,
    { peak, started, status: final });
  // The retry legitimately caches ITS OWN result under the shared key, so "the key is absent" would
  // be the wrong assertion: what matters is that the cached entry is the retry's, and that the
  // abandoned run's late result was the one thrown away.
  const cachedEntry = queue.completed.get(a.key) ?? null;
  add("late_result_is_discarded_and_only_the_retry_is_cached",
    final.counters.discarded_late_results >= 1 && cachedEntry?.task_id === b.task_id && cachedEntry?.task_id !== a.task_id,
    `the abandoned run's late result was discarded (discarded_late_results=${final.counters.discarded_late_results}); the only cached entry for that key belongs to the retry ${cachedEntry?.task_id} (abandoned task was ${a.task_id})`,
    { counters: final.counters, cached_task_id: cachedEntry?.task_id ?? null });
  add("ownership_guard_was_not_needed_but_remains",
    final.counters.ownership_guard_hits === 0,
    `the ownership guard never had to fire (${final.counters.ownership_guard_hits} hits), because a task holds its key until it physically ends -- the guard is a second line of defence for a late finisher, not the primary fix`,
    { ownership_guard_hits: final.counters.ownership_guard_hits });

  details.same_key_retry = { peak, started, status: final, counters: final.counters };
}

// ===============================================================================================
// PART C - stuck executor: reported degraded, and never over-admitted
// ===============================================================================================
{
  let started = 0;
  let peak = 0;
  let active = 0;
  const resolvers = [];
  const queue = new DerivationQueue({
    concurrency: 1,
    maxQueue: 4,
    taskTimeoutMs: 60,
    stuckGraceMs: 120,
    // The FIRST run ignores its abort signal entirely and resolves only when the test says so; later
    // runs resolve normally. That isolates the stuck case and still lets the check show that queued
    // work proceeds normally once the stuck run finally ends.
    run: () => new Promise((resolve) => {
      const call = ++started;
      active += 1;
      peak = Math.max(peak, active);
      if (call === 1) {
        resolvers.push(() => { active -= 1; resolve({ ok: true, call }); });
        return;
      }
      active -= 1;
      resolve({ ok: true, call });
    })
  });

  const stuck = queue.submit({ asset_version_id: "ver_stuck", derivative_type: "thumbnail", parameters: { width: 256 }, profile_key: "stuck" });
  const stuckError = await stuck.promise.catch((e) => e);
  await sleep(200); // past the stuck grace period

  const degraded = queue.status();
  add("stuck_executor_is_reported_as_degraded",
    stuckError?.code === "DERIVATION_TIMEOUT" && degraded.degraded === true && degraded.stuck_tasks.length === 1 && /reserved/.test(String(degraded.degraded_reason)),
    `the caller was rejected (${stuckError?.code}) and the never-ending run is reported as degraded: degraded=${degraded.degraded}, stuck_tasks=${degraded.stuck_tasks.length}, reason="${degraded.degraded_reason}"`,
    { status: degraded });

  // Fill the waiting room (4) and then one more: the extra must be REFUSED, not queued forever. The
  // loop is used rather than an assumed index so the count is measured, not guessed.
  const queuedTasks = [];
  let overflow = null;
  for (let i = 0; i < 3; i += 1) {
    queuedTasks.push(queue.submit({ asset_version_id: `ver_stuck_${i}`, derivative_type: "thumbnail", parameters: { width: 256 + i * 2 }, profile_key: "stuck" }));
  }
  await sleep(120);
  const afterMore = queue.status();
  add("stuck_executor_does_not_admit_extra_work",
    started === 1 && afterMore.running === 1 && peak === 1 && afterMore.queued === 3,
    `with the slot stuck, 3 further submits were QUEUED rather than started: started=${started}, peak=${peak}, queued=${afterMore.queued} -- a run that ignores its abort can not cause unbounded encoders`,
    { started, peak, status: afterMore });

  queuedTasks.push(queue.submit({ asset_version_id: "ver_stuck_3", derivative_type: "thumbnail", parameters: { width: 262 }, profile_key: "stuck" }));
  overflow = queue.submit({ asset_version_id: "ver_stuck_overflow", derivative_type: "thumbnail", parameters: { width: 999 }, profile_key: "stuck" });
  const overflowError = await overflow.promise.catch((e) => e);
  const atCapacity = queue.status();
  add("stuck_slot_still_refuses_beyond_the_waiting_room",
    overflow.refused === true && overflowError?.code === "DERIVATION_QUEUE_FULL" && atCapacity.queued === 4,
    `with the waiting room full (queued=${atCapacity.queued}/4) the next submit was refused with ${overflowError?.code} instead of piling up`,
    { code: overflowError?.code ?? null, queued: atCapacity.queued });

  // Release the stuck work: the queue must now admit queued jobs, which complete normally.
  resolvers.forEach((fn) => fn());
  await sleep(500);
  const drained = queue.status();
  add("queued_work_runs_once_the_stuck_run_ends",
    drained.abandoned_running === 0 && drained.running === 0 && drained.queued === 0 && started >= 5 && peak === 1,
    `after the stuck run finally ended, the queue admitted and completed the queued jobs (started=${started}, queued=${drained.queued}, running=${drained.running}, abandoned_running=${drained.abandoned_running}) with physical concurrency never above ${peak}`,
    { started, peak, status: drained });

  details.stuck = { peak, started, status: drained };
}

// ===============================================================================================
// PART D - maxQueue: 0 is a legal setting (no waiting room, not "always refuse")
// ===============================================================================================
{
  let started = 0;
  const release = [];
  const queue = new DerivationQueue({
    concurrency: 1,
    maxQueue: 0,
    taskTimeoutMs: 5_000,
    run: () => new Promise((resolve) => { started += 1; release.push(() => resolve({ ok: true })); })
  });

  const first = queue.submit({ asset_version_id: "v_zero", derivative_type: "thumbnail", parameters: { width: 128 }, profile_key: "zero" });
  add("max_queue_zero_runs_on_a_free_slot",
    first.refused !== true && first.task_id !== null,
    `with maxQueue=0 and an idle slot, the submit was ACCEPTED (task ${first.task_id}) instead of always being refused`,
    { task_id: first.task_id, refused: first.refused === true });
  await sleep(60);

  const second = queue.submit({ asset_version_id: "v_zero_2", derivative_type: "thumbnail", parameters: { width: 130 }, profile_key: "zero" });
  const secondError = await second.promise.catch((e) => e);
  add("max_queue_zero_refuses_when_no_slot_is_free",
    second.refused === true && secondError?.code === "DERIVATION_QUEUE_FULL",
    `with the only slot busy, the next submit was refused with ${secondError?.code} (no waiting room exists)`,
    { code: secondError?.code ?? null });

  release.forEach((fn) => fn());
  await sleep(50);
  details.max_queue_zero = { status: queue.status(), started };
}

// ===============================================================================================
// PART E1 - the commit checkpoint itself, deterministically
//
// WHY THIS IS A DIRECT TEST RATHER THAN A CONTRIVED RACE: once the timeout really aborts, an
// in-flight derivation is stopped at the ENCODER (measured: "ffmpeg.exe was cancelled"), so the run
// never reaches the registration step - meaning an end-to-end scenario can no longer exercise the
// checkpoint at all. The checkpoint still matters for the genuine window it was written for (the
// artifact exists and the abandon arrives just before the row). It is therefore tested directly:
// an abandoned/cancelled lifecycle must be refused, and - equally important - a HEALTHY lifecycle
// must still commit, so the test can not pass by refusing everything.
// ===============================================================================================
{
  const { service, root } = await freshService("commit_checkpoint");
  try {
    const clip = await service.ingestAsset({ file_path: clipFixture, title: "checkpoint clip" });
    const beforeRows = service.db.prepare("SELECT COUNT(*) AS n FROM derived_files").get().n;
    const beforeArtifacts = await countCacheArtifacts(root);
    const healthy = () => ({ signal: new AbortController().signal, isAbandoned: () => false, isCancelled: () => false, abandonReason: () => null });

    // CONTROL: a healthy lifecycle must commit. Without this, a checkpoint that refused everything
    // would look like a pass.
    const control = await service.performDerivation({
      asset_version_id: clip.default_version_id, derivative_type: "thumbnail", parameters: { width: 200 }, lifecycle: healthy()
    });
    const rowsAfterControl = service.db.prepare("SELECT COUNT(*) AS n FROM derived_files").get().n;
    add("healthy_lifecycle_commits_normally",
      Boolean(control?.derived_file_id) && rowsAfterControl === beforeRows + 1,
      `the control derivation succeeded and registered a row (derived_files ${beforeRows} -> ${rowsAfterControl}), so the checkpoint below is conditional rather than a blanket refusal`,
      { control_rows: rowsAfterControl });

    // An ABANDONED lifecycle must be refused, with nothing registered.
    let abandonedError = null;
    try {
      await service.performDerivation({
        asset_version_id: clip.default_version_id, derivative_type: "thumbnail", parameters: { width: 201 },
        lifecycle: { signal: new AbortController().signal, isAbandoned: () => true, isCancelled: () => false, abandonReason: () => "task-timeout" }
      });
    } catch (error) {
      abandonedError = error;
    }
    const rowsAfterAbandon = service.db.prepare("SELECT COUNT(*) AS n FROM derived_files").get().n;
    add("abandoned_lifecycle_is_refused_by_the_commit_checkpoint",
      abandonedError?.code === "DERIVATION_ABANDONED",
      `a lifecycle reporting "abandoned" was refused with ${abandonedError?.code ?? "(no error)"}: "${String(abandonedError?.message ?? "").slice(0, 100)}"`,
      { code: abandonedError?.code ?? null });
    add("abandoned_lifecycle_registers_no_row",
      rowsAfterAbandon === rowsAfterControl,
      `derived_files stayed at ${rowsAfterAbandon} after the refused derivation`,
      { rows: rowsAfterAbandon });

    // A CANCELLED lifecycle likewise.
    let cancelledError = null;
    try {
      await service.performDerivation({
        asset_version_id: clip.default_version_id, derivative_type: "thumbnail", parameters: { width: 202 },
        lifecycle: { signal: new AbortController().signal, isAbandoned: () => false, isCancelled: () => true, abandonReason: () => "cancelled" }
      });
    } catch (error) {
      cancelledError = error;
    }
    add("cancelled_lifecycle_is_refused_by_the_commit_checkpoint",
      cancelledError?.code === "DERIVATION_ABANDONED" && service.db.prepare("SELECT COUNT(*) AS n FROM derived_files").get().n === rowsAfterControl,
      `a lifecycle reporting "cancelled" was refused with ${cancelledError?.code ?? "(no error)"} and registered nothing`,
      { code: cancelledError?.code ?? null });

    // An already-ABORTED signal (no lifecycle flags) must also be refused: that is what a timeout now
    // produces, and the checkpoint must not depend on the lifecycle object alone.
    const abortedController = new AbortController();
    abortedController.abort();
    let signalError = null;
    try {
      await service.performDerivation({
        asset_version_id: clip.default_version_id, derivative_type: "thumbnail", parameters: { width: 203 },
        signal: abortedController.signal, lifecycle: healthy()
      });
    } catch (error) {
      signalError = error;
    }
    add("already_aborted_signal_is_refused_even_with_a_healthy_lifecycle",
      signalError?.code === "DERIVATION_CANCELLED" || signalError?.code === "DERIVATION_ABANDONED",
      `an already-aborted signal was refused with ${signalError?.code ?? "(no error)"} (the encoder is killed before any row can be written)`,
      { code: signalError?.code ?? null });

    const scan = service.integrityScan({ deep: true });
    add("repository_stays_integrity_clean_after_the_refusals",
      scan.ok === true,
      `integrityScan({deep:true}) is green with ${scan.scanned.derived_files} registered derivation(s) (issues=${scan.issues.length})`,
      { scanned: scan.scanned, errors: scan.errors.map((e) => e.code) });

    details.commit_checkpoint = {
      before: { rows: beforeRows, artifacts: beforeArtifacts },
      control_rows: rowsAfterControl,
      abandoned_code: abandonedError?.code ?? null,
      cancelled_code: cancelledError?.code ?? null,
      signal_code: signalError?.code ?? null
    };
  } finally {
    service.close();
  }
}

// ===============================================================================================
// PART E2 - end-to-end: a timed-out real derivation leaves no row and no artifact
// ===============================================================================================
{
  const { service, root } = await freshService("no_late_writeback_e2e");
  try {
    const clip = await service.ingestAsset({ file_path: clipFixture, title: "late writeback clip" });
    const beforeArtifacts = await countCacheArtifacts(root);
    const beforeRows = service.db.prepare("SELECT COUNT(*) AS n FROM derived_files").get().n;

    // A run that forwards the abort, exactly as the real path does, and only then reaches the real
    // derivation. The write must not happen.
    let lateOutcome = null;
    const queue = new DerivationQueue({
      service,
      concurrency: 1,
      maxQueue: 2,
      taskTimeoutMs: 60,
      run: async ({ signal, lifecycle, ...rest }) => {
        await sleep(400); // outlives the timeout
        try {
          lateOutcome = { kind: "resolved", value: await service.performDerivation({ ...rest, signal, lifecycle }) };
        } catch (error) {
          lateOutcome = { kind: "rejected", code: error.code, message: String(error.message) };
        }
        return lateOutcome;
      }
    });

    const task = queue.submit({ asset_version_id: clip.default_version_id, derivative_type: "thumbnail", parameters: { width: 256 }, profile_key: "late-e2e" });
    const error = await task.promise.catch((e) => e);
    await sleep(2_500);
    await queue.waitForIdle({ timeoutMs: 20_000 });

    const afterRows = service.db.prepare("SELECT COUNT(*) AS n FROM derived_files").get().n;
    const afterArtifacts = await countCacheArtifacts(root);
    const scan = service.integrityScan({ deep: true });

    add("late_real_derivation_is_refused",
      error?.code === "DERIVATION_TIMEOUT" && lateOutcome?.kind === "rejected" && ["DERIVATION_CANCELLED", "DERIVATION_ABANDONED"].includes(lateOutcome.code),
      `the caller got ${error?.code}; the late run was refused with ${lateOutcome?.code} ("${String(lateOutcome?.message ?? "").slice(0, 90)}")`,
      { late_outcome: lateOutcome, caller_error: error?.code ?? null });
    add("late_real_derivation_registers_no_row",
      afterRows === beforeRows,
      `derived_files ${beforeRows} -> ${afterRows}`,
      { before: beforeRows, after: afterRows });
    add("late_real_derivation_leaves_no_artifact",
      afterArtifacts === beforeArtifacts,
      `cache artifacts ${beforeArtifacts} -> ${afterArtifacts}: nothing was left behind for an "exists" check to trust`,
      { before: beforeArtifacts, after: afterArtifacts });
    add("repository_stays_integrity_clean_after_the_late_run",
      scan.ok === true,
      `integrityScan({deep:true}) is green (issues=${scan.issues.length})`,
      { errors: scan.errors.map((e) => e.code) });
    add("queue_reports_the_abandoned_slot_as_settled",
      queue.status().running === 0 && queue.status().abandoned_running === 0,
      `the queue drained (running=${queue.status().running}, settled_after_abandon=${queue.status().counters.settled_after_abandon})`,
      { status: queue.status() });

    details.late_writeback_e2e = { late_outcome: lateOutcome, before: { rows: beforeRows, artifacts: beforeArtifacts }, after: { rows: afterRows, artifacts: afterArtifacts } };
  } finally {
    service.close();
  }
}

// ===============================================================================================
// PART F - REAL ffmpeg: timeout and cancel release the slot and leave nothing behind
// ===============================================================================================
{
  const { service, root } = await freshService("real_ffmpeg_cleanup");
  try {
    const clip = await service.ingestAsset({ file_path: clipFixture, title: "real cleanup clip" });
    const rowsBefore = service.db.prepare("SELECT COUNT(*) AS n FROM derived_files").get().n;
    const artifactsBefore = await countCacheArtifacts(root);

    // A 1 ms budget can not complete a real encode, so the abort path is exercised for real.
    const timeoutQueue = new DerivationQueue({ service, concurrency: 1, maxQueue: 2, taskTimeoutMs: 1 });
    const timedOut = timeoutQueue.submit({ asset_version_id: clip.default_version_id, derivative_type: "proxy", parameters: { width: 640 }, profile_key: "real-timeout" });
    const timeoutError = await timedOut.promise.catch((e) => e);
    await timeoutQueue.waitForIdle({ timeoutMs: 30_000 });

    add("real_ffmpeg_timeout_rejects_the_caller",
      timeoutError?.code === "DERIVATION_TIMEOUT",
      `a real encode given a 1 ms budget rejected the caller with ${timeoutError?.code}`,
      { code: timeoutError?.code ?? null });
    add("real_ffmpeg_timeout_releases_the_slot_after_physical_end",
      timeoutQueue.status().running === 0 && timeoutQueue.status().abandoned_running === 0 && timeoutQueue.status().counters.settled_after_abandon >= 1,
      `the slot was released once the aborted child actually ended (running=${timeoutQueue.status().running}, settled_after_abandon=${timeoutQueue.status().counters.settled_after_abandon}) -- for real ffmpeg the abort terminates the process, so no slot stays stuck`,
      { status: timeoutQueue.status() });

    // Cancel a genuinely running encode.
    const cancelQueue = new DerivationQueue({ service, concurrency: 1, maxQueue: 2, taskTimeoutMs: 60_000 });
    const running = cancelQueue.submit({ asset_version_id: clip.default_version_id, derivative_type: "transcode", parameters: { width: 854 }, profile_key: "real-cancel" });
    let sawRunning = 0;
    for (let i = 0; i < 500; i += 1) {
      sawRunning = cancelQueue.status().running;
      if (sawRunning === 1) break;
      await sleep(10);
    }
    const cancelStartedAt = Date.now();
    const cancelled = cancelQueue.cancel(running.task_id);
    const cancelError = await running.promise.catch((e) => e);
    const cancelElapsed = Date.now() - cancelStartedAt;
    await cancelQueue.waitForIdle({ timeoutMs: 30_000 });
    const rowsAfter = service.db.prepare("SELECT COUNT(*) AS n FROM derived_files").get().n;
    const artifactsAfter = await countCacheArtifacts(root);
    const scan = service.integrityScan({ deep: true });

    add("real_ffmpeg_cancel_rejects_the_caller_promptly",
      cancelled === true && sawRunning === 1 && cancelError?.code === "DERIVATION_CANCELLED" && cancelElapsed < 5_000,
      `the task was running when cancelled (running=${sawRunning}), cancel()=${cancelled}, the caller got ${cancelError?.code} after ${cancelElapsed} ms`,
      { cancelled, saw_running: sawRunning, code: cancelError?.code ?? null, elapsed_ms: cancelElapsed });
    add("real_ffmpeg_cancel_leaves_no_row_and_no_artifact",
      rowsAfter === rowsBefore && artifactsAfter === artifactsBefore,
      `derived_files ${rowsBefore} -> ${rowsAfter}, cache artifacts ${artifactsBefore} -> ${artifactsAfter}: no partial or abandoned derivation was registered or left behind`,
      { rows: { before: rowsBefore, after: rowsAfter }, artifacts: { before: artifactsBefore, after: artifactsAfter } });
    add("real_ffmpeg_cancel_frees_the_slot",
      cancelQueue.status().running === 0 && cancelQueue.status().counters.settled_after_abandon >= 1,
      `the slot was freed after the killed child ended (running=${cancelQueue.status().running}, settled_after_abandon=${cancelQueue.status().counters.settled_after_abandon})`,
      { status: cancelQueue.status() });
    add("repository_stays_integrity_clean_after_real_faults",
      scan.ok === true,
      `integrityScan({deep:true}) is green after the real timeout and cancel (issues=${scan.issues.length})`,
      { errors: scan.errors.map((e) => e.code) });

    details.real_ffmpeg = { timeout_status: timeoutQueue.status(), cancel_status: cancelQueue.status() };
  } finally {
    service.close();
  }
}

const failed = checks.filter((c) => !c.ok);
const report = {
  report: "REN-05 boundary negative controls (If-Range date precision, queue ownership and permits)",
  generated_at: new Date().toISOString(),
  work_dir: workDir,
  checks,
  failed: failed.map((c) => `${c.id}: ${c.detail}`),
  details,
  all_pass: failed.length === 0
};
if (outPath) {
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await fs.promises.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
for (const c of checks) console.log(`[${c.ok ? "PASS" : "FAIL"}] ${c.id}: ${c.detail}`);
console.log(`boundary checks: ${checks.length - failed.length}/${checks.length} pass${outPath ? ` -> ${outPath}` : ""}`);
process.exitCode = failed.length === 0 ? 0 : 1;

// keep the unused import meaningful for future fixture-based cases
void crypto;
void stillFixture;
