/**
 * Ostromoukhov error diffusion (F-ED-14).
 *
 * Ostromoukhov, 2001. The only kernel in the catalogue whose coefficients
 * depend on the pixel: three taps — the same three Sierra Lite uses — whose
 * weights are looked up per input level from a table solved off-line so the
 * spectrum at each key level sits as close to blue noise as three coefficients
 * can be made to sit. That is why it is both cheaper than Floyd-Steinberg and
 * quieter than it.
 *
 * The kernel and its 128 published rows live in
 * `core/crates/dither-core/src/diffusion.rs` as the `OSTROMOUKHOV` constant,
 * where the transcription is pinned by the paper's own construction — every
 * non-key level is an exact linear interpolation of its neighbours' normalized
 * coefficients, checked in rational arithmetic. This file describes the kernel
 * to the UI, the scheduler and Surprise Me, and holds no algorithm. The shared
 * F-ED-CTL controls come from `./error-diffusion`; every one of them is live
 * here, because `run_variable` scans in rows and resolves through the same
 * jitter, clamp and channel machinery as the fixed-tap kernels.
 */

import { errorDiffusionEffect } from "./error-diffusion";

export default errorDiffusionEffect({
  id: "ostromoukhov",
  name: "Ostromoukhov",
  summary:
    "The only kernel whose weights change with the input tone — three taps, tuned per level towards blue noise.",
  description:
    "Ostromoukhov, 2001. Three taps, the same three Sierra Lite uses, but their proportions are looked up per input level from a table solved offline so that the spectrum at each level sits as close to blue noise as three coefficients can be made to sit. That is why it is both cheaper than Floyd–Steinberg and quieter than it: no worming, no clumping, and a texture that reads as grain rather than as structure.",
  keywords: ["ostromoukhov", "variable", "adaptive", "blue noise", "quiet", "clean", "modern", "three tap"],
  requirement: "F-ED-14",
});
