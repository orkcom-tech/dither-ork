/**
 * Colour arithmetic the palette editor needs and nothing else has.
 *
 * The forward half — `srgbToLinear`, `linearToSrgb`, `linearToOklab` — already
 * exists in `gpu/resources.ts` with coefficients that match `core/…/color.rs`
 * exactly, so it is imported rather than written a second time. Two copies of
 * those coefficients is how a swatch and the pixel it is supposed to produce
 * end up different colours.
 *
 * Imported from `gpu/resources` directly rather than through the `gpu` barrel:
 * the barrel re-exports the device, the compiler, the scheduler and the
 * boundary, and a palette panel has no business pulling the whole GPU layer
 * into its module graph to convert a hex string.
 *
 * **What is written here and should not be**: {@link oklabToLinear}. The
 * inverse transform lives in the core (`palette.rs`, itself noting it belongs
 * in `color.rs`) and is not exported across the WASM boundary, so the ramp
 * generator has nowhere to get it from. Coefficients are Ottosson's published
 * inverse matrices, transcribed from the core so the two agree.
 */

import type { SrgbTriplet } from "../../types/document";
import { linearToOklab, linearToSrgb, srgbToLinear } from "../../gpu/resources";

/** OKLab coordinates, the same triple `core/…/color.rs` carries. */
export interface Oklab {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

/**
 * Round and clamp to an 8-bit channel.
 *
 * The `+ 0.5` rounding matches `quantize_u8` in the core, so a colour that
 * travels TS -> core -> TS lands on the same byte.
 */
export function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** Linear light in `[0, 1]` to an 8-bit sRGB code value. */
export function linearToByte(value: number): number {
  return Math.trunc(Math.min(1, Math.max(0, linearToSrgb(value))) * 255 + 0.5);
}

/**
 * Parse `#rgb`, `#rrggbb`, or either without the hash.
 *
 * Returns `null` on anything else rather than guessing. The hex field shows the
 * text as invalid and keeps the palette as it was; substituting black for a
 * typo is the kind of silent repair that gets discovered at export.
 */
export function parseHex(text: string): SrgbTriplet | null {
  const body = text.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]+$/.test(body)) return null;

  if (body.length === 3) {
    const r = body[0];
    const g = body[1];
    const b = body[2];
    if (r === undefined || g === undefined || b === undefined) return null;
    return [
      Number.parseInt(r + r, 16),
      Number.parseInt(g + g, 16),
      Number.parseInt(b + b, 16),
    ];
  }
  if (body.length === 6) {
    return [
      Number.parseInt(body.slice(0, 2), 16),
      Number.parseInt(body.slice(2, 4), 16),
      Number.parseInt(body.slice(4, 6), 16),
    ];
  }
  return null;
}

/** `#rrggbb`, lower case. What `<input type="color">` reads and writes. */
export function formatHex(rgb: SrgbTriplet): string {
  const hex = (v: number): string => clampByte(v).toString(16).padStart(2, "0");
  return `#${hex(rgb[0])}${hex(rgb[1])}${hex(rgb[2])}`;
}

/** Linear light for an 8-bit sRGB triplet. */
export function tripletToLinear(rgb: SrgbTriplet): readonly [number, number, number] {
  return [
    srgbToLinear(clampByte(rgb[0]) / 255),
    srgbToLinear(clampByte(rgb[1]) / 255),
    srgbToLinear(clampByte(rgb[2]) / 255),
  ];
}

/** OKLab for an 8-bit sRGB triplet, through linear light — never from the code values. */
export function tripletToOklab(rgb: SrgbTriplet): Oklab {
  const linear = tripletToLinear(rgb);
  const [l, a, b] = linearToOklab(linear[0], linear[1], linear[2]);
  return { l, a, b };
}

/**
 * OKLab hue angle in `[0, 2pi)`, matching `hue_angle` in `core/…/palette.rs`.
 *
 * **What a neutral actually does, measured rather than assumed.** The core's
 * comment says a neutral has `a == b == 0`, that `atan2(0, 0)` is zero, and
 * that neutrals therefore collect at the *start* of a hue order. The first
 * clause is not true of the arithmetic: the forward matrix's rows do not sum to
 * exactly one, so a grey comes out with a chroma around `5e-8` rather than
 * zero, and the angle of that residual is a fixed `1.5009 rad`.
 *
 * The practical consequence is smaller than it sounds and is worth stating
 * exactly, because it is what a hue sort of a mixed palette looks like:
 *
 * - Every non-black neutral lands on the *same* angle, so neutrals still group
 *   together and still sort among themselves by lightness, which is what the
 *   core was after.
 * - That angle sits between red (`0.51`) and yellow (`1.92`), not at the start.
 * - Pure black is the exception and is genuinely zero, so it leads.
 *
 * This is mirrored rather than corrected. A chroma epsilon here would be an
 * ordering the core does not produce, and the copy would then change behaviour
 * on the day `sort_order` is bound across the WASM boundary and this file is
 * deleted. The fix belongs in the core.
 */
export function hueAngle(c: Oklab): number {
  const h = Math.atan2(c.b, c.a);
  return h < 0 ? h + Math.PI * 2 : h;
}

/**
 * OKLab to linear-light sRGB primaries. Ottosson's inverse matrices,
 * transcribed from `oklab_to_linear` in `core/…/palette.rs`.
 *
 * Does not clamp. OKLab is larger than the sRGB gamut, so an interpolated
 * coordinate can name a colour sRGB cannot show, and the ramp generator has to
 * be able to count how often that happened.
 */
export function oklabToLinear(c: Oklab): readonly [number, number, number] {
  const l_ = c.l + 0.39633778 * c.a + 0.21580376 * c.b;
  const m_ = c.l - 0.105561346 * c.a - 0.06385417 * c.b;
  const s_ = c.l - 0.08948418 * c.a - 1.2914855 * c.b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return [
    4.0767417 * l - 3.3077116 * m + 0.23096994 * s,
    -1.268438 * l + 2.6097574 * m - 0.34131938 * s,
    -0.0041960863 * l - 0.7034186 * m + 1.7076147 * s,
  ];
}

/**
 * Which ink to draw on top of a swatch.
 *
 * OKLab lightness rather than an sRGB average: the point of the label is that
 * it stays readable, and readability tracks perceptual lightness. The 0.62
 * threshold is where dark ink starts winning on this theme's two ink colours.
 */
export function inkOn(rgb: SrgbTriplet): "dark" | "light" {
  return tripletToOklab(rgb).l >= 0.62 ? "dark" : "light";
}

/** Unpack the document's flat triplet array into swatch colours. */
export function unpackColors(colors: readonly number[]): SrgbTriplet[] {
  if (colors.length % 3 !== 0) {
    throw new RangeError(
      `a packed palette needs a multiple of 3 components, got ${colors.length}`,
    );
  }
  const out: SrgbTriplet[] = [];
  for (let i = 0; i < colors.length; i += 3) {
    out.push([
      clampByte(colors[i] ?? 0),
      clampByte(colors[i + 1] ?? 0),
      clampByte(colors[i + 2] ?? 0),
    ]);
  }
  return out;
}

/** Pack swatch colours into the flat array `.dork` and the WASM boundary take. */
export function packColors(colors: readonly SrgbTriplet[]): number[] {
  const out: number[] = [];
  for (const c of colors) out.push(clampByte(c[0]), clampByte(c[1]), clampByte(c[2]));
  return out;
}
