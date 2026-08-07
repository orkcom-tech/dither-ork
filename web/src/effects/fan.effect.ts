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
  summary:
    "Floyd–Steinberg with the bottom row shifted one column left, which drags the error cone sideways.",
  description:
    "The row below runs from two columns left to directly underneath, where Floyd–Steinberg's runs from one left to one right. That is the whole trick: nothing lands diagonally ahead of the scan, so the diagonal worm Floyd–Steinberg produces has nowhere to start. Worth trying whenever those diagonals are showing and serpentine alone has not settled them.",
  keywords: ["fan", "shifted", "variant", "asymmetric"],
  requirement: "F-ED-11",
});
