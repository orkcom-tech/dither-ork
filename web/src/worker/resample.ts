/**
 * The fractional source resampler — the missing half of F-UI-03.
 *
 * The viewport has always computed a preview factor (`viewport/quality.ts`,
 * `previewScaleFactor`) and the renderer has always ignored it, because a
 * reduced-resolution render needs a **source buffer at the reduced extent** and
 * the factor is fractional: it comes from the zoom and a pixel budget, so it is
 * not expressible as the integer `PassExtent` the two resampling nodes use.
 * docs/ARCHITECTURE.md wrote that down as the reason the requirement was not
 * honoured. This is that resampler.
 *
 * ## Area average, not point sampling
 *
 * Every output pixel is the area-weighted mean of the source pixels it covers.
 * Point sampling would be cheaper and would be wrong in a way that matters more
 * here than almost anywhere else: this application's whole subject is
 * high-frequency pattern, and dropping three of every four pixels of a source
 * before a dither runs on it produces aliasing that reads as *the dither*. The
 * preview would then be lying about the thing it exists to show.
 *
 * ## Linear light, and nothing else
 *
 * The surface is already linear-light planar `f32` (`io/linear.ts`), so
 * averaging is the correct operation on it directly — averaging sRGB code
 * values would darken every edge. Alpha is averaged as coverage and stays
 * unassociated (F-IN-03); nothing here multiplies colour by it.
 *
 * ## Deterministic
 *
 * Pure, allocation-only, no clock and no randomness — the same source and the
 * same extent give byte-identical planes on every call and in every worker.
 * That is what lets a preview frame be content-hashed and cached like any other.
 *
 * Downscale only. The caller clamps the factor to (0, 1]; asking this to
 * magnify would be asking it to invent detail, and it refuses rather than
 * producing a blur that looks like a render.
 */

import type { CpuColorSurface } from "../types/graph";

export interface Extent {
  readonly width: number;
  readonly height: number;
}

/**
 * The extent a preview render runs at.
 *
 * Rounded to whole pixels and floored at 1: an extent of zero has no pixels to
 * render and a fractional one has no meaning to a compute dispatch. The factor
 * is clamped rather than trusted, because it arrives from a division by a zoom
 * that a user can drive to anything.
 */
export function previewExtent(width: number, height: number, factor: number): Extent {
  const clamped = Number.isFinite(factor) ? Math.min(1, Math.max(factor, 0)) : 1;
  return {
    width: Math.max(1, Math.min(width, Math.round(width * clamped))),
    height: Math.max(1, Math.min(height, Math.round(height * clamped))),
  };
}

/** Whether an extent is the document's own, in which case nothing is resampled. */
export function isFullExtent(extent: Extent, width: number, height: number): boolean {
  return extent.width === width && extent.height === height;
}

/**
 * One axis of the box filter, precomputed.
 *
 * Built once per axis and reused for all four planes, because the weights
 * depend only on the two lengths. For a 3000-wide source this is three thousand
 * multiply-adds saved per plane per row.
 */
interface AxisPlan {
  /** First source index output `i` reads. */
  readonly first: Int32Array;
  /** How many source samples output `i` reads. */
  readonly count: Int32Array;
  /** Where output `i`'s weights begin in {@link weights}. */
  readonly at: Int32Array;
  /** Weights in output order; each output's run sums to 1. */
  readonly weights: Float32Array;
}

function axisPlan(from: number, to: number): AxisPlan {
  const scale = from / to;
  const first = new Int32Array(to);
  const count = new Int32Array(to);
  const at = new Int32Array(to);

  let total = 0;
  for (let i = 0; i < to; i += 1) {
    const lo = i * scale;
    const hi = (i + 1) * scale;
    const start = Math.min(from - 1, Math.floor(lo));
    const end = Math.min(from - 1, Math.max(start, Math.ceil(hi) - 1));
    first[i] = start;
    count[i] = end - start + 1;
    at[i] = total;
    total += end - start + 1;
  }

  const weights = new Float32Array(total);
  for (let i = 0; i < to; i += 1) {
    const lo = i * scale;
    const hi = (i + 1) * scale;
    const start = first[i] ?? 0;
    const run = count[i] ?? 1;
    const base = at[i] ?? 0;

    let sum = 0;
    for (let k = 0; k < run; k += 1) {
      const sample = start + k;
      const overlap = Math.min(hi, sample + 1) - Math.max(lo, sample);
      const weight = overlap > 0 ? overlap : 0;
      weights[base + k] = weight;
      sum += weight;
    }
    // Normalising per output pixel rather than by the constant `1 / scale` is
    // what keeps the last output pixel correct when `to` does not divide `from`:
    // its box is clipped by the edge of the image and its overlaps sum to less
    // than a whole source pixel.
    if (sum > 0) {
      for (let k = 0; k < run; k += 1) weights[base + k] = (weights[base + k] ?? 0) / sum;
    } else {
      // Only reachable if `scale` is degenerate, which the caller's clamp
      // prevents. Writing a unit weight rather than leaving zeroes means a bug
      // upstream shows as a wrong picture rather than as a black one.
      weights[base] = 1;
    }
  }

  return { first, count, at, weights };
}

function resamplePlane(
  source: Float32Array,
  from: Extent,
  to: Extent,
  x: AxisPlan,
  y: AxisPlan,
  scratch: Float32Array,
): Float32Array {
  // Horizontal first, into `scratch` at (to.width x from.height): the narrower
  // intermediate is what the vertical pass then walks, so the expensive axis is
  // paid once at the reduced width rather than at the source's.
  for (let row = 0; row < from.height; row += 1) {
    const inRow = row * from.width;
    const outRow = row * to.width;
    for (let column = 0; column < to.width; column += 1) {
      const start = x.first[column] ?? 0;
      const run = x.count[column] ?? 1;
      const base = x.at[column] ?? 0;
      let accumulated = 0;
      for (let k = 0; k < run; k += 1) {
        accumulated += (source[inRow + start + k] ?? 0) * (x.weights[base + k] ?? 0);
      }
      scratch[outRow + column] = accumulated;
    }
  }

  const out = new Float32Array(to.width * to.height);
  for (let row = 0; row < to.height; row += 1) {
    const start = y.first[row] ?? 0;
    const run = y.count[row] ?? 1;
    const base = y.at[row] ?? 0;
    const outRow = row * to.width;
    for (let column = 0; column < to.width; column += 1) {
      let accumulated = 0;
      for (let k = 0; k < run; k += 1) {
        accumulated +=
          (scratch[(start + k) * to.width + column] ?? 0) * (y.weights[base + k] ?? 0);
      }
      out[outRow + column] = accumulated;
    }
  }
  return out;
}

/**
 * The source at a smaller extent.
 *
 * Throws rather than magnifying: the only caller is the preview path, whose
 * factor is clamped to (0, 1], so an extent larger than the source is a bug
 * upstream and a silently blurred preview would hide it.
 */
export function resampleLinearSurface(
  surface: CpuColorSurface,
  from: Extent,
  to: Extent,
): CpuColorSurface {
  if (to.width > from.width || to.height > from.height) {
    throw new RangeError(
      `resampleLinearSurface only reduces: asked for ${to.width}x${to.height} from ${from.width}x${from.height}`,
    );
  }
  if (to.width < 1 || to.height < 1) {
    throw new RangeError(`a ${to.width}x${to.height} extent has no pixels`);
  }
  const pixels = from.width * from.height;
  if (
    surface.r.length !== pixels ||
    surface.g.length !== pixels ||
    surface.b.length !== pixels ||
    surface.a.length !== pixels
  ) {
    throw new RangeError(
      `planes are ${surface.r.length}/${surface.g.length}/${surface.b.length}/${surface.a.length} long, expected ${pixels} for ${from.width}x${from.height}`,
    );
  }

  const x = axisPlan(from.width, to.width);
  const y = axisPlan(from.height, to.height);
  // One scratch buffer for all four planes: they are resampled one after
  // another, so a second allocation would be a second copy of the intermediate
  // for no benefit.
  const scratch = new Float32Array(to.width * from.height);

  return {
    residency: "cpu",
    r: resamplePlane(surface.r, from, to, x, y, scratch),
    g: resamplePlane(surface.g, from, to, x, y, scratch),
    b: resamplePlane(surface.b, from, to, x, y, scratch),
    a: resamplePlane(surface.a, from, to, x, y, scratch),
  };
}
