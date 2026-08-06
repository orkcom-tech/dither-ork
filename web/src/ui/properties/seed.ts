/**
 * Where a new seed comes from.
 *
 * Drawing a seed is a **user action**, not a render step: the value is written
 * into the document and every later render reads it from there. That is what
 * keeps the determinism rule intact — "no `Math.random()`, no wall-clock reads
 * inside the graph" (docs/ARCHITECTURE.md) — while still letting a person press
 * a button and get a different result.
 *
 * `crypto.getRandomValues` rather than `Math.random()` because it produces a
 * uniform 32-bit integer directly, which is exactly the seed's domain;
 * `Math.random() * 0xffffffff` has a 53-bit mantissa spread unevenly over that
 * range and would make some seeds unreachable.
 */

import { logger } from "../../lib/log";
import { SEED_RANGE } from "../../types/registry";

const log = logger("app");

/** A fresh seed in the full 32-bit unsigned range. */
export function randomSeed(): number {
  const draw = new Uint32Array(1);
  crypto.getRandomValues(draw);
  const seed = draw[0] ?? 0;
  log.debug("seed drawn", { seed, min: SEED_RANGE[0], max: SEED_RANGE[1] });
  return seed;
}
