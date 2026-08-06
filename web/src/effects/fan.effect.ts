/**
 * Fan error diffusion (F-ED-11).
 *
 * Floyd-Steinberg with the bottom row shifted one column left. A one-cell
 * change that moves the whole error cone leftward and takes the diagonal
 * worming with it.
 *
 * The kernel itself lives in `core/crates/dither-core/src/diffusion.rs` as the
 * `FAN` constant; this file describes it to the UI, the
 * scheduler and Surprise Me, and holds no algorithm. The shared F-ED-CTL
 * controls come from `./error-diffusion`.
 */

import { errorDiffusionEffect } from "./error-diffusion";

export default errorDiffusionEffect({
  id: "fan",
  name: "Fan",
  requirement: "F-ED-11",
});
