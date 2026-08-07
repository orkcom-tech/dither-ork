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
  summary:
    "Twelve taps over three rows — the widest reach in the family, and the softest grain.",
  description:
    "Spreading the error that widely averages out the texture and softens edges along with it, at three times Floyd–Steinberg's taps per pixel. Reach for it when you want a dither that reads as tone rather than as texture and you do not mind losing some edge definition. Stucki has the same footprint with sharper weights if you want the reach without the softness.",
  keywords: ["jarvis", "judice", "ninke", "jjn", "smooth", "soft", "wide", "three row"],
  requirement: "F-ED-03",
});
