/**
 * Stucki error diffusion (F-ED-04).
 *
 * Jarvis-Judice-Ninke's footprint with weights that halve away from the centre
 * and a power-of-two divisor. Sharper than JJN at the same reach.
 *
 * The kernel itself lives in `core/crates/dither-core/src/diffusion.rs` as the
 * `STUCKI` constant; this file describes it to the UI, the
 * scheduler and Surprise Me, and holds no algorithm. The shared F-ED-CTL
 * controls come from `./error-diffusion`.
 */

import { errorDiffusionEffect } from "./error-diffusion";

export default errorDiffusionEffect({
  id: "stucki",
  name: "Stucki",
  requirement: "F-ED-04",
});
