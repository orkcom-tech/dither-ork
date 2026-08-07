/**
 * F-AN-08 — keyframes, and the constraint that makes them loop.
 *
 * A keyframe track is a **cycle**, not a line with two ends. Its keys live on
 * frames `[0, N)` and the segment after the last key runs *through the seam* to
 * the first key, so there is no such thing as "the end of the track": every
 * frame index is inside exactly one segment, and frame `N` is frame `0` because
 * `N mod N` is `0`.
 *
 * That is the whole of the wrap-around constraint F-AN-08 asks for, and it is
 * the same trick `animation/cycles.ts` uses for modulators: the loop closes
 * **by construction** rather than by a rule someone has to remember to apply.
 * There is no "make first and last match" button here, because there is no last
 * key to match — the same key is the start of one segment and the end of
 * another. {@link keyframeValueAt} at frame `N` and at frame `0` evaluate the
 * *same expression on the same integers*, so they produce the same bits, which
 * is what a content hash needs and what "closes" has to mean.
 *
 * ## Easing belongs to the key the segment leaves
 *
 * A key carries the interpolation used on its way to the **next** key, which is
 * the convention every timeline uses and the only one that survives the wrap:
 * the last key's easing governs the segment that crosses the seam, so the seam
 * is eased like any other segment rather than being a special case.
 *
 * `hold` is a real interpolation and not the absence of one — it keeps the
 * outgoing key's value for the whole segment and jumps at the next key. It is
 * how a parameter steps rather than slides, which for an `int` parameter such as
 * a cell count is usually what is wanted.
 *
 * Pure, no clock, no DOM. Everything here is a function of the key list, the
 * frame count and an integer frame.
 */

import { AnimationError } from "../../animation";

/** F-AN-08's five interpolations. */
export type Easing = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "hold";

export const EASINGS: readonly Easing[] = [
  "linear",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "hold",
];

export const EASING_LABEL: Readonly<Record<Easing, string>> = {
  linear: "linear",
  "ease-in": "ease in",
  "ease-out": "ease out",
  "ease-in-out": "ease in-out",
  hold: "hold",
};

export interface Keyframe {
  /** Whole frame index in `[0, frames)`. Unique within a track. */
  readonly frame: number;
  readonly value: number;
  /** Interpolation from this key to the next one, wrapping at the seam. */
  readonly easing: Easing;
}

export function isEasing(value: string): value is Easing {
  return (EASINGS as readonly string[]).includes(value);
}

/**
 * The eased position within a segment, `[0, 1]`.
 *
 * Cubic rather than quadratic for the two-sided case so that `ease-in-out` has
 * zero slope at both ends; the one-sided pair are quadratic so that the eased
 * end is visibly softer than the linear end at the same duration. `hold`
 * returns 0 for the whole segment: the value is the outgoing key's until the
 * next key replaces it.
 */
export function easeUnit(easing: Easing, t: number): number {
  const u = t <= 0 ? 0 : t >= 1 ? 1 : t;
  switch (easing) {
    case "linear":
      return u;
    case "ease-in":
      return u * u;
    case "ease-out":
      return 1 - (1 - u) * (1 - u);
    case "ease-in-out":
      return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
    case "hold":
      return 0;
  }
}

function requireFrameCount(frames: number): number {
  if (!Number.isInteger(frames) || frames < 1) {
    throw new AnimationError(
      "invalid-clock",
      `a keyframe track needs a frame count of at least 1; it was given ${String(frames)}`,
      { frames: String(frames) },
    );
  }
  return frames;
}

/**
 * Fold a frame index into `[0, frames)`.
 *
 * Euclidean, for the reason `animation/clock.ts` gives: scrubbing backwards
 * produces negative indices and JavaScript's `%` is a remainder. `-0` is
 * collapsed to `0` so that frame `-N` and frame `0` are the same number and not
 * merely the same picture.
 */
export function wrapFrame(frame: number, frames: number): number {
  requireFrameCount(frames);
  if (!Number.isSafeInteger(frame)) {
    throw new AnimationError(
      "invalid-frame",
      `frame index is ${String(frame)}; it must be a whole number`,
      { frame: String(frame) },
    );
  }
  const wrapped = frame % frames;
  if (wrapped < 0) return wrapped + frames;
  return wrapped === 0 ? 0 : wrapped;
}

/** Keys in frame order. The list is kept sorted; this is what keeps it so. */
export function sortKeys(keys: readonly Keyframe[]): readonly Keyframe[] {
  return [...keys].sort((a, b) => a.frame - b.frame);
}

/**
 * Add a key, or move an existing key's value onto the frame it already holds.
 *
 * Two keys on one frame would make the segment between them zero frames long
 * and the value at that frame an accident of iteration order, so the incoming
 * key replaces the one that is there. Its easing is kept from the incoming key,
 * because setting a key on a frame that already has one is how a value is
 * corrected.
 */
export function addKey(
  keys: readonly Keyframe[],
  key: Keyframe,
  frames: number,
): readonly Keyframe[] {
  const frame = wrapFrame(key.frame, frames);
  const next = keys.filter((existing) => existing.frame !== frame);
  next.push({ ...key, frame });
  return sortKeys(next);
}

/**
 * Move a key to another frame.
 *
 * Landing on an occupied frame **replaces** the key that is there, for the same
 * reason two keys may not share a frame. Returns the list unchanged when there
 * is no key at `from`, which is what a drag that started on a key the state no
 * longer has looks like.
 */
export function moveKey(
  keys: readonly Keyframe[],
  from: number,
  to: number,
  frames: number,
): readonly Keyframe[] {
  const source = wrapFrame(from, frames);
  const target = wrapFrame(to, frames);
  const moving = keys.find((key) => key.frame === source);
  if (moving === undefined) return keys;
  if (source === target) return keys;
  const next = keys.filter((key) => key.frame !== source && key.frame !== target);
  next.push({ ...moving, frame: target });
  return sortKeys(next);
}

/** Remove the key on a frame. Unchanged when there is none. */
export function removeKey(
  keys: readonly Keyframe[],
  frame: number,
  frames: number,
): readonly Keyframe[] {
  const at = wrapFrame(frame, frames);
  if (!keys.some((key) => key.frame === at)) return keys;
  return keys.filter((key) => key.frame !== at);
}

/** Change one key's outgoing interpolation. Unchanged when there is no key. */
export function setKeyEasing(
  keys: readonly Keyframe[],
  frame: number,
  easing: Easing,
  frames: number,
): readonly Keyframe[] {
  const at = wrapFrame(frame, frames);
  if (!keys.some((key) => key.frame === at)) return keys;
  return keys.map((key) => (key.frame === at ? { ...key, easing } : key));
}

/** Change one key's value. Unchanged when there is no key. */
export function setKeyValue(
  keys: readonly Keyframe[],
  frame: number,
  value: number,
  frames: number,
): readonly Keyframe[] {
  const at = wrapFrame(frame, frames);
  if (!keys.some((key) => key.frame === at)) return keys;
  return keys.map((key) => (key.frame === at ? { ...key, value } : key));
}

/**
 * The segment covering a frame: the key it leaves, the key it arrives at, and
 * how far along it is.
 *
 * The wrapping case is not a special case in the arithmetic — it falls out of
 * taking both distances modulo the frame count. A frame before the first key is
 * governed by the **last** key, because the segment leaving the last key runs
 * through the seam.
 */
interface Segment {
  readonly from: Keyframe;
  readonly to: Keyframe;
  /** Position within the segment, before easing, in `[0, 1]`. */
  readonly t: number;
}

function segmentAt(
  keys: readonly Keyframe[],
  frames: number,
  frame: number,
): Segment | null {
  const last = keys[keys.length - 1];
  if (last === undefined) return null;

  let index = -1;
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (key !== undefined && key.frame <= frame) index = i;
  }
  // Before the first key: the segment that crosses the seam governs it.
  if (index === -1) index = keys.length - 1;

  const from = keys[index];
  if (from === undefined) return null;
  const to = keys[(index + 1) % keys.length] ?? from;

  const span = (((to.frame - from.frame) % frames) + frames) % frames;
  if (span === 0) {
    // One key in the track, or a segment that returns to the same frame — the
    // track is a constant and there is nothing to interpolate along.
    return { from, to, t: 0 };
  }
  const elapsed = (((frame - from.frame) % frames) + frames) % frames;
  return { from, to, t: elapsed / span };
}

/**
 * The track's value on a frame.
 *
 * `null` when the track has no keys — a track with nothing on it contributes
 * nothing, and returning a default here would be this module inventing a value
 * the user never set.
 *
 * Frame `N` evaluates the same expression on the same integers as frame `0`, so
 * the two are the same number and the loop closes. `keyframes.test.ts` asserts
 * that with `Object.is` rather than with a tolerance.
 */
export function keyframeValueAt(
  keys: readonly Keyframe[],
  frames: number,
  frame: number,
): number | null {
  requireFrameCount(frames);
  const at = wrapFrame(frame, frames);
  const segment = segmentAt(keys, frames, at);
  if (segment === null) return null;
  const { from, to, t } = segment;
  if (from === to) return from.value;
  const value = from.value + (to.value - from.value) * easeUnit(from.easing, t);
  // `-0` and `0` are the same value and must hash the same; `graph/hash.ts`
  // collapses it on the way in and so does `animation/binding.ts`.
  return value === 0 ? 0 : value;
}

/**
 * The extremes a track reaches over a whole loop.
 *
 * Walked frame by frame rather than reasoned about from the keys, because
 * easing is monotonic within a segment but the caller draws the curve from
 * samples and the lane's scale has to match what is drawn.
 */
export function keyframeExtremes(
  keys: readonly Keyframe[],
  frames: number,
): { readonly min: number; readonly max: number } | null {
  if (keys.length === 0) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let frame = 0; frame < frames; frame += 1) {
    const value = keyframeValueAt(keys, frames, frame);
    if (value === null) return null;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

/**
 * Drop keys that the loop no longer contains, after the frame count shrinks.
 *
 * Wrapping them would silently stack two keys on one frame and change the
 * animation; dropping is the only answer that leaves the remaining keys where
 * they were, and the caller logs how many went.
 */
export function keysWithinLoop(
  keys: readonly Keyframe[],
  frames: number,
): readonly Keyframe[] {
  requireFrameCount(frames);
  return keys.filter((key) => key.frame < frames);
}
