/**
 * False Floyd-Steinberg error diffusion (F-ED-02).
 *
 * The three-tap simplification that circulated as Floyd-Steinberg and is not.
 * It is here as itself, not as a bug: dropping Floyd-Steinberg's *down-right*
 * tap means no error is ever handed to a pixel both ahead of the scan and below
 * it, and the resulting diagonal drag is a look people came to expect from the
 * implementations that shipped it.
 *
 * (An earlier version of this comment said the *down-left* tap was dropped.
 * `FALSE_FLOYD_STEINBERG` is `[(1,0,3), (-1,1,3), (0,1,2)]` over 8 — down-left
 * is present and down-right is the one that is gone.)
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
  summary:
    "The three-tap simplification that circulated as Floyd–Steinberg and is not it.",
  description:
    "Three taps over eighths — right, down-left and down — where Floyd–Steinberg has four sixteenths. What is missing is the down-right tap, so no error is ever handed to a pixel that is both ahead of the scan and below it, and the texture drags along the descending-left diagonal instead of settling. It is in the catalogue as itself rather than as a bug: a great many implementations shipped this by mistake and the look is what people remember from them. It is also the least agreed-on kernel here — other implementations put the second row a column to the right, and both forms are called false Floyd–Steinberg.",
  keywords: ["false floyd", "simplified", "three tap", "diagonal", "drag", "variant"],
  requirement: "F-ED-02",
});
