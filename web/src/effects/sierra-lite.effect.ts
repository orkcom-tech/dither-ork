/**
 * Sierra Lite error diffusion (F-ED-08).
 *
 * Three taps over two rows, divisor 4. The cheapest kernel here, and the
 * closest thing in the family to Floyd-Steinberg's grain at half its taps.
 *
 * The kernel itself lives in `core/crates/dither-core/src/diffusion.rs` as the
 * `SIERRA_LITE` constant; this file describes it to the UI, the
 * scheduler and Surprise Me, and holds no algorithm. The shared F-ED-CTL
 * controls come from `./error-diffusion`.
 */

import { errorDiffusionEffect } from "./error-diffusion";

export default errorDiffusionEffect({
  id: "sierra-lite",
  name: "Sierra Lite",
  summary:
    "The cheapest kernel here — three taps over two rows, close to Floyd–Steinberg's grain at half the work.",
  description:
    "Divisor four, three taps. It gets remarkably close to Floyd–Steinberg's texture for half the taps, which makes it the one to reach for on very large images or when several diffusion nodes are stacked. The trade is slightly more directional structure.",
  keywords: ["sierra", "sierra lite", "fast", "cheap", "three tap", "light"],
  requirement: "F-ED-08",
});
