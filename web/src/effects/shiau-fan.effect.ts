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
  requirement: "F-ED-12",
});
