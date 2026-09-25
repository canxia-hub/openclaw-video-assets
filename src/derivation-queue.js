// REN-05 / src/derivation-queue.js
//
// BOUNDED, CANCELLABLE, DE-DUPLICATING derivation queue.
//
// WHY A QUEUE AT ALL
// ------------------
// Derivation shells out to ffmpeg. That is the one part of this plugin that can saturate the host:
// each job is a real process with real CPU and real disk reads, and the media objects live on a
// network mount. An unbounded "just await it" path lets a burst of requests start an unbounded
// number of encoders.
//
// THE ONE DISTINCTION THIS MODULE IS BUILT AROUND
// -----------------------------------------------
//   SETTLING THE CALLER  - telling the caller "your job timed out / was cancelled". Prompt.
//   RELEASING THE PERMIT - allowing another encoder to start. ONLY when the previous one has
//                          physically ended.
//
// THREE SEPARATE MISTAKES WERE FOUND HERE, EACH BY AN INDEPENDENT PROBE, AND EACH FIX IS STRUCTURAL
// RATHER THAN A PATCH ON THE SYMPTOM:
//
//   (1) A timeout released the slot while the run was still alive, so the next job started on top of
//       a live encoder. Fix: the permit is held until the run function actually settles; a timeout
//       only settles the caller. `#finish` is the ONLY place a permit is released.
//
//   (2) The running set was keyed by the DE-DUPLICATION KEY. When a retry for the same key was
//       admitted while the abandoned original was still running, `running.set(key, retry)`
//       OVERWROTE the original entry: the map held one entry while two encoders ran, so the
//       concurrency limit counted 1 and physical work was 2 - and a third job then pushed physical
//       work past the cap. Fix: physical occupancy is keyed by TASK ID (`running`), the de-duplication
//       key is a SEPARATE index (`keyIndex`), and a task whose key is still physically held is not
//       admitted at all (it waits in the queue). Other keys still use genuinely free slots.
//
//   (3) The timeout path never aborted the executor's AbortController, so `signal.aborted` stayed
//       false and a real ffmpeg child would have kept encoding to completion after its caller was
//       told the job timed out. Fix: settle the caller FIRST, then abort the controller. The order
//       matters - settling first means a run that reacts to the abort by rejecting can not race the
//       settlement.
//
//   (4) Admission asked the wrong question. It checked whether a PERMIT was free, but a free permit
//       does not mean the REQUEST can run: #pump refuses to start a task whose key is still physically
//       held, and it starts work in order. So a request that had to wait was admitted past `maxQueue` -
//       with maxQueue 0 a blocked same-key retry was queued while queued exceeded the waiting room.
//       Fix: admission is decided by "can this request start immediately" - a free permit AND this
//       key is not still held AND nothing admissible is ahead of it in the queue. A healthy same-key
//       join returns before admission and so consumes no waiting capacity; a different key can still
//       start immediately on a genuinely free permit even while another key is blocked.
//
// WHAT THIS GUARANTEES
//   * Physical concurrency never exceeds `concurrency`, for any mix of same-key and different-key
//     submissions, including abandoned-but-still-running work.
//   * `status().running` is the number of LIVE RUNS (physical), so it can not under-report while an
//     abandoned encoder is still alive.
//   * A timeout settles the caller promptly AND aborts the executor.
//   * Cancelling a running job aborts the child process; the permit is released when it ends.
//   * Identical requests share one in-flight job; a completed job is reused. An ABANDONED job is
//     never joined and never cached, and a same-key retry queues behind a still-running owner.
//   * A run that ignores its abort and never ends keeps its permit reserved and is reported as
//     degraded - the queue does NOT free the slot and does NOT start extra work on top of it.
//   * `maxQueue: 0` means "run it if it can start immediately, otherwise refuse" (not "always
//     refuse", and not "queue it anyway"). The waiting room bounds the requests that must WAIT.
//   * A missing source object and an unreachable object store are distinguishable errors.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_QUEUE = 64;
const DEFAULT_TASK_TIMEOUT_MS = 120_000;

export class QueueError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "QueueError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Is the object store actually reachable?
 *
 * The media objects live on a network mount (V: in the reference deployment). A detached mount is
 * NOT the same failure as a missing file, and reporting it as "asset not found" sends an operator
 * looking for the wrong problem. This check distinguishes them.
 */
export async function checkStorageAvailability(root) {
  const objectsDir = path.join(root, "asset-repo", "objects", "sha256");
  try {
    const stat = await fs.promises.stat(objectsDir);
    if (!stat.isDirectory()) return { ok: false, code: "STORAGE_OBJECTS_NOT_A_DIRECTORY", objects_dir: objectsDir };
  } catch (error) {
    return { ok: false, code: "STORAGE_OBJECTS_UNREACHABLE", objects_dir: objectsDir, reason: error?.code ?? String(error?.message ?? error) };
  }
  try {
    // A mount can be visible but unreadable; the read is what actually proves it answers.
    const shards = await fs.promises.readdir(objectsDir);
    const probe = await fs.promises.stat(path.join(root, "asset-repo", "objects"));
    if (!probe.isDirectory()) return { ok: false, code: "STORAGE_OBJECTS_NOT_A_DIRECTORY", objects_dir: objectsDir };
    return { ok: true, shard_count: shards.length };
  } catch (error) {
    return { ok: false, code: "STORAGE_OBJECTS_UNREADABLE", objects_dir: objectsDir, reason: error?.code ?? String(error?.message ?? error) };
  }
}

/** Expected on-disk location of a version's object, derived from its object_id. */
export function objectPathForVersion(root, objectId) {
  const match = /^sha256:([a-f0-9]{64})$/.exec(String(objectId ?? ""));
  if (!match) return null;
  return path.join(root, "asset-repo", "objects", "sha256", match[1].slice(0, 2), `${match[1]}.blob`);
}

/** The de-duplication identity of a request: same inputs, same job. */
function stableKey({ asset_version_id, derivative_type, profile_key, parameters }) {
  const normalized = Object.keys(parameters ?? {}).sort().map((k) => `${k}=${parameters[k]}`).join("&");
  return crypto.createHash("sha256").update(`${asset_version_id}|${derivative_type}|${profile_key}|${normalized}`).digest("hex").slice(0, 32);
}

export class DerivationQueue {
  /**
   * @param {object} options
   * @param {object} options.service       the VideoAssetService that runs the derivation
   * @param {number} [options.concurrency] how many ffmpeg jobs may run at once
   * @param {number} [options.maxQueue]    how many may WAIT before new work is refused (0 = none)
   * @param {number} [options.taskTimeoutMs]
   * @param {number} [options.stuckGraceMs] how long after abandonment, with no physical end, a held
   *                                       permit is reported as stuck/degraded (default: taskTimeoutMs)
   * @param {(entry: object) => Promise<object>} [options.run] override for tests
   */
  constructor({ service, concurrency = DEFAULT_CONCURRENCY, maxQueue = DEFAULT_MAX_QUEUE, taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS, stuckGraceMs = null, run = null } = {}) {
    this.service = service;
    this.concurrency = Math.max(1, Math.trunc(concurrency));
    this.maxQueue = Math.max(0, Math.trunc(maxQueue));
    this.taskTimeoutMs = taskTimeoutMs;
    this.stuckGraceMs = Number.isFinite(stuckGraceMs) ? stuckGraceMs : taskTimeoutMs;
    this.run = run ?? ((entry) => service.performDerivation(entry));
    this.waiting = [];
    /**
     * PHYSICAL occupancy, keyed by TASK ID.
     *
     * This map is the single source of truth for concurrency. It is keyed by task id - never by the
     * de-duplication key - because keying by key allowed a retry to overwrite a still-running
     * original: the map then held one entry while two encoders ran, and the concurrency limit was
     * bypassed. An entry stays here until the run function physically settles.
     */
    this.running = new Map();
    /** Which keys are physically held, and by which tasks. Separate from `running` on purpose. */
    this.keyIndex = new Map();
    this.completed = new Map();
    this.counters = {
      submitted: 0, started: 0, succeeded: 0, failed: 0, cancelled: 0, refused: 0,
      deduplicated: 0, cache_hits: 0, abandoned: 0, discarded_late_results: 0, settled_after_abandon: 0,
      ownership_guard_hits: 0, same_key_waits_behind_live_owner: 0, aborts_issued: 0, refused_needing_waiting_room: 0
    };
  }

  /** Live runs (physical). Includes runs whose caller has already been settled. */
  get physicalInFlight() {
    return this.running.size;
  }

  /** Runs whose caller already failed but which are still physically alive. */
  get abandonedInFlight() {
    return [...this.running.values()].filter((task) => task.abandoned === true).length;
  }

  /** The tasks currently holding a given de-duplication key, physically. */
  #liveKeyTasks(key) {
    const ids = this.keyIndex.get(key);
    if (!ids || ids.size === 0) return [];
    const tasks = [];
    for (const taskId of ids) {
      const task = this.running.get(taskId);
      if (task) tasks.push(task);
    }
    return tasks;
  }

  /** Is this key physically held by an unfinished run? If so a same-key job must NOT start. */
  #keyPhysicallyBusy(key) {
    const ids = this.keyIndex.get(key);
    return Boolean(ids && ids.size > 0);
  }

  status() {
    const now = Date.now();
    const abandoned = [...this.running.values()].filter((task) => task.abandoned === true);
    const stuck = abandoned.filter((task) => now - (task.abandonedAt ?? now) >= this.stuckGraceMs);
    return {
      concurrency: this.concurrency,
      max_queue: this.maxQueue,
      queued: this.waiting.length,
      // LIVE RUNS (physical). Not "callers awaiting an answer": a caller can be settled while its run
      // is still alive, and this number must keep counting that run.
      running: this.running.size,
      keys_in_flight: this.keyIndex.size,
      callers_waiting: this.waiting.length + [...this.running.values()].filter((t) => t.settled !== true).length,
      abandoned_running: abandoned.length,
      available_slots: Math.max(0, this.concurrency - this.running.size),
      cache_entries: this.completed.size,
      degraded: stuck.length > 0,
      degraded_reason: stuck.length > 0
        ? `${stuck.length} abandoned derivation(s) have not physically ended within ${this.stuckGraceMs}ms; their permits stay reserved so no extra encoder can start`
        : null,
      stuck_tasks: stuck.map((task) => ({ task_id: task.task_id, abandoned_for_ms: now - (task.abandonedAt ?? now), reason: task.abandon_reason ?? null })),
      counters: { ...this.counters }
    };
  }

  /**
   * Submit a derivation request.
   *
   * Returns `{ task_id, promise, deduplicated, cached }`. The promise rejects with a QueueError or the
   * underlying DerivationError; it never hangs past the task timeout.
   */
  submit(entry) {
    const key = stableKey(entry);

    const cached = this.completed.get(key);
    if (cached) {
      this.counters.cache_hits += 1;
      return { task_id: cached.task_id, key, promise: Promise.resolve(cached.result), deduplicated: true, cached: true };
    }

    // An ABANDONED, CANCELLED or already-SETTLED task must not be joined: its result is going to be
    // discarded, so a new caller would wait for an answer that can never be committed.
    const joinable = (task) => task.abandoned !== true && task.cancelled !== true && task.settled !== true;
    const queuedSameKey = this.waiting.find((task) => task.key === key && joinable(task));
    const liveSameKey = this.#liveKeyTasks(key).find(joinable);
    const existing = queuedSameKey ?? liveSameKey ?? null;
    if (existing) {
      this.counters.deduplicated += 1;
      return { task_id: existing.task_id, key, promise: existing.promise, deduplicated: true, cached: false };
    }

    // If the key is held by a run that can no longer be joined, this request must WAIT for it rather
    // than start a second encoder for the same key. Recorded so the situation is observable.
    if (this.#keyPhysicallyBusy(key)) this.counters.same_key_waits_behind_live_owner += 1;

    // Admission: a free permit is used immediately, whether or not there is waiting-room capacity.
    // `maxQueue: 0` therefore means "run it if a permit is free, otherwise refuse".
    // ADMISSION IS ABOUT THIS REQUEST, NOT ABOUT THE QUEUE'S PERMITS ALONE.
    //
    // A free permit does not mean THIS request can start now: #pump will refuse to start a task whose
    // de-duplication key is still physically held, and it also starts work in order. So "a permit is
    // free" is not the same question as "this request runs immediately", and using the permit alone
    // let a request that had to WAIT be admitted past `maxQueue` - with maxQueue 0, a blocked same-key
    // retry was queued (queued 1 > max_queue 0) even though it could not run.
    //
    // The consequence that matters: a small or zero waiting room no longer silently holds work that
    // is merely parked. Requests that genuinely can not run yet are counted against the waiting room
    // and refused when it is full;
    //   * a healthy join for the same key never reaches here (the join returns above), so it consumes
    //     no waiting capacity at all;
    //   * a different key CAN start immediately when a permit is free and nothing admissible is ahead
    //     of it, so it is still admitted rather than being refused merely because a blocked key exists.
    const freePermit = this.running.size < this.concurrency;
    const keyBusy = this.#keyPhysicallyBusy(key);
    const admissibleAhead = this.waiting.some((task) => !(task.settled || task.cancelled || task.abandoned) && !this.#keyPhysicallyBusy(task.key));
    const canStartImmediately = freePermit && !keyBusy && !admissibleAhead;

    if (!canStartImmediately && this.waiting.length >= this.maxQueue) {
      this.counters.refused += 1;
      this.counters.refused_needing_waiting_room += 1;
      const error = new QueueError("DERIVATION_QUEUE_FULL", `the derivation queue is full (${this.waiting.length}/${this.maxQueue} waiting, ${this.running.size}/${this.concurrency} running${keyBusy ? ", this key is still held by a live run" : ""})`, {
        queued: this.waiting.length,
        max_queue: this.maxQueue,
        running: this.running.size,
        concurrency: this.concurrency,
        abandoned_running: this.abandonedInFlight,
        key_physically_busy: keyBusy,
        can_start_immediately: false
      });
      return { task_id: null, key, promise: Promise.reject(error), deduplicated: false, cached: false, refused: true };
    }

    const task_id = `dtask_${crypto.randomUUID()}`;
    const task = {
      task_id, key, entry,
      promise: null,
      controller: new AbortController(),
      settled: false, cancelled: false, abandoned: false,
      state: canStartImmediately ? "dispatching" : "queued",
      submittedAt: Date.now(), startedAt: null, endedAt: null, abandonedAt: null, abandon_reason: null, timer: null
    };
    // The run function receives a lifecycle handle: it can see whether its work has been abandoned
    // and must check `lifecycle.checkpoint()` before committing anything. This is what stops a late
    // run from registering a derivation after its caller was already told the job failed.
    task.lifecycle = {
      task_id,
      signal: task.controller.signal,
      isAbandoned: () => task.abandoned === true,
      isCancelled: () => task.cancelled === true,
      status: () => task.state,
      abandonReason: () => task.abandon_reason,
      checkpoint: () => {
        if (task.abandoned || task.cancelled) {
          throw new QueueError(
            "DERIVATION_ABANDONED",
            `this derivation was ${task.cancelled ? "cancelled" : "abandoned"} (${task.abandon_reason ?? "unknown"}) and must not be committed`,
            { task_id, reason: task.abandon_reason ?? null }
          );
        }
      }
    };
    task.promise = new Promise((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
    });
    task.promise.catch(() => {}); // a caller that ignores the promise must not crash the process

    this.counters.submitted += 1;
    this.waiting.push(task);
    this.#pump();
    return { task_id, key, promise: task.promise, deduplicated: false, cached: false };
  }

  /**
   * Cancel a task.
   *
   * A queued task is removed before the encoder ever starts. A running task is settled for the caller
   * and then aborted, so a signal-honouring executor (the real ffmpeg child) is actually killed. The
   * PERMIT is not released here: it is released when the run physically ends, so nothing can start
   * beside an encoder that may still be alive.
   */
  cancel(task_id) {
    const index = this.waiting.findIndex((task) => task.task_id === task_id);
    if (index >= 0) {
      const [task] = this.waiting.splice(index, 1);
      task.settled = true;
      task.cancelled = true;
      task.state = "cancelled";
      this.counters.cancelled += 1;
      task.reject(new QueueError("DERIVATION_CANCELLED", "the derivation was cancelled while queued", { task_id }));
      return true;
    }
    const running = this.running.get(task_id);
    if (running) {
      // Settle the caller FIRST, then abort: a run that reacts to the abort by rejecting can not then
      // race the settlement.
      if (!running.settled) {
        running.cancelled = true;
        running.settled = true;
        running.abandoned = true;
        running.abandonedAt = Date.now();
        running.abandon_reason = "cancelled";
        running.state = "cancelled";
        this.counters.cancelled += 1;
        this.counters.abandoned += 1;
        running.reject(new QueueError("DERIVATION_CANCELLED", "the derivation was cancelled", { task_id }));
      }
      running.controller.abort();
      this.counters.aborts_issued += 1;
      return true;
    }
    return false;
  }

  /** Wait until no permit is held and nothing is queued. Used by tests to make completion deterministic. */
  async waitForIdle({ timeoutMs = 300_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (this.waiting.length > 0 || this.running.size > 0) {
      if (Date.now() > deadline) throw new QueueError("DERIVATION_QUEUE_TIMEOUT", "queue did not drain in time", this.status());
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  clearCache() {
    this.completed.clear();
  }

  /**
   * Admit work up to the concurrency limit.
   *
   * A task is admissible when a permit is free AND no unfinished run holds its de-duplication key -
   * starting a second encoder for one key would duplicate the work AND (with keyed occupancy) hide
   * the original from the concurrency count. Blocked tasks stay in the queue, IN ORDER, so a
   * same-key retry waits behind its live owner while other keys keep using genuinely free slots.
   *
   * The scan is bounded: each pass either starts a task, drops a dead entry, or changes nothing. When
   * a pass changes nothing the loop stops, so a blocked queue can never spin.
   */
  #pump() {
    while (this.running.size < this.concurrency) {
      let admitted = false;
      for (let index = 0; index < this.waiting.length; index += 1) {
        const task = this.waiting[index];
        if (task.settled || task.cancelled || task.abandoned) {
          this.waiting.splice(index, 1);
          index -= 1;
          continue;
        }
        if (this.#keyPhysicallyBusy(task.key)) continue; // wait behind the live owner of this key
        this.waiting.splice(index, 1);
        this.#start(task);
        admitted = true;
        break;
      }
      // Nothing admissible on this pass: stop rather than spin.
      if (!admitted) return;
    }
  }

  /** Put a task into physical occupancy. The ONLY place a permit is taken. */
  #start(task) {
    task.state = "running";
    task.startedAt = Date.now();
    this.running.set(task.task_id, task);
    if (!this.keyIndex.has(task.key)) this.keyIndex.set(task.key, new Set());
    this.keyIndex.get(task.key).add(task.task_id);
    this.counters.started += 1;
    this.#armTimeout(task);
    this.#execute(task);
  }

  #armTimeout(task) {
    task.timer = setTimeout(() => {
      if (task.settled) return;
      // 1) Settle the CALLER now: that is what a timeout means to whoever is waiting.
      task.settled = true;
      task.abandoned = true;
      task.abandonedAt = Date.now();
      task.abandon_reason = "task-timeout";
      task.state = "timed_out";
      this.counters.failed += 1;
      this.counters.abandoned += 1;
      task.reject(new QueueError("DERIVATION_TIMEOUT", `the derivation exceeded the ${this.taskTimeoutMs}ms task timeout`, { task_id: task.task_id }));
      // 2) THEN abort the executor. The abort is what actually kills a real ffmpeg child; omitting it
      //    left `signal.aborted === false`, so an encoder would have run to completion after its
      //    caller was already told the job had timed out.
      task.controller.abort();
      this.counters.aborts_issued += 1;
      // 3) The PERMIT stays reserved until the run physically ends (#finish). #pump() may still admit
      //    other keys onto genuinely free permits, but never this key while it is still held.
      this.#pump();
    }, this.taskTimeoutMs);
  }

  async #execute(task) {
    let outcome;
    try {
      outcome = { kind: "resolved", result: await this.run({ ...task.entry, signal: task.controller.signal, lifecycle: task.lifecycle }) };
    } catch (error) {
      outcome = { kind: "rejected", error };
    }
    this.#finish(task, outcome);
  }

  /**
   * The physical end of a task. The ONLY place a permit is released.
   *
   * Removal is by TASK ID with an identity check, so a late finisher can never disturb a newer task
   * that happens to share its de-duplication key.
   */
  #finish(task, outcome) {
    clearTimeout(task.timer);
    task.timer = null;
    task.endedAt = Date.now();

    if (this.running.get(task.task_id) === task) {
      this.running.delete(task.task_id);
      const ids = this.keyIndex.get(task.key);
      if (ids) {
        ids.delete(task.task_id);
        if (ids.size === 0) this.keyIndex.delete(task.key);
      }
    } else {
      // Should be unreachable now that occupancy is keyed by task id; kept as a tripwire so a future
      // regression in this invariant is VISIBLE instead of silently miscounting concurrency.
      this.counters.ownership_guard_hits += 1;
    }

    if (!task.settled) {
      // The normal path: the run finished before any timeout or cancel.
      task.settled = true;
      if (outcome.kind === "resolved") {
        task.state = "succeeded";
        this.counters.succeeded += 1;
        this.completed.set(task.key, { task_id: task.task_id, result: outcome.result });
        task.resolve(outcome.result);
      } else {
        task.state = task.cancelled ? "cancelled" : "failed";
        if (!task.cancelled) this.counters.failed += 1;
        task.reject(outcome.error);
      }
    } else {
      // LATE completion of an abandoned task. The caller already has its error, so the result is
      // DISCARDED: it must not enter the cache, and the run function was required to refuse to commit
      // anything (lifecycle.checkpoint). Counting it keeps the discarded work visible.
      task.discarded = true;
      this.counters.settled_after_abandon += 1;
      if (outcome.kind === "resolved") this.counters.discarded_late_results += 1;
    }

    this.#pump();
  }
}
