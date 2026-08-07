/**
 * F-AN-03 — cycles per loop, as a type.
 *
 * **This is the whole design of the animation system, expressed in one
 * constraint.** A modulator's phase advances `cyclesPerLoop` times over the
 * loop. If that count is an integer, the phase at frame `N` is the phase at
 * frame `0` plus a whole number of turns, which is the same phase — so the loop
 * closes *by construction*, with no crossfade, no easing at the seam and no
 * "close enough" tolerance anywhere. If it is 2.5, the loop does not close and
 * nothing downstream can repair it.
 *
 * So the constraint is not a comment on a field and not a check in a validator
 * that a caller can forget to run. It is a **branded type with a single smart
 * constructor**: {@link CyclesPerLoop} cannot be produced except by
 * {@link cyclesPerLoop}, which throws on anything that is not a positive
 * integer, and every evaluator in this module takes that type rather than a
 * bare `number`. A `2.5` cannot reach a modulator without someone writing a
 * cast, and a cast is visible in review in a way that a forgotten call is not.
 *
 * The same brand is used for {@link GlobalSpeed} (F-AN-10), because a global
 * speed multiplies every binding's cycle count at once: a fractional speed would
 * break F-AN-03 for every binding in the document simultaneously, which is the
 * one way to lose the property everywhere with a single control. Slowing an
 * animation down globally is therefore a change to the **frame count**, which is
 * the honest lever — a loop that must close cannot also run at an arbitrary
 * fraction of its own length.
 */

import { AnimationError } from "./errors";

/**
 * A positive integer number of modulator cycles over one loop.
 *
 * Branded so it cannot be confused with any other number and cannot be minted
 * anywhere except {@link cyclesPerLoop}.
 */
export type CyclesPerLoop = number & { readonly __brand: "CyclesPerLoop" };

/**
 * A positive integer multiplier applied to every binding's cycle count (F-AN-10).
 *
 * Deliberately the same shape and the same rule as {@link CyclesPerLoop}: an
 * integer times an integer is an integer, so applying a global speed cannot take
 * a document out of F-AN-03.
 */
export type GlobalSpeed = number & { readonly __brand: "GlobalSpeed" };

/**
 * Upper bound on cycles per loop.
 *
 * Two reasons, and the second is the load-bearing one:
 *
 * - Nothing musical needs more. A parameter that wiggles four thousand times
 *   over a loop is noise, and the modulator would be sampled far below its own
 *   rate anyway (see `modulator.ts`, the Nyquist report).
 * - It keeps `cycles * frame` **exactly** representable. Frame counts are
 *   bounded by `MAX_FRAMES` in `clock.ts`; the product of the two ceilings is
 *   far below 2^53, so the integer arithmetic the phase is computed from is
 *   exact rather than nearly exact. Phase equality at the seam is then a fact
 *   about integers, not a tolerance.
 */
export const MAX_CYCLES_PER_LOOP = 4096;

/** Upper bound on the global speed multiplier, for the same arithmetic reason. */
export const MAX_GLOBAL_SPEED = 64;

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

export function isCyclesPerLoop(value: number): value is CyclesPerLoop {
  return isPositiveInteger(value) && value <= MAX_CYCLES_PER_LOOP;
}

/**
 * The only way to make a {@link CyclesPerLoop}.
 *
 * Throws rather than clamping or rounding. Rounding 2.5 to 3 would produce a
 * loop that closes and an animation that is not the one the document asked
 * for — the document would have been silently rewritten, which is the failure
 * mode this project refuses everywhere else.
 */
export function cyclesPerLoop(value: number, what = "cyclesPerLoop"): CyclesPerLoop {
  if (!isCyclesPerLoop(value)) {
    throw new AnimationError(
      "invalid-cycles",
      `${what} is ${String(value)}; it must be an integer from 1 to ${MAX_CYCLES_PER_LOOP}. ` +
        `An integer number of cycles per loop is what makes frame N equal frame 0 (F-AN-03), ` +
        `so a fractional count is refused rather than rounded to one that would close.`,
      { value: String(value), max: MAX_CYCLES_PER_LOOP },
    );
  }
  return value;
}

export function isGlobalSpeed(value: number): value is GlobalSpeed {
  return isPositiveInteger(value) && value <= MAX_GLOBAL_SPEED;
}

/**
 * The only way to make a {@link GlobalSpeed}.
 *
 * There is no speed below 1. A half-speed global control would halve every
 * binding's cycle count, and half of an odd integer is not an integer — the loop
 * would stop closing for every binding whose count was odd, which is a control
 * that breaks the document depending on what is in it. Halving the *speed* of a
 * closing loop is doubling its **frame count**, and that is a clock edit.
 */
export function globalSpeed(value: number, what = "speed"): GlobalSpeed {
  if (!isGlobalSpeed(value)) {
    throw new AnimationError(
      "invalid-speed",
      `${what} is ${String(value)}; global speed must be an integer from 1 to ${MAX_GLOBAL_SPEED}. ` +
        `It multiplies every binding's cycles-per-loop, so a fractional speed would take every ` +
        `binding in the document out of F-AN-03 at once. To run a loop slower, raise the frame count.`,
      { value: String(value), max: MAX_GLOBAL_SPEED },
    );
  }
  return value;
}

/**
 * Apply a global speed to one binding's cycle count.
 *
 * The product of two positive integers is a positive integer, so this can only
 * fail by exceeding the ceiling — which is a real failure and is reported as
 * one, not clamped.
 */
export function scaleCycles(cycles: CyclesPerLoop, speed: GlobalSpeed): CyclesPerLoop {
  return cyclesPerLoop(cycles * speed, `cyclesPerLoop ${cycles} x speed ${speed}`);
}

/** Positive integer, for the temporal-variation settings that need one. */
export function positiveInteger(value: number, what: string): number {
  if (!isPositiveInteger(value) || !Number.isSafeInteger(value)) {
    throw new AnimationError(
      "invalid-period",
      `${what} is ${String(value)}; it must be a positive integer`,
      { value: String(value) },
    );
  }
  return value;
}

/** Any integer, for signed settings such as a scroll distance or a turn count. */
export function wholeNumber(value: number, what: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new AnimationError(
      "invalid-period",
      `${what} is ${String(value)}; it must be a whole number`,
      { value: String(value) },
    );
  }
  return value;
}
