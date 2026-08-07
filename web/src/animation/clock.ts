/**
 * F-AN-01 — the clock.
 *
 * A loop is `N` frames at `fps`, and normalized time is `t = frame / N`, so `t`
 * reaches 0 and never reaches 1. That asymmetry is the point: frame `N` is not a
 * frame of this loop, it is frame `0` of the next one, and an exporter that
 * emitted `N + 1` frames would emit the first frame twice and produce a visible
 * hitch on every repeat.
 *
 * ## The one rule the rest of the module follows from
 *
 * **Everything animated is a pure function of `frame mod N`.** Not of `frame`,
 * and not of a wall clock. That single convention is what makes periodicity
 * structural rather than something to be tested for afterwards: two frame
 * indices that are congruent mod `N` produce bit-identical values, so frame `N`
 * *is* frame `0` — the same numbers, not numbers that agree to within a
 * tolerance.
 *
 * It also means the phase is computed from an **integer** frame index rather
 * than by accumulating a per-frame increment. Accumulation drifts: adding
 * `1/N` to a float `N` times does not land on 1, so an accumulated phase at the
 * seam differs from the starting phase in the last few bits, and a content hash
 * notices a difference the eye cannot. Computing `cycles * (frame mod N) / N`
 * from integers gives the same bits at frame 0 and frame N because it is the
 * same expression evaluated on the same inputs.
 *
 * `types/document.ts` already exports `normalizedTime`, which agrees with
 * {@link loopTime} for every non-negative frame. This module has its own because
 * scrubbing a timeline backwards produces negative indices, and JavaScript's `%`
 * is a remainder rather than a modulus: `-1 % 60` is `-1`, so `normalizedTime`
 * of frame -1 is a negative time. {@link loopFrame} is Euclidean and returns 59.
 */

import type { Clock } from "../types/document";
import { AnimationError } from "./errors";

/**
 * Largest frame count accepted.
 *
 * At 60 fps this is more than 27 minutes of animation generated from one still
 * image, which is far past any use this application has; and an animated export
 * walks every frame, so the ceiling is also what stops a mistyped field from
 * asking for an export that will never finish. Its other job is arithmetic: the
 * product of this and `MAX_CYCLES_PER_LOOP` is far below 2^53, so the integer
 * phase arithmetic in `modulator.ts` is exact.
 */
export const MAX_FRAMES = 100_000;

/** Largest frame rate accepted. Above this the loop is shorter than a display refresh. */
export const MAX_FPS = 1000;

/**
 * A clock that has been checked.
 *
 * A distinct type from `Clock` so a function that needs the guarantees can ask
 * for them instead of re-deriving them, and so the checking happens once per
 * plan rather than once per frame per binding.
 */
export interface LoopClock {
  /** Frame count `N`. An integer, at least 1, at most {@link MAX_FRAMES}. */
  readonly frames: number;
  /** Frames per second. Finite and greater than zero. */
  readonly fps: number;
}

/**
 * Check a document's clock.
 *
 * Throws rather than repairing. A frame count of 0 is not "one frame with a typo",
 * and a document whose clock cannot describe a loop cannot be animated at all.
 */
export function loopClock(clock: Clock): LoopClock {
  const { frames, fps } = clock;
  if (!Number.isInteger(frames) || frames < 1 || frames > MAX_FRAMES) {
    throw new AnimationError(
      "invalid-clock",
      `frame count is ${String(frames)}; it must be an integer from 1 to ${MAX_FRAMES}`,
      { frames: String(frames), max: MAX_FRAMES },
    );
  }
  if (!Number.isFinite(fps) || fps <= 0 || fps > MAX_FPS) {
    throw new AnimationError(
      "invalid-clock",
      `fps is ${String(fps)}; it must be finite, greater than zero and at most ${MAX_FPS}`,
      { fps: String(fps), max: MAX_FPS },
    );
  }
  return { frames, fps };
}

/**
 * The frame's position in the loop: `frame mod N`, Euclidean, always in `[0, N)`.
 *
 * Every animated value in this module starts here. That is what makes frame `N`
 * and frame `0` the same numbers rather than numbers that happen to be close.
 */
export function loopFrame(clock: LoopClock, frame: number): number {
  if (!Number.isSafeInteger(frame)) {
    throw new AnimationError(
      "invalid-frame",
      `frame index is ${String(frame)}; it must be a whole number`,
      { frame: String(frame) },
    );
  }
  const wrapped = frame % clock.frames;
  if (wrapped < 0) return wrapped + clock.frames;
  // `-60 % 60` is `-0`, and `-0 < 0` is false, so the branch above does not
  // catch it. Left alone it would reach a parameter value and then a content
  // hash, where `-0` and `0` have different bits — the exact collision
  // `graph/hash.ts` collapses on the way in. Collapsing it at the source means
  // frame -60 and frame 0 are the same number here, not merely the same picture.
  return wrapped === 0 ? 0 : wrapped;
}

/**
 * Normalized loop time in `[0, 1)`.
 *
 * `t` never reaches 1 (F-AN-01): the last frame of an `N`-frame loop is at
 * `(N - 1) / N`.
 */
export function loopTime(clock: LoopClock, frame: number): number {
  return loopFrame(clock, frame) / clock.frames;
}

/** Seconds from the start of the loop to this frame. For a timeline ruler. */
export function loopSeconds(clock: LoopClock, frame: number): number {
  return loopFrame(clock, frame) / clock.fps;
}

/** Duration of one loop, in seconds. */
export function loopDuration(clock: LoopClock): number {
  return clock.frames / clock.fps;
}
