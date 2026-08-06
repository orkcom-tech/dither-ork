/**
 * The transfer curve: interpolation and editing.
 *
 * A `curve` parameter is stored as its control points and nothing else
 * (`web/src/types/document.ts`), which leaves the interpolation between them
 * undecided by the schema. **This module is that decision**: monotone cubic
 * Hermite with Fritsch–Carlson tangent limiting. Any node that consumes a curve
 * has to evaluate it the same way, or the curve the user drew is not the curve
 * that renders — so it is exported, and {@link evaluateCurve} is the one
 * definition.
 *
 * Monotone rather than plain Catmull–Rom because a transfer curve that
 * overshoots is a transfer curve that inverts locally: drag one point up and a
 * plain cubic dips *below* its neighbour on the way there, so a stretch of the
 * tone scale runs backwards and a smooth ramp comes out with a band in it. The
 * limiter is what stops that, and it costs a dozen lines.
 *
 * Nothing here is random and nothing reads a clock.
 */

import type { CurvePoint } from "../../types/document";

/**
 * Closest two control points may sit in x.
 *
 * The schema requires strictly increasing x, so coincident points are not
 * merely ugly — a zero-width segment divides by zero in the tangent
 * calculation. A thousandth of the domain is under half a pixel on a curve
 * widget of any usable size.
 */
export const MIN_POINT_GAP = 0.001;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Tangents at each control point, limited so the interpolant cannot overshoot.
 *
 * Fritsch, F. N. and Carlson, R. E., "Monotone Piecewise Cubic Interpolation",
 * SIAM Journal on Numerical Analysis 17 (1980). The three-point average gives
 * smoothness; the circle condition `a² + b² <= 9` is what gives monotonicity.
 */
function tangents(points: readonly CurvePoint[]): readonly number[] {
  const n = points.length;
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (a === undefined || b === undefined) return [];
    const dx = b.x - a.x;
    slopes.push(dx === 0 ? 0 : (b.y - a.y) / dx);
  }

  const m: number[] = new Array<number>(n).fill(0);
  m[0] = slopes[0] ?? 0;
  m[n - 1] = slopes[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i += 1) {
    const previous = slopes[i - 1] ?? 0;
    const next = slopes[i] ?? 0;
    // A local extremum: the tangent must be flat there or the curve turns
    // around inside the segment.
    m[i] = previous * next <= 0 ? 0 : (previous + next) / 2;
  }

  for (let i = 0; i < n - 1; i += 1) {
    const slope = slopes[i] ?? 0;
    if (slope === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = (m[i] ?? 0) / slope;
    const b = (m[i + 1] ?? 0) / slope;
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      m[i] = scale * a * slope;
      m[i + 1] = scale * b * slope;
    }
  }
  return m;
}

/**
 * The curve's value at `x`.
 *
 * `x` outside the unit interval is clamped rather than extrapolated: the
 * schema requires the control points to span x = 0 to x = 1, so there is
 * nothing outside the domain to extrapolate towards.
 */
export function evaluateCurve(points: readonly CurvePoint[], x: number): number {
  if (points.length === 0) return clamp01(x);
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return clamp01(x);
  if (points.length === 1) return clamp01(first.y);

  const at = clamp01(x);
  if (at <= first.x) return clamp01(first.y);
  if (at >= last.x) return clamp01(last.y);

  let segment = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const next = points[i + 1];
    if (next !== undefined && at <= next.x) {
      segment = i;
      break;
    }
    segment = i;
  }

  const a = points[segment];
  const b = points[segment + 1];
  if (a === undefined || b === undefined) return clamp01(first.y);

  const h = b.x - a.x;
  if (h <= 0) return clamp01(b.y);

  const m = tangents(points);
  const ma = m[segment] ?? 0;
  const mb = m[segment + 1] ?? 0;

  const t = (at - a.x) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;

  return clamp01(h00 * a.y + h10 * h * ma + h01 * b.y + h11 * h * mb);
}

/**
 * The curve as a polyline, for drawing.
 *
 * Sampling rather than emitting cubic path segments so that what is drawn is
 * {@link evaluateCurve} by construction. A path built from the Hermite control
 * points would be a second implementation of the same maths, and the failure it
 * produces — a widget that draws one curve while the renderer applies another —
 * is the one that cannot be seen by looking at the widget.
 */
export function sampleCurve(
  points: readonly CurvePoint[],
  samples: number,
): readonly CurvePoint[] {
  const count = Math.max(2, Math.trunc(samples));
  const out: CurvePoint[] = [];
  for (let i = 0; i < count; i += 1) {
    const x = i / (count - 1);
    out.push({ x, y: evaluateCurve(points, x) });
  }
  return out;
}

// --- editing ------------------------------------------------------------

/**
 * Move one control point.
 *
 * The endpoints keep their x. A transfer curve has to span the whole domain —
 * the registry validator rejects one that does not — so dragging the first
 * point off x = 0 would produce a curve the document cannot hold. Their y moves
 * freely, which is what makes lift and crush possible at all.
 */
export function moveCurvePoint(
  points: readonly CurvePoint[],
  index: number,
  x: number,
  y: number,
): readonly CurvePoint[] {
  const target = points[index];
  if (target === undefined) return points;

  const isFirst = index === 0;
  const isLast = index === points.length - 1;
  const previous = points[index - 1];
  const next = points[index + 1];

  const lower = previous === undefined ? 0 : previous.x + MIN_POINT_GAP;
  const upper = next === undefined ? 1 : next.x - MIN_POINT_GAP;

  const nextX = isFirst ? 0 : isLast ? 1 : Math.min(Math.max(x, lower), upper);
  const nextY = clamp01(y);
  if (nextX === target.x && nextY === target.y) return points;

  const out = [...points];
  out[index] = { x: nextX, y: nextY };
  return out;
}

export interface CurveInsertion {
  readonly points: readonly CurvePoint[];
  /** Index of the new point, or `-1` when nothing was inserted. */
  readonly index: number;
}

/**
 * Add a control point at `x`.
 *
 * Refused when it would land within {@link MIN_POINT_GAP} of an existing point,
 * rather than nudged aside: a click that lands on top of a point is a click
 * that meant to grab it, and inventing a second point a thousandth away is a
 * curve the user did not ask for.
 */
export function insertCurvePoint(
  points: readonly CurvePoint[],
  x: number,
  y: number,
): CurveInsertion {
  const at = clamp01(x);
  for (const point of points) {
    if (Math.abs(point.x - at) < MIN_POINT_GAP) return { points, index: -1 };
  }
  if (at <= 0 || at >= 1) return { points, index: -1 };

  let index = points.length;
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (point !== undefined && point.x > at) {
      index = i;
      break;
    }
  }
  const out = [...points];
  out.splice(index, 0, { x: at, y: clamp01(y) });
  return { points: out, index };
}

/**
 * Remove a control point.
 *
 * The two endpoints are not removable, and neither is anything once only two
 * points are left: both are what makes the curve span its domain.
 */
export function removeCurvePoint(
  points: readonly CurvePoint[],
  index: number,
): readonly CurvePoint[] {
  if (points.length <= 2) return points;
  if (index <= 0 || index >= points.length - 1) return points;
  const out = [...points];
  out.splice(index, 1);
  return out;
}

/**
 * The control point nearest `(x, y)` within `radius`, in unit-square distance,
 * or `-1`.
 *
 * The widget is square, so one radius in unit space is one radius in pixels
 * scaled by the same factor on both axes.
 */
export function nearestPoint(
  points: readonly CurvePoint[],
  x: number,
  y: number,
  radius: number,
): number {
  let best = -1;
  let bestDistance = radius * radius;
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (point === undefined) continue;
    const dx = point.x - x;
    const dy = point.y - y;
    const distance = dx * dx + dy * dy;
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/** A defensive copy — the document's points must not be aliased into the editor. */
export function copyCurve(points: readonly CurvePoint[]): readonly CurvePoint[] {
  return points.map((point) => ({ x: point.x, y: point.y }));
}
