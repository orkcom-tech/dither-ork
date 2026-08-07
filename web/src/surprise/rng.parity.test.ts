/**
 * The parity test.
 *
 * docs/ARCHITECTURE.md put the surprise generator in `core/gen`; it was moved to
 * TypeScript on 2026-08-06 because its only data source is the node registry and
 * it never touches a pixel (the full argument is at the top of `rng.ts`). The
 * price of that decision is that a seed has to mean the same thing on both sides
 * of the WASM boundary, and **this file is the receipt**. Every assertion below
 * mirrors one in the `#[cfg(test)] mod tests` block of
 * `core/crates/dither-core/src/rng.rs`, against the same vectors, so a change to
 * either implementation that would make one seed produce two different documents
 * fails here.
 *
 * The Rust file is not readable from this process — the `web` container mounts
 * `./web` and nothing else (see `docker-compose.yml`) — so the vectors are
 * transcribed rather than parsed. Each `it` names the Rust test it mirrors so
 * the pair can be found and kept together by hand, which is the honest
 * statement of what this test does and does not guarantee: it pins the *output*,
 * not the fact that somebody remembered to update both files.
 */

import { describe, expect, it } from "vitest";

import { Pcg32, RngRangeError, seededPcg32, streamOf } from "./rng";

describe("parity with core/crates/dither-core/src/rng.rs", () => {
  /** Mirrors `known_answer_matches_the_reference_implementation`. */
  it("reproduces the reference PCG32 sequence for srandom_r(42, 54)", () => {
    const rng = new Pcg32(42n, 54n);
    const got = [0, 0, 0, 0, 0, 0].map(() => rng.nextU32());
    expect(got).toEqual([
      0xa15c_02b7, 0x7b47_f409, 0xba1d_3330, 0x83d2_f293, 0xbfa4_784b, 0xcbed_606e,
    ]);
  });

  /** Mirrors `stream_of_matches_the_published_fnv1a_vectors`. */
  it("hashes stream names with the published FNV-1a 64 vectors", () => {
    expect(streamOf("")).toBe(0xcbf2_9ce4_8422_2325n);
    expect(streamOf("a")).toBe(0xaf63_dc4c_8601_ec8cn);
    expect(streamOf("foobar")).toBe(0x8594_4171_f739_67e8n);
  });

  /** Mirrors `seeded_is_the_default_stream`. */
  it("seeds the default stream the same way `Pcg32::seeded` does", () => {
    const viaHelper = seededPcg32(99n);
    const viaStream = new Pcg32(99n, 0n);
    const left = Array.from({ length: 8 }, () => viaHelper.nextU32());
    const right = Array.from({ length: 8 }, () => viaStream.nextU32());
    expect(left).toEqual(right);
  });

  /** Mirrors `same_seed_reproduces_the_same_stream`. */
  it("reproduces the same stream from the same seed", () => {
    const a = new Pcg32(0x853c_49e6_748f_ea9bn, 7n);
    const b = new Pcg32(0x853c_49e6_748f_ea9bn, 7n);
    const left = Array.from({ length: 256 }, () => a.nextU32());
    const right = Array.from({ length: 256 }, () => b.nextU32());
    expect(left).toEqual(right);
  });

  /** Mirrors `different_streams_from_one_seed_diverge`. */
  it("keeps two streams of one seed independent", () => {
    const seed = 0x853c_49e6_748f_ea9bn;
    const a = new Pcg32(seed, 0n);
    const b = new Pcg32(seed, 1n);
    const left = Array.from({ length: 256 }, () => a.nextU32());
    const right = Array.from({ length: 256 }, () => b.nextU32());

    expect(left).not.toEqual(right);
    // The stronger claim, as in Rust: two independent streams should agree on a
    // given draw only by coincidence.
    const shared = left.filter((value, index) => value === right[index]).length;
    expect(shared).toBeLessThan(4);
  });

  /** Mirrors `uniform_f32_stays_inside_the_half_open_unit_range`. */
  it("draws floats inside [0, 1) and reaches the top of the range", () => {
    const rng = seededPcg32(1n);
    let max = 0;
    // 30k rather than the Rust test's 100k. A BigInt multiply per draw makes a
    // hundred thousand of them a second and a half of a nine-second suite, and
    // the seed is fixed, so the sample size decides only how much of the range
    // is swept — not whether the check can flake.
    for (let i = 0; i < 30_000; i += 1) {
      const v = rng.nextF32();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      if (v > max) max = v;
    }
    expect(max).toBeGreaterThan(0.999);
  });

  /**
   * Mirrors `bounded_draws_stay_in_range_and_are_not_modulo_biased`.
   *
   * 3 does not divide 2^32, so this is exactly the case a bare modulo skews.
   * The seed is fixed, so the tolerance cannot flake.
   */
  it("draws bounded integers without modulo bias", () => {
    const rng = seededPcg32(0xfeed_beefn);
    const counts = [0, 0, 0];
    // 90k rather than 300k, for the timing reason above. Worth being honest
    // about what any sample size buys here: the bias a bare modulo introduces
    // for bound 3 is one part in 1.4 billion, so no feasible sample detects it
    // statistically. What this test actually pins is that the draws stay in
    // range and stay uniform; the *rejection loop itself* is pinned by the
    // reference vectors above, which is where a missing threshold would show.
    for (let i = 0; i < 90_000; i += 1) {
      const v = rng.nextBelow(3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(3);
      counts[v] = (counts[v] ?? 0) + 1;
    }
    for (const count of counts) {
      expect(Math.abs(count / 30_000 - 1)).toBeLessThan(0.02);
    }
  });

  /** Mirrors `bound_of_one_is_always_zero`. */
  it("returns zero for a bound of one", () => {
    const rng = seededPcg32(5n);
    for (let i = 0; i < 64; i += 1) expect(rng.nextBelow(1)).toBe(0);
  });

  /** Mirrors `zero_bound_panics_rather_than_inventing_an_answer`. */
  it("refuses a bound of zero", () => {
    expect(() => seededPcg32(5n).nextBelow(0)).toThrow(RngRangeError);
  });

  /** Mirrors `range_covers_negative_lows_and_never_reaches_the_high_bound`. */
  it("covers a negative low and never reaches the high bound", () => {
    const rng = seededPcg32(0x1234_5678n);
    let sawLow = false;
    let sawHigh = false;
    for (let i = 0; i < 10_000; i += 1) {
      const v = rng.nextRange(-5, 5);
      expect(v).toBeGreaterThanOrEqual(-5);
      expect(v).toBeLessThan(5);
      if (v === -5) sawLow = true;
      if (v === 4) sawHigh = true;
    }
    expect(sawLow && sawHigh).toBe(true);
  });

  /** Mirrors `range_handles_the_full_i32_span_without_overflow`. */
  it("handles the full i32 span", () => {
    const rng = seededPcg32(11n);
    for (let i = 0; i < 1_000; i += 1) {
      const v = rng.nextRange(-2_147_483_648, 2_147_483_647);
      expect(v).toBeLessThan(2_147_483_647);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  /** Mirrors `empty_range_panics`. */
  it("refuses an empty range", () => {
    expect(() => seededPcg32(5n).nextRange(3, 3)).toThrow(RngRangeError);
  });

  /** Mirrors `named_streams_are_stable_and_distinct`. */
  it("gives named streams that are stable and distinct", () => {
    expect(streamOf("row-offsets")).toBe(streamOf("row-offsets"));
    expect(streamOf("row-offsets")).not.toBe(streamOf("slice-heights"));

    const seed = 4242n;
    const a = new Pcg32(seed, streamOf("row-offsets"));
    const b = new Pcg32(seed, streamOf("slice-heights"));
    expect(a.nextU32()).not.toBe(b.nextU32());
  });
});

describe("the parts that have no Rust counterpart", () => {
  /**
   * `next_u32` is a u32 and nothing downstream should have to know a BigInt was
   * involved. A sign bit leaking out of the rotate would show up here and
   * nowhere else, because every consumer immediately divides or mods it.
   */
  it("returns unsigned 32-bit numbers", () => {
    const rng = new Pcg32(0n, 0n);
    for (let i = 0; i < 5_000; i += 1) {
      const v = rng.nextU32();
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffff_ffff);
    }
  });

  /**
   * The one place the TypeScript port is not a transcription is the output
   * permutation: `rng.ts` does the final rotate in 32-bit JS operators rather
   * than in `BigInt`, because a rotate per draw in `BigInt` is three allocations
   * for something the machine does in one instruction.
   *
   * That rewrite has exactly one interesting case. The rotation amount is the
   * top five bits, so it is zero on about one draw in thirty-two, and `x << 32`
   * in JS shifts by `32 % 32 === 0` — the identity, not zero. Get that wrong and
   * every thirty-second draw is `x | x` of the wrong half: plausible noise that
   * is simply not Rust's noise, and the six-vector test above would still pass
   * if none of its six draws happened to rotate by zero.
   *
   * So it is checked against an independent implementation written entirely in
   * `BigInt`, where the rotate has no such case, over enough draws that every
   * rotation amount occurs many times.
   */
  it("matches an all-BigInt implementation across every rotation amount", () => {
    const MASK64 = (1n << 64n) - 1n;
    const MASK32 = 0xffff_ffffn;
    const MULTIPLIER = 6_364_136_223_846_793_005n;

    /** The same algorithm with no 32-bit arithmetic anywhere. */
    class Reference {
      state = 0n;
      readonly inc: bigint;
      /** Rotation amounts seen, so the test can prove it exercised all 32. */
      readonly rotations = new Set<number>();

      constructor(seed: bigint, stream: bigint) {
        this.inc = ((stream << 1n) | 1n) & MASK64;
        this.next();
        this.state = (this.state + seed) & MASK64;
        this.next();
      }

      next(): bigint {
        const old = this.state;
        this.state = (old * MULTIPLIER + this.inc) & MASK64;
        const xorshifted = (((old >> 18n) ^ old) >> 27n) & MASK32;
        const rot = (old >> 59n) & 0x1fn;
        this.rotations.add(Number(rot));
        return ((xorshifted >> rot) | (xorshifted << ((32n - rot) & 31n))) & MASK32;
      }
    }

    const cases: readonly (readonly [bigint, bigint])[] = [
      [0n, 0n],
      [1n, 1n],
      [42n, 54n],
      [0xffff_ffff_ffff_ffffn, 0x7fff_ffff_ffff_ffffn],
      [0x853c_49e6_748f_ea9bn, 0xcbf2_9ce4_8422_2325n],
    ];

    for (const [seed, stream] of cases) {
      const mine = new Pcg32(seed, stream);
      const reference = new Reference(seed, stream);
      for (let i = 0; i < 4_000; i += 1) {
        expect(BigInt(mine.nextU32())).toBe(reference.next());
      }
      // Every rotation amount, including zero, actually occurred — otherwise
      // this test would pass without having exercised the case it exists for.
      expect(reference.rotations.size).toBe(32);
      expect(reference.rotations.has(0)).toBe(true);
    }
  });

  it("draws 64-bit seeds across the whole range", () => {
    const rng = seededPcg32(0xdead_beef_0bad_f00dn);
    const seeds = Array.from({ length: 1_000 }, () => rng.nextSeed64());
    for (const seed of seeds) {
      expect(seed).toBeGreaterThanOrEqual(0n);
      expect(seed).toBeLessThan(1n << 64n);
    }
    expect(new Set(seeds).size).toBe(seeds.length);
    // The high half must actually move; a seed built from one u32 would leave
    // every draw below 2^32 and halve the space without any test noticing.
    expect(seeds.some((seed) => seed >= 1n << 63n)).toBe(true);
  });

  it("draws a bool at the stated probability and always consumes one draw", () => {
    const rng = seededPcg32(99n);
    let hits = 0;
    for (let i = 0; i < 50_000; i += 1) if (rng.nextBool(0.25)) hits += 1;
    expect(Math.abs(hits / 50_000 - 0.25)).toBeLessThan(0.01);

    // p = 0 and p = 1 still draw, so a chaos setting that turns a decision off
    // does not shift every later decision in the sequence.
    const a = seededPcg32(5n);
    const b = seededPcg32(5n);
    expect(a.nextBool(0)).toBe(false);
    expect(b.nextBool(1)).toBe(true);
    expect(a.nextU32()).toBe(b.nextU32());
  });

  it("hashes stream names as UTF-8, not as UTF-16 code units", () => {
    // Rust hashes `name.as_bytes()`, which is UTF-8. JS strings are UTF-16, so a
    // `charCodeAt` loop would hash "é" as the single byte 0xe9 where Rust hashes
    // 0xc3 0xa9 — two streams that agree on every ASCII name and diverge on the
    // first one that is not. Checked against FNV-1a computed here over explicit
    // bytes, so the claim is about the bytes rather than about two spellings.
    const fnv1a = (bytes: readonly number[]): bigint => {
      let hash = 0xcbf2_9ce4_8422_2325n;
      for (const byte of bytes) {
        hash ^= BigInt(byte);
        hash = (hash * 0x0000_0100_0000_01b3n) & ((1n << 64n) - 1n);
      }
      return hash;
    };

    expect(streamOf("é")).toBe(fnv1a([0xc3, 0xa9]));
    expect(streamOf("é")).not.toBe(fnv1a([0xe9]));
    // The stream names the generator actually uses are ASCII, and those agree
    // under either reading — which is why this needs asserting rather than
    // being discovered the day a name grows an accent.
    expect(streamOf("surprise/stack")).toBe(
      fnv1a([...new TextEncoder().encode("surprise/stack")]),
    );
  });
});
