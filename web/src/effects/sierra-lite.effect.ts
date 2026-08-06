/**
 * Sierra Lite error diffusion (F-ED-08).
 *
 * Three taps over two rows, divisor 4. The cheapest kernel here, and the
 * closest thing in the family to Floyd-Steinberg's grain at half its taps.
 *
 * The kernel itself lives in `core/crates/dither-core/src/diffusion.rs` as the
 * `SIERRA_LITE` constant; this file describes it to the UI, the
 * scheduler and Surprise Me, and holds no algorithm. The shared F-ED-CTL
 * controls come from `./error-diffusion`.
 */

import { errorDiffusionEffect } from "./error-diffusion";

export default errorDiffusionEffect({
  id: "sierra-lite",
  name: "Sierra Lite",
  requirement: "F-ED-08",
});
