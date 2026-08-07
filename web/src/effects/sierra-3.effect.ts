/**
 * Sierra-3 error diffusion (F-ED-06).
 *
 * Three rows, ten taps. The full Sierra: JJN's reach with weights redistributed
 * towards the current row, which keeps more edge detail.
 *
 * The kernel itself lives in `core/crates/dither-core/src/diffusion.rs` as the
 * `SIERRA_3` constant; this file describes it to the UI, the
 * scheduler and Surprise Me, and holds no algorithm. The shared F-ED-CTL
 * controls come from `./error-diffusion`.
 */

import { errorDiffusionEffect } from "./error-diffusion";

export default errorDiffusionEffect({
  id: "sierra-3",
  name: "Sierra-3",
  summary:
    "The full Sierra: three rows and ten taps, with the weights pulled towards the row being scanned.",
  description:
    "It has Jarvis–Judice–Ninke's reach but redistributes weight towards the current row, which keeps more edge detail at a similar smoothness. If you want a wide kernel that does not soften the picture, try this after Stucki.",
  keywords: ["sierra", "sierra 3", "three row", "wide", "detail"],
  requirement: "F-ED-06",
});
