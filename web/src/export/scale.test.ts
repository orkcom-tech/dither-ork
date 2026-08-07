/**
 * F-EX-12 — the integer nearest-neighbour multiplier.
 *
 * What has to be true: every output pixel is a byte-for-byte copy of a source
 * pixel (nothing averaged, nothing interpolated, no new colours), the block
 * layout is right in both axes, and a fractional multiplier is refused rather
 * than truncated.
 */

import { describe, expect, it } from "vitest";

import type { ExportFrame } from "./types";
import { scaleNearest } from "./scale";

function frame(width: number, height: number, pixels: readonly number[]): ExportFrame {
  return { width, height, data: new Uint8ClampedArray(pixels) };
}

describe("scaleNearest", () => {
  it("copies rather than aliasing the frame at 1x", async () => {
    // The matte flatten writes in place, so handing back the viewport's own
    // buffer would mean a JPEG export edited the picture on screen.
    const source = frame(2, 1, [1, 2, 3, 4, 5, 6, 7, 8]);
    const scaled = await scaleNearest(source, 1);
    expect([...scaled.data]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    scaled.data[0] = 99;
    expect(source.data[0]).toBe(1);
  });

  it("replicates each pixel into a square block", async () => {
    const source = frame(2, 2, [
      // r, g, b, a per pixel
      10, 0, 0, 255, 20, 0, 0, 255, 30, 0, 0, 255, 40, 0, 0, 255,
    ]);
    const scaled = await scaleNearest(source, 2);
    expect(scaled.width).toBe(4);
    expect(scaled.height).toBe(4);

    const red = (x: number, y: number): number =>
      scaled.data[(y * scaled.width + x) * 4] ?? 0;
    expect([red(0, 0), red(1, 0), red(0, 1), red(1, 1)]).toEqual([10, 10, 10, 10]);
    expect([red(2, 0), red(3, 1)]).toEqual([20, 20]);
    expect([red(0, 2), red(1, 3)]).toEqual([30, 30]);
    expect([red(2, 2), red(3, 3)]).toEqual([40, 40]);
  });

  it("invents no colour, at any multiplier", async () => {
    // The property an indexed export depends on: if scaling could interpolate,
    // a four-colour dither at 3x would stop being a four-colour image.
    const source = frame(3, 3, [
      0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255,
      255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255,
    ]);
    const scaled = await scaleNearest(source, 5);
    const distinct = new Set<number>();
    for (let i = 0; i < scaled.data.length; i += 4) distinct.add(scaled.data[i] ?? 0);
    expect([...distinct].sort((a, b) => a - b)).toEqual([0, 255]);
  });

  it("carries alpha through untouched", async () => {
    const source = frame(1, 1, [10, 20, 30, 40]);
    const scaled = await scaleNearest(source, 3);
    for (let i = 0; i < scaled.data.length; i += 4) {
      expect([...scaled.data.subarray(i, i + 4)]).toEqual([10, 20, 30, 40]);
    }
  });

  it("refuses a fractional or zero multiplier", async () => {
    const source = frame(1, 1, [0, 0, 0, 255]);
    await expect(scaleNearest(source, 1.5)).rejects.toThrow(/positive integer/);
    await expect(scaleNearest(source, 0)).rejects.toThrow(/positive integer/);
    await expect(scaleNearest(source, -2)).rejects.toThrow(/positive integer/);
  });

  it("refuses a buffer that does not match the extent", async () => {
    await expect(
      scaleNearest({ width: 4, height: 4, data: new Uint8ClampedArray(16) }, 2),
    ).rejects.toThrow(/expected 64 bytes/);
  });
});
