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
  requirement: "F-ED-10",
});
