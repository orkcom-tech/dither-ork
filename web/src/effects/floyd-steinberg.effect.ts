/**
 * Floyd-Steinberg error diffusion (F-ED-01).
 *
 * Floyd & Steinberg, 1976. The one everybody means by "dithering": four
 * taps over two rows, and the shortest error path of the family, which is why
 * its grain is the finest and why it worms the most without serpentine.
 *
 * The kernel itself lives in `core/crates/dither-core/src/diffusion.rs` as the
 * `FLOYD_STEINBERG` constant; this file describes it to the UI, the
 * scheduler and Surprise Me, and holds no algorithm. The shared F-ED-CTL
 * controls come from `./error-diffusion`.
 */

import { errorDiffusionEffect } from "./error-diffusion";

export default errorDiffusionEffect({
  id: "floyd-steinberg",
  name: "Floyd-Steinberg",
  requirement: "F-ED-01",
});
