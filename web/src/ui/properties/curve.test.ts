import { describe, expect, it } from "vitest";

import type { CurvePoint } from "../../types/document";
import {
  MIN_POINT_GAP,
  copyCurve,
  evaluateCurve,
  insertCurvePoint,
  moveCurvePoint,
  nearestPoint,
  removeCurvePoint,
  sampleCurve,
} from "./curve";

const LINEAR: readonly CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

const S_CURVE: readonly CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 0.25, y: 0.15 },
  { x: 0.75, y: 0.85 },
  { x: 1, y: 1 },
];

/** The shape a non-monotone cubic overshoots on: a near-step in the middle. */
const STEP: readonly CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 0.45, y: 0.05 },
  { x: 0.55, y: 0.95 },
  { x: 1, y: 1 },
];

describe("evaluateCurve", () => {
  it("is the identity for a two-point diagonal", () => {
    for (const x of [0, 0.1, 0.33, 0.5, 0.75, 1]) {
      expect(evaluateCurve(LINEAR, x)).toBeCloseTo(x, 10);
    }
  });

  it("passes exactly through every control point", () => {
    for (const point of S_CURVE) {
      expect(evaluateCurve(S_CURVE, point.x)).toBeCloseTo(point.y, 12);
    }
  });

  it("clamps outside the domain rather than extrapolating", () => {
    expect(evaluateCurve(S_CURVE, -5)).toBe(0);
    expect(evaluateCurve(S_CURVE, 5)).toBe(1);
  });

  it("never leaves the unit square", () => {
    for (const points of [S_CURVE, STEP]) {
      for (const sample of sampleCurve(points, 401)) {
        expect(sample.y).toBeGreaterThanOrEqual(0);
        expect(sample.y).toBeLessThanOrEqual(1);
      }
    }
  });

  it("does not overshoot: a monotone control polygon gives a monotone curve", () => {
    // This is the whole reason for the Fritsch-Carlson limiter. A plain cubic
    // through STEP dips below y(0.45) on the way up and comes back, which is a
    // tone scale that runs backwards for part of its range.
    for (const points of [S_CURVE, STEP]) {
      const samples = sampleCurve(points, 401);
      for (let i = 1; i < samples.length; i += 1) {
        const previous = samples[i - 1];
        const current = samples[i];
        if (previous === undefined || current === undefined) continue;
        expect(current.y).toBeGreaterThanOrEqual(previous.y - 1e-12);
      }
    }
  });

  it("holds a flat segment flat", () => {
    const flat: readonly CurvePoint[] = [
      { x: 0, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
    ];
    expect(evaluateCurve(flat, 0.25)).toBeCloseTo(0.5, 12);
  });
});

describe("sampleCurve", () => {
  it("returns the requested count and spans the domain", () => {
    const samples = sampleCurve(S_CURVE, 33);
    expect(samples).toHaveLength(33);
    expect(samples[0]?.x).toBe(0);
    expect(samples[32]?.x).toBe(1);
  });

  it("never returns fewer than the two endpoints", () => {
    expect(sampleCurve(LINEAR, 0)).toHaveLength(2);
  });
});

describe("moveCurvePoint", () => {
  it("locks the first and last points to the ends of the domain", () => {
    const moved = moveCurvePoint(S_CURVE, 0, 0.4, 0.2);
    expect(moved[0]).toEqual({ x: 0, y: 0.2 });
    const movedLast = moveCurvePoint(S_CURVE, 3, 0.4, 0.7);
    expect(movedLast[3]).toEqual({ x: 1, y: 0.7 });
  });

  it("keeps an interior point between its neighbours", () => {
    const moved = moveCurvePoint(S_CURVE, 1, 0.99, 0.5);
    const point = moved[1];
    expect(point?.x).toBeCloseTo(0.75 - MIN_POINT_GAP, 12);
    const back = moveCurvePoint(S_CURVE, 1, -1, 0.5);
    expect(back[1]?.x).toBeCloseTo(MIN_POINT_GAP, 12);
  });

  it("clamps y into the unit square", () => {
    expect(moveCurvePoint(S_CURVE, 1, 0.25, 9)[1]?.y).toBe(1);
    expect(moveCurvePoint(S_CURVE, 1, 0.25, -9)[1]?.y).toBe(0);
  });

  it("returns the same array when nothing moved", () => {
    expect(moveCurvePoint(S_CURVE, 1, 0.25, 0.15)).toBe(S_CURVE);
    expect(moveCurvePoint(S_CURVE, 99, 0.5, 0.5)).toBe(S_CURVE);
  });

  it("leaves the curve strictly increasing in x, which the schema requires", () => {
    const moved = moveCurvePoint(S_CURVE, 2, 0.1, 0.5);
    for (let i = 1; i < moved.length; i += 1) {
      const previous = moved[i - 1];
      const current = moved[i];
      if (previous === undefined || current === undefined) continue;
      expect(current.x).toBeGreaterThan(previous.x);
    }
  });
});

describe("insertCurvePoint", () => {
  it("inserts in sorted position and reports where", () => {
    const inserted = insertCurvePoint(LINEAR, 0.5, 0.8);
    expect(inserted.index).toBe(1);
    expect(inserted.points).toHaveLength(3);
    expect(inserted.points[1]).toEqual({ x: 0.5, y: 0.8 });
  });

  it("refuses a point on top of an existing one", () => {
    const inserted = insertCurvePoint(S_CURVE, 0.25 + MIN_POINT_GAP / 2, 0.9);
    expect(inserted.index).toBe(-1);
    expect(inserted.points).toBe(S_CURVE);
  });

  it("refuses a point on the domain boundary, where an endpoint already is", () => {
    expect(insertCurvePoint(LINEAR, 0, 0.5).index).toBe(-1);
    expect(insertCurvePoint(LINEAR, 1, 0.5).index).toBe(-1);
  });

  it("clamps y", () => {
    expect(insertCurvePoint(LINEAR, 0.5, 4).points[1]?.y).toBe(1);
  });
});

describe("removeCurvePoint", () => {
  it("removes an interior point", () => {
    expect(removeCurvePoint(S_CURVE, 1)).toHaveLength(3);
  });

  it("refuses the endpoints", () => {
    expect(removeCurvePoint(S_CURVE, 0)).toBe(S_CURVE);
    expect(removeCurvePoint(S_CURVE, 3)).toBe(S_CURVE);
  });

  it("refuses to go below two points", () => {
    expect(removeCurvePoint(LINEAR, 0)).toBe(LINEAR);
    expect(removeCurvePoint(LINEAR, 1)).toBe(LINEAR);
  });
});

describe("nearestPoint", () => {
  it("finds a point inside the radius", () => {
    expect(nearestPoint(S_CURVE, 0.26, 0.16, 0.05)).toBe(1);
  });

  it("finds nothing outside it", () => {
    expect(nearestPoint(S_CURVE, 0.5, 0.5, 0.02)).toBe(-1);
  });
});

describe("copyCurve", () => {
  it("does not alias the document's points", () => {
    const copy = copyCurve(S_CURVE);
    expect(copy).toEqual(S_CURVE);
    expect(copy[0]).not.toBe(S_CURVE[0]);
  });
});
