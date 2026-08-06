/**
 * F-IN-02 — the transfer, removed on the way in and reapplied on the way out.
 *
 * This is the rule the whole project rests on. Everything between these two
 * functions is linear light: the diffusion kernels, the palette match, every
 * compute pass. Diffusing error in sRGB instead of linear light is the single
 * most common reason naive dither implementations look muddy
 * (docs/ARCHITECTURE.md, "Colour"), and it is invisible in any aggregate
 * measure — the picture is simply wrong in a way that reads as a style choice.
 *
 * **One implementation of the transfer, not two.** `srgbToLinear` and
 * `linearToSrgb` are imported from `gpu/resources.ts`, which is where the
 * palette upload uses them and where they match `color.rs`. A second copy here
 * would be two functions that agree today.
 *
 * **The table is exact, not an approximation.** There are 256 possible 8-bit
 * code values, so the forward direction is a lookup built once from the same
 * function rather than a `Math.pow` per channel per pixel — the same numbers,
 * about fifteen times faster on a 4000x3000 image, and no place for the two to
 * disagree because the table *is* the function.
 *
 * **Alpha carries no transfer** (F-IN-03). It is a coverage fraction, not a
 * colour, so it scales linearly by 255 in both directions. It is also
 * unassociated throughout and is never composited onto anything — the
 * checkerboard the viewport draws is the only thing that ever appears behind
 * the image.
 */

import type { CpuColorSurface } from "../types/graph";
import { linearToSrgb, srgbToLinear } from "../gpu/resources";

/** Every 8-bit sRGB code value, in linear light. Built once, at module load. */
const SRGB_TO_LINEAR_8BIT: Float32Array = buildTable();

function buildTable(): Float32Array {
  const table = new Float32Array(256);
  for (let code = 0; code < 256; code += 1) table[code] = srgbToLinear(code / 255);
  return table;
}

/** The linear value of one 8-bit sRGB code. Exposed so tests can pin the table. */
export function linearOfSrgbByte(code: number): number {
  return SRGB_TO_LINEAR_8BIT[code] ?? 0;
}

/**
 * Interleaved 8-bit sRGB RGBA to the planar linear-light `f32` the pipeline
 * carries.
 *
 * Planar because the serial kernels walk one channel at a time and per-channel
 * diffusion (F-ED-CTL) is then a choice of which planes to touch rather than a
 * strided access pattern — see `CpuColorSurface`.
 */
export function linearSurfaceFromSrgbBytes(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): CpuColorSurface {
  const pixels = width * height;
  if (data.length !== pixels * 4) {
    throw new RangeError(
      `expected ${pixels * 4} bytes for ${width}x${height} RGBA, got ${data.length}`,
    );
  }

  const r = new Float32Array(pixels);
  const g = new Float32Array(pixels);
  const b = new Float32Array(pixels);
  const a = new Float32Array(pixels);

  for (let i = 0; i < pixels; i += 1) {
    const at = i * 4;
    r[i] = SRGB_TO_LINEAR_8BIT[data[at] ?? 0] ?? 0;
    g[i] = SRGB_TO_LINEAR_8BIT[data[at + 1] ?? 0] ?? 0;
    b[i] = SRGB_TO_LINEAR_8BIT[data[at + 2] ?? 0] ?? 0;
    a[i] = (data[at + 3] ?? 0) / 255;
  }

  return { residency: "cpu", r, g, b, a };
}

/**
 * The inverse, for the screen and for export: linear light back to 8-bit sRGB.
 *
 * Values outside `[0, 1]` are clamped rather than wrapped. A stack can produce
 * them — an overshooting error term, a blend that adds — and the display has
 * nowhere to put them; clamping at the edge is the only place in the pipeline
 * where that is true, which is why nothing upstream does it.
 */
// The return type is inferred rather than annotated, and that is deliberate:
// TypeScript 5.7 made the typed arrays generic over their buffer, `ImageData`
// accepts only an `ArrayBuffer`-backed view, and writing the annotation as a
// bare `Uint8ClampedArray` widens it to `ArrayBufferLike` — which then cannot be
// handed to `new ImageData`, in a library where `SharedArrayBuffer` is very much
// in scope. Inference keeps the precise type without pinning a lib version.
export function srgbBytesFromLinearSurface(
  surface: CpuColorSurface,
  width: number,
  height: number,
) {
  const pixels = width * height;
  if (
    surface.r.length !== pixels ||
    surface.g.length !== pixels ||
    surface.b.length !== pixels ||
    surface.a.length !== pixels
  ) {
    throw new RangeError(
      `planes are ${surface.r.length}/${surface.g.length}/${surface.b.length}/${surface.a.length} long, expected ${pixels} for ${width}x${height}`,
    );
  }

  const data = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    const at = i * 4;
    data[at] = encode(surface.r[i] ?? 0);
    data[at + 1] = encode(surface.g[i] ?? 0);
    data[at + 2] = encode(surface.b[i] ?? 0);
    // Alpha again carries no transfer, and stays unassociated: nothing here
    // multiplies the colour channels by it.
    data[at + 3] = Math.round(clamp01(surface.a[i] ?? 0) * 255);
  }
  return data;
}

function encode(linear: number): number {
  return Math.round(linearToSrgb(clamp01(linear)) * 255);
}

function clamp01(value: number): number {
  // NaN falls through both comparisons and would reach `Math.round` as NaN,
  // which a Uint8ClampedArray stores as 0 — a black pixel with no explanation.
  if (Number.isNaN(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}
