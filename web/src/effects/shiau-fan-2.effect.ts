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
  summary:
    "Shiau–Fan with one more tap on the row below — a wider fan, softer, still directional.",
  description:
    "The same shape reaching one column further back: eight sixteenths straight right, and 1, 1, 2, 4 across the row below. Spreading the downward half over four columns instead of three trades a little sharpness for fewer worms still. Choose it over plain Shiau–Fan when that kernel's grain is too coarse for the image.",
  keywords: ["shiau", "shiau fan 2", "wide", "soft", "directional"],
  requirement: "F-ED-13",
});
