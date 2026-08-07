/**
 * PCG32, byte-identical to `core/crates/dither-core/src/rng.rs`.
 *
 * # Why this exists on this side of the WASM boundary at all
 *
 * docs/ARCHITECTURE.md originally put the surprise generator in `core/gen`. It
 * is here instead, and the decision was made on 2026-08-06 for two reasons that
 * are both about what the generator actually touches:
 *
 * - **Its only data source is the node registry, and the registry is
 *   TypeScript.** Every effect declares its surprise range, distribution and
 *   weight in `web/src/types/registry.ts` and its own module under
 *   `web/src/effects/`. A Rust generator would need that whole table mirrored
 *   across the boundary — sixty-seven descriptors and several hundred parameter
 *   declarations — and the mirror is what would drift the first time somebody
 *   added an effect.
 * - **It never touches a pixel.** It emits a `.dork` document, kilobytes of
 *   JSON. The performance argument that puts diffusion kernels in Rust — a
 *   serial loop over millions of pixels — does not apply to drawing forty
 *   numbers.
 *
 * # The cost that decision incurs, and this file is it
 *
 * A seed has to mean the same thing on both sides. `StackNode.seed` is drawn
 * here and read by a shader and by a Rust kernel; a document generated here has
 * to be reproducible by anything that later re-derives from the same seed,
 * including a Rust batch worker. So this generator must produce the **same
 * sequence** as `rng.rs`, and `rng.parity.test.ts` pins that against the same
 * known-answer vectors the Rust test module uses. That test is the whole
 * justification for keeping the generator in TypeScript; without it the
 * decision is a guess.
 *
 * # Why BigInt
 *
 * PCG32's state advance is a 64-bit wrapping multiply-add. A JS `number` holds
 * 53 bits of integer exactly, so the multiply would silently lose the high bits
 * and the sequence would diverge from Rust's on the first draw — plausible noise
 * that is not the same noise. `BigInt` is exact; the cost is that a draw
 * allocates, and it is paid a few thousand times per surprise rather than once
 * per pixel, which is the same argument that put this module here.
 *
 * The **output** is a plain `number` in every case: `next_u32` returns a `u32`,
 * which is exactly representable, so nothing downstream has to know a `BigInt`
 * was involved.
 */

/** 2^64 - 1. Every state update is masked back into the u64 range with it. */
const MASK64 = (1n << 64n) - 1n;

/**
 * LCG multiplier from the reference PCG implementation.
 *
 * Transcribed from `MULTIPLIER` in `core/crates/dither-core/src/rng.rs`, where
 * the same comment says it is a constant and not a tunable: changing it changes
 * every rendered frame with a stochastic node in it. Changing it *here* would
 * additionally make the two sides disagree, which `rng.parity.test.ts` is what
 * catches.
 */
const MULTIPLIER = 6_364_136_223_846_793_005n;

/** Stream used by {@link seededPcg32}, matching `DEFAULT_STREAM` in rng.rs. */
const DEFAULT_STREAM = 0n;

/**
 * 2^-24, matching `F32_SCALE` in rng.rs.
 *
 * Both the scale and every numerator are exactly representable in `f32` *and*
 * in `f64`, so the multiplication is exact in both languages and the two agree
 * bit for bit — which is not true of a scale like `1 / 0xffffffff`.
 */
const F32_SCALE = 1 / 16_777_216;

/** FNV-1a 64-bit offset basis and prime, used by {@link streamOf}. */
const FNV_OFFSET = 0xcbf2_9ce4_8422_2325n;
const FNV_PRIME = 0x0000_0100_0000_01b3n;

/** Thrown rather than an answer being invented for a range that has none. */
export class RngRangeError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "RngRangeError";
  }
}

/**
 * A seeded PCG32 generator.
 *
 * Mutable by design — a generator is a position in a sequence — and deliberately
 * not cloneable through any public method. `rng.rs` makes the same point by
 * refusing `Copy`: an accidental duplicate hands out a second generator walking
 * the identical sequence, which is precisely the bug seeded randomness exists to
 * prevent.
 */
export class Pcg32 {
  #state: bigint;
  /**
   * The sequence selector, stored pre-shifted and forced odd as the reference
   * implementation requires — an even increment shortens the period of the
   * underlying LCG.
   */
  readonly #inc: bigint;

  /**
   * Seed a generator on an explicit stream.
   *
   * `seed` is the document seed; `stream` selects which of the 2^63 distinct
   * sequences this generator walks. Two generators built from the same seed and
   * different streams are independent, which is what keeps one node's draws from
   * depending on how many draws the nodes before it happened to make.
   */
  constructor(seed: bigint, stream: bigint = DEFAULT_STREAM) {
    // The reference seeding routine: zero the state, install the increment,
    // step once, add the seed, step again. Both steps are load bearing —
    // without them low-entropy seeds such as 0 and 1 produce visibly correlated
    // first outputs.
    this.#state = 0n;
    this.#inc = ((BigInt.asUintN(64, stream) << 1n) | 1n) & MASK64;
    this.nextU32();
    this.#state = (this.#state + BigInt.asUintN(64, seed)) & MASK64;
    this.nextU32();
  }

  /** Next 32 bits. Every other draw is built on this one. */
  nextU32(): number {
    const old = this.#state;
    this.#state = (old * MULTIPLIER + this.#inc) & MASK64;

    // XSH-RR: xorshift the high bits down to 32, then rotate by an amount taken
    // from the top 5 bits. The rotation is what defeats the lattice structure a
    // plain truncated LCG has in its low bits.
    const xorshifted = Number((((old >> 18n) ^ old) >> 27n) & 0xffff_ffffn);
    const rot = Number((old >> 59n) & 0x1fn);
    // `x << 32` in JS shifts by `32 % 32 === 0`, so the rot === 0 case comes out
    // as `x | x === x`, which is what `rotate_right(0)` returns in Rust.
    return ((xorshifted >>> rot) | (xorshifted << (32 - rot))) >>> 0;
  }

  /**
   * Uniform number in `[0, 1)`.
   *
   * Takes the top 24 bits, which is exactly the `f32` significand Rust's
   * `next_f32` uses: every representable value in the range is reachable,
   * spacing is uniform, and the result is provably below 1.0. Returned as a
   * `f64`, whose value is identical to the `f32` Rust produces because the
   * numerator is below 2^24 and the scale is a power of two.
   */
  nextF32(): number {
    return (this.nextU32() >>> 8) * F32_SCALE;
  }

  /**
   * Uniform integer in `[0, bound)`, without modulo bias.
   *
   * A bare `nextU32() % bound` favours the low end whenever `bound` does not
   * divide 2^32. That is invisible for a dice roll and very visible in a
   * three-value enum sampled across a batch, so the biased draws are rejected
   * instead — the same rejection loop, with the same threshold, as `rng.rs`.
   *
   * @throws RngRangeError when `bound` is not a positive integer. An empty range
   * has no correct answer, and returning 0 would hide the caller's bug in the
   * generated document.
   */
  nextBelow(bound: number): number {
    if (!Number.isInteger(bound) || bound <= 0 || bound > 0xffff_ffff) {
      throw new RngRangeError(`bound must be a positive u32, got ${bound}`);
    }
    // 2^32 % bound, computed without widening: the size of the short final block
    // of [0, 2^32). Draws landing in the first `threshold` values are the ones
    // that would be over-represented after the modulo.
    const threshold = (-bound >>> 0) % bound;
    for (;;) {
      const r = this.nextU32();
      if (r >= threshold) return r % bound;
    }
  }

  /**
   * Uniform integer in `[low, high)`, without modulo bias.
   *
   * @throws RngRangeError when the range is empty.
   */
  nextRange(low: number, high: number): number {
    if (!Number.isInteger(low) || !Number.isInteger(high)) {
      throw new RngRangeError(`range bounds must be integers, got ${low}..${high}`);
    }
    if (low >= high) {
      throw new RngRangeError(`range must be non-empty: ${low}..${high}`);
    }
    // The span of a non-empty i32 range always fits in a u32, and a u32 is
    // exactly representable as a JS number, so this needs no widening of its own.
    const span = high - low;
    return low + this.nextBelow(span);
  }

  /** Uniform number in `[low, high)`. Both bounds must be finite. */
  nextFloat(low: number, high: number): number {
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
      throw new RngRangeError(`float range bounds must be finite, got ${low}..${high}`);
    }
    if (low > high) {
      throw new RngRangeError(`float range is inverted: ${low}..${high}`);
    }
    return low + (high - low) * this.nextF32();
  }

  /** `true` with the given probability. `p <= 0` never fires; `p >= 1` always does. */
  nextBool(probability: number): boolean {
    if (!Number.isFinite(probability)) {
      throw new RngRangeError(`probability must be finite, got ${probability}`);
    }
    // The draw happens either way. A generator that skipped it for p = 0 would
    // put every later draw in a different place, so a chaos setting that turns
    // one decision off would silently re-roll everything after it.
    const u = this.nextF32();
    return u < probability;
  }

  /** A fresh 64-bit seed drawn from this generator, for a derived document. */
  nextSeed64(): bigint {
    const hi = BigInt(this.nextU32());
    const lo = BigInt(this.nextU32());
    return ((hi << 32n) | lo) & MASK64;
  }
}

/** Seed a generator on the default stream, matching `Pcg32::seeded`. */
export function seededPcg32(seed: bigint): Pcg32 {
  return new Pcg32(seed, DEFAULT_STREAM);
}

/**
 * Map a name to a stream selector — FNV-1a 64, matching `stream_of` in rng.rs.
 *
 * Lets each part of a surprise name its own independent stream —
 * `streamOf("surprise/stack")`, `streamOf("surprise/params/n3")` — without a
 * central table of stream numbers that every new step would have to edit and
 * that two steps could collide in by hand.
 *
 * FNV-1a because it is specified to the bit and has published test vectors.
 * A JS string hash of convenience would not do for the same reason `rng.rs`
 * refuses `std::hash::DefaultHasher`: an unspecified algorithm silently re-rolls
 * every seeded draw the day it changes.
 *
 * The bytes hashed are **UTF-8**, so a name is hashed identically here and in
 * Rust. JS strings are UTF-16, so the encode is explicit rather than a
 * `charCodeAt` loop, which would disagree on any non-ASCII character.
 */
export function streamOf(name: string): bigint {
  const bytes = new TextEncoder().encode(name);
  let hash = FNV_OFFSET;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash;
}

/**
 * A generator for one named part of one surprise.
 *
 * The whole feature draws through this, so every stream in the feature is
 * derived from the document seed and a name, and nothing takes turns from a
 * shared generator.
 *
 * Deliberately silent. One surprise opens a stream per parameter of every node —
 * several hundred — and a line each would bury the lines that say what the
 * surprise actually did. What is logged is one line per node and one per
 * surprise, in `params.ts` and `generate.ts`, which is the level a person reads
 * at. Opening a generator is not an event.
 */
export function streamFor(seed: bigint, name: string): Pcg32 {
  return new Pcg32(seed, streamOf(name));
}
