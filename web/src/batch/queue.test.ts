import { describe, expect, it } from "vitest";

import {
  cancelUnfinished,
  completionOf,
  detailFor,
  duplicatesIn,
  initialItems,
  outputBytesOf,
  patchItem,
  runStateOf,
  summarise,
} from "./queue";
import type { BatchInputFile, BatchItem } from "./types";

function inputs(count: number): readonly BatchInputFile[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `batch-${index}`,
    path: `folder/image-${index}.png`,
    blob: new Blob([new Uint8Array([index])]),
    bytes: 1,
  }));
}

/** The invariant every test below leans on: nothing may fall out of the list. */
function accountsForEverything(items: readonly BatchItem[]): boolean {
  const counts = summarise(items);
  return (
    counts.pending + counts.running + counts.done + counts.failed + counts.cancelled ===
    counts.total
  );
}

describe("initialItems", () => {
  it("starts everything pending with nothing known about the output", () => {
    const items = initialItems(inputs(3));
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.state).toBe("pending");
      expect(item.stage).toBe("waiting");
      expect(item.outputName).toBeNull();
      expect(item.error).toBeNull();
    }
    expect(accountsForEverything(items)).toBe(true);
  });

  it("keeps the input order and the input's own path", () => {
    const items = initialItems(inputs(3));
    expect(items.map((item) => item.path)).toEqual([
      "folder/image-0.png",
      "folder/image-1.png",
      "folder/image-2.png",
    ]);
  });
});

describe("patchItem", () => {
  it("replaces one item without touching the others", () => {
    const before = initialItems(inputs(3));
    const after = patchItem(before, 1, { state: "running", stage: "rendering" });
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(after[1]?.state).toBe("running");
    expect(after[1]?.stage).toBe("rendering");
    // Immutable: the snapshot React last rendered must not change underneath it.
    expect(before[1]?.state).toBe("pending");
  });

  it("throws on an index that is not in the queue", () => {
    expect(() => patchItem(initialItems(inputs(2)), 5, { state: "done" })).toThrow(RangeError);
  });
});

describe("cancelUnfinished", () => {
  it("moves pending and running to cancelled and leaves the rest alone", () => {
    let items = initialItems(inputs(4));
    items = patchItem(items, 0, { state: "done", stage: "finished" });
    items = patchItem(items, 1, { state: "failed", stage: "finished", error: "bad bytes" });
    items = patchItem(items, 2, { state: "running", stage: "encoding" });

    const after = cancelUnfinished(items);
    expect(after.map((item) => item.state)).toEqual([
      "done",
      "failed",
      "cancelled",
      "cancelled",
    ]);
    // A failure that already happened is still a failure after a cancel.
    expect(after[1]?.error).toBe("bad bytes");
    expect(accountsForEverything(after)).toBe(true);
  });

  it("is idempotent", () => {
    const once = cancelUnfinished(initialItems(inputs(2)));
    expect(cancelUnfinished(once).map((item) => item.state)).toEqual(
      once.map((item) => item.state),
    );
  });
});

describe("summarise", () => {
  it("counts every terminal state separately", () => {
    let items = initialItems(inputs(5));
    items = patchItem(items, 0, { state: "done" });
    items = patchItem(items, 1, { state: "done" });
    items = patchItem(items, 2, { state: "failed", error: "no" });
    items = patchItem(items, 3, { state: "cancelled" });
    const counts = summarise(items);
    expect(counts).toEqual({
      total: 5,
      pending: 1,
      running: 0,
      done: 2,
      failed: 1,
      cancelled: 1,
    });
  });
});

describe("completionOf", () => {
  it("counts a failure as finished, because it is not coming back", () => {
    let items = initialItems(inputs(4));
    items = patchItem(items, 0, { state: "done" });
    items = patchItem(items, 1, { state: "failed", error: "no" });
    expect(completionOf(summarise(items))).toBeCloseTo(0.5);
  });

  it("is one for an empty queue rather than NaN", () => {
    expect(completionOf(summarise([]))).toBe(1);
  });
});

describe("outputBytesOf", () => {
  it("adds up what was written and ignores what was not", () => {
    let items = initialItems(inputs(3));
    items = patchItem(items, 0, { state: "done", outputBytes: 1200 });
    items = patchItem(items, 1, { state: "failed", error: "no" });
    items = patchItem(items, 2, { state: "done", outputBytes: 800 });
    expect(outputBytesOf(items)).toBe(2000);
  });
});

describe("detailFor", () => {
  it("says something different for each phase", () => {
    const counts = summarise(initialItems(inputs(3)));
    const lines = (["idle", "running", "finished", "cancelled", "failed"] as const).map(
      (phase) => detailFor(phase, counts),
    );
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("names the failures when there are any", () => {
    let items = initialItems(inputs(2));
    items = patchItem(items, 0, { state: "failed", error: "no" });
    expect(detailFor("finished", summarise(items))).toContain("1 failed");
  });
});

describe("runStateOf", () => {
  it("carries the counts and the failure through", () => {
    let items = initialItems(inputs(2));
    items = patchItem(items, 0, { state: "done", outputBytes: 10 });
    const state = runStateOf(items, "failed", "the archive could not be written", null);
    expect(state.done).toBe(1);
    expect(state.phase).toBe("failed");
    expect(state.failure).toBe("the archive could not be written");
    expect(state.summary).toBeNull();
  });
});

describe("duplicatesIn", () => {
  it("names a repeat once, however many times it repeats", () => {
    expect(duplicatesIn(["a", "a", "a", "b"])).toEqual(["a"]);
  });

  it("compares case-insensitively", () => {
    expect(duplicatesIn(["A", "a"])).toEqual(["a"]);
  });
});
