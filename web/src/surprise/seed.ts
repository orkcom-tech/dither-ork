/**
 * The 64-bit surprise seed — F-SM-02.
 *
 * "Every surprise is derived from a single 64-bit seed, shown in the UI,
 * copyable, and encoded in the share URL. The same seed and the same build
 * always reproduce the same result, so a good accident is never lost."
 *
 * Three things follow from that sentence and all three are here.
 *
 * **It is a `bigint`, not a `number`.** 64 bits do not fit in a JS number, and a
 * seed silently truncated to 53 bits is a seed that means something different to
 * the Rust side. Everything in `surprise/` passes the seed as a `bigint` and
 * only this file turns it into text.
 *
 * **It is written as sixteen lowercase hex characters.** `DitherDocument.
 * surpriseSeed` is a `string` for exactly this reason: JSON has no 64-bit
 * integer, and `JSON.parse` of a bare `7f3a1c92b04e5d68` would come back as a
 * double that has lost its low bits. Fixed width and zero-padded so two seeds
 * sort and compare as text, and lowercase so a seed copied out of the UI and
 * pasted back is the same string.
 *
 * **Minting a fresh one is the single unseeded draw in the whole feature**, and
 * it is quarantined in {@link mintSeed} so that fact is checkable by reading one
 * function rather than by auditing a directory. See its own comment.
 */

import { logger } from "../lib/log";

const log = logger("app");

/** Sixteen lowercase hex characters. What `surpriseSeed` holds in a `.dork`. */
export const SEED_TEXT_PATTERN = /^[0-9a-f]{16}$/;

/** 2^64 - 1. A seed is taken modulo this space rather than refused for size. */
const MASK64 = (1n << 64n) - 1n;

/** The canonical text form: sixteen lowercase hex characters, zero-padded. */
export function formatSeed(seed: bigint): string {
  return BigInt.asUintN(64, seed).toString(16).padStart(16, "0");
}

/**
 * Read a seed somebody typed or pasted, or `null` if it is not one.
 *
 * Tolerant about presentation and strict about value: surrounding whitespace, a
 * `0x` prefix and upper case are all accepted because they are how a seed
 * arrives out of a chat message, and anything that is not 64 bits of hex is
 * refused rather than partially parsed. A seed that silently became a different
 * seed is the one failure this feature cannot afford — the whole point of
 * F-SM-02 is that a person can get back to a picture they liked.
 */
export function parseSeed(text: string): bigint | null {
  const trimmed = text.trim().toLowerCase().replace(/^0x/, "");
  if (trimmed.length === 0 || trimmed.length > 16) return null;
  const padded = trimmed.padStart(16, "0");
  if (!SEED_TEXT_PATTERN.test(padded)) return null;
  return BigInt(`0x${padded}`);
}

/**
 * A fresh 64-bit seed.
 *
 * **This is the only unseeded draw in the Surprise Me feature, and it is not in
 * a render path.** The project rule is that no `Math.random()` and no clock read
 * happens inside the graph; this happens strictly before one, and its result is
 * written into `DitherDocument.surpriseSeed`, so everything downstream of it —
 * the stack, every parameter, every node seed, the palette, the bindings — is
 * derived deterministically from a number the document records. That is what
 * makes "same seed and same build reproduce the same result" true rather than
 * approximately true.
 *
 * `crypto.getRandomValues` rather than `Math.random()`: `Math.random()` is
 * allowed to be seeded from anything, is 53-bit at best, and two tabs opened at
 * the same instant have been observed to agree on their first draw in some
 * engines. A seed that collides is a surprise a person cannot tell apart from
 * one they have already seen.
 */
export function mintSeed(): bigint {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  const seed = ((BigInt(words[0] ?? 0) << 32n) | BigInt(words[1] ?? 0)) & MASK64;
  log.info("surprise seed minted", { seed: formatSeed(seed) });
  return seed;
}

/**
 * The seed a document carries, or `null` when it did not come from a surprise.
 *
 * A `surpriseSeed` that is present but unreadable is reported rather than
 * ignored: it means a document was hand-edited or written by a different build,
 * and silently treating it as "not a surprise" would hide that.
 */
export function seedOfDocument(surpriseSeed: string | undefined): bigint | null {
  if (surpriseSeed === undefined) return null;
  const parsed = parseSeed(surpriseSeed);
  if (parsed === null) {
    log.warn("document carries a surpriseSeed that is not 64 bits of hex", {
      surpriseSeed,
    });
    return null;
  }
  return parsed;
}
