/**
 * Sampling, driven entirely by the metadata a descriptor already declares.
 *
 * This is F-SM-04 — "musical parameter ranges" — as code. Every parameter in the
 * catalogue declares, beside its legal range, a **surprise range**, a sampling
 * **distribution** and a **weight**, and `validateRegistry` fails the build if
 * any of the three is missing. This file samples that and never the legal range.
 * The gap between the two is the whole difference between a usable random result
 * and noise: a legal blur radius goes to 200 px, a musical one stops around 12.
 *
 * **There is no per-effect logic here and there must never be any.** An effect
 * added tomorrow is sampled by the code written today, which is the property
 * `docs/ARCHITECTURE.md` claims for the generator and the reason the registry
 * demands the metadata in the first place.
 *
 * # Every draw is quantised
 *
 * Continuous samples are rounded to {@link SAMPLE_QUANTUM} before they reach a
 * document. Two reasons, and the second is the load-bearing one:
 *
 * - A parameter of `0.7300000000000001` in a saved `.dork` is noise in the file
 *   and in the UI.
 * - `Math.log`, `Math.exp` and `Math.pow` are **not** required to be correctly
 *   rounded by ECMAScript, so the log distribution can differ in the last bit
 *   between two engines. docs/ARCHITECTURE.md already records that qualifier for
 *   `powf` and `cbrt` on the render path and accepts it there. Here it is
 *   avoidable: the integer draws underneath are bit-identical everywhere (that
 *   is what `rng.parity.test.ts` pins), and rounding the mapped value to a
 *   millionth puts the last-bit difference below the quantum. A seed therefore
 *   produces the same *document* on every platform, even though it produces the
 *   same *picture* only on one — which is the stronger of the two guarantees to
 *   have, since the document is what gets shared.
 */

import type { CurvePoint, SrgbTriplet } from "../types/document";
import type {
  BoolSurprise,
  ColorSurprise,
  CurveArchetype,
  CurveSurprise,
  EnumSurprise,
  NumericSurprise,
  Range,
  Weighted,
} from "../types/registry";
import type { Pcg32 } from "./rng";
import { chromaTaper, oklchToSrgb } from "./oklab";

/**
 * The grid every continuous sample lands on: one millionth.
 *
 * Fine enough that no control in the catalogue can tell — the finest declared
 * `step` in the registry is three orders of magnitude coarser — and coarse
 * enough to swallow the last-bit disagreement of a transcendental.
 */
export const SAMPLE_QUANTUM = 1e-6;

/** Attempts a truncated normal makes before it gives up and clamps. */
const NORMAL_ATTEMPTS = 8;

/** Uniforms summed for one standard normal. See {@link standardNormal}. */
const IRWIN_HALL_TERMS = 12;

export class SampleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SampleError";
  }
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** Round to {@link SAMPLE_QUANTUM} and clamp back inside `range`. */
export function quantise(value: number, range: Range): number {
  const snapped = Math.round(value / SAMPLE_QUANTUM) * SAMPLE_QUANTUM;
  // Rounding can step a hair outside a bound that is not itself on the grid, so
  // the clamp comes after. Both orders are defensible; this one cannot produce
  // an illegal value, which is the property `coerceParams` would otherwise have
  // to repair and log.
  const clamped = clamp(snapped, range[0], range[1]);
  // Negative zero is collapsed onto zero. `Math.round(-0.4)` is `-0`, and a
  // clamp against a lower bound of 0 leaves it there, because `-0 < 0` is false.
  // It matters twice: `graph/hash.ts` has to normalise it away to stop two
  // identical documents hashing differently, and `JSON.stringify(-0)` writes
  // `0`, so a saved document would not round-trip to the value it held. Both are
  // better fixed at the one place the value is produced.
  return clamped === 0 ? 0 : clamped;
}

/**
 * Pick from a weighted set.
 *
 * Weights are relative, not probabilities — that is what `Weighted<T>` says —
 * so they are summed and a point is drawn along the total. Every weight is
 * positive by `validateRegistry`, and an empty or non-positive set throws rather
 * than returning the first entry, because the silent version of this bug is a
 * parameter whose "random" value is the same one forever.
 */
export function weightedChoice<T>(rng: Pcg32, entries: readonly Weighted<T>[]): T {
  if (entries.length === 0) {
    throw new SampleError("cannot choose from an empty weighted set");
  }
  let total = 0;
  for (const entry of entries) {
    if (!Number.isFinite(entry.weight) || entry.weight <= 0) {
      throw new SampleError(
        `weight ${entry.weight} is not finite and greater than zero`,
      );
    }
    total += entry.weight;
  }

  const point = rng.nextF32() * total;
  let running = 0;
  for (const entry of entries) {
    running += entry.weight;
    if (point < running) return entry.value;
  }
  // Only reachable if the running sum lost the last entry to floating point,
  // which the half-open draw makes vanishingly unlikely. Returning the last
  // entry is exactly what the maths says should have happened.
  const last = entries[entries.length - 1];
  if (last === undefined) throw new SampleError("weighted set became empty mid-draw");
  return last.value;
}

/**
 * A standard normal, built from twelve uniforms (Irwin–Hall).
 *
 * Box–Muller is the usual answer and needs `Math.log` and `Math.cos`, both of
 * which are transcendentals whose last bit is unspecified. This needs neither:
 * the sum of twelve uniforms on `[0, 1)` has mean 6 and variance 1, so
 * subtracting 6 gives a mean-zero unit-variance draw out of pure addition, which
 * is exact `f64` arithmetic on every engine.
 *
 * The cost is that the result is bounded at ±6 sigma rather than unbounded, and
 * the tails past about 3 sigma are slightly thin. Neither matters for what this
 * is used for: the draw is truncated to the surprise range immediately
 * afterwards, and no surprise range in the catalogue is six sigma wide.
 */
export function standardNormal(rng: Pcg32): number {
  let sum = 0;
  for (let i = 0; i < IRWIN_HALL_TERMS; i += 1) sum += rng.nextF32();
  return sum - IRWIN_HALL_TERMS / 2;
}

/**
 * Sample a numeric surprise range under its declared distribution.
 *
 * The result is inside the surprise range, quantised, and — for an `int`
 * parameter — an integer. It is **not** clamped to the legal range here, because
 * `validateRegistry` has already proved the surprise range sits inside it.
 */
export function sampleNumeric(
  rng: Pcg32,
  surprise: NumericSurprise,
  integral: boolean,
): number {
  const [low, high] = surprise.range;
  if (!(low <= high)) {
    throw new SampleError(`surprise range [${low}, ${high}] is inverted`);
  }
  if (low === high) {
    // A degenerate range is legal and means "always this value". The draw still
    // happens, so turning a range into a point does not shift every later draw.
    rng.nextF32();
    return integral ? Math.round(low) : quantise(low, surprise.range);
  }

  const raw = drawNumeric(rng, surprise, low, high);
  if (!integral) return quantise(raw, surprise.range);

  // Rounded then clamped: `validateRegistry` requires an int parameter's
  // surprise bounds to be integral, so the clamp cannot reintroduce a fraction.
  return clamp(Math.round(raw), low, high);
}

function drawNumeric(
  rng: Pcg32,
  surprise: NumericSurprise,
  low: number,
  high: number,
): number {
  const distribution = surprise.distribution;
  switch (distribution.kind) {
    case "uniform":
      return rng.nextFloat(low, high);

    case "log": {
      // Flat in log space — the right default for anything measured in octaves
      // (cell size, radius, frequency), where uniform sampling spends most of
      // its draws in the top octave and every result looks the same.
      // `validateRegistry` refuses a log distribution on a range that is not
      // strictly positive, so the logarithms are defined.
      if (low <= 0) {
        throw new SampleError(
          `log sampling needs a strictly positive range; got [${low}, ${high}]`,
        );
      }
      const t = rng.nextF32();
      return Math.exp(Math.log(low) + (Math.log(high) - Math.log(low)) * t);
    }

    case "normal": {
      const { mean, sigma } = distribution;
      // Rejection, bounded. An unbounded loop would hang on a sigma small
      // relative to the distance from the mean to the nearer bound, which is a
      // legal declaration; eight attempts and then a clamp costs at most eight
      // draws and cannot spin. The clamp is reached for a declaration that puts
      // almost all of its mass outside its own range, which is a descriptor bug
      // worth having behave predictably rather than a case to design around.
      for (let attempt = 0; attempt < NORMAL_ATTEMPTS; attempt += 1) {
        const value = mean + sigma * standardNormal(rng);
        if (value >= low && value <= high) return value;
      }
      return clamp(mean + sigma * standardNormal(rng), low, high);
    }
  }
}

/** Draw a boolean at its declared probability (F-SM-04's bool analogue). */
export function sampleBool(rng: Pcg32, surprise: BoolSurprise): boolean {
  return rng.nextBool(surprise.trueProbability);
}

/**
 * Draw an enum from the subset the descriptor nominates.
 *
 * The subset is usually smaller than the legal set — a halftone dot shape is
 * legally any of four, but two of them carry the look — and
 * `validateRegistry` has already proved every nominated value is legal.
 */
export function sampleEnum(rng: Pcg32, surprise: EnumSurprise): string {
  return weightedChoice(rng, surprise.values);
}

/**
 * Draw a colour in OKLab.
 *
 * The hue range may be inverted, which is the declared way to say the arc wraps
 * through 0 — the only way to express "warm" as one range. Chroma is requested
 * and then reduced to whatever sRGB can show at that lightness and hue, so a
 * parameter declaring a wide chroma range does not silently produce clipped,
 * hue-shifted colours (see `oklab.ts`).
 */
export function sampleColor(rng: Pcg32, surprise: ColorSurprise): SrgbTriplet {
  const l = rng.nextFloat(surprise.lightness[0], surprise.lightness[1]);
  const c = rng.nextFloat(surprise.chroma[0], surprise.chroma[1]);
  const h = sampleHue(rng, surprise.hue);
  return oklchToSrgb({ l, c, h });
}

/** A hue in `[0, 360)` from a range that may wrap through zero. */
export function sampleHue(rng: Pcg32, hue: Range): number {
  const [from, to] = hue;
  const span = from <= to ? to - from : 360 - from + to;
  const drawn = from + rng.nextFloat(0, span);
  return ((drawn % 360) + 360) % 360;
}

/**
 * The named curve shapes, as control points.
 *
 * Sampling control points directly produces curves that are legal and useless —
 * non-monotonic in intent, clipped at both ends, flat through the midtones —
 * which is F-SM-04's noise-versus-result distinction in its most extreme form.
 * So an archetype is drawn and then jittered.
 *
 * Every one spans `x = 0` to `x = 1` with strictly increasing `x`, which is what
 * `registry/params.ts` requires of a transfer curve: a curve that stops short of
 * `x = 1` leaves the brightest pixels with no defined output.
 */
export const CURVE_ARCHETYPES: Readonly<Record<CurveArchetype, readonly CurvePoint[]>> = {
  linear: [
    { x: 0, y: 0 },
    { x: 0.5, y: 0.5 },
    { x: 1, y: 1 },
  ],
  "s-curve": [
    { x: 0, y: 0 },
    { x: 0.25, y: 0.14 },
    { x: 0.5, y: 0.5 },
    { x: 0.75, y: 0.86 },
    { x: 1, y: 1 },
  ],
  "inverse-s": [
    { x: 0, y: 0 },
    { x: 0.25, y: 0.36 },
    { x: 0.5, y: 0.5 },
    { x: 0.75, y: 0.64 },
    { x: 1, y: 1 },
  ],
  lift: [
    { x: 0, y: 0.14 },
    { x: 0.5, y: 0.58 },
    { x: 1, y: 1 },
  ],
  crush: [
    { x: 0, y: 0 },
    { x: 0.5, y: 0.38 },
    { x: 1, y: 0.9 },
  ],
  invert: [
    { x: 0, y: 1 },
    { x: 0.5, y: 0.5 },
    { x: 1, y: 0 },
  ],
};

/**
 * Draw a transfer curve: an archetype, jittered in `y` only.
 *
 * **`x` is never jittered.** A curve has to stay a function of `x` with strictly
 * increasing control points and has to span the whole domain; moving `x` risks
 * both, and repairing the result afterwards would invent a transfer function
 * nobody drew. Moving `y` cannot break either property and is where the look
 * lives anyway — it is the response, not the sampling positions.
 */
export function sampleCurve(rng: Pcg32, surprise: CurveSurprise): readonly CurvePoint[] {
  const archetype = weightedChoice(rng, surprise.archetypes);
  const points = CURVE_ARCHETYPES[archetype];
  const jitter = clamp(surprise.jitter, 0, 1);
  return points.map((point) => ({
    x: point.x,
    y: clamp(quantise(point.y + rng.nextFloat(-jitter, jitter), [0, 1]), 0, 1),
  }));
}

/**
 * Move a sampled value back toward the default — the chaos slider's
 * "parameter deviation from defaults" (F-SM-07).
 *
 * `deviation` of 1 keeps the sample whole; 0 returns the default. Both endpoints
 * are legal values and the legal range is an interval, so every point between
 * them is legal too — which is why this needs no clamp of its own.
 */
export function towardDefault(
  sampled: number,
  fallback: number,
  deviation: number,
): number {
  const d = clamp(deviation, 0, 1);
  return fallback + (sampled - fallback) * d;
}

/** Chroma taper re-exported so palette synthesis reads as one vocabulary. */
export { chromaTaper };
