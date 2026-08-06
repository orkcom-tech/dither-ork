/**
 * F-IN-04 — the ceiling, and that going over it is a sentence rather than a
 * resample.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../lib/log";
import { ImageLoadError } from "./errors";
import {
  DEFAULT_SOURCE_LIMITS,
  MAX_SOURCE_DIMENSION,
  MAX_SOURCE_PIXELS,
  assertSourceExtent,
  sourceLimits,
} from "./limits";

setLevel("error");

function refusal(width: number, height: number): ImageLoadError {
  try {
    assertSourceExtent(width, height, "photo.png");
  } catch (error) {
    if (error instanceof ImageLoadError) return error;
    throw error;
  }
  throw new Error(`${width}x${height} was accepted; expected a refusal`);
}

describe("what is accepted", () => {
  it("accepts an ordinary image", () => {
    expect(() => assertSourceExtent(1920, 1080, "photo.png")).not.toThrow();
  });

  it("accepts exactly the limit", () => {
    // A limit that is one pixel off is a limit nobody can reason about.
    const edge = Math.trunc(Math.sqrt(MAX_SOURCE_PIXELS));
    expect(() => assertSourceExtent(edge, edge, "square.png")).not.toThrow();
    expect(() =>
      assertSourceExtent(MAX_SOURCE_DIMENSION, 2048, "wide.png"),
    ).not.toThrow();
  });
});

describe("what is refused", () => {
  it("refuses a long edge, naming the size and the limit", () => {
    const error = refusal(12_000, 900);
    expect(error.code).toBe("too-large");
    expect(error.message).toContain("12000x900");
    expect(error.message).toContain(String(MAX_SOURCE_DIMENSION));
    // The requirement is that nothing resamples behind the user's back, so the
    // message says so rather than leaving them to wonder.
    expect(error.message).toMatch(/resize the image/i);
  });

  it("refuses an area even when both edges are legal", () => {
    // 8000x8000 is inside the edge limit and is 64 megapixels — 512 MB as one
    // working surface, and a stack holds several.
    const error = refusal(8000, 8000);
    expect(error.code).toBe("too-large");
    expect(error.message).toContain("megapixels");
  });

  it("refuses a zero or fractional extent as its own kind of failure", () => {
    expect(refusal(0, 100).code).toBe("zero-dimension");
    expect(refusal(100, 0).code).toBe("zero-dimension");
    expect(refusal(10.5, 100).code).toBe("zero-dimension");
    expect(refusal(-4, 100).code).toBe("zero-dimension");
  });
});

describe("device limits", () => {
  it("narrows to what the device reports", () => {
    const limits = sourceLimits(4096);
    expect(limits.maxDimension).toBe(4096);
    expect(() => assertSourceExtent(6000, 100, "wide.png", limits)).toThrow(/4096/);
  });

  it("never widens past what the renderer will hold", () => {
    // A device may report 16384. The area ceiling binds long before that, and a
    // refusal quoting a limit the renderer will not honour is a lie.
    expect(sourceLimits(16_384).maxDimension).toBe(MAX_SOURCE_DIMENSION);
    expect(sourceLimits(16_384).maxPixels).toBe(DEFAULT_SOURCE_LIMITS.maxPixels);
  });
});
