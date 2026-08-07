/**
 * Stucki error diffusion (F-ED-04).
 *
 * Jarvis-Judice-Ninke's footprint with weights that halve away from the centre
 * — 8, 4, 2, 1. Sharper than JJN at the same reach.
 *
 * (An earlier version of this comment credited it with a power-of-two divisor.
 * `STUCKI` divides by 42; Burkes is the kernel in this family whose divisor is
 * a power of two, at 32.)
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
  summary:
    "Jarvis–Judice–Ninke's reach with weights that halve outward — the same spread, noticeably sharper.",
  description:
    "The same twelve-tap footprint as Jarvis–Judice–Ninke, but every weight halves as it moves away from the centre — 8, 4, 2, 1 — instead of tapering gently. More of the error stays near the pixel that produced it, so edges survive better while the texture keeps most of JJN's smoothness. Of the two wide kernels this is usually the better starting point.",
  keywords: ["stucki", "sharp", "wide", "three row", "smooth"],
  requirement: "F-ED-04",
});
