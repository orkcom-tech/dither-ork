/**
 * Shiau-Fan error diffusion (F-ED-12).
 *
 * Half the error straight to the right and the rest fanned down-left. The
 * asymmetry is deliberate: it keeps error moving along the scan rather than
 * pooling under the current pixel.
 *
 * The kernel itself lives in `core/crates/dither-core/src/diffusion.rs` as the
 * `SHIAU_FAN` constant; this file describes it to the UI, the
 * scheduler and Surprise Me, and holds no algorithm. The shared F-ED-CTL
 * controls come from `./error-diffusion`.
 */

import { errorDiffusionEffect } from "./error-diffusion";

export default errorDiffusionEffect({
  id: "shiau-fan",
  name: "Shiau-Fan",
  summary:
    "Half the error goes straight right and the rest fans down-left — deliberately asymmetric.",
  description:
    "Four eighths go straight right and the remaining four are spread 1, 1, 2 across the row below, ending directly underneath. The asymmetry keeps error moving along the scan rather than pooling under the current pixel, which suppresses the clumping flat areas otherwise show. Every weight is a power of two over a power of two, so the whole kernel is shifts — it is among the cheapest here. Being directional by construction, it benefits more than most from serpentine scanning.",
  keywords: ["shiau", "shiau fan", "asymmetric", "directional"],
  requirement: "F-ED-12",
});
