/**
 * Shiau-Fan 2 error diffusion (F-ED-13).
 *
 * Shiau-Fan with a wider fan — one more tap to the left on the row below.
 * Softer than Shiau-Fan and still directional.
 *
 * The kernel itself lives in `core/crates/dither-core/src/diffusion.rs` as the
 * `SHIAU_FAN_2` constant; this file describes it to the UI, the
 * scheduler and Surprise Me, and holds no algorithm. The shared F-ED-CTL
 * controls come from `./error-diffusion`.
 */

import { errorDiffusionEffect } from "./error-diffusion";

export default errorDiffusionEffect({
  id: "shiau-fan-2",
  name: "Shiau-Fan 2",
  requirement: "F-ED-13",
});
