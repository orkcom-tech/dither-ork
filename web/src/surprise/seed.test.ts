import { describe, expect, it } from "vitest";

import { SEED_TEXT_PATTERN, formatSeed, mintSeed, parseSeed, seedOfDocument } from "./seed";

describe("formatSeed", () => {
  it("writes sixteen lowercase hex characters, zero-padded", () => {
    expect(formatSeed(0n)).toBe("0000000000000000");
    expect(formatSeed(1n)).toBe("0000000000000001");
    expect(formatSeed(0x7f3a_1c92_b04e_5d68n)).toBe("7f3a1c92b04e5d68");
    expect(formatSeed(0xffff_ffff_ffff_ffffn)).toBe("ffffffffffffffff");
    for (const seed of [0n, 1n, 0xdead_beefn, 0xffff_ffff_ffff_ffffn]) {
      expect(SEED_TEXT_PATTERN.test(formatSeed(seed))).toBe(true);
    }
  });

  it("wraps rather than throwing on a value outside 64 bits", () => {
    // The one sensible reading of a 65-bit seed: it is a u64 and always was.
    expect(formatSeed(1n << 64n)).toBe("0000000000000000");
    expect(formatSeed(-1n)).toBe("ffffffffffffffff");
  });
});

describe("parseSeed", () => {
  it("round-trips every seed it formats", () => {
    for (const seed of [
      0n,
      1n,
      0x7f3a_1c92_b04e_5d68n,
      0xffff_ffff_ffff_ffffn,
      0x8000_0000_0000_0000n,
    ]) {
      expect(parseSeed(formatSeed(seed))).toBe(seed);
    }
  });

  it("accepts the forms a seed arrives in", () => {
    expect(parseSeed("  7F3A1C92B04E5D68 ")).toBe(0x7f3a_1c92_b04e_5d68n);
    expect(parseSeed("0x7f3a1c92b04e5d68")).toBe(0x7f3a_1c92_b04e_5d68n);
    // Short is padded, so somebody who typed the seed of surprise number 3 gets
    // seed 3 rather than a refusal.
    expect(parseSeed("3")).toBe(3n);
  });

  it("refuses anything that is not a seed rather than reading part of it", () => {
    // Silently reading "7f3a…" out of "7f3a nope" is the failure this feature
    // cannot afford: a person would get a different picture and no message.
    expect(parseSeed("")).toBeNull();
    expect(parseSeed("   ")).toBeNull();
    expect(parseSeed("nope")).toBeNull();
    expect(parseSeed("7f3a1c92b04e5d68extra")).toBeNull();
    expect(parseSeed("7f3a-1c92-b04e-5d68")).toBeNull();
    expect(parseSeed("12.5")).toBeNull();
  });
});

describe("seedOfDocument", () => {
  it("returns null for a document that did not come from a surprise", () => {
    expect(seedOfDocument(undefined)).toBeNull();
  });

  it("reads a well-formed seed", () => {
    expect(seedOfDocument("7f3a1c92b04e5d68")).toBe(0x7f3a_1c92_b04e_5d68n);
  });

  it("reports a malformed one rather than treating it as absent", () => {
    // Returns null either way; the difference is the warning, which is what
    // makes a hand-edited or foreign document visible instead of silent.
    expect(seedOfDocument("not-a-seed")).toBeNull();
  });
});

describe("mintSeed", () => {
  it("draws across the whole 64-bit space", () => {
    const seeds = Array.from({ length: 500 }, () => mintSeed());
    for (const seed of seeds) {
      expect(seed).toBeGreaterThanOrEqual(0n);
      expect(seed).toBeLessThan(1n << 64n);
    }
    expect(new Set(seeds).size).toBe(seeds.length);
    // The high half has to move, or the seed space is 32 bits and collisions
    // become likely after a few tens of thousands of surprises.
    expect(seeds.some((seed) => seed >= 1n << 63n)).toBe(true);
  });
});
