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
  summary:
    "Stucki with the third row removed — most of its smoothness for seven of its twelve taps.",
  description:
    "Two rows of reach and a divisor of 32, so every weight is a shift. Losing Stucki's third row costs a little of the smoothness the wide kernels have and buys back nearly half the work, which makes it a good middle choice when Floyd–Steinberg's grain is too busy but Jarvis–Judice–Ninke's softness is too much.",
  keywords: ["burkes", "two row", "balanced", "medium"],
  requirement: "F-ED-05",
});
