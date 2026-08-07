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
  summary:
    "The dither everybody means by the word — four taps, and the finest grain in the family.",
  description:
    "Floyd and Steinberg, 1976. The error goes to four neighbours over two rows, which is the shortest path any kernel here uses, and a short path is why the grain is fine and busy. It is also why this kernel worms the most: with serpentine off the leftover error walks the same way on every line and organises into visible diagonal trails. Start here — it is the reference the other fourteen are variations on.",
  keywords: ["floyd", "steinberg", "floyd steinberg", "classic", "standard", "default", "fine grain"],
  requirement: "F-ED-01",
});
