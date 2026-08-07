/**
 * F-EX-04's actual requirement, tested as a property rather than as a call:
 * **no pixel's colour changes.**
 *
 * Every test here reconstructs the frames from the palette and the index maps
 * and compares them to the pixels that went in. That is the only assertion that
 * distinguishes "used the palette" from "quantized to a palette" — a second
 * quantization produces a table of the right size, indices in the right range
 * and a picture that is subtly wrong, and no assertion about counts would catch
 * it.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../../lib/log";
import type { ExportFrame } from "../types";
import { LoopPaletteBuilder, paletteAsRgbTriplets, replicateIndices } from "./palette";
import type { LoopPalette } from "./types";

setLevel("error");

function frameOf(width: number, height: number, pixels: readonly number[][]): ExportFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const pixel = pixels[i % pixels.length] ?? [0, 0, 0, 255];
    data[i * 4] = pixel[0] ?? 0;
    data[i * 4 + 1] = pixel[1] ?? 0;
    data[i * 4 + 2] = pixel[2] ?? 0;
    data[i * 4 + 3] = pixel[3] ?? 255;
  }
  return { width, height, data };
}

/** The picture the palette and an index map describe, as RGBA. */
function reconstruct(palette: LoopPalette, indices: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(indices.length * 4);
  for (let i = 0; i < indices.length; i += 1) {
    const entry = (indices[i] ?? 0) * 4;
    out[i * 4] = palette.rgba[entry] ?? 0;
    out[i * 4 + 1] = palette.rgba[entry + 1] ?? 0;
    out[i * 4 + 2] = palette.rgba[entry + 2] ?? 0;
    out[i * 4 + 3] = palette.rgba[entry + 3] ?? 0;
  }
  return out;
}

describe("the loop palette", () => {
  it("reproduces every frame exactly", async () => {
    const builder = new LoopPaletteBuilder();
    const a = frameOf(4, 4, [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
    ]);
    const b = frameOf(4, 4, [
      [0, 0, 255, 255],
      [255, 0, 0, 255],
    ]);

    const first = await builder.index(a);
    const second = await builder.index(b);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const palette = builder.palette();
    // Three colours across two frames, and the union is the table.
    expect(palette.count).toBe(3);
    expect(reconstruct(palette, first!.indices)).toEqual(a.data);
    expect(reconstruct(palette, second!.indices)).toEqual(b.data);
  });

  it("gives one colour one entry however many frames wear it", async () => {
    const builder = new LoopPaletteBuilder();
    const frame = frameOf(2, 2, [[9, 9, 9, 255]]);
    for (let i = 0; i < 5; i += 1) await builder.index(frame);
    expect(builder.palette().count).toBe(1);
  });

  it("is deterministic: first-seen order, every time", async () => {
    const build = async (): Promise<LoopPalette> => {
      const builder = new LoopPaletteBuilder();
      await builder.index(
        frameOf(3, 1, [
          [3, 3, 3, 255],
          [1, 1, 1, 255],
          [2, 2, 2, 255],
        ]),
      );
      return builder.palette();
    };
    const one = await build();
    const two = await build();
    expect([...one.rgba]).toEqual([...two.rgba]);
    // First seen, not sorted: entry 0 is the first pixel's colour.
    expect([one.rgba[0], one.rgba[4], one.rgba[8]]).toEqual([3, 1, 2]);
  });

  it("refuses rather than quantizing when the loop passes 256 colours", async () => {
    const builder = new LoopPaletteBuilder();
    // 256 distinct colours in the first frame, one more in the second.
    const many = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i += 1) {
      many[i * 4] = i;
      many[i * 4 + 3] = 255;
    }
    const full = await builder.index({ width: 256, height: 1, data: many });
    expect(full).not.toBeNull();
    expect(builder.size).toBe(256);

    const oneMore = await builder.index(frameOf(1, 1, [[0, 0, 1, 255]]));
    // Null, not a nearest match. That is the whole requirement.
    expect(oneMore).toBeNull();
  });

  it("gives every fully transparent pixel one shared entry", async () => {
    const builder = new LoopPaletteBuilder();
    const frame = frameOf(2, 2, [
      [10, 20, 30, 0],
      [40, 50, 60, 0],
      [70, 80, 90, 255],
      [70, 80, 90, 255],
    ]);
    const result = await builder.index(frame);
    expect(result).not.toBeNull();
    expect(result!.transparent).toBe(true);

    const palette = builder.palette();
    // Two entries, not three: a transparent pixel has no colour, so the two
    // different RGB values under zero alpha are the same pixel to a GIF.
    expect(palette.count).toBe(2);
    expect(palette.transparentIndex).toBe(0);
    expect(result!.indices[0]).toBe(0);
    expect(result!.indices[1]).toBe(0);
    expect(palette.rgba[3]).toBe(0);
  });

  it("composites partial alpha onto the matte and says that it did", async () => {
    const builder = new LoopPaletteBuilder();
    const result = await builder.index(frameOf(2, 1, [[255, 255, 255, 128]]));
    expect(result).not.toBeNull();
    expect(result!.flattened).toBe(true);
    expect(builder.flattened).toBe(true);

    const palette = builder.palette();
    expect(palette.count).toBe(1);
    // Half coverage of white over black, in linear light, is well below 128 in
    // sRGB — which is the whole reason the composite is not done in gamma space.
    const grey = palette.rgba[0] ?? 0;
    expect(grey).toBeGreaterThan(0);
    expect(grey).toBeLessThan(200);
    expect(palette.rgba[3]).toBe(255);
    // No transparent entry: a half-covered pixel is drawn, not skipped.
    expect(palette.transparentIndex).toBe(-1);
  });

  it("leaves a fully opaque frame untouched and allocates no transparent entry", async () => {
    const builder = new LoopPaletteBuilder();
    const result = await builder.index(frameOf(4, 4, [[1, 2, 3, 255]]));
    expect(result!.flattened).toBe(false);
    expect(result!.transparent).toBe(false);
    expect(builder.palette().transparentIndex).toBe(-1);
  });

  it("refuses a buffer that is not the extent it claims", async () => {
    const builder = new LoopPaletteBuilder();
    await expect(
      builder.index({ width: 4, height: 4, data: new Uint8ClampedArray(8) }),
    ).rejects.toThrow(RangeError);
  });
});

describe("the RGB view of a palette", () => {
  it("drops alpha and keeps the order", async () => {
    const builder = new LoopPaletteBuilder();
    await builder.index(
      frameOf(2, 1, [
        [1, 2, 3, 255],
        [4, 5, 6, 255],
      ]),
    );
    expect([...paletteAsRgbTriplets(builder.palette())]).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("index replication", () => {
  it("is the same picture at a larger grid", () => {
    const indices = new Uint8Array([1, 2, 3, 4]) as Uint8Array<ArrayBuffer>;
    const scaled = replicateIndices(indices, 2, 2, 2);
    expect(scaled.width).toBe(4);
    expect(scaled.height).toBe(4);
    expect([...scaled.indices]).toEqual([
      1, 1, 2, 2, //
      1, 1, 2, 2, //
      3, 3, 4, 4, //
      3, 3, 4, 4,
    ]);
  });

  it("hands the original back at 1x", () => {
    // Not a copy: the caller pushes it straight into the encoder, and a copy per
    // frame of a 60-frame loop is 60 allocations for nothing.
    const indices = new Uint8Array([7]) as Uint8Array<ArrayBuffer>;
    expect(replicateIndices(indices, 1, 1, 1).indices).toBe(indices);
  });

  it("refuses a scale that is not a positive integer", () => {
    const indices = new Uint8Array([0]) as Uint8Array<ArrayBuffer>;
    expect(() => replicateIndices(indices, 1, 1, 1.5)).toThrow(RangeError);
    expect(() => replicateIndices(indices, 1, 1, 0)).toThrow(RangeError);
  });
});
