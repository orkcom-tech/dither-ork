//! The correctness claims docs/ARCHITECTURE.md names by hand, run over the
//! generated fixtures and the whole kernel catalogue — plus one the fixtures
//! turned up on their own.
//!
//! * **Colour correctness** — "a linear ramp dithered to 1-bit must average back
//!   to input luminance within tolerance". The unit tests in `diffusion.rs`
//!   check this on a flat field; a flat field cannot tell a kernel that
//!   reproduces a level from one that reproduces the image's overall mean and
//!   smears everything else. A ramp can, because it asks the question again in
//!   every band.
//!
//! * **Determinism** — "the same frame rendered in two workers, byte-equal".
//!   `diffusion.rs` proves the jitter draws come from the seed; this proves the
//!   whole path, including the sRGB encode, produces identical *bytes* when two
//!   threads run it at once. Threads rather than workers because `dither-core`
//!   has no idea what a worker is and must not learn.
//!
//! * **Saturated flats** — not in the architecture document, and it should be.
//!   The hard-edge chart and the colour wheel both contain colours no palette
//!   here can reach, and putting them through the catalogue exposed a real
//!   defect in how the working buffer is bounded. See
//!   [`a_flat_colour_the_palette_cannot_reach_settles_on_its_nearest_entry`].
//!
//! These are separate from `golden.rs` on purpose. A golden image says "the
//! output is what it was yesterday"; these say "the output is right", and one
//! is no substitute for the other — a wrong reference blessed by mistake passes
//! the first and fails these.

use std::thread;

use dither_core::color::{encode_srgb, linear_to_srgb, Rgba};
use dither_core::diffusion::{dither, ChannelMode, Kernel, Options, Rule, KERNELS};
use dither_core::fixture::{Fixture, FLAT_MID_GREY, LINEAR_RAMP, RADIAL_GRADIENT};
use dither_core::palette::{builtin, Metric, Palette};

/// The neutral fixtures: the ones whose per-channel mean is a meaningful thing
/// to compare against a two-colour palette.
///
/// The colour wheel and the hard-edge chart are deliberately absent. Against
/// `mono` every output pixel is black or white, so the three output channels
/// are locked together and no per-channel mean can track a saturated input;
/// asserting otherwise would be asserting something untrue about the palette,
/// not about the kernel.
const NEUTRAL: [Fixture; 3] = [LINEAR_RAMP, RADIAL_GRADIENT, FLAT_MID_GREY];

/// Edge of a local averaging window, in pixels.
///
/// 16 is small enough that a window covers a narrow slice of the ramp — about
/// an eighth of its range — so the test is really asking whether the kernel
/// reproduces the *local* level, and large enough that a two-colour dither has
/// 256 pixels to build an average out of. A 4x4 window would be measuring
/// quantization, not colour.
const WINDOW: usize = 16;

fn options(channels: ChannelMode) -> Options {
    Options {
        strength: 1.0,
        serpentine: true,
        jitter: 0.0,
        seed: 0,
        overshoot_limit: 1.0,
        channels,
        metric: Metric::Oklab,
    }
}

fn mono() -> Palette {
    Palette::from_srgb_rgb(builtin::MONO)
}

/// The share of each quantization error a kernel hands on.
///
/// The same function `diffusion.rs` derives its flat-field allowance from, and
/// for the same reason: Atkinson distributes six eighths and drops the rest, so
/// its mean cannot come back to the input's and the allowance has to be derived
/// from how much it throws away rather than picked to make it pass.
fn retained(k: &Kernel) -> f32 {
    match k.rule {
        Rule::Fixed { taps, divisor } => taps.iter().map(|t| t.weight).sum::<f32>() / divisor,
        Rule::Variable { .. } | Rule::Riemersma { .. } => 1.0,
    }
}

// ---------------------------------------------------------------------------
// Colour correctness
// ---------------------------------------------------------------------------

/// The claim docs/ARCHITECTURE.md makes, over every kernel and both channel
/// modes: dithered to 1-bit, a linear ramp averages back to its own luminance —
/// globally, and in every window across it.
///
/// The second assertion is the one that catches diffusing in the wrong space.
/// A pipeline that removed the sRGB transfer and never put it back, or that
/// diffused the error in the encoding, reproduces the *encoded* value instead
/// of the light. For this ramp those two numbers are 0.500 and 0.688, so the
/// comparison is not close and the test is not delicate.
#[test]
fn the_linear_ramp_averages_back_to_its_own_luminance_for_every_kernel() {
    let pal = mono();
    let f = LINEAR_RAMP;
    let source = f.render();

    let target: f32 = source.iter().map(|p| p.r).sum::<f32>() / source.len() as f32;
    let if_diffused_in_srgb: f32 =
        source.iter().map(|p| linear_to_srgb(p.r)).sum::<f32>() / source.len() as f32;
    // A guard on the test itself, not on the code under test. If the ramp is
    // ever redefined so that its linear and encoded means converge, both
    // assertions below stay green while proving nothing, and that failure mode
    // is silent. Measured separation is 0.188.
    assert!(
        if_diffused_in_srgb - target > 0.15,
        "the ramp no longer separates the two answers ({target} against \
         {if_diffused_in_srgb}); this test has stopped meaning anything"
    );

    for kernel in KERNELS {
        for channels in [ChannelMode::PerChannel, ChannelMode::Luma] {
            let out = dither(&source, f.width, f.height, &pal, kernel, options(channels));
            let mean: f32 = out.pixels.iter().map(|p| p.r).sum::<f32>() / out.pixels.len() as f32;

            // Derived, not chosen: a kernel that hands on a share `t` of each
            // error settles a `(1 - t) / t` fraction of the distance to the
            // palette's own range away from the level it is reproducing.
            let t = retained(kernel);
            let allowance = if t >= 1.0 { 0.02 } else { (1.0 - t) / t * 0.5 };
            assert!(
                (mean - target).abs() < allowance,
                "{} ({channels:?}): ramp mean {mean} against target {target}",
                kernel.id
            );

            // The sRGB discriminator applies to the kernels that hand on all of
            // their error, and only to those. Atkinson throws a quarter of it
            // away by design, and on a ramp that loss is systematic and one-
            // signed: its mean comes out at 0.598, which is inside the 0.167 its
            // own retention allows but is nearer 0.688 than 0.500 — so for
            // Atkinson this comparison would be testing the documented
            // behaviour of the kernel rather than the colour space the error was
            // diffused in. Excluding it is the honest reading; widening it until
            // Atkinson fits would make it pass for a genuinely gamma-space
            // pipeline too.
            if t < 1.0 {
                continue;
            }
            assert!(
                (mean - target).abs() < (mean - if_diffused_in_srgb).abs(),
                "{} ({channels:?}): ramp mean {mean} sits nearer the encoded answer \
                 {if_diffused_in_srgb} than the linear one {target} — this is what \
                 diffusing in sRGB looks like",
                kernel.id
            );
        }
    }
}

/// The same claim locally, over every neutral fixture.
///
/// A kernel can hold the whole-image mean and still be wrong everywhere: smear
/// the top half into the bottom half and the global average is untouched. This
/// walks a window across each fixture and asks the question again inside it,
/// which is what actually says the dither is reproducing the picture rather
/// than its average.
#[test]
fn every_kernel_reproduces_the_local_level_of_every_neutral_fixture() {
    let pal = mono();

    for f in NEUTRAL {
        let source = f.render();
        for kernel in KERNELS {
            let out = dither(
                &source,
                f.width,
                f.height,
                &pal,
                kernel,
                options(ChannelMode::PerChannel),
            );

            let t = retained(kernel);
            // Wider than the global allowance, and it has to be. A window
            // exchanges error with its neighbours across all four edges, and
            // that flux does not cancel inside one window the way it does over
            // the whole image — most visibly at the ends of the ramp, where a
            // window sits against a hard black or white it cannot reach.
            //
            // Measured, the worst window of a full-error kernel is 0.051
            // (Stevenson-Arce on the ramp; Riemersma is the tightest at 0.006,
            // which is what a traversal with no preferred direction buys). The
            // 0.09 is not far above that on purpose: this is a tolerance that
            // should fail if a kernel starts smearing, and doubling it would
            // buy nothing but silence.
            let allowance = if t >= 1.0 {
                0.09
            } else {
                0.09 + (1.0 - t) / t * 0.5
            };

            let mut worst = 0.0f32;
            for wy in (0..f.height).step_by(WINDOW) {
                for wx in (0..f.width).step_by(WINDOW) {
                    // Partial windows at the right and bottom edges are skipped
                    // rather than measured on fewer pixels: a 5-pixel-wide
                    // window has a different noise floor, and mixing the two
                    // would put a size-dependent term in one tolerance.
                    if wx + WINDOW > f.width || wy + WINDOW > f.height {
                        continue;
                    }
                    let (want, got) = window_means(&source, &out.pixels, f.width, wx, wy);
                    worst = worst.max((got - want).abs());
                    assert!(
                        (got - want).abs() < allowance,
                        "{} on {} at ({wx}, {wy}): window mean {got} against {want}",
                        kernel.id,
                        f.id
                    );
                }
            }
            println!("{:<16} {:<24} worst window {worst:.4}", f.id, kernel.id);
        }
    }
}

/// Mean of the source and of the result over one `WINDOW`-square window.
fn window_means(source: &[Rgba], out: &[Rgba], width: usize, wx: usize, wy: usize) -> (f32, f32) {
    let mut want = 0.0f32;
    let mut got = 0.0f32;
    for y in wy..wy + WINDOW {
        for x in wx..wx + WINDOW {
            want += source[y * width + x].r;
            got += out[y * width + x].r;
        }
    }
    let n = (WINDOW * WINDOW) as f32;
    (want / n, got / n)
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

/// Threads used by the determinism check. Four, because the failure it is
/// looking for — a shared mutable buffer, a hash iteration order, a lazily
/// initialised table — needs contention to show up, and one extra thread would
/// not produce any.
const THREADS: usize = 4;

/// Same document, same seed, byte-identical output — rendered concurrently.
///
/// Compared on the **encoded bytes**, not on the index map. The index map is
/// what `diffusion.rs` compares, and it is the right thing there; here the
/// claim is the one the export path depends on, which is that the PNG coming
/// out is the same PNG. That covers the sRGB encode as well as the dither, and
/// the encode is where a `powf` result and a rounding rule meet.
///
/// Jitter is on, at a fixed seed, because that is the only part of a diffusion
/// pass that touches a generator — with it off the test would prove determinism
/// of arithmetic that was never in doubt.
#[test]
fn the_same_document_and_seed_render_byte_identically_across_threads() {
    let pal = mono();
    let opts = Options {
        jitter: 0.5,
        seed: 0x0d17_4e12_9b3a_5fc4,
        ..options(ChannelMode::PerChannel)
    };

    for f in dither_core::fixture::FIXTURES {
        let source = f.render();

        let renders: Vec<Vec<Vec<u8>>> = thread::scope(|scope| {
            let handles: Vec<_> = (0..THREADS)
                .map(|_| {
                    let source = &source;
                    let pal = &pal;
                    scope.spawn(move || {
                        KERNELS
                            .iter()
                            .map(|k| {
                                let out = dither(source, f.width, f.height, pal, k, opts);
                                encode_srgb(&out.pixels)
                            })
                            .collect::<Vec<Vec<u8>>>()
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().expect("render thread panicked"))
                .collect()
        });

        let first = &renders[0];
        for (t, other) in renders.iter().enumerate().skip(1) {
            for (k, kernel) in KERNELS.iter().enumerate() {
                assert_eq!(
                    first[k].len(),
                    f.pixel_count() * 4,
                    "{} on {}: short buffer",
                    kernel.id,
                    f.id
                );
                assert!(
                    first[k] == other[k],
                    "{} on {}: thread {t} produced different bytes from thread 0",
                    kernel.id,
                    f.id
                );
            }
        }
    }
}

/// A flat colour the palette cannot reach must settle on the palette's own
/// nearest entry, not walk away from it.
///
/// The residual error of such an input never cancels — every pixel is wrong in
/// the same direction — so the working buffer drifts monotonically away from
/// the palette until something stops it. The thing that stops it is
/// `overshoot_limit`, and at `0.0` it stops it at the edge of the gamut, which
/// is the correct place: the part of the colour the palette cannot represent is
/// discarded rather than accumulated, and a flat magenta comes out as the
/// palette's flat magenta.
///
/// **This test runs at `overshoot_limit = 0.0` and deliberately does not run at
/// the `1.0` that `Options::default()` sets, because at `1.0` the pipeline gets
/// this wrong.** With a full unit of headroom the working value travels a long
/// way outside the sRGB cube, `Palette::nearest` is asked to match a colour that
/// does not exist, and both metrics answer with something far darker. Measured
/// on a flat field with Floyd-Steinberg: CGA-16 magenta `FF00FF` resolves to
/// `FF55FF` at 0.0 and to `C228C2` at 1.0; PICO-8 red `FF0000` resolves to
/// `FF004D` at 0.0 and, under the sRGB metric, to `5B0D14` at 1.0 — a worst
/// channel error of 0.895 out of a possible 1.0. The reference images for the
/// colour wheel and the hard-edge chart record the current behaviour, so when
/// it is fixed the fix will be visible as an image diff. See the report
/// accompanying this harness.
#[test]
fn a_flat_colour_the_palette_cannot_reach_settles_on_its_nearest_entry() {
    let (w, h) = (40usize, 40usize);
    let saturated: [[u8; 3]; 6] = [
        [0xFF, 0x00, 0x00],
        [0x00, 0xFF, 0x00],
        [0x00, 0x00, 0xFF],
        [0xFF, 0xFF, 0x00],
        [0x00, 0xFF, 0xFF],
        [0xFF, 0x00, 0xFF],
    ];

    for palette_id in ["cga-16", "pico-8", "c64"] {
        let entry = builtin::by_id(palette_id).expect("palette is registered");
        let pal = Palette::from_srgb_rgb(entry.srgb);

        for code in saturated {
            let c = Rgba::new(srgb(code[0]), srgb(code[1]), srgb(code[2]), 1.0);
            let src = vec![c; w * h];
            let want = pal.nearest(c, Metric::Oklab);

            for kernel in KERNELS {
                let out = dither(
                    &src,
                    w,
                    h,
                    &pal,
                    kernel,
                    Options {
                        overshoot_limit: 0.0,
                        ..options(ChannelMode::PerChannel)
                    },
                );
                assert!(
                    out.indices.iter().all(|&i| usize::from(i) == want),
                    "{} on flat {code:?} against {palette_id}: drifted off entry {want}",
                    kernel.id
                );
            }
        }
    }
}

fn srgb(code: u8) -> f32 {
    dither_core::color::srgb_to_linear(code as f32 / 255.0)
}

/// The other half of determinism: the seed has to be the only thing deciding.
///
/// A pass that ignored its seed would sail through the test above — four
/// threads agreeing on the same wrong answer is still agreement.
#[test]
fn a_different_seed_produces_a_different_render() {
    let pal = mono();
    let f = RADIAL_GRADIENT;
    let source = f.render();

    for kernel in KERNELS {
        let with = |seed| {
            let out = dither(
                &source,
                f.width,
                f.height,
                &pal,
                kernel,
                Options {
                    jitter: 0.5,
                    seed,
                    ..options(ChannelMode::PerChannel)
                },
            );
            encode_srgb(&out.pixels)
        };
        assert_ne!(with(1), with(2), "{} ignores its seed", kernel.id);
        assert_eq!(with(1), with(1), "{} is not reproducible", kernel.id);
    }
}
