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
  requirement: "F-ED-09",
});
