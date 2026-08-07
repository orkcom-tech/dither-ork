/**
 * The sampling primitives.
 *
 * Every one of these is a pure function of a seeded generator, so each test is a
 * fixed seed and an exact expectation rather than a statistical one — except
 * where the property under test *is* statistical, in which case the seed is
 * still fixed and the tolerance cannot flake.
 */

import { describe, expect, it } from "vitest";

import type { CurveSurprise, NumericSurprise } from "../types/registry";
import { seededPcg32 } from "./rng";
import {
  CURVE_ARCHETYPES,
  SAMPLE_QUANTUM,
  SampleError,
  quantise,
  sampleColor,
  sampleCurve,
  sampleEnum,
  sampleHue,
  sampleNumeric,
  standardNormal,
  towardDefault,
  weightedChoice,
} from "./sample";

describe("weightedChoice", () => {
  it("honours the relative weights", () => {
    const rng = seededPcg32(7n);
    const counts = new Map<string, number>();
    for (let i = 0; i < 20_000; i += 1) {
      const value = weightedChoice(rng, [
        { value: "a", weight: 3 },
        { value: "b", weight: 1 },
      ]);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    expect((counts.get("a") ?? 0) / 20_000).toBeCloseTo(0.75, 2);
  });

  it("refuses an empty set rather than returning nothing", () => {
    expect(() => weightedChoice(seededPcg32(1n), [])).toThrow(SampleError);
  });

  it("refuses a non-positive weight", () => {
    expect(() =>
      weightedChoice(seededPcg32(1n), [{ value: "a", weight: 0 }]),
    ).toThrow(SampleError);
  });

  it("can reach every entry, including the last", () => {
    const rng = seededPcg32(3n);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i += 1) {
      seen.add(
        weightedChoice(rng, [
          { value: 0, weight: 1 },
          { value: 1, weight: 1 },
          { value: 2, weight: 1 },
        ]),
      );
    }
    expect([...seen].sort()).toEqual([0, 1, 2]);
  });
});

describe("quantise", () => {
  it("lands values on the sampling grid", () => {
    const value = quantise(0.1234567891, [0, 1]);
    expect(Math.abs(Math.round(value / SAMPLE_QUANTUM) * SAMPLE_QUANTUM - value)).toBeLessThan(
      1e-12,
    );
  });

  it("never leaves the range it was given", () => {
    expect(quantise(1.0000004, [0, 1])).toBe(1);
    expect(quantise(-0.0000004, [0, 1])).toBe(0);
  });

  /**
   * `Math.round(-0.4)` is `-0`, and clamping against a lower bound of zero
   * leaves it there because `-0 < 0` is false. It has to be collapsed at the
   * source: `graph/hash.ts` normalises it so two identical documents do not
   * hash differently, and `JSON.stringify(-0)` writes `0`, so a saved document
   * would come back holding a different value than it was given.
   */
  it("never produces negative zero", () => {
    expect(Object.is(quantise(-0.0000004, [0, 1]), -0)).toBe(false);
    expect(Object.is(quantise(-0.0000004, [-1, 1]), -0)).toBe(false);
    expect(Object.is(quantise(-0, [-1, 1]), -0)).toBe(false);
  });
});

describe("sampleNumeric", () => {
  const uniform: NumericSurprise = {
    range: [2, 8],
    distribution: { kind: "uniform" },
    weight: 1,
  };

  it("stays inside the surprise range", () => {
    const rng = seededPcg32(11n);
    for (let i = 0; i < 2_000; i += 1) {
      const v = sampleNumeric(rng, uniform, false);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(8);
    }
  });

  it("returns integers for an int parameter", () => {
    const rng = seededPcg32(12n);
    for (let i = 0; i < 500; i += 1) {
      expect(Number.isInteger(sampleNumeric(rng, uniform, true))).toBe(true);
    }
  });

  it("spends its draws across octaves under a log distribution", () => {
    // The whole reason `log` exists: a uniform draw over 1..256 puts about half
    // its results above 128, where every cell size looks the same. A log draw
    // puts about an eighth there, one per octave.
    const log: NumericSurprise = {
      range: [1, 256],
      distribution: { kind: "log" },
      weight: 1,
    };
    const rng = seededPcg32(13n);
    let topOctave = 0;
    for (let i = 0; i < 8_000; i += 1) {
      if (sampleNumeric(rng, log, false) > 128) topOctave += 1;
    }
    expect(topOctave / 8_000).toBeGreaterThan(0.08);
    expect(topOctave / 8_000).toBeLessThan(0.2);
  });

  it("refuses a log distribution over a range that reaches zero", () => {
    const bad: NumericSurprise = {
      range: [0, 4],
      distribution: { kind: "log" },
      weight: 1,
    };
    expect(() => sampleNumeric(seededPcg32(1n), bad, false)).toThrow(SampleError);
  });

  it("clusters a normal distribution around its mean and stays in range", () => {
    const normal: NumericSurprise = {
      range: [0, 10],
      distribution: { kind: "normal", mean: 5, sigma: 1 },
      weight: 1,
    };
    const rng = seededPcg32(14n);
    let inside = 0;
    for (let i = 0; i < 5_000; i += 1) {
      const v = sampleNumeric(rng, normal, false);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(10);
      if (v >= 4 && v <= 6) inside += 1;
    }
    // One sigma either side of the mean should hold roughly 68% of the mass.
    expect(inside / 5_000).toBeGreaterThan(0.6);
    expect(inside / 5_000).toBeLessThan(0.76);
  });

  it("clamps rather than spinning when a normal cannot reach its own range", () => {
    // A descriptor bug: the mean sits on a bound and sigma is tiny, so almost
    // every draw lands outside. The bounded rejection loop has to terminate.
    const pathological: NumericSurprise = {
      range: [0, 1],
      distribution: { kind: "normal", mean: 0, sigma: 0.0001 },
      weight: 1,
    };
    const rng = seededPcg32(15n);
    for (let i = 0; i < 200; i += 1) {
      const v = sampleNumeric(rng, pathological, false);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("treats a degenerate range as a constant and still consumes a draw", () => {
    const point: NumericSurprise = {
      range: [3, 3],
      distribution: { kind: "uniform" },
      weight: 1,
    };
    const a = seededPcg32(16n);
    const b = seededPcg32(16n);
    expect(sampleNumeric(a, point, false)).toBe(3);
    b.nextF32();
    // Both generators are now at the same position: turning a range into a point
    // must not shift everything drawn after it.
    expect(a.nextU32()).toBe(b.nextU32());
  });
});

describe("standardNormal", () => {
  it("has mean zero and unit variance", () => {
    const rng = seededPcg32(17n);
    let sum = 0;
    let sumSquares = 0;
    const n = 20_000;
    for (let i = 0; i < n; i += 1) {
      const z = standardNormal(rng);
      sum += z;
      sumSquares += z * z;
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.03);
    expect(Math.abs(sumSquares / n - 1)).toBeLessThan(0.05);
  });

  it("is bounded at plus or minus six, which is the documented trade", () => {
    const rng = seededPcg32(18n);
    for (let i = 0; i < 20_000; i += 1) {
      const z = standardNormal(rng);
      expect(z).toBeGreaterThanOrEqual(-6);
      expect(z).toBeLessThanOrEqual(6);
    }
  });
});

describe("sampleHue", () => {
  it("draws from a plain arc", () => {
    const rng = seededPcg32(19n);
    for (let i = 0; i < 1_000; i += 1) {
      const h = sampleHue(rng, [30, 90]);
      expect(h).toBeGreaterThanOrEqual(30);
      expect(h).toBeLessThanOrEqual(90);
    }
  });

  it("draws from an arc that wraps through zero", () => {
    // `min > max` is the declared way to say the arc wraps — the only way to
    // express "warm" as one range.
    const rng = seededPcg32(20n);
    let belowThirty = 0;
    let aboveThreeThirty = 0;
    for (let i = 0; i < 2_000; i += 1) {
      const h = sampleHue(rng, [330, 30]);
      expect(h >= 330 || h <= 30).toBe(true);
      if (h <= 30) belowThirty += 1;
      if (h >= 330) aboveThreeThirty += 1;
    }
    expect(belowThirty).toBeGreaterThan(500);
    expect(aboveThreeThirty).toBeGreaterThan(500);
  });
});

describe("sampleColor", () => {
  it("returns an 8-bit triplet inside gamut", () => {
    const rng = seededPcg32(21n);
    for (let i = 0; i < 500; i += 1) {
      const colour = sampleColor(rng, {
        lightness: [0.2, 0.9],
        chroma: [0, 0.4],
        hue: [0, 359],
        weight: 1,
      });
      expect(colour).toHaveLength(3);
      for (const component of colour) {
        expect(Number.isInteger(component)).toBe(true);
        expect(component).toBeGreaterThanOrEqual(0);
        expect(component).toBeLessThanOrEqual(255);
      }
    }
  });

  it("keeps lightness where it was asked for", () => {
    // The point of sampling in OKLab: a dark request comes back dark, which
    // three independent sRGB channel draws would not guarantee.
    const rng = seededPcg32(22n);
    for (let i = 0; i < 200; i += 1) {
      const colour = sampleColor(rng, {
        lightness: [0.1, 0.2],
        chroma: [0, 0.1],
        hue: [0, 359],
        weight: 1,
      });
      // OKLab L of 0.2 is a very dark colour; every channel should be well down.
      expect(Math.max(...colour)).toBeLessThan(96);
    }
  });
});

describe("sampleEnum", () => {
  it("only ever returns a value from the declared subset", () => {
    const rng = seededPcg32(23n);
    for (let i = 0; i < 500; i += 1) {
      const value = sampleEnum(rng, {
        values: [
          { value: "round", weight: 2 },
          { value: "diamond", weight: 1 },
        ],
        weight: 1,
      });
      expect(["round", "diamond"]).toContain(value);
    }
  });
});

describe("sampleCurve", () => {
  const surprise: CurveSurprise = {
    archetypes: [
      { value: "s-curve", weight: 1 },
      { value: "crush", weight: 1 },
      { value: "invert", weight: 1 },
    ],
    jitter: 0.2,
    weight: 1,
  };

  it("produces a curve the document schema accepts", () => {
    const rng = seededPcg32(24n);
    for (let i = 0; i < 500; i += 1) {
      const curve = sampleCurve(rng, surprise);
      expect(curve.length).toBeGreaterThanOrEqual(2);
      expect(curve[0]?.x).toBe(0);
      expect(curve[curve.length - 1]?.x).toBe(1);
      let previous = Number.NEGATIVE_INFINITY;
      for (const point of curve) {
        expect(point.x).toBeGreaterThan(previous);
        previous = point.x;
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(1);
      }
    }
  });

  it("never moves x, so the domain stays covered and the curve stays a function", () => {
    const rng = seededPcg32(25n);
    const shapes = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      const curve = sampleCurve(rng, surprise);
      shapes.add(curve.map((p) => p.x).join(","));
    }
    // Three archetypes, and the only distinct x sets are theirs.
    for (const shape of shapes) {
      const found = Object.values(CURVE_ARCHETYPES).some(
        (archetype) => archetype.map((p) => p.x).join(",") === shape,
      );
      expect(found).toBe(true);
    }
  });

  it("every archetype is itself a legal curve", () => {
    for (const [name, points] of Object.entries(CURVE_ARCHETYPES)) {
      expect(points.length, name).toBeGreaterThanOrEqual(2);
      expect(points[0]?.x, name).toBe(0);
      expect(points[points.length - 1]?.x, name).toBe(1);
      let previous = Number.NEGATIVE_INFINITY;
      for (const point of points) {
        expect(point.x, name).toBeGreaterThan(previous);
        previous = point.x;
        expect(point.y, name).toBeGreaterThanOrEqual(0);
        expect(point.y, name).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("towardDefault", () => {
  it("returns the default at zero deviation and the sample at one", () => {
    expect(towardDefault(10, 2, 0)).toBe(2);
    expect(towardDefault(10, 2, 1)).toBe(10);
    expect(towardDefault(10, 2, 0.5)).toBe(6);
  });

  it("clamps a deviation outside 0..1 rather than extrapolating past the sample", () => {
    expect(towardDefault(10, 2, 2)).toBe(10);
    expect(towardDefault(10, 2, -1)).toBe(2);
  });
});
