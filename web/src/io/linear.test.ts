/**
 * The transfer, in both directions (F-IN-02), and the alpha rule (F-IN-03).
 *
 * The first test in here is the one the whole project rests on. Everything else
 * — every kernel, every palette match, every golden image — is computed on the
 * numbers this file produces, and getting it wrong is invisible: the picture is
 * simply muddy, which reads as a look rather than as a bug.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../lib/log";
import {
  linearOfSrgbByte,
  linearSurfaceFromSrgbBytes,
  srgbBytesFromLinearSurface,
} from "./linear";

setLevel("error");

describe("sRGB transfer removal (F-IN-02)", () => {
  it("takes mid-grey to its linear value, not to its code value", () => {
    // 128/255 = 0.502 as a code. In linear light it is 0.2159. A pipeline that
    // used 0.502 would still average back to mid-grey in a 1-bit dither test —
    // it is the *midtones of a gradient* that come out wrong, which no
    // aggregate measure catches.
    expect(linearOfSrgbByte(128)).toBeCloseTo(0.21586, 5);
    expect(linearOfSrgbByte(128)).not.toBeCloseTo(128 / 255, 3);
  });

  it("pins the ends and the toe of the curve", () => {
    expect(linearOfSrgbByte(0)).toBe(0);
    expect(linearOfSrgbByte(255)).toBeCloseTo(1, 6);
    // Below the knee the transfer is the linear segment c/12.92.
    expect(linearOfSrgbByte(10)).toBeCloseTo(10 / 255 / 12.92, 8);
    // Just above it, the power segment.
    expect(linearOfSrgbByte(64)).toBeCloseTo(0.0512695, 6);
  });

  it("is monotonic across all 256 codes", () => {
    for (let code = 1; code < 256; code += 1) {
      expect(linearOfSrgbByte(code)).toBeGreaterThan(linearOfSrgbByte(code - 1));
    }
  });
});

describe("round trip", () => {
  it("returns every 8-bit code value unchanged", () => {
    // 256 codes in, 256 codes out. If the table and the encoder disagreed by
    // half a code anywhere, an image loaded and immediately exported would come
    // back different — the failure that would be blamed on the effects.
    const data = new Uint8ClampedArray(256 * 4);
    for (let code = 0; code < 256; code += 1) {
      const at = code * 4;
      data[at] = code;
      data[at + 1] = code;
      data[at + 2] = code;
      data[at + 3] = 255;
    }

    const surface = linearSurfaceFromSrgbBytes(data, 256, 1);
    const back = srgbBytesFromLinearSurface(surface, 256, 1);

    for (let code = 0; code < 256; code += 1) {
      expect(back[code * 4]).toBe(code);
      expect(back[code * 4 + 1]).toBe(code);
      expect(back[code * 4 + 2]).toBe(code);
      expect(back[code * 4 + 3]).toBe(255);
    }
  });

  it("returns every 8-bit alpha value unchanged", () => {
    const data = new Uint8ClampedArray(256 * 4);
    for (let code = 0; code < 256; code += 1) data[code * 4 + 3] = code;
    const back = srgbBytesFromLinearSurface(
      linearSurfaceFromSrgbBytes(data, 256, 1),
      256,
      1,
    );
    for (let code = 0; code < 256; code += 1) expect(back[code * 4 + 3]).toBe(code);
  });
});

describe("alpha (F-IN-03)", () => {
  it("carries no transfer — it is coverage, not colour", () => {
    const data = new Uint8ClampedArray([128, 128, 128, 128]);
    const surface = linearSurfaceFromSrgbBytes(data, 1, 1);
    // The colour channels went through the curve; alpha did not.
    expect(surface.a[0]).toBeCloseTo(128 / 255, 6);
    expect(surface.r[0]).toBeCloseTo(0.21586, 5);
  });

  it("keeps the colour of a fully transparent pixel", () => {
    // The silent-compositing failure this requirement names: a transparent red
    // pixel becomes white (composited) or black (multiplied out) and the colour
    // is gone before any effect sees it.
    const data = new Uint8ClampedArray([255, 0, 0, 0]);
    const surface = linearSurfaceFromSrgbBytes(data, 1, 1);
    expect(surface.r[0]).toBeCloseTo(1, 6);
    expect(surface.g[0]).toBe(0);
    expect(surface.a[0]).toBe(0);

    const back = srgbBytesFromLinearSurface(surface, 1, 1);
    expect([back[0], back[1], back[2], back[3]]).toEqual([255, 0, 0, 0]);
  });

  it("does not associate alpha into the colour channels", () => {
    const data = new Uint8ClampedArray([255, 255, 255, 64]);
    const surface = linearSurfaceFromSrgbBytes(data, 1, 1);
    expect(surface.r[0]).toBeCloseTo(1, 6);
    expect(surface.r[0]).not.toBeCloseTo(64 / 255, 3);
  });
});

describe("the edge of the pipeline", () => {
  it("clamps out-of-range linear values rather than wrapping them", () => {
    const surface = {
      residency: "cpu" as const,
      r: new Float32Array([2, -1]),
      g: new Float32Array([0, 0]),
      b: new Float32Array([0, 0]),
      a: new Float32Array([1, 1]),
    };
    const back = srgbBytesFromLinearSurface(surface, 2, 1);
    expect(back[0]).toBe(255);
    expect(back[4]).toBe(0);
  });

  it("turns a NaN into black rather than into whatever a cast produces", () => {
    const surface = {
      residency: "cpu" as const,
      r: new Float32Array([Number.NaN]),
      g: new Float32Array([Number.NaN]),
      b: new Float32Array([Number.NaN]),
      a: new Float32Array([Number.NaN]),
    };
    const back = srgbBytesFromLinearSurface(surface, 1, 1);
    expect([back[0], back[1], back[2], back[3]]).toEqual([0, 0, 0, 0]);
  });

  it("refuses a buffer whose length does not match the extent", () => {
    expect(() => linearSurfaceFromSrgbBytes(new Uint8ClampedArray(12), 2, 2)).toThrow(
      /expected 16 bytes/,
    );
    const surface = linearSurfaceFromSrgbBytes(new Uint8ClampedArray(16), 2, 2);
    expect(() => srgbBytesFromLinearSurface(surface, 3, 3)).toThrow(/expected 9/);
  });
});
