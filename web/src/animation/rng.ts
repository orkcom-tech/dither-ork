/**
 * Seeded, stateless integer mixing — the only source of "randomness" in the
 * animation module (F-AN-05).
 *
 * There is no generator object and no stream to advance. Every draw is a pure
 * function of an explicit seed and an explicit index, so the value for frame 41
 * does not depend on frames 0 to 40 ever having been evaluated. That matters for
 * two reasons the render path actually has:
 *
 * - **Scrubbing.** A timeline lands on an arbitrary frame. A stateful generator
 *   would have to be run forward from 0 to get there, and would give a different
 *   answer if it were not.
 * - **The cache.** `graph/animate.ts` decides which nodes are frame-invariant by
 *   hashing every frame up front, before any of them renders. A stateful
 *   generator would make the hash depend on the order the frames were prepared
 *   in.
 *
 * **No `Math.random`, no `Date.now`, no `performance.now`.** Nothing in this
 * file reads anything outside its arguments, which is the F-AN-05 guarantee in
 * its most literal form, and `rng.test.ts` proves it by making all three throw.
 *
 * ## Why this is bit-exact everywhere and `Math.sin` is not
 *
 * Everything here is 32-bit integer arithmetic through `Math.imul` and `>>> 0`,
 * both of which are exactly specified by the language. So the seed lever of
 * temporal variation (F-AN-04) is byte-identical on every platform and every
 * engine — which is a stronger guarantee than the pipeline as a whole makes,
 * since `srgb_to_linear` and the modulator's `Math.sin` are not correctly
 * rounded anywhere (see docs/ARCHITECTURE.md, "Determinism").
 *
 * The mixer is the MurmurHash3 32-bit finalizer, and the fold is FNV-1a's.
 * Neither is a cryptographic choice and neither needs to be: what is required is
 * that consecutive indices produce uncorrelated outputs, which avalanche gives,
 * and that the function is fixed forever, which is why it is written out here
 * rather than imported from something that might be tuned later.
 */

/** MurmurHash3's 32-bit finalizer. Avalanches every input bit. */
export function mix32(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** FNV-1a's offset basis and prime, 32-bit. */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Fold a sequence of 32-bit words into one.
 *
 * Order matters and length matters: `fold(a, b)` is not `fold(b, a)`, and
 * `fold(a)` is not `fold(a, 0)`. Both properties are wanted — two seed inputs
 * that differ only in how they were split must not collide.
 */
export function fold(...words: readonly number[]): number {
  let h = FNV_OFFSET >>> 0;
  // The length goes in first so that `fold(a)` and `fold(a, 0)` differ.
  h = mixWord(h, words.length >>> 0);
  for (const word of words) h = mixWord(h, word >>> 0);
  return mix32(h);
}

function mixWord(state: number, word: number): number {
  let h = state >>> 0;
  for (let byte = 0; byte < 4; byte += 1) {
    h = (h ^ ((word >>> (byte * 8)) & 0xff)) >>> 0;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h;
}

/**
 * A stable 32-bit seed for a string — a node id, a parameter key, a mode name.
 *
 * UTF-16 code units rather than UTF-8 bytes, because the input is always an
 * identifier this codebase minted and the conversion would buy nothing but a
 * `TextEncoder` allocation per call. Length is folded in for the same reason as
 * in {@link fold}.
 */
export function seedFromString(text: string): number {
  let h = FNV_OFFSET >>> 0;
  h = mixWord(h, text.length >>> 0);
  for (let i = 0; i < text.length; i += 1) {
    h = mixWord(h, text.charCodeAt(i) >>> 0);
  }
  return mix32(h);
}

/**
 * A draw in `[0, 1)`.
 *
 * Divided by 2^32 rather than by 2^32 - 1, so the result is uniform over the
 * half-open interval and can never be exactly 1 — which is what every consumer
 * here wants, since they all multiply it by a count and take the floor.
 */
export function unitFrom(word: number): number {
  return (word >>> 0) / 0x1_0000_0000;
}

/** A draw in `[-1, 1)`. */
export function bipolarFrom(word: number): number {
  return unitFrom(word) * 2 - 1;
}

/**
 * A seed value in the range `StackNode.seed` and the `seed` parameter kind use.
 *
 * `SEED_RANGE` in `types/registry.ts` is the full unsigned 32-bit space, which
 * is exactly what {@link fold} produces, so no scaling is involved and no value
 * is unreachable.
 */
export function seedValue(...words: readonly number[]): number {
  return fold(...words);
}
