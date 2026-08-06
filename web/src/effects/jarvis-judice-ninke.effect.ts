/**
 * Jarvis-Judice-Ninke error diffusion (F-ED-03).
 *
 * Twelve taps over three rows. Spreading error that widely smooths the texture
 * and softens edges, and it costs three times Floyd-Steinberg's taps per pixel
 * — the trade the whole family is a spectrum of.
 *
 * The kernel itself lives in `core/crates/dither-core/src/diffusion.rs` as the
 * `JARVIS_JUDICE_NINKE` constant; this file describes it to the UI, the
 * scheduler and Surprise Me, and holds no algorithm. The shared F-ED-CTL
 * controls come from `./error-diffusion`.
 */

import { errorDiffusionEffect } from "./error-diffusion";

export default errorDiffusionEffect({
  id: "jarvis-judice-ninke",
  name: "Jarvis-Judice-Ninke",
  requirement: "F-ED-03",
});
