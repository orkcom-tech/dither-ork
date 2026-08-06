/**
 * Ramp generation between two colours — the second half of F-CO-06.
 *
 * Mirrors `oklab_ramp` in `core/crates/dither-core/src/palette.rs`, which is
 * not exported across the WASM boundary. Two properties are transcribed
 * deliberately and are what the tests pin:
 *
 * - **The interpolation is in OKLab, not in linear light.** A linear-light
 *   interpolation between two saturated colours passes through a desaturated,
 *   wrongly-lit middle, which is exactly what a ramp must not do.
 * - **Endpoints are emitted verbatim** rather than round-tripped through OKLab,
 *   so a hand-picked colour at either end comes back as the byte it was.
 *
 * Out-of-gamut steps are counted and reported rather than clamped in silence: a
 * straight line in OKLab between two in-gamut colours can leave the sRGB cube,
 * and the editor says so instead of the user finding out at export.
 */

import type { SrgbTriplet } from "../../types/document";
import { linearToByte, oklabToLinear, tripletToLinear, tripletToOklab } from "./color";

export const RAMP_STEP_RANGE = { min: 2, max: 64 } as const;

export interface Ramp {
  readonly colors: readonly SrgbTriplet[];
  /** How many steps left the sRGB cube and were clamped back into it. */
  readonly clamped: number;
}

export class RampError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RampError";
  }
}

/** Interpolate `steps` colours from `from` to `to` along a straight line in OKLab. */
export function oklabRamp(from: SrgbTriplet, to: SrgbTriplet, steps: number): Ramp {
  if (!Number.isInteger(steps) || steps < RAMP_STEP_RANGE.min) {
    throw new RampError(`a ramp between two colours needs at least two steps, got ${steps}`);
  }
  if (steps > RAMP_STEP_RANGE.max) {
    throw new RampError(`a ramp of ${steps} steps exceeds the ${RAMP_STEP_RANGE.max} limit`);
  }

  const a = tripletToOklab(from);
  const b = tripletToOklab(to);
  const last = steps - 1;

  const colors: SrgbTriplet[] = [];
  let clamped = 0;

  for (let i = 0; i < steps; i += 1) {
    if (i === 0) {
      colors.push(from);
      continue;
    }
    if (i === last) {
      colors.push(to);
      continue;
    }

    const t = i / last;
    const linear = oklabToLinear({
      l: a.l + (b.l - a.l) * t,
      a: a.a + (b.a - a.a) * t,
      b: a.b + (b.b - a.b) * t,
    });
    const inside = linear.every((c) => c >= 0 && c <= 1);
    if (!inside) clamped += 1;
    colors.push([
      linearToByte(linear[0]),
      linearToByte(linear[1]),
      linearToByte(linear[2]),
    ]);
  }

  return { colors, clamped };
}

/**
 * Whether a ramp can be built over the span the UI is offering, and why not.
 *
 * The span is inclusive of both endpoints and the ramp replaces it, so `steps`
 * may be fewer or more than the span currently holds — that is how a ramp both
 * smooths an existing run and grows one.
 */
export function canRamp(
  paletteLength: number,
  from: number,
  to: number,
  steps: number,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (paletteLength < 2) return { ok: false, reason: "a ramp needs two colours to run between" };
  if (from === to) return { ok: false, reason: "pick two different swatches" };
  for (const index of [from, to]) {
    if (!Number.isInteger(index) || index < 0 || index >= paletteLength) {
      return { ok: false, reason: `swatch ${index} is not in the palette` };
    }
  }
  if (!Number.isInteger(steps) || steps < RAMP_STEP_RANGE.min || steps > RAMP_STEP_RANGE.max) {
    return {
      ok: false,
      reason: `steps must be a whole number between ${RAMP_STEP_RANGE.min} and ${RAMP_STEP_RANGE.max}`,
    };
  }
  return { ok: true };
}

/**
 * A rough perceptual length for a ramp, in OKLab units.
 *
 * Shown beside the steps control so the number of steps is a decision with a
 * scale attached rather than a guess: two colours 0.05 apart do not need
 * sixteen steps, and two 0.6 apart cannot be covered by three.
 */
export function rampDistance(from: SrgbTriplet, to: SrgbTriplet): number {
  const a = tripletToOklab(from);
  const b = tripletToOklab(to);
  return Math.hypot(a.l - b.l, a.a - b.a, a.b - b.b);
}

/** Linear-light coordinates of a triplet — re-exported so the panel can read one. */
export { tripletToLinear };
