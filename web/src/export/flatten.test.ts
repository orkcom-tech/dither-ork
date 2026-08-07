/**
 * The one place transparency has to go somewhere, and the checks that it only
 * happens when it has to and that it happens in the right colour space.
 */

import { describe, expect, it } from "vitest";

import { linearOfSrgbByte } from "../io";
import { linearToSrgb } from "../gpu/resources";
import { EXPORT_MATTE, flattenOntoMatte, isFullyOpaque } from "./flatten";

describe("isFullyOpaque", () => {
  it("is true for an opaque buffer and false for one transparent pixel", () => {
    expect(isFullyOpaque(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]))).toBe(true);
    expect(isFullyOpaque(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 254]))).toBe(false);
  });
});

describe("flattenOntoMatte", () => {
  it("leaves an opaque image completely alone and says it did nothing", async () => {
    const data = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]);
    const result = await flattenOntoMatte(data);
    expect(result.hadTransparency).toBe(false);
    expect([...result.data]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  it("takes a fully transparent pixel to the matte", async () => {
    const data = new Uint8Array([200, 100, 50, 0]);
    const result = await flattenOntoMatte(data);
    expect(result.hadTransparency).toBe(true);
    expect([...result.data]).toEqual([...EXPORT_MATTE, 255]);
  });

  it("blends in linear light, not in gamma space", async () => {
    // The whole point. Half coverage of mid-grey over black is *not* half the
    // sRGB code value — it is the code value of half the linear value, which is
    // about 46 lower. Compositing in gamma space is the same class of mistake as
    // diffusing error in gamma space, and it looks like a style rather than a bug.
    const source = 128;
    const data = new Uint8Array([source, source, source, 128]);
    const result = await flattenOntoMatte(data);

    const coverage = 128 / 255;
    const expected = Math.round(linearToSrgb(linearOfSrgbByte(source) * coverage) * 255);
    expect(result.data[0]).toBe(expected);
    // And the naive answer, which this must not be.
    expect(result.data[0]).not.toBe(Math.round(source * coverage));
  });

  it("leaves an already-opaque pixel untouched inside a mixed image", async () => {
    const data = new Uint8Array([9, 9, 9, 255, 200, 200, 200, 0]);
    const result = await flattenOntoMatte(data);
    expect([...result.data.subarray(0, 4)]).toEqual([9, 9, 9, 255]);
    expect(result.data[7]).toBe(255);
  });

  it("makes every pixel opaque, which is what a format with no alpha needs", async () => {
    const data = new Uint8Array([1, 1, 1, 0, 2, 2, 2, 77, 3, 3, 3, 200, 4, 4, 4, 255]);
    const result = await flattenOntoMatte(data);
    for (let at = 3; at < result.data.length; at += 4) {
      expect(result.data[at]).toBe(255);
    }
  });

  it("is idempotent", async () => {
    const data = new Uint8Array([200, 100, 50, 90]);
    const once = await flattenOntoMatte(data);
    const twice = await flattenOntoMatte(once.data);
    expect(twice.hadTransparency).toBe(false);
    expect([...twice.data]).toEqual([...once.data]);
  });
});
