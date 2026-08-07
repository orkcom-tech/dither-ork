/**
 * Stevenson-Arce error diffusion (F-ED-10).
 *
 * Twelve taps on a hexagonal lattice over three rows below the current one.
 * Designed for a hex-addressed display, and the lattice is why its texture has
 * no horizontal or vertical grain at all.
 *
 * The kernel itself lives in `core/crates/dither-core/src/diffusion.rs` as the
 * `STEVENSON_ARCE` constant; this file describes it to the UI, the
 * scheduler and Surprise Me, and holds no algorithm. The shared F-ED-CTL
 * controls come from `./error-diffusion`.
 */

import { errorDiffusionEffect } from "./error-diffusion";

export default errorDiffusionEffect({
  id: "stevenson-arce",
  name: "Stevenson-Arce",
  summary:
    "Twelve taps on a hexagonal lattice, so the texture has no horizontal or vertical grain at all.",
  description:
    "Designed for a hex-addressed display, and the lattice is the reason to choose it: because no taps line up on the row or column axes, the result carries none of the rectilinear structure the other kernels leave behind. It reaches three rows below the current one, so it is among the widest and most expensive here.",
  keywords: ["stevenson", "arce", "hex", "hexagonal", "lattice", "wide", "isotropic"],
  requirement: "F-ED-10",
});
