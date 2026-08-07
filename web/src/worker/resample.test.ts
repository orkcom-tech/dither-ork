/**
 * The preview resampler, pinned.
 *
 * The properties here are the ones a wrong resampler would break silently. A
 * preview that is subtly darker, or that keeps every fourth pixel instead of
 * averaging four, still *looks* like a render — and this application's whole
 * subject is high-frequency pattern, so an aliased preview reads as a different
 * dither rather than as a bug.
 */

import { describe, expect, it } from "vitest";

import type { CpuColorSurface } from "../types/graph";
import { isFullExtent, previewExtent, resampleLinearSurface } from "./resample";

function surface(
  width: number,
  height: number,
  value: (x: number, y: number) => number,
): CpuColorSurface {
  const pixels = width * height;
  const r = new Float32Array(pixels);
  const g = new Float32Array(pixels);
  const b = new Float32Array(pixels);
  const a = new Float32Array(pixels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * width + x;
      const v = value(x, y);
      r[at] = v;
      g[at] = v * 0.5;
      b[at] = v * 0.25;
      a[at] = 1;
    }
  }
  return { residency: "cpu", r, g, b, a };
}

function mean(plane: Float32Array): number {
  let total = 0;
  for (const value of plane) total += value;
  return total / plane.length;
}

describe("previewExtent", () => {
  it("multiplies both axes and rounds to whole pixels", () => {
    expect(previewExtent(1000, 750, 0.5)).toEqual({ width: 500, height: 375 });
    expect(previewExtent(1001, 751, 0.5)).toEqual({ width: 501, height: 376 });
  });

  it("never exceeds the document, whatever the factor claims", () => {
    // The factor comes from a division by a zoom the user drives, so it is
    // clamped rather than trusted. Above 1 there is no such thing as rendering
    // a document at more than its own resolution.
    expect(previewExtent(640, 480, 4)).toEqual({ width: 640, height: 480 });
    expect(previewExtent(640, 480, 1)).toEqual({ width: 640, height: 480 });
  });

  it("never produces an extent with no pixels", () => {
    // A dispatch over zero pixels renders nothing and a fractional extent has
    // no meaning to one, so both ends are floored at a single pixel.
    expect(previewExtent(640, 480, 0)).toEqual({ width: 1, height: 1 });
    expect(previewExtent(640, 480, 0.0001)).toEqual({ width: 1, height: 1 });
    expect(previewExtent(640, 480, Number.NaN)).toEqual({ width: 640, height: 480 });
  });

  it("recognises the document's own extent, which is what skips the resample", () => {
    expect(isFullExtent(previewExtent(800, 600, 1), 800, 600)).toBe(true);
    expect(isFullExtent(previewExtent(800, 600, 0.5), 800, 600)).toBe(false);
  });
});

describe("resampleLinearSurface", () => {
  it("halves both axes by averaging each 2x2 block", () => {
    // 4x4 counting up by one; each output is the mean of its four inputs.
    const source = surface(4, 4, (x, y) => y * 4 + x);
    const out = resampleLinearSurface(source, { width: 4, height: 4 }, { width: 2, height: 2 });
    expect(Array.from(out.r)).toEqual([2.5, 4.5, 10.5, 12.5]);
    // Every plane goes through the same path, so the ratios between them hold.
    expect(Array.from(out.g)).toEqual([1.25, 2.25, 5.25, 6.25]);
    expect(Array.from(out.a)).toEqual([1, 1, 1, 1]);
  });

  it("preserves the mean, which is what stops a preview from being darker", () => {
    // The failure this guards is the one nobody sees as a bug: a resampler
    // whose weights do not sum to one produces a preview a few per cent off,
    // and every judgement made against it is made against the wrong picture.
    const source = surface(97, 61, (x, y) => ((x * 7 + y * 13) % 100) / 100);
    const out = resampleLinearSurface(source, { width: 97, height: 61 }, { width: 31, height: 19 });
    expect(mean(out.r)).toBeCloseTo(mean(source.r), 3);
    expect(mean(out.b)).toBeCloseTo(mean(source.b), 3);
  });

  it("averages rather than point-samples a one-pixel checkerboard", () => {
    // Point sampling a checkerboard at half scale produces flat black or flat
    // white — the classic aliasing failure, and the one that would make a
    // preview of a dither show a pattern that is not in the picture.
    const source = surface(64, 64, (x, y) => ((x + y) % 2 === 0 ? 1 : 0));
    const out = resampleLinearSurface(source, { width: 64, height: 64 }, { width: 32, height: 32 });
    for (const value of out.r) expect(value).toBeCloseTo(0.5, 6);
  });

  it("keeps the last output pixel correct when the ratio does not divide", () => {
    // 3 -> 2 gives boxes of 1.5 source pixels; the second is clipped by the
    // right edge, so its weights are normalised over what is actually there.
    const source = surface(3, 1, (x) => x);
    const out = resampleLinearSurface(source, { width: 3, height: 1 }, { width: 2, height: 1 });
    expect(out.r[0]).toBeCloseTo((0 * 1 + 1 * 0.5) / 1.5, 6);
    expect(out.r[1]).toBeCloseTo((1 * 0.5 + 2 * 1) / 1.5, 6);
  });

  it("is a pure function of its arguments", () => {
    // Nothing in a render path may read a clock or a random source. Two calls
    // must be byte-identical, which is also what lets a preview frame be
    // content-hashed and cached like any other buffer.
    const source = surface(53, 37, (x, y) => Math.sin(x * 0.3) * Math.cos(y * 0.7));
    const from = { width: 53, height: 37 };
    const to = { width: 17, height: 11 };
    const first = resampleLinearSurface(source, from, to);
    const second = resampleLinearSurface(source, from, to);
    expect(Array.from(first.r)).toEqual(Array.from(second.r));
    expect(Array.from(first.a)).toEqual(Array.from(second.a));
  });

  it("does not touch the source", () => {
    const source = surface(8, 8, (x, y) => x + y);
    const before = Array.from(source.r);
    resampleLinearSurface(source, { width: 8, height: 8 }, { width: 3, height: 3 });
    expect(Array.from(source.r)).toEqual(before);
  });

  it("returns the same values at 1:1", () => {
    const source = surface(5, 4, (x, y) => x * 0.1 + y);
    const out = resampleLinearSurface(source, { width: 5, height: 4 }, { width: 5, height: 4 });
    for (const [index, value] of Array.from(out.r).entries()) {
      expect(value).toBeCloseTo(source.r[index] ?? 0, 6);
    }
  });

  it("refuses to magnify rather than inventing detail", () => {
    const source = surface(4, 4, () => 1);
    expect(() =>
      resampleLinearSurface(source, { width: 4, height: 4 }, { width: 8, height: 8 }),
    ).toThrow(RangeError);
  });

  it("refuses planes that are not the size they claim", () => {
    // A source extent that disagrees with the planes would read past the end of
    // one and produce a picture with garbage in it, so it is refused rather
    // than clamped.
    const source = surface(4, 4, () => 1);
    expect(() =>
      resampleLinearSurface(source, { width: 5, height: 5 }, { width: 2, height: 2 }),
    ).toThrow(RangeError);
  });
});
