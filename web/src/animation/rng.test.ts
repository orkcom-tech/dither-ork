/**
 * F-AN-05 — determinism, at the source.
 *
 * Two families of assertion:
 *
 * - **Statelessness.** A draw for index 41 is the same whether or not indices 0
 *   to 40 were ever asked for. A timeline scrub lands on an arbitrary frame and
 *   `graph/animate.ts` hashes frames out of order, so a generator with a
 *   position would give different answers to the two.
 * - **Nothing outside the arguments.** `Math.random`, `Date.now` and
 *   `performance.now` are replaced with functions that throw, and the whole
 *   module is exercised through that. This is the check that cannot be made by
 *   reading the code once, because it stays true as the code changes.
 *
 * The golden values are pinned. Changing the mixer is allowed; changing it
 * without noticing that every seeded animation in every saved document now looks
 * different is not.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { setLevel } from "../lib/log";
import { bipolarFrom, fold, mix32, seedFromString, seedValue, unitFrom } from "./rng";

beforeAll(() => setLevel("error"));
afterEach(() => vi.restoreAllMocks());

describe("mix32", () => {
  it("is the MurmurHash3 finalizer, pinned", () => {
    // Fixed by construction; a rewrite that changes these changes every seeded
    // animation in every document already saved.
    expect(mix32(0)).toBe(0);
    expect(mix32(1)).toBe(0x514e28b7);
    expect(mix32(0xffffffff)).toBe(0x81f16f39);
  });

  it("returns an unsigned 32-bit value for any input", () => {
    for (const value of [0, 1, -1, 0x7fffffff, 0xffffffff, 2 ** 31]) {
      const out = mix32(value);
      expect(Number.isInteger(out)).toBe(true);
      expect(out).toBeGreaterThanOrEqual(0);
      expect(out).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("avalanches: one bit in changes about half the bits out", () => {
    let total = 0;
    const trials = 64;
    for (let i = 0; i < trials; i += 1) {
      const a = mix32(i * 2_654_435_761);
      const b = mix32((i * 2_654_435_761) ^ 1);
      let differing = 0;
      let x = (a ^ b) >>> 0;
      while (x !== 0) {
        differing += x & 1;
        x >>>= 1;
      }
      total += differing;
    }
    const mean = total / trials;
    expect(mean).toBeGreaterThan(12);
    expect(mean).toBeLessThan(20);
  });
});

describe("fold", () => {
  it("is order sensitive and length sensitive", () => {
    expect(fold(1, 2)).not.toBe(fold(2, 1));
    expect(fold(1)).not.toBe(fold(1, 0));
    expect(fold()).not.toBe(fold(0));
  });

  it("is stateless: the same words always give the same word", () => {
    const first = fold(7, 11, 13);
    for (let i = 0; i < 100; i += 1) fold(i, i * 3);
    expect(fold(7, 11, 13)).toBe(first);
  });

  it("does not depend on any index having been drawn before", () => {
    const ascending: number[] = [];
    for (let i = 0; i < 32; i += 1) ascending.push(fold(99, i));
    const descending: number[] = [];
    for (let i = 31; i >= 0; i -= 1) descending.unshift(fold(99, i));
    expect(descending).toEqual(ascending);
  });
});

describe("seedFromString", () => {
  it("distinguishes identifiers that differ only in order or length", () => {
    expect(seedFromString("offsetX")).not.toBe(seedFromString("offsetY"));
    expect(seedFromString("ab")).not.toBe(seedFromString("ba"));
    expect(seedFromString("a")).not.toBe(seedFromString("aa"));
  });

  it("is stable across calls", () => {
    expect(seedFromString("tileRotation")).toBe(seedFromString("tileRotation"));
  });
});

describe("the unit conversions", () => {
  it("map the whole 32-bit range into [0, 1) and [-1, 1)", () => {
    expect(unitFrom(0)).toBe(0);
    expect(unitFrom(0xffffffff)).toBeLessThan(1);
    expect(unitFrom(0xffffffff)).toBeGreaterThan(0.999_999_999);
    expect(bipolarFrom(0)).toBe(-1);
    expect(bipolarFrom(0x80000000)).toBe(0);
    expect(bipolarFrom(0xffffffff)).toBeLessThan(1);
  });

  it("never produces exactly 1, so a floor by a count cannot overrun", () => {
    for (let i = 0; i < 4096; i += 1) {
      const u = unitFrom(fold(i));
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      expect(Math.floor(u * 16)).toBeLessThan(16);
    }
  });
});

describe("seedValue", () => {
  it("lands inside SEED_RANGE, which is the full unsigned 32-bit space", () => {
    for (let i = 0; i < 512; i += 1) {
      const seed = seedValue(1234, i);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("spreads consecutive frame indices rather than walking them", () => {
    const seeds = new Set<number>();
    for (let i = 0; i < 256; i += 1) seeds.add(seedValue(42, i));
    expect(seeds.size).toBe(256);
  });
});

describe("F-AN-05: nothing here reads anything outside its arguments", () => {
  it("works with Math.random, Date.now and performance.now removed", () => {
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random is not allowed in a render path");
    });
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Date.now is not allowed in a render path");
    });
    vi.spyOn(performance, "now").mockImplementation(() => {
      throw new Error("performance.now is not allowed in a render path");
    });

    expect(() => {
      for (let i = 0; i < 64; i += 1) {
        seedValue(seedFromString("node-1"), i);
        bipolarFrom(fold(i, 3));
      }
    }).not.toThrow();
  });
});
