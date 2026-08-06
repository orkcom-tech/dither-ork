/**
 * Burkes error diffusion (F-ED-05).
 *
 * Stucki with the third row removed. Two rows of reach, a power-of-two divisor,
 * and most of Stucki's smoothness for two thirds of the taps.
 *
 * The kernel itself lives in `core/crates/dither-core/src/diffusion.rs` as the
 * `BURKES` constant; this file describes it to the UI, the
 * scheduler and Surprise Me, and holds no algorithm. The shared F-ED-CTL
 * controls come from `./error-diffusion`.
 */

import { errorDiffusionEffect } from "./error-diffusion";

export default errorDiffusionEffect({
  id: "burkes",
  name: "Burkes",
  requirement: "F-ED-05",
});
