/**
 * Atkinson error diffusion (F-ED-09).
 *
 * Bill Atkinson's kernel from the original Macintosh. Six taps of 1/8 each,
 * so only three quarters of the error is ever passed on; the missing eighth is
 * what blows out highlights and crushes shadows, and it is the whole reason
 * this one looks like a 1984 Mac screen rather than like the others.
 *
 * The kernel itself lives in `core/crates/dither-core/src/diffusion.rs` as the
 * `ATKINSON` constant; this file describes it to the UI, the
 * scheduler and Surprise Me, and holds no algorithm. The shared F-ED-CTL
 * controls come from `./error-diffusion`.
 */

import { errorDiffusionEffect } from "./error-diffusion";

export default errorDiffusionEffect({
  id: "atkinson",
  name: "Atkinson",
  summary:
    "The original Macintosh dither: only three quarters of the error is passed on, so highlights blow out and shadows crush.",
  description:
    "Bill Atkinson's kernel, six taps of one eighth each. The missing eighth is the whole character of it — error that is discarded rather than passed on, which throws contrast away at both ends and leaves large clean areas of pure white and pure black. That is why this one looks like a 1984 Mac screen and none of the others do. Pair it with a one-bit palette for the classic result.",
  keywords: ["atkinson", "mac", "macintosh", "apple", "1 bit", "one bit", "hypercard", "classic", "blown out", "retro"],
  requirement: "F-ED-09",
});
