/**
 * The curve widget draws what the renderer applies.
 *
 * A curve parameter is stored as its control points, so the interpolation
 * between them is a contract rather than data — and it is a contract held by
 * two pieces of code that never meet: `evaluateCurve` here, which is what the
 * editor draws and what the user therefore believes the curve is, and
 * `buildCurveLut` in the effect, which is what the shader actually samples.
 *
 * Both are monotone cubic Hermite with Fritsch–Carlson limiting, written
 * independently. This is the test that says so, and it is the only place the
 * two can be caught drifting: a widget that draws a shape the renderer does not
 * apply looks perfectly correct from the widget.
 *
 * The tolerance is the renderer's own precision, not slack. `buildCurveLut`
 * returns a `Float32Array` because that is what the shader samples, so every
 * entry has been rounded to single precision; the editor evaluates in double.
 * Six places is below what f32 can express and four orders of magnitude below
 * the 1/255 at which a tone becomes visible.
 */

import { describe, expect, it } from "vitest";

import { CURVES_DEFAULT_CURVE, CURVE_LUT_SIZE, buildCurveLut } from "../../effects/curves.effect";
import type { CurvePoint } from "../../types/document";
import { evaluateCurve } from "./curve";

const CASES: ReadonlyArray<readonly [string, readonly CurvePoint[]]> = [
  ["the descriptor default", CURVES_DEFAULT_CURVE],
  [
    "an s-curve",
    [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.15 },
      { x: 0.75, y: 0.85 },
      { x: 1, y: 1 },
    ],
  ],
  [
    "a near-step, where an unlimited cubic overshoots",
    [
      { x: 0, y: 0 },
      { x: 0.45, y: 0.05 },
      { x: 0.55, y: 0.95 },
      { x: 1, y: 1 },
    ],
  ],
  [
    "a lift with a flat shoulder",
    [
      { x: 0, y: 0.2 },
      { x: 0.5, y: 0.5 },
      { x: 0.8, y: 0.5 },
      { x: 1, y: 0.9 },
    ],
  ],
  [
    "an inversion",
    [
      { x: 0, y: 1 },
      { x: 0.5, y: 0.4 },
      { x: 1, y: 0 },
    ],
  ],
];

describe("the editor and the renderer interpolate identically", () => {
  for (const [name, points] of CASES) {
    it(name, () => {
      const lut = buildCurveLut(points);
      const last = CURVE_LUT_SIZE - 1;
      for (let i = 0; i < CURVE_LUT_SIZE; i += 1) {
        const x = i / last;
        expect(evaluateCurve(points, x)).toBeCloseTo(lut[i] ?? Number.NaN, 6);
      }
    });
  }
});
