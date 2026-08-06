/**
 * Bayer 16×16 ordered dither (F-OD-04).
 *
 * Two hundred and fifty-six thresholds — one per level of an 8-bit channel, so
 * this is the largest Bayer tile that can add anything. Its structure is only
 * visible when the tile is scaled up.
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

import { orderedDitherDescriptor, orderedDitherSpec } from "../gpu/effects/ordered";

export default orderedDitherDescriptor(orderedDitherSpec("bayer-16"));
