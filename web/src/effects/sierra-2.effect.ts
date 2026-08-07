/**
 * Sierra-2 (two-row) error diffusion (F-ED-07).
 *
 * Sierra with the third row folded away. The middle of the family — cheaper
 * than Sierra-3, smoother than Sierra Lite.
 *
 * The kernel itself lives in `core/crates/dither-core/src/diffusion.rs` as the
 * `SIERRA_2` constant; this file describes it to the UI, the
 * scheduler and Surprise Me, and holds no algorithm. The shared F-ED-CTL
 * controls come from `./error-diffusion`.
 */

import { errorDiffusionEffect } from "./error-diffusion";

export default errorDiffusionEffect({
  id: "sierra-2",
  name: "Sierra-2 (two-row)",
  summary:
    "Sierra with the third row folded away — the middle of the Sierra family.",
  description:
    "Cheaper than Sierra-3 and smoother than Sierra Lite, over two rows. There is nothing exotic about it, and that is the point: it is the Sierra to use when the three-row version spreads the error further than the image wants.",
  keywords: ["sierra", "sierra 2", "two row", "middle", "balanced"],
  requirement: "F-ED-07",
});
