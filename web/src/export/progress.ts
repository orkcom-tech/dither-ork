/**
 * F-EX-13 — progress, and a cancel that actually stops.
 *
 * A still export finishes in under a second at 1x and in several at 8x, so this
 * looks like ceremony for the case it is built for. It is not built for that
 * case. Animated export (F-EX-04 through F-EX-07) lands on this path, and the
 * two things it needs — a stage-weighted fraction and a cancellation that
 * reaches the inside of a loop rather than only the caller's `await` — are
 * things that have to be threaded through every encoder from the start. Adding
 * them afterwards means editing every function that takes a pixel buffer.
 *
 * ## Cancellation is `AbortSignal`, not a flag
 *
 * The platform already has the vocabulary and every consumer already speaks it:
 * `fetch`, streams, and — the one that matters here — the worker RPC in
 * docs/API.md, whose `cancel()` "actually stops the worker; it does not merely
 * stop reporting". A boolean would have to be re-invented at that boundary.
 *
 * ## Yielding is not optional
 *
 * The render loop runs on the main thread (docs/ARCHITECTURE.md, "The render
 * loop runs on the main thread") and so does this. A cancel button that cannot
 * be clicked because the encoder is holding the thread is a cancel button that
 * does not exist, and a progress bar that jumps from 0 to 100 at the end is not
 * progress. So the long loops call {@link shouldYield} and hand the thread back
 * often enough for a click to land. That costs a few milliseconds of wall time
 * and buys the requirement.
 */

/** The stages a still export passes through, in order. */
export const EXPORT_STAGES = [
  "rendering",
  "scaling",
  "encoding",
  "writing",
] as const;

export type ExportStage = (typeof EXPORT_STAGES)[number];

/**
 * How much of the whole job each stage is worth.
 *
 * Measured shares rather than equal quarters: encoding dominates — the filter
 * pass and deflate together are most of the wall time at any scale above 1 —
 * and writing a blob to a file handle is close to instant. Weights that lie
 * about this produce a bar that sits at 25% for four seconds and then finishes,
 * which reads as a hang.
 */
export const STAGE_WEIGHTS: Readonly<Record<ExportStage, number>> = {
  rendering: 0.25,
  scaling: 0.1,
  encoding: 0.6,
  writing: 0.05,
};

export interface ExportProgress {
  readonly stage: ExportStage;
  /** 0..1 across the whole job, monotonic. */
  readonly completed: number;
  /** One short line naming what is happening, for the UI. */
  readonly detail: string;
}

export type ProgressListener = (progress: ExportProgress) => void;

/**
 * The fraction of the whole job at `within` through `stage`.
 *
 * `within` outside 0..1 is clamped rather than trusted: a caller that divides
 * by a row count can hand in 1.0000001, and a bar that overshoots its track is
 * a visible defect for an invisible cause.
 */
export function overallProgress(stage: ExportStage, within: number): number {
  const clamped = within <= 0 ? 0 : within >= 1 ? 1 : within;
  let before = 0;
  for (const candidate of EXPORT_STAGES) {
    if (candidate === stage) break;
    before += STAGE_WEIGHTS[candidate];
  }
  return before + STAGE_WEIGHTS[stage] * clamped;
}

/** Thrown out of every stage when the signal aborts. Never an error state. */
export class ExportCancelledError extends Error {
  constructor(message = "the export was cancelled") {
    super(message);
    this.name = "ExportCancelledError";
  }
}

export function isCancellation(error: unknown): boolean {
  if (error instanceof ExportCancelledError) return true;
  // `showSaveFilePicker` and `navigator.clipboard` reject with a DOMException
  // named AbortError when the person dismisses the dialog. That is the same
  // event as pressing cancel and must not reach the UI as a failure.
  return error instanceof Error && error.name === "AbortError";
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new ExportCancelledError();
}

/**
 * A budget for how long a loop may hold the thread before handing it back.
 *
 * 8ms rather than a row count: a row of a 512-wide image and a row of an
 * 8192-wide one differ by sixteen times, and a fixed row count therefore either
 * yields far too often on the small one or not nearly often enough on the large
 * one. A wall-clock budget is the same responsiveness at both.
 */
const FRAME_BUDGET_MS = 8;

export function shouldYield(since: number): boolean {
  return performance.now() - since >= FRAME_BUDGET_MS;
}

/**
 * Hand the thread back so a paint and a click can happen.
 *
 * A macrotask rather than a resolved promise: a microtask does not let the
 * browser paint, so a progress bar driven by microtask yields never moves.
 *
 * ## Why not `setTimeout(0)`
 *
 * It was `setTimeout(resolve, 0)`, and that is a real defect rather than a
 * stylistic one. **Browsers clamp timers in a background tab to about one
 * second.** These loops yield every 8 ms of work (see {@link shouldYield}), so
 * a PNG encode that yields sixty times takes sixty seconds instead of half of
 * one — as soon as the person switches tabs, which is exactly what somebody does
 * while waiting for a long export or a batch of thirty images. Measured: a
 * 900x700 PNG in a background tab had not finished encoding after two minutes.
 *
 * A `MessageChannel` message is an ordinary macrotask on the same task queue and
 * is **not** clamped, so the yield stays a yield when the tab is hidden. It
 * still lets the browser paint when the tab is visible, which is the property
 * the microtask lacked and the reason a timer was reached for in the first
 * place. `scheduler.yield()` would be better still and is not in every browser
 * this application supports, so it is used when it is there.
 *
 * The port pair is created once and reused: one per yield would allocate two
 * objects per 8 ms of encoding.
 */
const yieldChannel: MessageChannel | null =
  typeof MessageChannel === "function" ? new MessageChannel() : null;

const yieldWaiting: (() => void)[] = [];

if (yieldChannel !== null) {
  yieldChannel.port1.onmessage = (): void => {
    // Drained one at a time rather than all at once: each waiter is a separate
    // slice of work, and running them in one task would defeat the yield.
    const next = yieldWaiting.shift();
    next?.();
  };
  yieldChannel.port1.start();
}

interface SchedulerWithYield {
  readonly scheduler?: { readonly yield?: () => Promise<void> };
}

export function yieldToHost(): Promise<void> {
  const scheduler = (globalThis as SchedulerWithYield).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();

  const channel = yieldChannel;
  if (channel === null) {
    // No `MessageChannel` — not a browser this application runs in, but a
    // `vitest` environment can be one. The clamp does not apply outside a
    // background tab, so the timer is correct here.
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  return new Promise((resolve) => {
    yieldWaiting.push(resolve);
    channel.port2.postMessage(0);
  });
}

/**
 * A progress reporter scoped to one stage.
 *
 * Handed down into the encoders so they report `0..1 of my own work` and know
 * nothing about the job around them — which is what lets the same PNG encoder
 * serve the export, the size estimate and, later, one frame of an animation.
 */
export function stageReporter(
  stage: ExportStage,
  detail: string,
  listener: ProgressListener | undefined,
): (within: number) => void {
  if (listener === undefined) return () => undefined;
  return (within: number) => {
    listener({ stage, completed: overallProgress(stage, within), detail });
  };
}
