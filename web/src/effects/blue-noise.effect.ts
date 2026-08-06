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

import { orderedDitherDescriptor, orderedDitherSpec } from "../gpu/effects/ordered";

export default orderedDitherDescriptor(orderedDitherSpec("blue-noise"));
