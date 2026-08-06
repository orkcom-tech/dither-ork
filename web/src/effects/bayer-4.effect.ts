/**
 * Bayer 4×4 ordered dither (F-OD-02).
 *
 * Sixteen thresholds. The tile most people picture when they say "ordered
 * dither" — coarse enough to see the pattern, fine enough to hold a gradient.
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

export default orderedDitherDescriptor(orderedDitherSpec("bayer-4"));
