/**
 * The render queue — one GPU device, two priorities, and a way to abandon work.
 *
 * ## The problem it replaces
 *
 * `DocumentRenderer` holds one node cache, one surface pool and one GPU
 * backend, and none of it is re-entrant. It has two callers — the session's
 * render pump and export — and until now they were kept apart by a promise
 * chain inside `ui/export/session.ts` that could only serialise export against
 * *itself*, plus a comment admitting the real fix belonged in one queue both
 * callers go through. This is that queue.
 *
 * Serialising is not the interesting part; two renders cannot share one device
 * and one cache, so exactly one runs at a time by physics. What matters is what
 * happens to the *others*, and there are three rules:
 *
 * - **A preview is superseded by a newer preview.** A parameter drag emits a
 *   render per pointer move. Queueing them would put the user behind their own
 *   input: every frame they see would be one they asked for several moves ago.
 *   So at most one preview waits, the newest, and an older one waiting is
 *   rejected the moment a newer arrives. A preview already *running* is
 *   aborted, so the work stops rather than merely stopping being reported.
 * - **An export preempts a preview.** Export is a file somebody asked for and
 *   must not wait behind a preview that will itself be superseded in 16 ms —
 *   "preview must not block export". The running preview is aborted and
 *   *re-queued*, so the caller waiting on it still gets a frame; it simply gets
 *   it after the export. That is why a preempted preview is not an error
 *   anybody has to handle, and it is the other half of "export must not degrade
 *   preview": the displaced preview is re-run rather than dropped, so the
 *   screen ends up where the viewport asked for it to be.
 * - **An export is never superseded and never preempted.** It runs to
 *   completion or it is cancelled explicitly, and exports run in arrival order,
 *   which is what makes two of them produce two files rather than one twice.
 *
 * ## No re-entrancy, by construction
 *
 * `#runNext` is called from exactly two places — `submit`, when nothing is
 * running, and the settle handler — and both check `#running` first. The
 * renderer therefore cannot be entered twice; it also asserts that for itself,
 * so a future caller that bypasses the queue fails loudly rather than
 * corrupting a cache.
 *
 * Deliberately free of any browser, GPU or WASM dependency: a job is a function
 * taking an `AbortSignal`, so the whole policy above is unit-tested without a
 * device.
 */

import type { RenderLane } from "./protocol";
import { RenderAbandoned } from "./protocol";

export interface QueueJob<T> {
  /** The call id, so an explicit cancel can name it. */
  readonly id: number;
  readonly lane: RenderLane;
  /**
   * The work. Must observe `signal` — the queue aborts it and moves on, and a
   * job that ignores the signal keeps the device busy while the next one waits.
   */
  readonly run: (signal: AbortSignal) => Promise<T>;
}

/**
 * A queued job with its promise's two ends.
 *
 * The result type is erased to `unknown` here and restored by the cast in
 * `submit`, which is the one place that knows it. The alternative — making the
 * whole queue generic — would force every lane to carry the same result type,
 * and a render result and a trace result are not the same thing.
 */
interface Entry {
  readonly id: number;
  readonly lane: RenderLane;
  readonly run: (signal: AbortSignal) => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  controller: AbortController;
  /**
   * Set when an export took the device from this preview.
   *
   * A flag rather than an inference from the queue's shape, because an explicit
   * `cancel` and a preemption both abort with the same code, and telling them
   * apart by "is an export waiting?" would silently re-queue a render somebody
   * asked to stop if an export happened to arrive in the same tick.
   */
  preempted: boolean;
}

/** How a job ended, for the queue's own log line. */
export type QueueOutcome = "ok" | "abandoned" | "failed";

/** What the queue is doing. Read by the log and by the tests. */
export interface QueueState {
  readonly running: number | null;
  readonly runningLane: RenderLane | null;
  readonly pendingPreview: number | null;
  readonly pendingExports: readonly number[];
}

export type QueueListener = (
  lane: RenderLane,
  outcome: QueueOutcome,
  state: QueueState,
) => void;

export class RenderQueue {
  #running: Entry | null = null;
  #pendingPreview: Entry | null = null;
  readonly #pendingExports: Entry[] = [];
  readonly #onSettled: QueueListener | undefined;

  constructor(onSettled?: QueueListener) {
    this.#onSettled = onSettled;
  }

  get state(): QueueState {
    return {
      running: this.#running?.id ?? null,
      runningLane: this.#running?.lane ?? null,
      pendingPreview: this.#pendingPreview?.id ?? null,
      pendingExports: this.#pendingExports.map((entry) => entry.id),
    };
  }

  submit<T>(job: QueueJob<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = {
        id: job.id,
        lane: job.lane,
        run: job.run,
        resolve: resolve as (value: unknown) => void,
        reject,
        controller: new AbortController(),
        preempted: false,
      };

      if (job.lane === "preview") this.#admitPreview(entry);
      else this.#admitExport(entry);

      this.#runNext();
    });
  }

  /**
   * Abandon a call by id, wherever it is.
   *
   * Returns whether anything was found, so a cancel that arrives after the
   * thing it names has already finished — ordinary, not an error — is still
   * visible in the log.
   */
  cancel(id: number): boolean {
    if (this.#running?.id === id) {
      // An explicit cancel outranks a preemption that has already been marked
      // in the same tick: somebody asked for this render to stop, and re-running
      // it after the export would be doing the thing they cancelled.
      this.#running.preempted = false;
      this.#running.controller.abort(
        new RenderAbandoned("cancelled", `render ${id} was cancelled`),
      );
      return true;
    }
    if (this.#pendingPreview?.id === id) {
      const entry = this.#pendingPreview;
      this.#pendingPreview = null;
      entry.reject(new RenderAbandoned("cancelled", `render ${id} was cancelled`));
      return true;
    }
    const index = this.#pendingExports.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    const [entry] = this.#pendingExports.splice(index, 1);
    entry?.reject(new RenderAbandoned("cancelled", `export render ${id} was cancelled`));
    return true;
  }

  /** Abandon everything. Used on dispose, so no promise is left unsettled. */
  clear(reason: string): void {
    const pending = this.#pendingPreview;
    this.#pendingPreview = null;
    pending?.reject(new RenderAbandoned("cancelled", reason));

    while (this.#pendingExports.length > 0) {
      this.#pendingExports.shift()?.reject(new RenderAbandoned("cancelled", reason));
    }
    this.#running?.controller.abort(new RenderAbandoned("cancelled", reason));
  }

  // --- admission --------------------------------------------------------

  #admitPreview(entry: Entry): void {
    const displaced = this.#pendingPreview;
    this.#pendingPreview = entry;
    // Whatever was waiting is older than this by construction — nothing else
    // writes this slot — so it is rejected rather than run. Its caller is the
    // session, which drops a supersession without touching the screen.
    displaced?.reject(
      new RenderAbandoned(
        "superseded",
        `preview render ${displaced.id} was superseded by ${entry.id} before it started`,
      ),
    );

    const running = this.#running;
    if (running !== null && running.lane === "preview") {
      running.controller.abort(
        new RenderAbandoned(
          "superseded",
          `preview render ${running.id} was superseded by ${entry.id} mid-render`,
        ),
      );
    }
  }

  #admitExport(entry: Entry): void {
    this.#pendingExports.push(entry);
    const running = this.#running;
    if (running === null || running.lane !== "preview") return;
    // Preempted. The abort is what frees the device; the promise stays alive
    // and the job goes back into the preview slot when it unwinds.
    running.preempted = true;
    running.controller.abort(
      new RenderAbandoned(
        "cancelled",
        `preview render ${running.id} was preempted by export render ${entry.id}`,
      ),
    );
  }

  // --- execution --------------------------------------------------------

  #runNext(): void {
    if (this.#running !== null) return;
    const next = this.#pendingExports.shift() ?? this.#takePendingPreview();
    if (next === null) return;

    this.#running = next;
    void next.run(next.controller.signal).then(
      (value) => {
        this.#settle(next, "ok", () => next.resolve(value));
      },
      (error: unknown) => {
        if (this.#preempted(next, error)) {
          this.#settle(next, "abandoned", () => this.#requeuePreview(next));
          return;
        }
        const abandoned = error instanceof RenderAbandoned;
        this.#settle(next, abandoned ? "abandoned" : "failed", () => next.reject(error));
      },
    );
  }

  #takePendingPreview(): Entry | null {
    const entry = this.#pendingPreview;
    this.#pendingPreview = null;
    return entry;
  }

  /** Whether this abort was an export taking the device, rather than a cancel. */
  #preempted(entry: Entry, error: unknown): boolean {
    return entry.preempted && error instanceof RenderAbandoned;
  }

  #requeuePreview(entry: Entry): void {
    entry.preempted = false;
    const newer = this.#pendingPreview;
    if (newer !== null) {
      // Something more recent is already waiting; this one is stale after all.
      entry.reject(
        new RenderAbandoned(
          "superseded",
          `preempted preview render ${entry.id} was superseded by ${newer.id}`,
        ),
      );
      return;
    }
    // A fresh controller: the old one is aborted for good and reusing it would
    // make the requeued job finish instantly on its next signal check.
    entry.controller = new AbortController();
    this.#pendingPreview = entry;
  }

  #settle(entry: Entry, outcome: QueueOutcome, deliver: () => void): void {
    if (this.#running === entry) this.#running = null;
    deliver();
    this.#onSettled?.(entry.lane, outcome, this.state);
    this.#runNext();
  }
}
