/**
 * Riemersma error diffusion (F-ED-15).
 *
 * Riemersma, 1998. The odd one out twice over: it visits pixels along a
 * Hilbert curve instead of by rows, and it hands error forward through a
 * fixed-length queue whose weights decay exponentially instead of splashing it
 * onto named neighbours. Because the curve has no preferred direction the
 * output has no directional structure at all — no worms, no diagonal grain,
 * and nothing for serpentine scanning to fix, which is why the scan-direction
 * control is absent here rather than present and inert.
 *
 * The kernel itself lives in `core/crates/dither-core/src/diffusion.rs` as the
 * `RIEMERSMA` constant; this file describes it to the UI, the
 * scheduler and Surprise Me, and holds no algorithm. The shared F-ED-CTL
 * controls come from `./error-diffusion`.
 */

import { errorDiffusionEffect } from "./error-diffusion";

export default errorDiffusionEffect({
  id: "riemersma",
  name: "Riemersma",
  requirement: "F-ED-15",
  serpentine: false,
});
