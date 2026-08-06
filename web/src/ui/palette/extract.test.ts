import { describe, expect, it } from "vitest";

import type { SrgbTriplet } from "../../types/document";
import {
  DEFAULT_EXTRACT_SETTINGS,
  canExtract,
  entriesToExtract,
  lockedCount,
  mergeLocked,
  sourceToSrgbBytes,
} from "./extract";
import type { PaletteSource } from "./extract";
import type { Swatch } from "./model";

function swatch(rgb: SrgbTriplet, locked = false, population: number | null = null): Swatch {
  return { rgb, locked, population };
}

function source(width = 4, height = 4): PaletteSource {
  const pixels = width * height;
  return {
    name: "fixture.png",
    width,
    height,
    surface: {
      residency: "cpu",
      r: new Float32Array(pixels),
      g: new Float32Array(pixels),
      b: new Float32Array(pixels),
      a: new Float32Array(pixels).fill(1),
    },
  };
}

describe("canExtract", () => {
  it("refuses without a source", () => {
    const verdict = canExtract([], DEFAULT_EXTRACT_SETTINGS, null);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("image");
  });

  it("refuses when the locks already fill k", () => {
    // Running anyway would delete every unlocked swatch and call the result an
    // extraction; a refusal that names the number is the honest outcome.
    const swatches = [swatch([0, 0, 0], true), swatch([255, 255, 255], true)];
    const verdict = canExtract(swatches, { ...DEFAULT_EXTRACT_SETTINGS, k: 2 }, source());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("locked");
  });

  it("allows it once k leaves room for at least one extracted colour", () => {
    const swatches = [swatch([0, 0, 0], true), swatch([255, 255, 255], true)];
    expect(canExtract(swatches, { ...DEFAULT_EXTRACT_SETTINGS, k: 3 }, source()).ok).toBe(true);
  });

  it("refuses a k outside the editor's range", () => {
    expect(canExtract([], { ...DEFAULT_EXTRACT_SETTINGS, k: 1 }, source()).ok).toBe(false);
    expect(canExtract([], { ...DEFAULT_EXTRACT_SETTINGS, k: 257 }, source()).ok).toBe(false);
    expect(canExtract([], { ...DEFAULT_EXTRACT_SETTINGS, k: 8.5 }, source()).ok).toBe(false);
  });

  it("refuses an empty image", () => {
    expect(canExtract([], DEFAULT_EXTRACT_SETTINGS, source(0, 4)).ok).toBe(false);
  });
});

describe("sourceToSrgbBytes", () => {
  it("interleaves the planes and encodes the transfer function", () => {
    // Linear 1.0 is code 255, linear 0 is code 0, and sRGB mid-grey sits near
    // 0.214 in linear light — the one number that proves the transfer function
    // is being applied rather than a plain multiply by 255.
    const surface = {
      residency: "cpu" as const,
      r: new Float32Array([0, 1, 0.2140]),
      g: new Float32Array([0, 1, 0.2140]),
      b: new Float32Array([0, 1, 0.2140]),
      a: new Float32Array([1, 1, 0.5]),
    };
    const bytes = sourceToSrgbBytes({ name: "x", width: 3, height: 1, surface });
    expect(bytes).toHaveLength(12);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0, 0, 0, 255]);
    expect(Array.from(bytes.slice(4, 8))).toEqual([255, 255, 255, 255]);
    expect(bytes[8]).toBeGreaterThan(126);
    expect(bytes[8]).toBeLessThan(130);
    // Alpha carries no transfer function; encoding it through one is a classic
    // and invisible error.
    expect(bytes[11]).toBe(128);
  });

  it("refuses a plane shorter than the image it claims to be", () => {
    const surface = {
      residency: "cpu" as const,
      r: new Float32Array(2),
      g: new Float32Array(4),
      b: new Float32Array(4),
      a: new Float32Array(4),
    };
    expect(() => sourceToSrgbBytes({ name: "x", width: 2, height: 2, surface })).toThrow(
      RangeError,
    );
  });
});

describe("entriesToExtract", () => {
  it("asks the core for k less the locks", () => {
    const swatches = [swatch([0, 0, 0], true), swatch([1, 1, 1]), swatch([2, 2, 2], true)];
    expect(lockedCount(swatches)).toBe(2);
    expect(entriesToExtract(swatches, { ...DEFAULT_EXTRACT_SETTINGS, k: 16 })).toBe(14);
  });
});

describe("mergeLocked", () => {
  const extracted: SrgbTriplet[] = [
    [10, 10, 10],
    [20, 20, 20],
    [30, 30, 30],
  ];
  const populations = [100, 50, 25];

  it("replaces everything when nothing is locked", () => {
    const previous = [swatch([1, 1, 1]), swatch([2, 2, 2])];
    const merged = mergeLocked(previous, extracted, populations);
    expect(merged.map((s) => s.rgb)).toEqual(extracted);
    expect(merged.map((s) => s.population)).toEqual(populations);
  });

  it("keeps a locked swatch at its own index", () => {
    const previous = [swatch([1, 1, 1]), swatch([9, 9, 9], true), swatch([3, 3, 3])];
    const merged = mergeLocked(previous, extracted, populations);
    expect(merged.map((s) => s.rgb)).toEqual([
      [10, 10, 10],
      [9, 9, 9],
      [20, 20, 20],
      [30, 30, 30],
    ]);
    expect(merged[1]?.locked).toBe(true);
  });

  it("keeps every lock and clears the locked swatches' stale counts", () => {
    const previous = [swatch([9, 9, 9], true, 999), swatch([3, 3, 3])];
    const merged = mergeLocked(previous, extracted, populations);
    expect(merged.filter((s) => s.locked)).toHaveLength(1);
    // 999 was counted against a different extraction and describes nothing here.
    expect(merged[0]?.population).toBeNull();
  });

  it("places every extracted colour exactly once", () => {
    const previous = [
      swatch([1, 1, 1], true),
      swatch([2, 2, 2]),
      swatch([3, 3, 3], true),
      swatch([4, 4, 4]),
      swatch([5, 5, 5]),
      swatch([6, 6, 6]),
    ];
    const merged = mergeLocked(previous, extracted, populations);
    expect(merged).toHaveLength(2 + extracted.length);
    for (const colour of extracted) {
      expect(merged.filter((s) => s.rgb === colour)).toHaveLength(1);
    }
  });

  it("shrinks rather than padding when the extraction comes back short", () => {
    // The core returns fewer entries than k when the image has fewer
    // distinguishable colours; a palette padded to length with a colour nothing
    // chose would be worse than a short one.
    const previous = [swatch([1, 1, 1]), swatch([2, 2, 2]), swatch([3, 3, 3])];
    const merged = mergeLocked(previous, [[10, 10, 10]], [7]);
    expect(merged).toHaveLength(1);
  });

  it("grows past the previous palette when the extraction is longer", () => {
    const merged = mergeLocked([swatch([1, 1, 1])], extracted, populations);
    expect(merged).toHaveLength(3);
  });

  it("carries populations with the colour they were counted for", () => {
    const previous = [swatch([9, 9, 9], true)];
    const merged = mergeLocked(previous, extracted, populations);
    const counted = merged.filter((s) => !s.locked);
    expect(counted.map((s) => s.population)).toEqual(populations);
  });
});
