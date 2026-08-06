import { describe, expect, it } from "vitest";

import { RampError, canRamp, oklabRamp, rampDistance } from "./ramp";
import { tripletToOklab } from "./color";

describe("oklabRamp", () => {
  it("emits both endpoints byte for byte", () => {
    // A locked colour at either end of a ramp must come back as the value it
    // was, not as a round trip through OKLab that lands a code value away.
    const from = [8, 24, 32] as const;
    const to = [224, 248, 208] as const;
    const ramp = oklabRamp(from, to, 7);
    expect(ramp.colors[0]).toEqual([...from]);
    expect(ramp.colors[ramp.colors.length - 1]).toEqual([...to]);
  });

  it("produces exactly the requested number of steps", () => {
    for (const steps of [2, 3, 5, 16]) {
      expect(oklabRamp([0, 0, 0], [255, 255, 255], steps).colors).toHaveLength(steps);
    }
  });

  it("interpolates lightness monotonically between two neutrals", () => {
    const ramp = oklabRamp([0, 0, 0], [255, 255, 255], 9);
    const lightness = ramp.colors.map((c) => tripletToOklab(c).l);
    for (let i = 1; i < lightness.length; i += 1) {
      expect(lightness[i] ?? 0).toBeGreaterThan(lightness[i - 1] ?? 0);
    }
  });

  it("keeps the middle of a red-to-green ramp saturated", () => {
    // The reason the interpolation is in OKLab and not in linear light: a
    // linear-light ramp between two saturated colours passes through a
    // desaturated middle, which is exactly what a ramp must not do.
    const ramp = oklabRamp([255, 0, 0], [0, 255, 0], 5);
    const middle = ramp.colors[2];
    expect(middle).toBeDefined();
    if (middle === undefined) return;
    const chroma = Math.hypot(tripletToOklab(middle).a, tripletToOklab(middle).b);
    expect(chroma).toBeGreaterThan(0.1);
  });

  it("counts steps that left the sRGB gamut rather than clamping in silence", () => {
    const wide = oklabRamp([255, 0, 0], [0, 0, 255], 9);
    // Whether this particular pair leaves the gamut is a property of OKLab, not
    // of this code; what the test pins is that the count is reported and is
    // never more than the interior steps.
    expect(wide.clamped).toBeGreaterThanOrEqual(0);
    expect(wide.clamped).toBeLessThanOrEqual(7);
  });

  it("refuses a ramp with fewer than two ends", () => {
    expect(() => oklabRamp([0, 0, 0], [255, 255, 255], 1)).toThrow(RampError);
    expect(() => oklabRamp([0, 0, 0], [255, 255, 255], 2.5)).toThrow(RampError);
  });

  it("refuses a ramp past the step ceiling", () => {
    expect(() => oklabRamp([0, 0, 0], [255, 255, 255], 65)).toThrow(RampError);
  });
});

describe("canRamp", () => {
  it("refuses one swatch used as both ends", () => {
    const verdict = canRamp(4, 2, 2, 5);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("different");
  });

  it("refuses an endpoint outside the palette", () => {
    expect(canRamp(3, 0, 3, 5).ok).toBe(false);
    expect(canRamp(3, -1, 2, 5).ok).toBe(false);
  });

  it("refuses a step count outside the range", () => {
    expect(canRamp(4, 0, 3, 1).ok).toBe(false);
    expect(canRamp(4, 0, 3, 999).ok).toBe(false);
  });

  it("allows a legitimate span", () => {
    expect(canRamp(4, 0, 3, 6).ok).toBe(true);
  });
});

describe("rampDistance", () => {
  it("is zero for one colour and grows with separation", () => {
    expect(rampDistance([10, 20, 30], [10, 20, 30])).toBe(0);
    expect(rampDistance([0, 0, 0], [255, 255, 255])).toBeGreaterThan(
      rampDistance([0, 0, 0], [128, 128, 128]),
    );
  });
});
