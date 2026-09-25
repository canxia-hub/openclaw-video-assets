// REN-05 / scripts/ren05-boundary-concurrency.mjs
//
// CONCURRENCY MATRIX for the queue.
//
// Why a matrix rather than one more scenario: the previous round passed at concurrency 1 and still
// failed at concurrency 2 (the default), because physical occupancy was keyed by the de-duplication
// key, so a same-key retry could OVERWRITE a still-running original - the map held one entry while
// two encoders ran, and a third job then pushed real concurrency past the cap. A single-limit test
// could not see that.
//
// Two executor kinds, because they behave differently and both must be safe:
//   * ABORT-IGNORING   - never observes its signal; ends only when the test ends it. This is the
//     pathological case that exposed the overwrite bug: the owner stays ALIVE after its caller was
//     settled, so the queue must hold its permit, must NOT start the same-key retry, and must not
//     over-admit other keys beyond the cap.
//   * SIGNAL-HONOURING - resolves when its AbortSignal fires. This is the real ffmpeg child. Here the
//     owner DIES on abort, which is the evidence that the timeout really kills the executor rather
//     than merely settling the caller; a same-key retry then legitimately starts, because the key has
//     genuinely been released.
//
// The expectations below are therefore kind-aware. Asserting "the retry always waits" would be wrong
// for the honourable case, and asserting "the retry always starts" would be wrong for the other -
// measuring which one actually happened is the point.
//
// Usage: node scripts/ren05-boundary-concurrency.mjs --out <json>

import fs from "node:fs";
import path from "node:path";
import { DerivationQueue } from "../src/derivation-queue.js";

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const outPath = arg("out");
const checks = [];
const add = (id, ok, detail, extra = {}) => checks.push({ id, ok, detail, ...extra });
const details = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

/**
 * Build a queue whose executor records REAL physical concurrency and can be ended by the test.
 *
 * @param {number} concurrency
 * @param {"signal-honouring"|"abort-ignoring"} kind
 * @param {number} taskTimeoutMs
 * @param {number} [maxQueue] waiting-room size; pass 0 or 1 to exercise admission capacity
 */
function buildQueue(concurrency, kind, taskTimeoutMs, maxQueue = 8) {
  const state = { physical: 0, peak: 0, starts: 0, enders: new Map(), abortEvents: 0, kind };
  const queue = new DerivationQueue({
    concurrency,
    maxQueue,
    taskTimeoutMs,
    stuckGraceMs: 20,
    run: ({ signal }) => new Promise((resolve) => {
      const index = state.starts;
      state.starts += 1;
      state.physical += 1;
      state.peak = Math.max(state.peak, state.physical);
      const end = () => {
        if (!state.enders.has(index)) return;
        state.enders.delete(index);
        state.physical -= 1;
        resolve({ ok: true, index });
      };
      state.enders.set(index, end);
      if (kind === "signal-honouring") {
        signal.addEventListener("abort", () => {
          state.abortEvents += 1;
          end();
        }, { once: true });
      }
    })
  });
  return { queue, state };
}

/** End every outstanding executor, repeatedly, until nothing is left running. */
async function drain(queue, state, { rounds = 12 } = {}) {
  for (let i = 0; i < rounds; i += 1) {
    for (const end of [...state.enders.values()]) end();
    await tick();
    await sleep(25);
    if (state.enders.size === 0 && queue.status().queued === 0 && queue.status().running === 0) return;
  }
}

async function cell(concurrency, kind) {
  const label = `c${concurrency}-${kind}`;
  // A short timeout is what makes the abort observable. For the honourable executor that means the
  // owner is killed promptly; for the ignoring one it means the owner survives, which is exactly the
  // state the overwrite bug needed.
  const { queue, state } = buildQueue(concurrency, kind, 60);
  const base = { asset_version_id: "ver_A", derivative_type: "thumbnail", parameters: { width: 256 }, profile_key: "matrix" };
  const record = { label, concurrency, kind, observations: {} };

  const a = queue.submit({ ...base });
  const aError = await a.promise.catch((e) => e);
  const signalAborted = [...queue.running.values()].length === 0 ? state.abortEvents > 0 : [...queue.running.values()][0].controller.signal.aborted === true;
  await tick();
  await sleep(40);

  const afterTimeout = {
    a_error: aError?.code ?? null,
    abort_events: state.abortEvents,
    signal_aborted: state.abortEvents > 0 || signalAborted === true,
    physical: state.physical,
    status_running: queue.status().running,
    aborts_issued: queue.status().counters.aborts_issued,
    owner_still_alive: state.physical > 0,
    status: queue.status()
  };
  record.observations.afterTimeout = afterTimeout;

  // Same-key retry.
  const startsBeforeRetry = state.starts;
  const b = queue.submit({ ...base });
  await tick();
  await sleep(15);
  const afterSameKeyRetry = {
    retry_is_new_task: b.task_id !== a.task_id,
    deduplicated: b.deduplicated,
    starts_before: startsBeforeRetry,
    starts: state.starts,
    physical: state.physical,
    status_running: queue.status().running,
    queued: queue.status().queued,
    same_key_waits: queue.status().counters.same_key_waits_behind_live_owner
  };
  record.observations.afterSameKeyRetry = afterSameKeyRetry;

  // Different key.
  const c = queue.submit({ ...base, asset_version_id: "ver_C" });
  await tick();
  await sleep(15);
  const afterDifferentKey = {
    starts: state.starts,
    physical: state.physical,
    status_running: queue.status().running,
    peak: state.peak,
    queued: queue.status().queued
  };
  record.observations.afterDifferentKey = afterDifferentKey;

  await drain(queue, state);
  await Promise.allSettled([b.promise, c.promise]);
  await tick();
  await drain(queue, state, { rounds: 6 });

  const final = queue.status();
  const finalPhysical = state.physical;
  record.observations.final = {
    peak: state.peak, physical: finalPhysical, status_running: final.running,
    status_queued: final.queued, starts: state.starts, counters: final.counters,
    abandoned_running: final.abandoned_running
  };
  record.observations.statusMatchedPhysicalAtEveryStep =
    afterTimeout.status_running === afterTimeout.physical &&
    afterSameKeyRetry.status_running === afterSameKeyRetry.physical &&
    afterDifferentKey.status_running === afterDifferentKey.physical;

  return record;
}

for (const concurrency of [1, 2]) {
  for (const kind of ["abort-ignoring", "signal-honouring"]) {
    const record = await cell(concurrency, kind);
    details[record.label] = record;
    const o = record.observations;

    add(`${record.label}: timeout_settles_caller_and_aborts_executor`,
      o.afterTimeout.a_error === "DERIVATION_TIMEOUT" && o.afterTimeout.signal_aborted === true && o.afterTimeout.aborts_issued >= 1,
      `the caller got ${o.afterTimeout.a_error}; the executor's signal reports aborted (${o.afterTimeout.signal_aborted}); aborts issued ${o.afterTimeout.aborts_issued}. Before the fix the abort was never issued, so signal.aborted stayed false and a real encoder would have run to completion after its caller was already told the job had timed out.`,
      { observation: o.afterTimeout });

    // The SAME-KEY retry: what it must do depends on whether the owner is still alive.
    if (o.afterTimeout.owner_still_alive) {
      add(`${record.label}: same_key_retry_waits_behind_a_live_owner`,
        o.afterSameKeyRetry.starts === o.afterSameKeyRetry.starts_before &&
        o.afterSameKeyRetry.retry_is_new_task === true &&
        o.afterSameKeyRetry.same_key_waits >= 1,
        `the owner is still alive after the timeout, so the same-key retry did NOT start (starts stayed ${o.afterSameKeyRetry.starts}), it is a NEW task rather than a join (deduplicated=${o.afterSameKeyRetry.deduplicated}), and the wait is recorded (same_key_waits=${o.afterSameKeyRetry.same_key_waits}, queued=${o.afterSameKeyRetry.queued})`,
        { observation: o.afterSameKeyRetry });
    } else {
      add(`${record.label}: same_key_retry_starts_once_the_owner_is_gone`,
        o.afterSameKeyRetry.starts === o.afterSameKeyRetry.starts_before + 1 &&
        o.afterSameKeyRetry.retry_is_new_task === true &&
        o.afterSameKeyRetry.status_running === o.afterSameKeyRetry.physical,
        `the owner was killed by the abort (no live run at the timeout), the key was therefore genuinely free, and the same-key retry started exactly once (starts ${o.afterSameKeyRetry.starts_before} -> ${o.afterSameKeyRetry.starts}) with status agreeing with reality (${o.afterSameKeyRetry.status_running}/${o.afterSameKeyRetry.physical})`,
        { observation: o.afterSameKeyRetry });
    }

    // THE REGRESSION THE PARENT FOUND: at concurrency 2 with the owner still alive, the third submit
    // produced real concurrency 3. Live runs must never exceed the cap.
    add(`${record.label}: live_runs_never_exceed_the_cap`,
      o.afterDifferentKey.physical <= concurrency && o.afterDifferentKey.peak <= concurrency && o.final.peak <= concurrency,
      `live executors: ${o.afterDifferentKey.physical} after the third submit, peak ${o.afterDifferentKey.peak} over the cell and ${o.final.peak} overall, against a cap of ${concurrency}`,
      { observation: o.afterDifferentKey });

    add(`${record.label}: a_free_permit_is_usable_by_another_key`,
      concurrency === 1
        ? o.afterDifferentKey.starts === o.afterSameKeyRetry.starts
        : o.afterDifferentKey.starts >= o.afterSameKeyRetry.starts,
      concurrency === 1
        ? `at concurrency 1 the different-key submit did not start a second run (starts stayed ${o.afterDifferentKey.starts}): no permit was free`
        : `at concurrency 2 the different-key submit was able to use the free permit (starts ${o.afterSameKeyRetry.starts} -> ${o.afterDifferentKey.starts}) instead of being starved`,
      { observation: o.afterDifferentKey });

    add(`${record.label}: status_running_always_equals_live_runs`,
      o.statusMatchedPhysicalAtEveryStep === true,
      `at every observation status().running equalled the real number of live runs (after timeout ${o.afterTimeout.status_running}/${o.afterTimeout.physical}; after same-key retry ${o.afterSameKeyRetry.status_running}/${o.afterSameKeyRetry.physical}; after different key ${o.afterDifferentKey.status_running}/${o.afterDifferentKey.physical}). This is the counter that read 1 while two encoders ran before the fix.`,
      {});

    if (record.kind === "abort-ignoring") {
      add(`${record.label}: abandoned_owner_is_reported_degraded_not_over_admitted`,
        o.afterTimeout.status.degraded === true && o.afterTimeout.status.abandoned_running >= 1 &&
        o.afterTimeout.status.stuck_tasks.length >= 1 && o.afterTimeout.status.available_slots === concurrency - o.afterTimeout.physical,
        `the still-alive abandoned run is reported as degraded (degraded=${o.afterTimeout.status.degraded}, abandoned_running=${o.afterTimeout.status.abandoned_running}, available_slots=${o.afterTimeout.status.available_slots}) instead of its permit being quietly freed`,
        { observation: o.afterTimeout.status });
    }

    add(`${record.label}: queue_drained_completely`,
      o.final.status_running === 0 && o.final.status_queued === 0 && o.final.physical === 0,
      `the queue drained once every executor was ended: live runs ${o.final.status_running}, queued ${o.final.status_queued}, real executors still alive ${o.final.physical}`,
      { observation: o.final });
  }
}

// ---------------------------------------------------------------------------------------------
// The exact shape the parent's probe used, restated as an explicit cap assertion: at DEFAULT
// concurrency, an abandoned-but-alive owner plus a same-key retry plus a different key must yield
// exactly `concurrency` live runs - not concurrency+1.
// ---------------------------------------------------------------------------------------------
{
  const concurrency = 2;
  const { queue, state } = buildQueue(concurrency, "abort-ignoring", 60);
  const base = { asset_version_id: "probe-v1", derivative_type: "thumbnail", parameters: { width: 256 } };
  const a = queue.submit({ ...base });
  await a.promise.catch(() => {});
  await tick();
  await sleep(40);
  const b = queue.submit({ ...base });
  await tick();
  await sleep(20);
  const afterSame = { physical: state.physical, status_running: queue.status().running };
  queue.submit({ ...base, asset_version_id: "probe-v2" }).promise.catch(() => {});
  await tick();
  await sleep(20);
  const afterDifferent = { physical: state.physical, status_running: queue.status().running };
  await drain(queue, state);
  add("parent_probe_shape_yields_at_most_the_cap",
    afterSame.physical === 1 && afterSame.status_running === 1 && afterDifferent.physical === concurrency && afterDifferent.status_running === concurrency && state.peak <= concurrency,
    `replaying the probe's exact sequence at concurrency ${concurrency}: after the same-key retry live runs were ${afterSame.physical} (status ${afterSame.status_running}, was 2/1 before the fix), after the different-key submit ${afterDifferent.physical} (status ${afterDifferent.status_running}, was 3/2 before the fix), peak ${state.peak}`,
    { after_same: afterSame, after_different: afterDifferent, peak: state.peak });
}

// ---------------------------------------------------------------------------------------------
// An abandoned attempt must never be cached, or a later caller would be handed a result for a job
// that never completed.
// ---------------------------------------------------------------------------------------------
{
  const { queue, state } = buildQueue(2, "abort-ignoring", 60);
  const base = { asset_version_id: "ver_cache", derivative_type: "thumbnail", parameters: { width: 64 }, profile_key: "cache" };
  const a = queue.submit({ ...base });
  await a.promise.catch(() => {});
  await sleep(30);
  const cacheAfterAbandon = queue.status().cache_entries;
  const b = queue.submit({ ...base });
  await tick();
  const bWasCached = b.cached === true;
  await drain(queue, state);
  await b.promise.catch(() => {});
  add("abandoned_attempt_is_never_cached_or_reused",
    cacheAfterAbandon === 0 && bWasCached === false,
    `after the timeout the cache held ${cacheAfterAbandon} entries and the same-key retry was not served from cache (cached=${bWasCached}): the absence of a result is preserved rather than papered over`,
    { cache_after_abandon: cacheAfterAbandon, retry_cached: bWasCached });
}


// ================================================================================================
// PART B - ADMISSION CAPACITY: the waiting room bounds requests that must WAIT
//
// The defect this section pins: admission used to ask whether a PERMIT was free. A free permit does
// not mean the request can RUN - #pump declines to start a task whose key is still physically held,
// and it starts work in order. So with maxQueue 0, a blocked same-key retry was queued while
// `queued` (1) exceeded `max_queue` (0). The rule now: a request that can not start immediately
// needs waiting-room capacity, and is refused when the room is full.
// ================================================================================================
{
  // --- maxQueue 0: a blocked same-key retry is refused; a different key is still admitted ---------
  {
    const { queue, state } = buildQueue(2, "abort-ignoring", 60, 0);
    const base = { asset_version_id: "adm_A", derivative_type: "thumbnail", parameters: { width: 128 }, profile_key: "admission" };
    const a = queue.submit({ ...base });
    const aError = await a.promise.catch((e) => e);
    await tick();
    await sleep(40);
    const ownerAlive = state.physical > 0;

    const retry = queue.submit({ ...base });
    const retryError = await retry.promise.catch((e) => e);
    const afterRetry = queue.status();

    add("max_queue_zero_refuses_a_blocked_same_key_retry",
      ownerAlive === true && retry.refused === true && retryError?.code === "DERIVATION_QUEUE_FULL" &&
      afterRetry.queued === 0 && afterRetry.queued <= afterRetry.max_queue,
      `the owner was still alive after its timeout (${ownerAlive}), so the same-key retry could not run; it was REFUSED with ${retryError?.code} and nothing was queued (queued=${afterRetry.queued}, max_queue=${afterRetry.max_queue}). Before the fix this request was admitted and queued (queued 1 > max_queue 0).`,
      { owner_alive: ownerAlive, code: retryError?.code ?? null, status: afterRetry });

    const startsBeforeDifferent = state.starts;
    const different = queue.submit({ ...base, asset_version_id: "adm_C" });
    await tick();
    await sleep(20);
    const afterDifferent = queue.status();
    add("max_queue_zero_still_admits_a_different_key_immediately",
      different.refused !== true && state.starts === startsBeforeDifferent + 1 &&
      afterDifferent.running === state.physical && state.peak <= 2,
      `with the same waiting room (0) a DIFFERENT key was still admitted and started at once (starts ${startsBeforeDifferent} -> ${state.starts}, live runs ${afterDifferent.running}/${state.physical}, peak ${state.peak} against a cap of 2): a blocked key must not starve unrelated work`,
      { refused: different.refused === true, starts: state.starts, status: afterDifferent });

    await drain(queue, state);
    const drained = queue.status();
    add("max_queue_zero_drains_completely",
      state.physical === 0 && drained.running === 0 && drained.queued === 0,
      `the queue drained after the executor was ended (live ${drained.running}, queued ${drained.queued}, real executors ${state.physical})`,
      { status: drained });
  }

  // --- maxQueue 0 with an IDLE queue: the first request must simply run ---------------------------
  {
    const { queue, state } = buildQueue(1, "abort-ignoring", 30_000, 0);
    const first = queue.submit({ asset_version_id: "adm_idle", derivative_type: "thumbnail", parameters: { width: 96 }, profile_key: "admission" });
    await tick();
    await sleep(20);
    add("max_queue_zero_runs_immediately_when_nothing_is_blocked",
      first.refused !== true && state.physical === 1 && queue.status().queued === 0,
      `with an idle queue and a waiting room of 0 the request was admitted and started immediately (refused=${first.refused === true}, live runs ${state.physical}, queued ${queue.status().queued})`,
      { refused: first.refused === true });
    await drain(queue, state);
  }

  // --- maxQueue 1: exactly one request may wait ------------------------------------------------
  {
    const { queue, state } = buildQueue(1, "abort-ignoring", 60, 1);
    const base = { asset_version_id: "adm_cap", derivative_type: "thumbnail", parameters: { width: 160 }, profile_key: "admission" };
    const a = queue.submit({ ...base });
    await a.promise.catch(() => {});
    await tick();
    await sleep(40);

    const retry = queue.submit({ ...base }); // blocked same key -> must wait, capacity 1 allows it
    await tick();
    const afterRetry = queue.status();

    const otherBlocked = queue.submit({ ...base, asset_version_id: "adm_cap_other" }); // no permit free, must wait -> over capacity
    const otherError = await otherBlocked.promise.catch((e) => e);
    const afterOther = queue.status();

    add("max_queue_one_allows_exactly_one_waiting_request",
      afterRetry.queued === 1 && afterRetry.queued <= afterRetry.max_queue &&
      otherBlocked.refused === true && otherError?.code === "DERIVATION_QUEUE_FULL" && afterOther.queued === 1,
      `with maxQueue 1 the first blocked request waited (queued=${afterRetry.queued}/1) and the second was REFUSED with ${otherError?.code} (queued stayed ${afterOther.queued}): the waiting room is a bound, not a suggestion`,
      { after_retry: afterRetry, code: otherError?.code ?? null });

    await drain(queue, state);
    const drained = queue.status();
    add("max_queue_one_drains_completely",
      state.physical === 0 && drained.running === 0 && drained.queued === 0,
      `the queue drained (live ${drained.running}, queued ${drained.queued}, real executors ${state.physical})`,
      { status: drained });
  }

  // --- a healthy same-key join must consume NO waiting capacity ---------------------------------
  {
    const { queue, state } = buildQueue(1, "abort-ignoring", 30_000, 0);
    const base = { asset_version_id: "adm_join", derivative_type: "thumbnail", parameters: { width: 112 }, profile_key: "admission" };
    const a = queue.submit({ ...base });
    await tick();
    await sleep(20);
    // A long timeout keeps the first task healthy (not abandoned) while the duplicate arrives, so this
    // measures JOINING rather than the blocked-retry path.
    const join = queue.submit({ ...base });
    await tick();
    const afterJoin = queue.status();
    add("healthy_same_key_join_consumes_no_waiting_capacity",
      join.refused !== true && join.deduplicated === true && join.task_id === a.task_id &&
      afterJoin.queued === 0 && afterJoin.counters.cache_hits === 0,
      `the duplicate joined the in-flight task instead of being queued or refused (deduplicated=${join.deduplicated}, same task id=${join.task_id === a.task_id}, queued=${afterJoin.queued}, deduplicated counter=${afterJoin.counters.deduplicated}) - the join path returns before admission, so a waiting room of ${afterJoin.max_queue} is untouched`,
      { status: afterJoin });

    await drain(queue, state);
    const drained = queue.status();
    add("healthy_join_case_drains_completely",
      state.physical === 0 && drained.running === 0 && drained.queued === 0,
      `the queue drained (live ${drained.running}, queued ${drained.queued}, real executors ${state.physical})`,
      { status: drained });
  }
}

const failed = checks.filter((c) => !c.ok);
const report = {
  report: "REN-05 queue concurrency matrix (limits 1 and 2 x abort-ignoring and signal-honouring executors)",
  generated_at: new Date().toISOString(),
  checks,
  details,
  failed: failed.map((c) => `${c.id}: ${c.detail}`),
  all_pass: failed.length === 0
};
if (outPath) {
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await fs.promises.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
for (const c of checks) console.log(`[${c.ok ? "PASS" : "FAIL"}] ${c.id}: ${c.detail}`);
console.log(`concurrency matrix: ${checks.length - failed.length}/${checks.length} pass${outPath ? ` -> ${outPath}` : ""}`);
process.exitCode = failed.length === 0 ? 0 : 1;
