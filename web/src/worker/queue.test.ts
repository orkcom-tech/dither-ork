/**
 * The render queue's policy, pinned.
 *
 * Every case here is one a user can produce in a second of dragging, and every
 * one of them used to end differently: renders queued behind each other so the
 * picture lagged the pointer, and an export that had to wait for a preview
 * frame nobody would ever see.
 */

import { describe, expect, it } from "vitest";

import { RenderAbandoned } from "./protocol";
import { RenderQueue } from "./queue";

/** A job that finishes when told, and records whether it was aborted. */
function deferred(): {
  readonly run: (signal: AbortSignal) => Promise<string>;
  finish: (value: string) => void;
  readonly started: () => boolean;
  readonly aborted: () => boolean;
} {
  let resolve: ((value: string) => void) | null = null;
  let start = false;
  let abortedWith: unknown = null;

  return {
    run: (signal: AbortSignal) => {
      start = true;
      return new Promise<string>((res, rej) => {
        resolve = res;
        signal.addEventListener("abort", () => {
          abortedWith = signal.reason;
          rej(signal.reason);
        });
      });
    },
    finish: (value: string) => resolve?.(value),
    started: () => start,
    aborted: () => abortedWith !== null,
  };
}

/** Let the microtask queue drain, which is where every settle happens. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => ({ ok: value }),
    (error: unknown) => ({ error }),
  );
}

describe("one job at a time", () => {
  it("runs the first submission immediately", async () => {
    const queue = new RenderQueue();
    const job = deferred();
    const promise = queue.submit({ id: 1, lane: "preview", run: job.run });
    expect(job.started()).toBe(true);
    expect(queue.state.running).toBe(1);
    job.finish("frame");
    await expect(promise).resolves.toBe("frame");
  });

  it("does not start a second job while one is running", async () => {
    const queue = new RenderQueue();
    const first = deferred();
    const second = deferred();
    void caught(queue.submit({ id: 1, lane: "export", run: first.run }));
    void caught(queue.submit({ id: 2, lane: "export", run: second.run }));

    // The renderer holds one node cache and one surface pool; two overlapping
    // renders would interleave pins with each other's evictions.
    expect(second.started()).toBe(false);
    first.finish("a");
    await settle();
    expect(second.started()).toBe(true);
  });
});

describe("a preview is superseded by a newer preview", () => {
  it("aborts the running preview and rejects it", async () => {
    const queue = new RenderQueue();
    const stale = deferred();
    const outcome = caught(queue.submit({ id: 1, lane: "preview", run: stale.run }));

    const fresh = deferred();
    void caught(queue.submit({ id: 2, lane: "preview", run: fresh.run }));

    // The abort is the whole point: the stale render stops at its next node
    // rather than finishing a picture nobody will see.
    expect(stale.aborted()).toBe(true);
    const result = (await outcome) as { error: unknown };
    expect(result.error).toBeInstanceOf(RenderAbandoned);
    expect((result.error as RenderAbandoned).code).toBe("superseded");
  });

  it("keeps only the newest of several waiting previews", async () => {
    const queue = new RenderQueue();
    const running = deferred();
    void caught(queue.submit({ id: 1, lane: "export", run: running.run }));

    const a = deferred();
    const b = deferred();
    const c = deferred();
    const first = caught(queue.submit({ id: 2, lane: "preview", run: a.run }));
    const second = caught(queue.submit({ id: 3, lane: "preview", run: b.run }));
    const third = queue.submit({ id: 4, lane: "preview", run: c.run });

    expect(queue.state.pendingPreview).toBe(4);
    expect(((await first) as { error: RenderAbandoned }).error.code).toBe("superseded");
    expect(((await second) as { error: RenderAbandoned }).error.code).toBe("superseded");

    running.finish("export");
    await settle();
    expect(c.started()).toBe(true);
    expect(a.started()).toBe(false);
    expect(b.started()).toBe(false);
    c.finish("newest");
    await expect(third).resolves.toBe("newest");
  });
});

describe("an export preempts a preview", () => {
  it("stops the running preview and runs the export first", async () => {
    const queue = new RenderQueue();
    const preview = deferred();
    void queue.submit({ id: 1, lane: "preview", run: preview.run });

    const job = deferred();
    const exported = queue.submit({ id: 2, lane: "export", run: job.run });
    expect(preview.aborted()).toBe(true);

    await settle();
    // Export never waits behind a frame that will be superseded in 16 ms.
    expect(job.started()).toBe(true);
    job.finish("file");
    await expect(exported).resolves.toBe("file");
  });

  it("re-runs the preempted preview rather than failing it", async () => {
    // The other half of "export must not degrade preview": the displaced
    // preview still produces a frame, so the screen ends up where the viewport
    // asked for it to be.
    const queue = new RenderQueue();
    let previewRuns = 0;
    const previewSignals: AbortSignal[] = [];
    const preview = queue.submit<string>({
      id: 1,
      lane: "preview",
      run: (signal) => {
        previewRuns += 1;
        previewSignals.push(signal);
        const attempt = previewRuns;
        return new Promise<string>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
          if (attempt === 2) setTimeout(() => resolve("preview frame"), 0);
        });
      },
    });

    const job = deferred();
    const exported = queue.submit({ id: 2, lane: "export", run: job.run });
    await settle();
    job.finish("file");
    await expect(exported).resolves.toBe("file");

    await expect(preview).resolves.toBe("preview frame");
    expect(previewRuns).toBe(2);
    // A fresh controller on the re-run, or the second attempt would see an
    // already-aborted signal and finish instantly.
    expect(previewSignals[0]?.aborted).toBe(true);
    expect(previewSignals[1]?.aborted).toBe(false);
  });

  it("drops a preempted preview when a newer one is already waiting", async () => {
    const queue = new RenderQueue();
    const stale = deferred();
    const staleOutcome = caught(queue.submit({ id: 1, lane: "preview", run: stale.run }));

    const job = deferred();
    void caught(queue.submit({ id: 2, lane: "export", run: job.run }));

    const fresh = deferred();
    const freshOutcome = queue.submit({ id: 3, lane: "preview", run: fresh.run });

    await settle();
    expect(((await staleOutcome) as { error: RenderAbandoned }).error.code).toBe("superseded");

    job.finish("file");
    await settle();
    expect(fresh.started()).toBe(true);
    fresh.finish("newest");
    await expect(freshOutcome).resolves.toBe("newest");
  });

  it("does not re-queue a preview that was cancelled outright", async () => {
    // An explicit cancel and a preemption abort with the same code, and an
    // export can be waiting for either reason. Telling them apart by the shape
    // of the queue would silently re-run a render somebody asked to stop.
    const queue = new RenderQueue();
    let runs = 0;
    const outcome = caught(
      queue.submit({
        id: 1,
        lane: "preview",
        run: (signal) => {
          runs += 1;
          return new Promise<string>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason));
          });
        },
      }),
    );
    const job = deferred();
    const exported = queue.submit({ id: 2, lane: "export", run: job.run });
    // The export is queued but has not preempted anything yet: cancel first.
    queue.cancel(1);

    expect(((await outcome) as { error: RenderAbandoned }).error.code).toBe("cancelled");
    await settle();
    job.finish("file");
    await expect(exported).resolves.toBe("file");
    expect(runs).toBe(1);
    expect(queue.state.pendingPreview).toBe(null);
  });

  it("never preempts a running export", async () => {
    const queue = new RenderQueue();
    const running = deferred();
    const first = queue.submit({ id: 1, lane: "export", run: running.run });
    void caught(queue.submit({ id: 2, lane: "export", run: deferred().run }));

    expect(running.aborted()).toBe(false);
    running.finish("first file");
    await expect(first).resolves.toBe("first file");
  });

  it("runs exports in arrival order", async () => {
    const queue = new RenderQueue();
    const order: number[] = [];
    const jobs = [1, 2, 3].map((id) => {
      const job = deferred();
      void caught(
        queue.submit({
          id,
          lane: "export",
          run: (signal) => {
            order.push(id);
            return job.run(signal);
          },
        }),
      );
      return job;
    });

    for (const job of jobs) {
      job.finish("done");
      await settle();
    }
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("explicit cancellation", () => {
  it("aborts a running job", async () => {
    const queue = new RenderQueue();
    const job = deferred();
    const outcome = caught(queue.submit({ id: 7, lane: "export", run: job.run }));
    expect(queue.cancel(7)).toBe(true);
    expect(job.aborted()).toBe(true);
    expect(((await outcome) as { error: RenderAbandoned }).error.code).toBe("cancelled");
  });

  it("removes a waiting export without ever starting it", async () => {
    const queue = new RenderQueue();
    const running = deferred();
    void caught(queue.submit({ id: 1, lane: "export", run: running.run }));
    const waiting = deferred();
    const outcome = caught(queue.submit({ id: 2, lane: "export", run: waiting.run }));

    expect(queue.cancel(2)).toBe(true);
    expect(((await outcome) as { error: RenderAbandoned }).error.code).toBe("cancelled");
    running.finish("a");
    await settle();
    expect(waiting.started()).toBe(false);
  });

  it("removes a waiting preview", async () => {
    const queue = new RenderQueue();
    void caught(queue.submit({ id: 1, lane: "export", run: deferred().run }));
    const outcome = caught(queue.submit({ id: 2, lane: "preview", run: deferred().run }));
    expect(queue.cancel(2)).toBe(true);
    expect(((await outcome) as { error: RenderAbandoned }).error.code).toBe("cancelled");
    expect(queue.state.pendingPreview).toBe(null);
  });

  it("reports a cancel for something that already finished", async () => {
    // Ordinary — the main thread does not know when a render lands — but the
    // caller gets to see it rather than have it swallowed.
    const queue = new RenderQueue();
    const job = deferred();
    const promise = queue.submit({ id: 1, lane: "export", run: job.run });
    job.finish("done");
    await expect(promise).resolves.toBe("done");
    expect(queue.cancel(1)).toBe(false);
  });

  it("settles everything on clear, so nothing is left hanging", async () => {
    const queue = new RenderQueue();
    const running = deferred();
    const first = caught(queue.submit({ id: 1, lane: "export", run: running.run }));
    const second = caught(queue.submit({ id: 2, lane: "export", run: deferred().run }));
    const third = caught(queue.submit({ id: 3, lane: "preview", run: deferred().run }));

    queue.clear("shutting down");
    for (const outcome of [first, second, third]) {
      expect(((await outcome) as { error: RenderAbandoned }).error).toBeInstanceOf(
        RenderAbandoned,
      );
    }
  });
});

describe("failures", () => {
  it("passes a real failure through and carries on with the next job", async () => {
    const queue = new RenderQueue();
    const failure = new Error("this stack cannot be rendered");
    const first = caught(
      queue.submit({ id: 1, lane: "export", run: () => Promise.reject(failure) }),
    );
    const next = deferred();
    const second = queue.submit({ id: 2, lane: "export", run: next.run });

    expect((await first) as { error: unknown }).toEqual({ error: failure });
    await settle();
    expect(next.started()).toBe(true);
    next.finish("recovered");
    await expect(second).resolves.toBe("recovered");
  });

  it("reports what it is doing", () => {
    const queue = new RenderQueue();
    void caught(queue.submit({ id: 1, lane: "export", run: deferred().run }));
    void caught(queue.submit({ id: 2, lane: "export", run: deferred().run }));
    void caught(queue.submit({ id: 3, lane: "preview", run: deferred().run }));
    expect(queue.state).toEqual({
      running: 1,
      runningLane: "export",
      pendingPreview: 3,
      pendingExports: [2],
    });
  });
});
