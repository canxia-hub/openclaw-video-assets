/**
 * REN-06: transfer gate - how many uploads may be WRITING at once.
 *
 * Why this exists
 * ---------------
 * The audit measured eight simultaneous uploads against an unbounded path: every one of them started
 * writing immediately, so the peak memory and disk pressure came from the burst rather than from any
 * single file. The requirement is that only a configured number (initially 2) are being processed and
 * the rest either wait in a bounded queue or are refused in a way the client can act on.
 *
 * Why it is not the same as a "semaphore" wrapper
 * ----------------------------------------------
 * Three distinctions matter and are easy to get wrong, so they are explicit here:
 *
 *   1. WAITING vs RUNNING. A request that is waiting must not hold a permit, otherwise the cap counts
 *      requests that are doing nothing and the real concurrency is lower than configured.
 *   2. REFUSAL vs WAITING. The waiting room is bounded. When it is full the request is refused with a
 *      code, rather than being accepted into an unbounded backlog that would eventually consume
 *      memory for every pending session.
 *   3. RELEASE ON PHYSICAL END. A permit is released when the transfer actually finishes - including
 *      when it fails or is cancelled - not when the caller's promise settles. A cancelled upload that
 *      is still flushing to disk must not have its permit handed to the next request.
 *
 * The implementation is deliberately small: a counter, a FIFO of waiters, and one release point.
 */

export class TransferGateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "TransferGateError";
    this.code = code;
    this.status = code === "UPLOAD_QUEUE_FULL" ? 429 : 503;
    this.details = details;
  }
}

export class TransferGate {
  /**
   * @param {object} options
   * @param {number} options.concurrency how many transfers may be active at once
   * @param {number} options.maxQueue    how many may wait before new transfers are refused
   */
  constructor({ concurrency = 2, maxQueue = 8 } = {}) {
    this.concurrency = Math.max(1, Math.trunc(concurrency));
    this.maxQueue = Math.max(0, Math.trunc(maxQueue));
    this.active = 0;
    this.waiting = [];
    this.peakActive = 0;
    this.counters = { accepted: 0, started: 0, completed: 0, failed: 0, refused: 0, waited: 0, cancelled_while_waiting: 0 };
    /** Every acquisition, for the acceptance evidence: when it started and when it was released. */
    this.history = [];
  }

  status() {
    return {
      concurrency: this.concurrency,
      max_queue: this.maxQueue,
      active: this.active,
      queued: this.waiting.length,
      peak_active: this.peakActive,
      available: Math.max(0, this.concurrency - this.active),
      counters: { ...this.counters }
    };
  }

  /**
   * Acquire a permit, waiting in the bounded queue if necessary.
   *
   * Resolves with a release function. The caller MUST call it exactly once, when the physical work
   * ends (including on failure), and must call it even if its own promise has already been rejected.
   */
  async acquire({ label = null } = {}) {
    this.counters.accepted += 1;

    if (this.active < this.concurrency) {
      this.#start({ label });
      return this.#releaser();
    }

    if (this.waiting.length >= this.maxQueue) {
      this.counters.refused += 1;
      throw new TransferGateError(
        "UPLOAD_QUEUE_FULL",
        `the upload queue is full (${this.waiting.length}/${this.maxQueue} waiting, ${this.active}/${this.concurrency} active)`,
        { queued: this.waiting.length, max_queue: this.maxQueue, active: this.active, concurrency: this.concurrency }
      );
    }

    this.counters.waited += 1;
    const index = this.history.length;
    this.history.push({ label, state: "waiting", queued_at: Date.now() });
    await new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject, label, index, cancelled: false });
    });
    return this.#releaser();
  }

  /**
   * Cancel a transfer that is still WAITING (not one that is running - a running transfer is stopped by
   * ending its own request).
   *
   * The waiter is removed from the queue at this moment, not when the next release happens to pump: leaving
   * it there would both over-report `queued` and keep the waiting room full, so a new request could be
   * refused for space that is actually free. The `cancelled` flag is still set, because #pump may already
   * have shifted this entry out in the window between the lookup and the splice.
   */
  cancelWaiting(token) {
    if (!token) return false;
    const index = this.waiting.findIndex((waiter) => waiter.label === token);
    if (index < 0) return false;
    const [entry] = this.waiting.splice(index, 1);
    entry.cancelled = true;
    this.counters.cancelled_while_waiting += 1;
    entry.reject(new TransferGateError("UPLOAD_CANCELLED", "the upload was cancelled while waiting for a transfer slot", { label: token }));
    return true;
  }

  #start({ label }) {
    this.active += 1;
    this.peakActive = Math.max(this.peakActive, this.active);
    this.counters.started += 1;
    this.history.push({ label, state: "active", started_at: Date.now() });
  }

  #releaser() {
    let released = false;
    return (outcome = "completed") => {
      if (released) return; // double release must not inflate the next slot
      released = true;
      this.active -= 1;
      if (outcome === "completed") this.counters.completed += 1;
      else this.counters.failed += 1;
      const record = [...this.history].reverse().find((entry) => entry.label !== null && entry.label !== undefined && entry.state === "active" && entry.released_at === undefined);
      if (record) {
        record.state = outcome === "completed" ? "released" : `released:${outcome}`;
        record.released_at = Date.now();
      }
      this.#pump();
    };
  }

  /** Admit the next waiter, in order. One per free permit; a cancelled waiter is skipped. */
  #pump() {
    while (this.active < this.concurrency && this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      if (waiter.cancelled) continue; // already rejected; do not consume the permit
      this.#start({ label: waiter.label });
      waiter.resolve();
    }
  }
}
