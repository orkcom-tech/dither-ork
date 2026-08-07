/**
 * F-BA-06 — the visible queue, as pure arithmetic.
 *
 * Everything in this file is a function from a queue to a queue, or from a
 * queue to a summary. No worker, no device, no DOM, no promises: the state
 * machine that decides what a person sees in the list is unit-tested in a Node
 * process, and `run.ts` is the only place where it meets an image.
 *
 * The requirement is one sentence — *one corrupt file in a folder of two
 * hundred must not kill the run or vanish silently* — and three properties here
 * are what make it true:
 *
 * - **A failure is a state of an item, not of the run.** `failed` carries the
 *   message and the run keeps going. Nothing anywhere collapses the queue to a
 *   single boolean.
 * - **Every item ends in exactly one of four terminal states**, and
 *   {@link summarise} counts them. `done + failed + cancelled + pending +
 *   running === total` is invariant and is pinned by a test, so an item cannot
 *   fall out of the list by being forgotten in some branch.
 * - **A cancel is not a failure.** The items that had not started become
 *   `cancelled`, which is a different word from `failed` because the difference
 *   is the whole of what the person needs to know afterwards.
 */

import type {
  BatchInputFile,
  BatchItem,
  BatchItemStage,
  BatchItemState,
  BatchPhase,
  BatchRunState,
  BatchSummary,
} from "./types";

/** A fresh queue: everything pending, nothing known about the output yet. */
export function initialItems(inputs: readonly BatchInputFile[]): readonly BatchItem[] {
  return inputs.map((input) => ({
    id: input.id,
    path: input.path,
    bytes: input.bytes,
    state: "pending" as const,
    stage: "waiting" as const,
    outputName: null,
    width: null,
    height: null,
    outputBytes: null,
    error: null,
    ms: null,
  }));
}

/** Everything about one item that a transition may change. */
export type ItemPatch = Partial<{
  readonly state: BatchItemState;
  readonly stage: BatchItemStage;
  readonly outputName: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly outputBytes: number | null;
  readonly error: string | null;
  readonly ms: number | null;
}>;

/**
 * Apply a patch to one item, by index.
 *
 * By index rather than by id because `run.ts` addresses items positionally —
 * the queue's order is the input order and never changes — and because an index
 * that is out of range is a programming error rather than a state, so it
 * throws rather than returning the list unchanged.
 */
export function patchItem(
  items: readonly BatchItem[],
  index: number,
  patch: ItemPatch,
): readonly BatchItem[] {
  const current = items[index];
  if (current === undefined) {
    throw new RangeError(`no queue item at ${index}; the queue holds ${items.length}`);
  }
  const next = items.slice();
  next[index] = { ...current, ...patch };
  return next;
}

/**
 * Move everything not yet finished to `cancelled`.
 *
 * A running item is included: the abort signal has already been raised, so its
 * own catch will land on `cancelled` too — this is what makes the list correct
 * *immediately* rather than a few hundred milliseconds later when the worker
 * unwinds, which is the difference between a cancel button that works and one
 * that appears not to.
 */
export function cancelUnfinished(items: readonly BatchItem[]): readonly BatchItem[] {
  return items.map((item) =>
    item.state === "pending" || item.state === "running"
      ? { ...item, state: "cancelled" as const, stage: "finished" as const }
      : item,
  );
}

export interface QueueCounts {
  readonly total: number;
  readonly pending: number;
  readonly running: number;
  readonly done: number;
  readonly failed: number;
  readonly cancelled: number;
}

export function summarise(items: readonly BatchItem[]): QueueCounts {
  let pending = 0;
  let running = 0;
  let done = 0;
  let failed = 0;
  let cancelled = 0;
  for (const item of items) {
    if (item.state === "pending") pending += 1;
    else if (item.state === "running") running += 1;
    else if (item.state === "done") done += 1;
    else if (item.state === "failed") failed += 1;
    else cancelled += 1;
  }
  return { total: items.length, pending, running, done, failed, cancelled };
}

/** Bytes actually written, across the items that finished. */
export function outputBytesOf(items: readonly BatchItem[]): number {
  let total = 0;
  for (const item of items) total += item.outputBytes ?? 0;
  return total;
}

/**
 * 0..1 across the queue, counted in items.
 *
 * Items rather than bytes: a person watching a batch counts files, and a bar
 * driven by bytes jumps backwards every time a large input produces a small
 * output. An item that failed still counts as finished — it is not coming back.
 */
export function completionOf(counts: QueueCounts): number {
  if (counts.total === 0) return 1;
  return (counts.done + counts.failed + counts.cancelled) / counts.total;
}

/** One short line naming what the run is doing, for the panel's header. */
export function detailFor(phase: BatchPhase, counts: QueueCounts): string {
  switch (phase) {
    case "idle":
      return counts.total === 0
        ? "No images queued."
        : `${counts.total} image${counts.total === 1 ? "" : "s"} queued.`;
    case "running":
      return `${counts.done + counts.failed} of ${counts.total} finished` +
        (counts.failed > 0 ? `, ${counts.failed} failed` : "") +
        (counts.running > 0 ? `, ${counts.running} in flight` : "") + ".";
    case "finished":
      return `${counts.done} of ${counts.total} written` +
        (counts.failed > 0 ? `, ${counts.failed} failed` : "") + ".";
    case "cancelled":
      return `Cancelled after ${counts.done} of ${counts.total}` +
        (counts.failed > 0 ? `, ${counts.failed} failed` : "") + ".";
    case "failed":
      return `The run stopped after ${counts.done} of ${counts.total}.`;
  }
}

export function runStateOf(
  items: readonly BatchItem[],
  phase: BatchPhase,
  failure: string | null,
  summary: BatchSummary | null,
): BatchRunState {
  const counts = summarise(items);
  return {
    items,
    phase,
    done: counts.done,
    failed: counts.failed,
    cancelled: counts.cancelled,
    completed: completionOf(counts),
    detail: detailFor(phase, counts),
    failure,
    summary,
  };
}

/**
 * Input names that would produce the same output name.
 *
 * Only meaningful when the template distinguishes files by name alone; see
 * `run.ts` for why the check has to be made twice — once here, exactly, before
 * a run that cannot disambiguate, and once at write time as the backstop for a
 * template whose output depends on the picture's own dimensions.
 */
export function duplicatesIn(names: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const twice: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      if (!twice.includes(name)) twice.push(name);
      continue;
    }
    seen.add(key);
  }
  return twice;
}
