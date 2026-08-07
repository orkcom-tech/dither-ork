/**
 * F-EX-01 — "indexed when the output is indexed" is a question about the
 * finished pixels, and this is the answer to it.
 *
 * The properties that matter are lossless-ness (an indexed result must be able
 * to reproduce every pixel exactly), determinism (the same frame must produce
 * the same palette in the same order, or nothing downstream can be pinned), and
 * the refusal above 256 colours being a refusal rather than a quantization.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../lib/log";
import { MAX_PALETTE_ENTRIES, bitDepthFor, indexImage, scaleIndices, sliceIndexed } from "./census";

setLevel("error");

/** An image from a list of RGBA quadruples, laid out row-major. */
function imageOf(width: number, height: number, pixels: readonly number[][]): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const pixel = pixels[i % pixels.length] ?? [0, 0, 0, 255];
    data.set(pixel, i * 4);
  }
  return data;
}

/** Reconstruct RGBA from an indexed result — the definition of lossless here. */
function expand(indexed: {
  readonly width: number;
  readonly height: number;
  readonly indices: Uint8Array;
  readonly palette: Uint8Array;
}): Uint8Array {
  const out = new Uint8Array(indexed.width * indexed.height * 4);
  for (let i = 0; i < indexed.indices.length; i += 1) {
    const entry = (indexed.indices[i] ?? 0) * 4;
    out.set(indexed.palette.subarray(entry, entry + 4), i * 4);
  }
  return out;
}

describe("bitDepthFor", () => {
  it("takes the smallest depth that addresses the palette", () => {
    // This is where the size win is: a 4-colour dither at 2 bits a pixel is
    // sixteen times smaller than RGBA before deflate has seen it.
    expect(bitDepthFor(1)).toBe(1);
    expect(bitDepthFor(2)).toBe(1);
    expect(bitDepthFor(3)).toBe(2);
    expect(bitDepthFor(4)).toBe(2);
    expect(bitDepthFor(5)).toBe(4);
    expect(bitDepthFor(16)).toBe(4);
    expect(bitDepthFor(17)).toBe(8);
    expect(bitDepthFor(256)).toBe(8);
  });
});

describe("indexImage", () => {
  it("indexes a four-colour dither losslessly", async () => {
    const data = imageOf(8, 4, [
      [0, 0, 0, 255],
      [255, 255, 255, 255],
      [255, 0, 0, 255],
      [0, 0, 255, 255],
    ]);
    const indexed = await indexImage(8, 4, data);
    expect(indexed).not.toBeNull();
    if (indexed === null) return;

    expect(indexed.count).toBe(4);
    expect(indexed.bitDepth).toBe(2);
    expect(indexed.transparentEntries).toBe(0);
    expect(expand(indexed)).toEqual(data);
  });

  it("refuses rather than quantizing above 256 colours", async () => {
    // 257 distinct greys. Returning a 256-entry approximation would be a second
    // dither the document never asked for, applied at export time.
    const data = new Uint8Array(257 * 4);
    for (let i = 0; i < 257; i += 1) {
      data.set([i & 0xff, (i >> 8) & 0xff, 0, 255], i * 4);
    }
    expect(await indexImage(257, 1, data)).toBeNull();
  });

  it("accepts exactly 256", async () => {
    const data = new Uint8Array(MAX_PALETTE_ENTRIES * 4);
    for (let i = 0; i < MAX_PALETTE_ENTRIES; i += 1) data.set([i, i, i, 255], i * 4);
    const indexed = await indexImage(MAX_PALETTE_ENTRIES, 1, data);
    expect(indexed?.count).toBe(256);
    expect(indexed?.bitDepth).toBe(8);
  });

  it("puts transparent entries first, so tRNS is as short as it can be", async () => {
    const data = imageOf(4, 1, [
      [10, 20, 30, 255],
      [40, 50, 60, 0],
      [70, 80, 90, 255],
      [1, 2, 3, 128],
    ]);
    const indexed = await indexImage(4, 1, data);
    expect(indexed).not.toBeNull();
    if (indexed === null) return;

    expect(indexed.transparentEntries).toBe(2);
    expect(indexed.palette[3]).not.toBe(255);
    expect(indexed.palette[7]).not.toBe(255);
    expect(indexed.palette[11]).toBe(255);
    expect(expand(indexed)).toEqual(data);
  });

  it("produces the same palette in the same order every time", async () => {
    // Insertion order is a property of Map, and it is what makes the encoder's
    // output a function of its input rather than of the iteration order of a set.
    const data = imageOf(16, 16, [
      [3, 3, 3, 255],
      [200, 10, 10, 255],
      [9, 9, 200, 255],
    ]);
    const first = await indexImage(16, 16, data);
    const second = await indexImage(16, 16, data);
    expect(first?.palette).toEqual(second?.palette);
    expect(first?.indices).toEqual(second?.indices);
  });

  it("refuses a buffer that is not the size it claims", async () => {
    await expect(indexImage(4, 4, new Uint8Array(12))).rejects.toThrow(/expected 64 bytes/);
  });
});

describe("scaleIndices", () => {
  it("replicates without touching the palette", async () => {
    const data = imageOf(2, 2, [
      [0, 0, 0, 255],
      [255, 255, 255, 255],
    ]);
    const indexed = await indexImage(2, 2, data);
    expect(indexed).not.toBeNull();
    if (indexed === null) return;

    const scaled = scaleIndices(indexed, 3);
    expect(scaled.width).toBe(6);
    expect(scaled.height).toBe(6);
    expect(scaled.count).toBe(indexed.count);
    expect(scaled.palette).toEqual(indexed.palette);
    expect(scaled.bitDepth).toBe(indexed.bitDepth);

    // Every 3x3 block is one source index.
    for (let y = 0; y < 6; y += 1) {
      for (let x = 0; x < 6; x += 1) {
        const source = indexed.indices[Math.floor(y / 3) * 2 + Math.floor(x / 3)];
        expect(scaled.indices[y * 6 + x]).toBe(source);
      }
    }
  });

  it("returns the same object at 1x rather than copying", async () => {
    const indexed = await indexImage(2, 1, imageOf(2, 1, [[1, 2, 3, 255]]));
    expect(indexed).not.toBeNull();
    if (indexed === null) return;
    expect(scaleIndices(indexed, 1)).toBe(indexed);
  });

  it("refuses a fractional multiplier", async () => {
    const indexed = await indexImage(2, 1, imageOf(2, 1, [[1, 2, 3, 255]]));
    expect(indexed).not.toBeNull();
    if (indexed === null) return;
    expect(() => scaleIndices(indexed, 1.5)).toThrow(/positive integer/);
  });
});

describe("sliceIndexed", () => {
  it("keeps the whole image's palette, which is why the estimate is right", async () => {
    // Rows 0 and 1 use two colours; rows 2 and 3 use two more. A band re-censused
    // on its own would find two colours and one bit a pixel; the whole image
    // needs four and two bits, and the estimate has to be built on the latter.
    const data = new Uint8Array(4 * 4 * 4);
    const colours = [
      [0, 0, 0, 255],
      [255, 255, 255, 255],
      [255, 0, 0, 255],
      [0, 255, 0, 255],
    ];
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        data.set(colours[(y < 2 ? 0 : 2) + (x % 2)] ?? [], (y * 4 + x) * 4);
      }
    }
    const indexed = await indexImage(4, 4, data);
    expect(indexed?.count).toBe(4);
    if (indexed === null) return;

    const band = sliceIndexed(indexed, 0, 2);
    expect(band.height).toBe(2);
    expect(band.count).toBe(4);
    expect(band.bitDepth).toBe(2);
    expect(band.indices.length).toBe(8);
  });

  it("clamps a band that runs off the bottom", async () => {
    const indexed = await indexImage(2, 2, imageOf(2, 2, [[1, 2, 3, 255]]));
    expect(indexed).not.toBeNull();
    if (indexed === null) return;
    expect(sliceIndexed(indexed, 1, 10).height).toBe(1);
  });
});
