/**
 * False Floyd-Steinberg error diffusion (F-ED-02).
 *
 * The three-tap simplification that circulated as Floyd-Steinberg and is not.
 * It is here as itself, not as a bug: dropping the down-left tap throws away
 * the leftward error path, and the resulting diagonal drag is a look people
 * came to expect from the implementations that shipped it.
 *
 * The kernel itself lives in `core/crates/dither-core/src/diffusion.rs` as the
 * `FALSE_FLOYD_STEINBERG` constant; this file describes it to the UI, the
 * scheduler and Surprise Me, and holds no algorithm. The shared F-ED-CTL
 * controls come from `./error-diffusion`.
 */

import { errorDiffusionEffect } from "./error-diffusion";

export default errorDiffusionEffect({
  id: "false-floyd-steinberg",
  name: "False Floyd-Steinberg",
  requirement: "F-ED-02",
});
