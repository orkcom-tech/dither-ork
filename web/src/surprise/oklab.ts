/**
 * OKLab, for the two places Surprise Me needs a colour it did not read from
 * somewhere: a random `color` parameter (F-SM-04) and palette synthesis
 * (F-SM-05).
 *
 * # Why not sRGB
 *
 * Drawing three sRGB channels independently clumps around muddy mid-greys, gives
 * uneven perceptual lightness, and makes "a random palette" mean "six colours
 * that are all about as dark as each other". OKLab separates lightness from
 * chroma and hue, so an even spread in `L` really is an even spread in
 * *apparent* lightness — which is the property F-SM-05 asks for by name, and the
 * reason `ColorSurprise` declares its range in OKLab rather than in bytes.
 *
 * # The transforms are imported, not written
 *
 * `srgbToLinear`, `linearToSrgb` and `linearToOklab` live in `gpu/resources.ts`
 * with coefficients that match `core/…/color.rs` exactly; the inverse,
 * `oklabToLinear`, lives in `ui/palette/color.ts`, transcribed from
 * `core/…/palette.rs` because the core does not export it across the WASM
 * boundary. Both are imported here rather than transcribed a third time. A third
 * copy of Ottosson's matrices is how a synthesised swatch and the pixel it is
 * supposed to produce end up different colours, and the file that already owns
 * the second copy says so at the top of itself.
 *
 * That makes this module import from `ui/palette/`, which is the wrong direction
 * for a domain module. It is a deep import of one leaf — `ui/palette/color.ts`
 * has no React, no store and no panel in it, and is itself unit-tested in a Node
 * environment — rather than of the `ui/palette` barrel, which would pull the
 * editor in. The alternative was a third transcription, and correctness of the
 * numbers wins over tidiness of the graph. If the core ever exports
 * `oklab_to_linear`, both copies go and this import goes with them.
 *
 * # Out-of-gamut colours are darkened in chroma, never clipped per channel
 *
 * OKLab is much larger than sRGB, so most (L, C, h) triples name a colour sRGB
 * cannot show. Clipping the three linear components independently is the obvious
 * thing and it is wrong in a visible way: it moves hue, so a saturated blue
 * clips to a violet and a saturated orange clips to a yellow, and a "random
 * triad" comes out as three colours that are not a triad. {@link oklchToSrgb}
 * reduces chroma — the coordinate that is out of range — until the colour fits,
 * which keeps hue and lightness and gives up only saturation.
 */

import type { SrgbTriplet } from "../types/document";
import { linearToByte, oklabToLinear } from "../ui/palette/color";

/** Polar OKLab: lightness, chroma, hue in degrees. */
export interface Oklch {
  /** OKLab L, in `[0, 1]`. */
  readonly l: number;
  /** OKLab chroma. sRGB tops out near 0.33. */
  readonly c: number;
  /** Degrees, any value; reduced into `[0, 360)` on use. */
  readonly h: number;
}

/** Bisection steps used to find the largest in-gamut chroma. */
const GAMUT_STEPS = 20;

/**
 * A component is treated as in gamut a hair outside `[0, 1]`.
 *
 * The bisection converges on the boundary, and a value that lands at
 * `1 + 1e-9` is the same 8-bit code as one at exactly 1. Without the tolerance
 * the search would spend every one of its steps on a difference no output can
 * represent.
 */
const GAMUT_EPSILON = 1e-6;

/** Degrees to radians, and into `[0, 2pi)`. */
function radians(degrees: number): number {
  const wrapped = ((degrees % 360) + 360) % 360;
  return (wrapped * Math.PI) / 180;
}

function inGamut(linear: readonly [number, number, number]): boolean {
  return linear.every((v) => v >= -GAMUT_EPSILON && v <= 1 + GAMUT_EPSILON);
}

function linearFor(l: number, c: number, hueRadians: number): readonly [number, number, number] {
  return oklabToLinear({
    l,
    a: c * Math.cos(hueRadians),
    b: c * Math.sin(hueRadians),
  });
}

/**
 * The largest chroma at this lightness and hue that sRGB can show, up to
 * `wanted`.
 *
 * Bisection rather than a closed form: the gamut boundary in OKLab is the image
 * of a cube under a cubic map and has no algebraic solution worth the code.
 * Twenty steps resolve chroma to about 3e-7, which is far below one 8-bit code.
 *
 * Exported because palette synthesis wants to *report* how much chroma it had to
 * give up — a scheme that came out grey because the requested chroma was
 * impossible at those lightnesses is worth stating rather than wondering about.
 */
export function maxChroma(l: number, wanted: number, hue: number): number {
  const hueRadians = radians(hue);
  if (wanted <= 0) return 0;
  if (inGamut(linearFor(l, wanted, hueRadians))) return wanted;

  let low = 0;
  let high = wanted;
  for (let i = 0; i < GAMUT_STEPS; i += 1) {
    const mid = (low + high) / 2;
    if (inGamut(linearFor(l, mid, hueRadians))) low = mid;
    else high = mid;
  }
  return low;
}

/**
 * An OKLCh colour as an 8-bit sRGB triplet, chroma-reduced into gamut.
 *
 * The rounding to bytes at the end is what makes a generated document
 * reproducible across platforms in practice as well as in principle: `cos`,
 * `sin` and `cbrt` are not required to be correctly rounded by either ECMAScript
 * or the C library, so two machines can disagree in the last bit or two of the
 * linear value — and then agree exactly on which of 256 codes it is. The same
 * qualifier docs/ARCHITECTURE.md records for `powf` and `cbrt` in the render
 * path applies here, and quantising to eight bits is what removes it.
 */
export function oklchToSrgb(colour: Oklch): SrgbTriplet {
  const c = maxChroma(colour.l, Math.max(0, colour.c), colour.h);
  const linear = linearFor(colour.l, c, radians(colour.h));
  return [linearToByte(linear[0]), linearToByte(linear[1]), linearToByte(linear[2])];
}

/**
 * `n` lightnesses evenly spaced across `[low, high]`, inclusive of both ends.
 *
 * "Even perceptual lightness spacing" from F-SM-05, and it is one line because
 * OKLab is where that is one line. A single entry sits in the middle rather than
 * at `low`, because a one-colour ramp has no direction to run in.
 */
export function evenLightness(n: number, low: number, high: number): readonly number[] {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`a lightness ramp needs at least one entry, got ${n}`);
  }
  if (n === 1) return [(low + high) / 2];
  const step = (high - low) / (n - 1);
  return Array.from({ length: n }, (_unused, i) => low + step * i);
}

/**
 * A chroma taper across a lightness ramp.
 *
 * Peak chroma in the middle, falling to a fraction of it at both ends. Not
 * decoration: at `L` near 0 or 1 the sRGB gamut is a needle, so a flat chroma
 * across a ramp gets bisected down to almost nothing at the ends anyway — and
 * the ramp then reads as "two greys and four colours" rather than as one ramp.
 * Tapering on purpose puts the entries where the gamut actually is.
 *
 * A parabola rather than a sinusoid so this is pure arithmetic: it is on the
 * path from a seed to a document, and `Math.sin` is one more transform whose
 * last bit is not specified.
 */
export function chromaTaper(t: number, peak: number, ends: number): number {
  const shaped = 1 - (2 * t - 1) * (2 * t - 1);
  return ends + (peak - ends) * shaped;
}
