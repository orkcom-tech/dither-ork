/**
 * Blue noise ordered dither (F-OD-05).
 *
 * A void-and-cluster tile rather than a recursion: the thresholds are arranged
 * so the spectrum has no low-frequency energy, which is why the result has no
 * repeating pattern to see at all. It flatters more images than any of the
 * Bayer tiles, and it is the one whose tile has to be generated and cached
 * rather than derived on the spot.
 *
 * The descriptor is not written here. Its identity, its tile size and its
 * F-OD-CTL controls all live in `../gpu/effects/ordered`, next to the uniform
 * layout that reads the same parameter keys, so a rename breaks in one place
 * instead of two. This file is what makes the registry glob find it — see
 * `registry/discovery.ts` for why the catalogue is discovered and never listed.
 *
 * The threshold tile itself comes from `dither-core` through
 * `bayerRanks`/`blueNoiseRanks` at the WASM boundary. Nothing on this side
 * fabricates one.
 */

import {
  orderedDitherDescriptor,
  orderedDitherEffect,
  orderedDitherSpec,
} from "../gpu/effects/ordered";
import { thresholdMatrixGpuEffect } from "../types/registry";

const spec = orderedDitherSpec("blue-noise");

export default orderedDitherDescriptor(spec);

/**
 * Resolves this effect's id to its passes; see `registry/gpu-effects.ts`.
 *
 * The tile is a build-time input rather than something this module fetches: it
 * comes from `dither-core`, and an ordered dither has no passes until it has
 * one. That is the case the source contract exists for.
 */
export const gpu = thresholdMatrixGpuEffect(spec.effectId, spec.tile, (matrix) =>
  orderedDitherEffect(spec, matrix),
);
