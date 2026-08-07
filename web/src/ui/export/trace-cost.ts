/**
 * The one trace setting combination that looks like a hang (F-EX-08, F-EX-09).
 *
 * Pixel-perfect tracing walks every connected run of a single palette index and
 * emits a contour for it. On a dithered megapixel image almost every run is one
 * pixel long, so the tracer emits a contour per pixel — hundreds of thousands of
 * four-point squares — and the WASM call that produces them has no cancellation
 * point inside it (see `web/src/export/trace.ts`). The panel shows "measuring…"
 * and never comes back. Nothing is broken; the answer is simply enormous.
 *
 * The minimum feature size is what stops it, and its default is off. That is the
 * right default — silently dropping detail from a drawing somebody asked to be
 * pixel-exact would be worse — so the fix is to *say so before the trace starts*
 * rather than to change the setting underneath the user.
 *
 * ## Why "off" is `< 2` and not `=== 0`
 *
 * `core/crates/dither-core/src/trace.rs` gates the whole filter on
 * `min_feature_area > 1`, and even without that gate a region of area 1 passes
 * `areas[root] >= 1`. So a minimum feature area of exactly 1 removes nothing:
 * it is the same setting as 0 wearing a different number. This module treats it
 * as off, and the panel labels it as off, because a control that reads "1 px²"
 * while filtering nothing is a control that lies.
 */

import type { TraceMode, VectorTraceSettings } from "../../export";

/**
 * The smallest minimum feature area the core acts on.
 *
 * Below this the filter is skipped entirely — `trace.rs`, `min_feature_area > 1`.
 */
export const MIN_FEATURE_FILTER_FLOOR = 2;

/**
 * Where "large enough to notice" starts, in pixels.
 *
 * A megapixel is the number in the report that named this bug, and it is about
 * where the contour count stops being something a browser draws in a moment. It
 * is a threshold for *warning*, not for refusing: below it the same settings
 * still produce a contour per pixel, they just produce few enough of them that
 * nobody waits.
 */
export const TRACE_CONTOUR_WARNING_PIXELS = 1_000_000;

/**
 * The tolerance at which Douglas-Peucker collapses a one-pixel square.
 *
 * A unit square's ring is cut at two opposite corners, and the remaining two
 * corners each sit `sqrt(2) / 2` from that diagonal. At or above that the chain
 * simplifies to its endpoints, the ring drops below three points, and
 * `simplify()` discards the contour and counts it in `contoursDropped`. Stated
 * as the fact it is, so the advice below ("at least 1") is a rounded-up version
 * of something true rather than a guess.
 */
export const SPECK_COLLAPSING_TOLERANCE = Math.SQRT2 / 2;

/**
 * Group thousands, so the number that matters is legible at a glance.
 *
 * `1200000` and `12000000` are the same shape to the eye, and the whole point of
 * quoting the count is that the reader should recoil from it. Grouped here
 * rather than with `toLocaleString` because the separator would then depend on
 * the machine's locale, and a test that pins the sentence would pass on one
 * developer's machine and fail on another's.
 */
function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Whether this minimum feature area removes anything at all. */
export function minFeatureFilters(minFeatureArea: number): boolean {
  return minFeatureArea >= MIN_FEATURE_FILTER_FLOOR;
}

/**
 * Whether this mode drops the smallest specks on its own.
 *
 * Simplified does, once the tolerance is large enough to flatten a single pixel;
 * pixel-perfect never does, because reproducing the staircase exactly is the
 * whole of what it promises.
 */
export function modeCollapsesSpecks(mode: TraceMode, tolerance: number): boolean {
  return mode === "simplified" && tolerance >= SPECK_COLLAPSING_TOLERANCE;
}

export interface TraceCostWarning {
  /** The problem in one line. */
  readonly headline: string;
  /** Why it happens, in terms of the settings that cause it. */
  readonly mechanism: string;
  /** What to change. Each entry names a control that is on screen. */
  readonly fixes: readonly string[];
  /**
   * One contour per pixel — the worst case, which a fine dither approaches.
   *
   * Carried as a number rather than baked into the prose so the panel can format
   * it and a test can assert it without matching a sentence.
   */
  readonly worstCaseContours: number;
}

/**
 * Warn about a trace that will emit a contour per pixel, or `null`.
 *
 * `pixels` is the source extent: a vector export ignores the scale multiplier
 * (there is no pixel grid to replicate), so the traced image is always the
 * subject at 1:1.
 *
 * Returns `null` for every other combination rather than hedging. A warning that
 * fires on settings which are fine is a warning people learn to scroll past, and
 * this one has to be read the first time.
 */
export function traceCostWarning(
  settings: VectorTraceSettings,
  pixels: number,
): TraceCostWarning | null {
  if (!Number.isFinite(pixels) || pixels < TRACE_CONTOUR_WARNING_PIXELS) return null;
  if (minFeatureFilters(settings.minFeatureArea)) return null;
  if (modeCollapsesSpecks(settings.mode, settings.tolerance)) return null;

  const worstCaseContours = Math.floor(pixels);
  return {
    headline:
      "These settings can take minutes and look like a hang. Nothing is broken — the answer is simply enormous.",
    mechanism:
      `Pixel-perfect tracing emits one contour per connected run of a single colour, and the minimum ` +
      `feature size is off, so nothing removes the single-pixel ones. A dither at this size is mostly ` +
      `single pixels: up to ${grouped(worstCaseContours)} contours, each a four-point square. The tracer runs in ` +
      `the worker as one call that cannot be interrupted, so the estimate will sit at “measuring…” until ` +
      `it finishes.`,
    fixes: [
      `Raise “min. feature” to at least ${MIN_FEATURE_FILTER_FLOOR} px². It removes whole regions before ` +
        `any contour is extracted, which is the direct fix; the result line reports how much of the ` +
        `picture it left bare.`,
      `Or set “outline” to Simplified with a tolerance of at least 1. Douglas-Peucker flattens a ` +
        `one-pixel square to nothing and the contour is dropped, so the specks go without a size filter.`,
    ],
    worstCaseContours,
  };
}
