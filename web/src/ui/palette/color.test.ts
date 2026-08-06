import { describe, expect, it } from "vitest";

import {
  clampByte,
  formatHex,
  hueAngle,
  inkOn,
  linearToByte,
  oklabToLinear,
  packColors,
  parseHex,
  tripletToLinear,
  tripletToOklab,
  unpackColors,
} from "./color";

describe("parseHex", () => {
  it("reads both lengths, with and without the hash", () => {
    expect(parseHex("#ff8800")).toEqual([255, 136, 0]);
    expect(parseHex("ff8800")).toEqual([255, 136, 0]);
    expect(parseHex("#f80")).toEqual([255, 136, 0]);
    expect(parseHex("  #FF8800  ")).toEqual([255, 136, 0]);
  });

  it("refuses what it cannot read rather than guessing", () => {
    // Substituting a colour for a typo is the failure that gets found at
    // export; every one of these has to come back null.
    for (const bad of ["", "#", "#ff", "#ffff", "#fffff", "#gggggg", "rgb(1,2,3)", "#ff88000"]) {
      expect(parseHex(bad), bad).toBeNull();
    }
  });

  it("round-trips through formatHex", () => {
    for (const hex of ["#000000", "#ffffff", "#0d0f0c", "#8ee06a"]) {
      const parsed = parseHex(hex);
      expect(parsed).not.toBeNull();
      if (parsed !== null) expect(formatHex(parsed)).toBe(hex);
    }
  });
});

describe("clampByte", () => {
  it("rounds and clamps", () => {
    expect(clampByte(-1)).toBe(0);
    expect(clampByte(300)).toBe(255);
    expect(clampByte(127.5)).toBe(128);
    expect(clampByte(Number.NaN)).toBe(0);
  });
});

describe("oklab", () => {
  it("puts sRGB mid-grey near 0.214 in linear light", () => {
    // The reason the whole pipeline is linear: sRGB 0.5 is not 0.5 of the
    // light. Same assertion the core makes in `color.rs`.
    const [r] = tripletToLinear([128, 128, 128]);
    expect(r).toBeGreaterThan(0.2);
    expect(r).toBeLessThan(0.23);
  });

  it("leaves a neutral with a chroma residual rather than an exact zero", () => {
    // Measured, not assumed. The core's `hue_angle` comment says a neutral has
    // a == b == 0; the forward matrix's rows do not sum to exactly one, so it
    // does not. The residual is far below anything an eye resolves — visible
    // chroma runs to 0.33 — but it is not zero, and a hue sort is built on it.
    for (const grey of [64, 128, 200, 255]) {
      const lab = tripletToOklab([grey, grey, grey]);
      const chroma = Math.hypot(lab.a, lab.b);
      expect(chroma).toBeGreaterThan(0);
      expect(chroma).toBeLessThan(1e-6);
    }
  });

  it("puts every non-black neutral on one hue angle, so they still group", () => {
    // The consequence that matters for F-CO-06: neutrals do collect together
    // and do sort among themselves by lightness, but at 1.5009 rad — between
    // red and yellow — rather than at the start of the order.
    const angles = [64, 128, 200, 255].map((v) => hueAngle(tripletToOklab([v, v, v])));
    for (const angle of angles) expect(angle).toBeCloseTo(1.500885, 5);

    const red = hueAngle(tripletToOklab([255, 0, 0]));
    const yellow = hueAngle(tripletToOklab([255, 255, 0]));
    expect(red).toBeLessThan(angles[0] ?? 0);
    expect(angles[0] ?? 0).toBeLessThan(yellow);
  });

  it("gives pure black a hue of exactly zero, so it leads a hue order", () => {
    const lab = tripletToOklab([0, 0, 0]);
    expect(Math.hypot(lab.a, lab.b)).toBe(0);
    expect(hueAngle(lab)).toBe(0);
  });

  it("orders hue red < yellow < green < blue", () => {
    const angle = (rgb: readonly [number, number, number]): number =>
      hueAngle(tripletToOklab(rgb));
    expect(angle([255, 0, 0])).toBeLessThan(angle([255, 255, 0]));
    expect(angle([255, 255, 0])).toBeLessThan(angle([0, 255, 0]));
    expect(angle([0, 255, 0])).toBeLessThan(angle([0, 0, 255]));
  });

  it("returns hue in [0, 2pi)", () => {
    for (const rgb of [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 0, 255],
      [12, 200, 90],
    ] as const) {
      const h = hueAngle(tripletToOklab(rgb));
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(Math.PI * 2);
    }
  });

  it("inverts itself back to the byte it started from", () => {
    // The ramp's correctness rests on this: forward and inverse are the core's
    // two matrices, and a transcription error in either shows up here.
    for (const rgb of [
      [0, 0, 0],
      [255, 255, 255],
      [128, 128, 128],
      [255, 136, 0],
      [13, 200, 91],
      [3, 7, 251],
    ] as const) {
      const linear = oklabToLinear(tripletToOklab(rgb));
      const back = [
        linearToByte(linear[0]),
        linearToByte(linear[1]),
        linearToByte(linear[2]),
      ] as const;
      // Within one code value: the two matrices are single-precision constants
      // and the round trip is three cube roots and three cubes.
      expect(Math.abs(back[0] - rgb[0]), `r of ${rgb.join(",")}`).toBeLessThanOrEqual(1);
      expect(Math.abs(back[1] - rgb[1]), `g of ${rgb.join(",")}`).toBeLessThanOrEqual(1);
      expect(Math.abs(back[2] - rgb[2]), `b of ${rgb.join(",")}`).toBeLessThanOrEqual(1);
    }
  });
});

describe("inkOn", () => {
  it("picks dark ink on light swatches and light ink on dark ones", () => {
    expect(inkOn([255, 255, 255])).toBe("dark");
    expect(inkOn([0, 0, 0])).toBe("light");
    expect(inkOn([255, 255, 0])).toBe("dark");
    expect(inkOn([0, 0, 128])).toBe("light");
  });
});

describe("packing", () => {
  it("round-trips a palette through the document's flat layout", () => {
    const colors = [
      [0, 0, 0],
      [255, 136, 0],
      [8, 24, 32],
    ] as const;
    expect(unpackColors(packColors(colors))).toEqual([...colors]);
  });

  it("refuses a packed list that is not a multiple of three", () => {
    expect(() => unpackColors([1, 2, 3, 4])).toThrow(RangeError);
  });
});
