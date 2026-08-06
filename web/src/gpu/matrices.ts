/**
 * Threshold matrices: the upload interface between the Rust core and the
 * ordered-dither shaders.
 *
 * **The matrices are generated in Rust, not here.** Bayer tiles and
 * void-and-cluster blue-noise tiles belong in `dither-core` next to the other
 * look-defining maths, for the same reason the diffusion kernels do: one
 * implementation, one golden-image set, and a native or CLI build later that is
 * packaging rather than a rewrite. This module defines the shape that data
 * takes on the way in and refuses anything that is not it.
 *
 * **Ranks, not normalized thresholds.** A matrix arrives as `size * size`
 * integers that are a permutation of `0 .. size*size - 1`; the shader turns
 * rank `k` into the threshold `(k + 0.5) / (size * size)`. Integers cross the
 * language boundary exactly, whereas two float implementations of the same
 * recursion disagree in the last bit and put a visible seam between a CPU
 * preview and a GPU export. It is also the natural output of both generators —
 * Bayer's recursion produces an ordering, and void-and-cluster produces one by
 * definition.
 */

import { logger } from "../lib/log";

const log = logger("gpu");

export class ThresholdMatrixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThresholdMatrixError";
  }
}

/** A validated tile, ready to be handed to an ordered-dither effect. */
export interface ThresholdMatrix {
  /** Matches the effect id that consumes it, e.g. `"bayer-8"`. */
  readonly id: string;
  /** Tile edge in texels. The shader restates it as a compile-time constant. */
  readonly size: number;
  /** Row-major ranks, a permutation of `0 .. size*size - 1`. */
  readonly ranks: Uint32Array;
}

/**
 * What the GPU layer needs from `core/crates/dither-core/src/noise.rs`, through
 * `dither-wasm`.
 *
 * Written as an interface rather than an import because the Rust module is not
 * implemented yet. Nothing in this repository fabricates a matrix in
 * TypeScript to fill the gap: a plausible-looking Bayer table that disagrees
 * with the one the CPU path uses is worse than no table at all, because it
 * looks like it works.
 *
 * The two functions map to these WASM exports:
 *
 * ```rust
 * /// F-OD-01..04. Recursive Bayer ordering. `size` is a power of two, 2..=16.
 * #[wasm_bindgen]
 * pub fn bayer_ranks(size: u32) -> Vec<u32>;
 *
 * /// F-OD-05. Void-and-cluster tile. `seed` makes it reproducible; the same
 * /// seed must give byte-identical output on every platform.
 * #[wasm_bindgen]
 * pub fn blue_noise_ranks(size: u32, seed: u32) -> Vec<u32>;
 * ```
 */
export interface ThresholdMatrixSource {
  bayerRanks(size: number): Uint32Array;
  blueNoiseRanks(size: number, seed: number): Uint32Array;
}

/**
 * Check a matrix and wrap it.
 *
 * The permutation check is the whole point: a generator that repeats a rank
 * produces a tile that dithers, looks broadly right, and has a fixed pattern of
 * pixels that never cross their threshold. That is a bug found by staring at a
 * gradient for an hour, or by this loop.
 */
export function thresholdMatrix(id: string, size: number, ranks: Uint32Array): ThresholdMatrix {
  if (!Number.isInteger(size) || size < 2) {
    throw new ThresholdMatrixError(`${id}: tile size ${size} must be an integer of at least 2`);
  }
  const area = size * size;
  if (ranks.length !== area) {
    throw new ThresholdMatrixError(
      `${id}: got ${ranks.length} ranks for a ${size}x${size} tile, expected ${area}`,
    );
  }

  const seen = new Uint8Array(area);
  for (let i = 0; i < area; i += 1) {
    const rank = ranks[i];
    if (rank === undefined || rank >= area) {
      throw new ThresholdMatrixError(
        `${id}: rank ${String(rank)} at index ${i} is outside 0..${area - 1}`,
      );
    }
    if (seen[rank] === 1) {
      throw new ThresholdMatrixError(
        `${id}: rank ${rank} appears more than once; the tile is not a permutation`,
      );
    }
    seen[rank] = 1;
  }

  log.debug("threshold matrix accepted", { id, size, entries: area });
  return { id, size, ranks };
}

/**
 * The bytes a `table` binding carries.
 *
 * A view, not a copy. `Uint32Array` already uses host byte order and WebGPU
 * buffer contents are host byte order, so the shader's `array<u32>` reads
 * exactly these words.
 */
export function thresholdMatrixBytes(matrix: ThresholdMatrix): Uint8Array {
  return new Uint8Array(
    matrix.ranks.buffer,
    matrix.ranks.byteOffset,
    matrix.ranks.byteLength,
  );
}
