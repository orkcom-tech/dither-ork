/**
 * The transport — F-AN-09's clock, and the honesty about whether it is keeping
 * up.
 *
 * ## Reading a clock here is not the defect the render path forbids
 *
 * Nothing animated in this application may read a wall clock: every value is a
 * pure function of `frame mod N` and an explicit seed, which is what makes
 * scrubbing, caching and re-rendering give the same answer
 * (`animation/clock.ts`, `animation/rng.ts`). That rule is about **what a frame
 * contains**. Real-time playback is about **which frame to show now**, and that
 * question has no answer that does not involve elapsed time.
 *
 * The two are kept apart by this file being the only place a timestamp appears:
 * it turns a monotonic timestamp into an integer frame index, and everything
 * downstream takes the index. The rendered picture is therefore still a pure
 * function of the index, and the same index always produces the same bits.
 *
 * The timestamp is injected rather than read, so the tests here drive playback
 * by hand and no test depends on how fast the machine running it is.
 *
 * ## Frames are dropped, never queued
 *
 * The frame index is computed from the time **elapsed since playback started**,
 * not by adding one per tick. Those two are different things the moment a render
 * takes longer than a frame:
 *
 * - Adding one per tick makes a slow render *slow the animation down*, and it
 *   accumulates: after a stall the loop is behind and never catches up, so the
 *   playhead reads one frame and the picture is another.
 * - Computing from elapsed time skips the frames that could not be produced. The
 *   animation stays in real time, the playhead is always the frame on screen, and
 *   what is lost is smoothness — which is visible, measurable, and reported by
 *   {@link PlaybackMeter} rather than left to be felt.
 *
 * There is no catch-up queue anywhere in this module, and there must not be one:
 * a queue of frames nobody will see is work that makes the next frame later
 * still.
 */

/** Slowest playback the transport will report as healthy, as a fraction of `fps`. */
export const KEEPING_UP = 0.85;

/** How far back the meter looks when it reports a rate, in milliseconds. */
export const METER_WINDOW_MS = 1000;

/**
 * The frame that should be on screen after `elapsedMs` of playback.
 *
 * Wrapping is Euclidean and `-0` collapses to `0`, matching
 * `animation/clock.ts`: frame `N` is frame `0`, the same number and not merely
 * the same picture.
 */
export function frameAtElapsed(
  startFrame: number,
  elapsedMs: number,
  fps: number,
  frames: number,
): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return wrap(startFrame, frames);
  const advanced = Math.floor((elapsedMs * fps) / 1000);
  return wrap(startFrame + advanced, frames);
}

function wrap(frame: number, frames: number): number {
  if (frames < 1) return 0;
  const wrapped = frame % frames;
  if (wrapped < 0) return wrapped + frames;
  return wrapped === 0 ? 0 : wrapped;
}

/** How many loops have completed after `elapsedMs`. For the transport readout. */
export function loopsElapsed(
  startFrame: number,
  elapsedMs: number,
  fps: number,
  frames: number,
): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || frames < 1) return 0;
  const advanced = Math.floor((elapsedMs * fps) / 1000);
  return Math.floor((startFrame + advanced) / frames);
}

/** What the transport bar says about the last second of playback. */
export interface PlaybackReport {
  /** Frames actually handed to the viewport in the window. */
  readonly presented: number;
  /** Frames the transport asked for and abandoned because a render was still running. */
  readonly dropped: number;
  /** Presented frames per second over the window. */
  readonly effectiveFps: number;
  /** Whether the transport is failing to hit the document's fps. */
  readonly behind: boolean;
}

export const IDLE_REPORT: PlaybackReport = {
  presented: 0,
  dropped: 0,
  effectiveFps: 0,
  behind: false,
};

type Event = { readonly at: number; readonly presented: boolean };

/**
 * A sliding count of what playback managed.
 *
 * Deliberately not a smoothed average: an average hides exactly the case this
 * exists to surface, which is a burst of drops on one heavy node. The window is
 * a second because that is the unit the reading is stated in.
 */
export class PlaybackMeter {
  readonly #window: number;
  #events: Event[] = [];

  constructor(windowMs: number = METER_WINDOW_MS) {
    this.#window = windowMs;
  }

  note(presented: boolean, at: number): void {
    this.#events.push({ at, presented });
    this.#trim(at);
  }

  reset(): void {
    this.#events = [];
  }

  report(at: number, fps: number): PlaybackReport {
    this.#trim(at);
    let presented = 0;
    let dropped = 0;
    for (const event of this.#events) {
      if (event.presented) presented += 1;
      else dropped += 1;
    }
    const seconds = this.#window / 1000;
    const effectiveFps = presented / seconds;
    return {
      presented,
      dropped,
      effectiveFps,
      // A drop on its own is not a verdict — one heavy frame in a second is
      // still smooth playback. Falling short of the document's own rate is.
      behind: presented > 0 && effectiveFps < fps * KEEPING_UP,
    };
  }

  #trim(at: number): void {
    const cutoff = at - this.#window;
    if (this.#events.length === 0) return;
    const first = this.#events[0];
    if (first !== undefined && first.at >= cutoff) return;
    this.#events = this.#events.filter((event) => event.at >= cutoff);
  }
}

/**
 * One line stating what playback is doing, for the transport bar.
 *
 * It says "reduced" only when the preview really is reduced and "dropping" only
 * when frames really were dropped, because a badge that is always up is a badge
 * nobody reads — the argument `viewport/quality.ts` makes about the degraded
 * indicator.
 */
export function describePlayback(
  report: PlaybackReport,
  fps: number,
  previewScale: number,
): string {
  const parts: string[] = [];
  if (report.behind) {
    parts.push(`${report.effectiveFps.toFixed(0)}/${fps} fps`);
  }
  if (report.dropped > 0) {
    parts.push(`${report.dropped} dropped`);
  }
  if (previewScale < 0.999) {
    parts.push(`${Math.round(previewScale * 100)}% resolution`);
  }
  return parts.join(" · ");
}
