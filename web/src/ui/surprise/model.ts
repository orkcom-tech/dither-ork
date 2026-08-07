/**
 * The surprise panel's state, as pure functions.
 *
 * Everything the panel can be asked to do that does not need a renderer, a
 * document store or a WASM core lives here, so it is unit-tested without any of
 * them — the same arrangement `ui/palette/model.ts` and `ui/stack/model.ts` use.
 *
 * The one thing worth reading twice is {@link readiness}. Surprise Me is refused
 * rather than degraded when its inputs are not all there, and the refusal names
 * which input. That is not caution: F-SM-05 draws the palette mode from three
 * modes — extract, library, synthesize — and a mode that is drawn and then found
 * unavailable would have to fall back to another, which would make one seed mean
 * two different palettes depending on whether the hardware library had finished
 * loading. Refusing until all three are available is what keeps F-SM-02's "the
 * same seed always reproduces the same result" true.
 */

import type { SurpriseLocks } from "../../surprise";

/** Where the chaos slider starts (F-SM-07). */
export const DEFAULT_CHAOS = 0.35;

/** The slider's quantum. Coarse enough that the number reads as a setting. */
export const CHAOS_STEP = 0.05;

/** The four things that lock independently (F-SM-06), in the order they are shown. */
export const LOCK_KEYS = ["palette", "stack", "params", "animation"] as const;
export type LockKey = (typeof LOCK_KEYS)[number];

export function lockLabel(key: LockKey): string {
  switch (key) {
    case "palette":
      return "palette";
    case "stack":
      return "stack";
    case "params":
      return "parameters";
    case "animation":
      return "animation";
  }
}

export function lockHint(key: LockKey): string {
  switch (key) {
    case "palette":
      return "Keep this palette. A liked palette survives fifty stack rerolls.";
    case "stack":
      return "Keep these effects and their order. Parameters still reroll unless they are locked too.";
    case "params":
      return "Keep every parameter. With the stack unlocked, new effects arrive at their defaults — there is nothing of theirs to keep.";
    case "animation":
      return "Keep the modulator bindings. Bindings whose node the new stack does not contain are dropped.";
  }
}

export function toggleLock(locks: SurpriseLocks, key: LockKey): SurpriseLocks {
  return { ...locks, [key]: !locks[key] };
}

export function lockedCount(locks: SurpriseLocks): number {
  return LOCK_KEYS.filter((key) => locks[key]).length;
}

/** Clamp and snap the chaos slider. Out-of-range input is a caller bug, not a value. */
export function clampChaos(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CHAOS;
  const clamped = value < 0 ? 0 : value > 1 ? 1 : value;
  return Math.round(clamped / CHAOS_STEP) * CHAOS_STEP;
}

/** A word for where the slider is, so the number is not the only label. */
export function chaosLabel(chaos: number): string {
  if (chaos < 0.2) return "tame";
  if (chaos < 0.45) return "lively";
  if (chaos < 0.7) return "loud";
  if (chaos < 0.9) return "wild";
  return "feral";
}

/** What the surprise engine needs before it can run, and what is missing. */
export type Readiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: string };

export interface ReadinessInput {
  /** An image is open, so there is something to be surprised against (F-SM-01). */
  readonly hasSource: boolean;
  /** The hardware palette library has been read from the core (F-CO-04). */
  readonly libraryReady: boolean;
  /** Set when reading the library failed; shown instead of "still loading". */
  readonly libraryFailure: string | null;
}

export function readiness(input: ReadinessInput): Readiness {
  if (!input.hasSource) {
    return { ready: false, reason: "Open an image first — a surprise is built against it." };
  }
  if (input.libraryFailure !== null) {
    return {
      ready: false,
      reason: `The built-in palette library could not be read (${input.libraryFailure}), and one of the three palette modes draws from it.`,
    };
  }
  if (!input.libraryReady) {
    return {
      ready: false,
      reason: "Reading the built-in palette library — one of the three palette modes draws from it.",
    };
  }
  return { ready: true };
}

/**
 * One line naming the stack, for the button's tooltip and the history strip.
 *
 * Arrows rather than commas because the stack is an order, and reading it as a
 * pipeline is the point.
 */
export function describeStack(effectNames: readonly string[]): string {
  return effectNames.length === 0 ? "empty stack" : effectNames.join(" → ");
}
