//! Golden-image harness for the error-diffusion catalogue.
//!
//! docs/ARCHITECTURE.md calls golden images "the only defence against a
//! plausible-looking coefficient typo", and it is right: thirteen of the
//! fourteen registered kernels are nothing but a table transcribed from a
//! published paper, and a transposed digit in one of them still produces a
//! picture. `diffusion.rs` already checks that a tap table sums to its divisor
//! and only reaches forward — but *swapping* two weights preserves both
//! properties, changes the look, and is exactly the mistake a human makes
//! copying a matrix. Nothing but a stored reference catches it.
//!
//! Every [`FIXTURES`] entry is rendered through every [`KERNELS`] entry against
//! each of [`PALETTE_IDS`], and compared to a PNG under `core/fixtures/golden`.
//! The inputs are generated (see `dither_core::fixture`); only the outputs are
//! committed, which is the right way round — a reviewer can read what went in
//! and look at what came out.
//!
//! ## Regenerating
//!
//! ```text
//! DITHER_ORK_BLESS=1 cargo test -p dither-core --test golden
//! ```
//!
//! rewrites the whole reference tree and says so, loudly, on the real stderr.
//! A harness nobody can regenerate is a harness that gets deleted the first
//! time a deliberate change lands, so this is not a convenience.
//!
//! ## The tolerance, and why it is zero
//!
//! **Pixels are compared byte for byte.** That is a deliberate choice, not a
//! default, and the reasoning is worth stating because "allow a couple of
//! levels" is the obvious thing to reach for and it is wrong here.
//!
//! Every output pixel is a palette colour, and a palette colour is
//! `srgb_to_linear(byte / 255)` on the way in and `linear_to_srgb` on the way
//! out. That round trip is accurate to about 1e-7, and it takes an error near
//! 2e-3 to move an 8-bit code value — four orders of magnitude of headroom. So
//! the encoded output of a *given* set of decisions is bit-stable even if the
//! platform's `powf` disagrees in its last place. There is no rounding slack to
//! allow, and a per-channel tolerance of "a few levels" would only ever hide
//! something else: a flip between two palette entries that happen to be near
//! neighbours.
//!
//! What can differ across machines is a **decision** — `Palette::nearest` runs
//! through `cbrt`, and libm is not required to be correctly rounded, so a pixel
//! whose two best candidates are within an ulp of each other could match
//! differently. A per-pixel budget does not help with that either, because a
//! single flipped decision in an error-diffusion pass does not stay one pixel:
//! it changes the error handed forward, and the difference spreads.
//! [`one_ulp_of_palette_disagreement_disturbs_almost_none_of_the_set`] measures
//! it — perturbing every palette value by one ulp leaves 136 of the 140
//! comparisons bit-identical and moves the other four by 0.06%, 0.5%, 8.0% and
//! 9.0% of their pixels. The difference between two builds is therefore
//! bimodal: nothing, or a region. No budget sits usefully between the two, and
//! one wide enough to cover the 9% case would swallow a real defect on three of
//! the five fixtures. Zero it is, on a pinned environment, exactly as
//! docs/ARCHITECTURE.md specifies — with the consequence stated plainly: the
//! reference set is valid for one architecture, and a second one needs its own
//! run of the harness rather than a wider tolerance.
//!
//! [`a_transposed_coefficient_moves_far_more_than_a_rounding_difference_could`]
//! is the other half of the argument. Measured across the catalogue, a
//! transposed weight moves between 36% and 42% of the pixels of its loudest
//! fixture, and never fewer than 1.8% of even the least sensitive one. That is
//! the margin the zero tolerance is running on, and it is a number in the test
//! output rather than a hope.

use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use dither_core::color::encode_srgb;
use dither_core::diffusion::{
    dither, ChannelMode, DitherResult, Kernel, Options, Rule, Tap, KERNELS,
};
use dither_core::fixture::{Fixture, FIXTURES};
use dither_core::palette::{builtin, Metric, Palette};

/// Set to anything but `0` to rewrite the reference tree.
const BLESS_VAR: &str = "DITHER_ORK_BLESS";

/// The palettes the whole catalogue is rendered against.
///
/// Two, and deliberately these two. `mono` is the hardest case a dither has —
/// two colours, so every pixel carries the maximum possible quantization error
/// and the kernel's structure is the only thing in the picture. `cga-16` is the
/// opposite: sixteen entries spread over the cube, where the palette match
/// itself does real work and per-channel diffusion has somewhere to push a hue.
/// A greyscale-only pair would let the colour path break silently.
const PALETTE_IDS: [&str; 2] = ["mono", "cga-16"];

/// The settings every reference is rendered at.
///
/// Written out field by field rather than as `..Options::default()` on purpose.
/// The defaults are a product decision and may reasonably move; the reference
/// images are a record of what a kernel does at *stated* settings, and they
/// must not silently re-mean themselves because a default changed. Spelling
/// every field also means adding one to `Options` breaks this file, which is
/// the moment to decide whether the golden set needs regenerating.
fn reference_options() -> Options {
    Options {
        // Full diffusion: the coefficients are what is on trial.
        strength: 1.0,
        // On, because it is on by default in the product and because the
        // mirrored tap offsets are a second thing a table transcription can get
        // wrong.
        serpentine: true,
        // Off. Jitter is proved reproducible from its seed in `diffusion.rs`;
        // adding it here would only add noise on top of the signal these images
        // exist to record.
        jitter: 0.0,
        seed: 0,
        overshoot_limit: 1.0,
        channels: ChannelMode::PerChannel,
        metric: Metric::Oklab,
    }
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

#[test]
fn every_kernel_matches_its_reference_image() {
    let bless = bless_requested();
    let root = reference_root();

    if bless {
        announce(&format!(
            "REWRITING the golden reference tree at {}\n\
             {BLESS_VAR} is set, so nothing is being checked — every reference \n\
             below is being replaced with whatever this build produces. Review \n\
             the diff before committing it.",
            root.display()
        ));
        // Wholesale, so a kernel or fixture that has been renamed or removed
        // does not leave a stale reference behind that nothing reads and nobody
        // notices.
        for dir in [root.join("source"), root.join("golden")] {
            if dir.exists() {
                fs::remove_dir_all(&dir)
                    .unwrap_or_else(|e| panic!("cannot clear {}: {e}", dir.display()));
            }
        }
    }

    let mut run = Run {
        bless,
        written: 0,
        checked: 0,
        failures: Vec::new(),
    };

    // The fixtures themselves, so a reviewer can see what the catalogue is
    // being fed and a change to a generator shows up as an image diff rather
    // than as 140 unexplained ones. Nothing reads these back as input — the
    // input is always the generator.
    for f in FIXTURES {
        let path = root.join("source").join(format!("{}.png", f.id));
        let bytes = encode_srgb(&f.render());
        run.settle(&path, f.width, f.height, &bytes);
    }

    for palette_id in PALETTE_IDS {
        let palette = palette_by_id(palette_id);
        for f in FIXTURES {
            let source = f.render();
            for kernel in KERNELS {
                let result = dither(
                    &source,
                    f.width,
                    f.height,
                    &palette,
                    kernel,
                    reference_options(),
                );
                assert_eq!(
                    result.pixels.len(),
                    f.pixel_count(),
                    "{} / {} / {palette_id}: short buffer",
                    f.id,
                    kernel.id
                );

                let path = golden_path(&root, f, palette_id, kernel.id);
                let bytes = encode_srgb(&result.pixels);
                run.settle(&path, f.width, f.height, &bytes);
            }
        }
    }

    // Orphans: files in the tree that no live fixture / palette / kernel names.
    // In bless mode the tree was cleared above, so this can only fire in check
    // mode, which is where it is useful — a renamed kernel otherwise leaves its
    // old references behind, still committed, still green.
    let expected = expected_paths(&root);
    for found in walk_png(&root) {
        if !expected.contains(&found) {
            run.failures.push(format!(
                "{}: orphaned reference — no registered fixture, palette and kernel \
                 produce this path. Delete it, or re-bless.",
                found.display()
            ));
        }
    }

    if run.bless {
        announce(&format!(
            "wrote {} reference images under {}. \
             Re-run without {BLESS_VAR} to verify them.",
            run.written,
            root.display()
        ));
        return;
    }

    assert!(run.checked > 0, "the harness compared nothing at all");
    assert!(
        run.failures.is_empty(),
        "{} of {} reference images did not match:\n\n{}\n\n\
         If this change is intended, regenerate with:\n  \
         {BLESS_VAR}=1 cargo test -p dither-core --test golden",
        run.failures.len(),
        run.checked,
        run.failures.join("\n")
    );
}

/// One run of the harness, in whichever of its two modes it is in.
///
/// The counters live here rather than as locals threaded through a free
/// function, so the write path and the compare path cannot drift apart: there
/// is exactly one place that decides which of the two an image goes down.
struct Run {
    bless: bool,
    written: usize,
    checked: usize,
    failures: Vec<String>,
}

impl Run {
    /// Write or compare one image.
    ///
    /// A comparison failure is collected rather than asserted. One wrong
    /// coefficient shows up in ten images at once, and a run that stopped at
    /// the first would report one of them and hide the pattern that says which
    /// kernel is at fault.
    fn settle(&mut self, path: &Path, width: usize, height: usize, bytes: &[u8]) {
        if self.bless {
            write_png(path, width, height, bytes);
            self.written += 1;
            return;
        }

        self.checked += 1;
        match read_png(path) {
            Err(why) => self.failures.push(format!("{}: {why}", path.display())),
            Ok(reference) => {
                if reference.width != width || reference.height != height {
                    self.failures.push(format!(
                        "{}: reference is {}x{}, this build produced {width}x{height}",
                        path.display(),
                        reference.width,
                        reference.height
                    ));
                    return;
                }
                if let Some(diff) = first_difference(&reference.bytes, bytes, width) {
                    self.failures.push(format!("{}: {diff}", path.display()));
                }
            }
        }
    }
}

/// A description of how two buffers differ, or `None` when they do not.
///
/// Reports the count, the fraction and the first differing pixel rather than
/// just "not equal". The fraction is what tells a reader which failure they are
/// looking at: a handful of pixels is a divergence that started at one
/// decision, a large fraction is a changed coefficient, and they are diagnosed
/// completely differently.
fn first_difference(reference: &[u8], got: &[u8], width: usize) -> Option<String> {
    assert_eq!(reference.len(), got.len(), "buffers differ in length");

    let mut differing = 0usize;
    let mut first: Option<(usize, usize, [u8; 4], [u8; 4])> = None;
    for (i, (a, b)) in reference
        .chunks_exact(4)
        .zip(got.chunks_exact(4))
        .enumerate()
    {
        if a == b {
            continue;
        }
        differing += 1;
        if first.is_none() {
            let mut want = [0u8; 4];
            let mut have = [0u8; 4];
            want.copy_from_slice(a);
            have.copy_from_slice(b);
            first = Some((i % width, i / width, want, have));
        }
    }

    let (x, y, want, have) = first?;
    let total = reference.len() / 4;
    let percent = 100.0 * differing as f64 / total as f64;
    Some(format!(
        "{differing} of {total} pixels differ ({percent:.2}%); \
         first at ({x}, {y}): reference {want:?}, this build {have:?}"
    ))
}

// ---------------------------------------------------------------------------
// What the zero tolerance is buying, measured rather than assumed
// ---------------------------------------------------------------------------

/// The margin the golden comparison runs on.
///
/// A transposed digit is the failure this whole harness exists for, and it is
/// invisible to every other test in the tree: swapping two weights inside a tap
/// table leaves the sum, the divisor and the forward-only property all intact.
/// This measures what such a swap actually does to the reference fixtures, so
/// the claim "the check has margin" is a number and not a feeling.
///
/// Atkinson is perturbed differently because it has to be: every one of its
/// weights is 1, so transposing two of them is a no-op. The realistic
/// transcription error for a matrix of equal weights is a misplaced tap, which
/// is what is done instead.
#[test]
fn a_transposed_coefficient_moves_far_more_than_a_rounding_difference_could() {
    /// Every kernel's loudest fixture must move at least this much.
    ///
    /// Measured, the loudest fixture moves 36% to 42% for every kernel in the
    /// catalogue — Atkinson is the quietest at 36.5% and Burkes the loudest at
    /// 41.8%. The floor sits at a little over a quarter of the weakest of those,
    /// so it fails on a real loss of sensitivity rather than on a fixture being
    /// retuned by a few percent.
    ///
    /// It is the *loudest* fixture and not every fixture because the golden set
    /// covers all five: a typo is caught if any one of them responds. The
    /// hard-edge chart responds least (1.8% to 4.1%), which is exactly what it
    /// should do — it is mostly saturated flats where no palette match is a
    /// close call, and it is in the set for edges and overshoot, not for
    /// coefficient sensitivity.
    const FLOOR: f64 = 0.10;

    let palette = palette_by_id("mono");
    let mut weakest = (f64::INFINITY, String::new());

    for kernel in KERNELS {
        let Some(perturbed) = transpose_a_coefficient(kernel) else {
            // Riemersma has no tap table to transpose. Its own perturbation
            // test is below.
            continue;
        };

        let mut best = 0.0f64;
        for f in FIXTURES {
            let moved = fraction_changed(
                &dither(
                    &f.render(),
                    f.width,
                    f.height,
                    &palette,
                    kernel,
                    reference_options(),
                ),
                &dither(
                    &f.render(),
                    f.width,
                    f.height,
                    &palette,
                    &perturbed,
                    reference_options(),
                ),
            );
            println!("{:<24} {:<16} {:>7.3}%", kernel.id, f.id, moved * 100.0);
            best = best.max(moved);
        }

        if best < weakest.0 {
            weakest = (best, kernel.id.to_string());
        }
        assert!(
            best > FLOOR,
            "{}: the loudest fixture moved only {:.4}% of pixels under a transposed \
             coefficient — the golden set cannot be relied on to catch one",
            kernel.id,
            best * 100.0
        );
    }

    println!(
        "weakest transposed-coefficient signal across the catalogue: {:.2}% of pixels ({})",
        weakest.0 * 100.0,
        weakest.1
    );
}

/// The same argument for Riemersma, which has no tap table.
///
/// Its two numbers are the queue length and the decay ratio, and getting either
/// wrong is the same class of mistake as a transposed weight. One step on
/// either has to be visible, or nothing in the suite pins them.
#[test]
fn riemersmas_history_and_decay_are_pinned_by_the_golden_set() {
    /// Measured: dropping a slot of history moves 18.1% of the radial gradient,
    /// and shaving one off the decay ratio moves 5.0% of the ramp. The decay is
    /// the weaker of the two because a queue of sixteen weights barely notices
    /// its ratio moving from 16 to 15, and it is the number this floor is
    /// really sized against.
    const FLOOR: f64 = 0.02;

    let real = KERNELS
        .iter()
        .find(|k| k.id == "riemersma")
        .expect("riemersma is registered");
    let Rule::Riemersma { history, decay } = real.rule else {
        panic!("riemersma is no longer a Riemersma rule");
    };

    let variants = [
        (
            "one fewer slot of history",
            Rule::Riemersma {
                history: history - 1,
                decay,
            },
        ),
        (
            "one step of decay",
            Rule::Riemersma {
                history,
                decay: decay - 1.0,
            },
        ),
    ];

    let palette = palette_by_id("mono");
    for (what, rule) in variants {
        let perturbed = Kernel {
            id: "riemersma-perturbed",
            name: "perturbed",
            rule,
        };
        let mut best = 0.0f64;
        for f in FIXTURES {
            let source = f.render();
            let moved = fraction_changed(
                &dither(
                    &source,
                    f.width,
                    f.height,
                    &palette,
                    real,
                    reference_options(),
                ),
                &dither(
                    &source,
                    f.width,
                    f.height,
                    &palette,
                    &perturbed,
                    reference_options(),
                ),
            );
            println!("riemersma {what:<28} {:<16} {:>7.3}%", f.id, moved * 100.0);
            best = best.max(moved);
        }
        assert!(
            best > FLOOR,
            "riemersma: {what} moved only {:.4}% of pixels on its loudest fixture",
            best * 100.0
        );
    }
}

/// How exposed the reference set is to a last-place disagreement.
///
/// This is the measurement the zero tolerance rests on, kept as a test because
/// it is the number that decides whether the reference set stays usable. Every
/// palette value is nudged by one ulp — a stand-in for two architectures'
/// `cbrt` disagreeing in its last bit, which is the only step in the path that
/// is not exactly rounded — and the whole set is re-rendered.
///
/// The point is not that nothing moves. The point is that almost nothing does,
/// and that what moves, moves a lot: a decision either survives the nudge
/// intact or it flips and the flip spreads through the error it hands forward.
/// That is why the harness compares byte for byte instead of allowing a budget
/// — there is no budget that covers a cascade and still catches a defect.
///
/// If this count ever climbs, the reference set has become knife-edged and will
/// start disagreeing between machines. Finding that out here, with the offending
/// combinations named, is a great deal better than finding it out as a red CI
/// job on somebody else's laptop.
#[test]
fn one_ulp_of_palette_disagreement_disturbs_almost_none_of_the_set() {
    /// A tenth of the set. Measured: 4 of 140.
    const MAX_DISTURBED: usize = 14;

    let mut disturbed = 0usize;
    let mut total = 0usize;

    for palette_id in PALETTE_IDS {
        let exact = palette_by_id(palette_id);
        let nudged = Palette::new(exact.colors().iter().map(|c| next_up(*c)).collect());

        for f in FIXTURES {
            let source = f.render();
            for kernel in KERNELS {
                total += 1;
                let moved = fraction_changed(
                    &dither(
                        &source,
                        f.width,
                        f.height,
                        &exact,
                        kernel,
                        reference_options(),
                    ),
                    &dither(
                        &source,
                        f.width,
                        f.height,
                        &nudged,
                        kernel,
                        reference_options(),
                    ),
                );
                if moved > 0.0 {
                    disturbed += 1;
                    println!(
                        "one ulp moves {:>6.3}% of {palette_id} / {} / {}",
                        moved * 100.0,
                        f.id,
                        kernel.id
                    );
                }
            }
        }
    }

    println!("{disturbed} of {total} reference images are ulp-sensitive");
    assert!(
        disturbed <= MAX_DISTURBED,
        "{disturbed} of {total} reference images change under a one-ulp palette \
         nudge (budget {MAX_DISTURBED}). The set has become too knife-edged to \
         compare byte for byte across machines."
    );
}

/// Every channel of a colour moved up by one representable step.
fn next_up(c: dither_core::color::Rgba) -> dither_core::color::Rgba {
    fn step(v: f32) -> f32 {
        // Only ever called on palette values, which are finite and in 0..=1.
        assert!(v.is_finite() && v >= 0.0, "unexpected palette value {v}");
        if v == 0.0 {
            f32::from_bits(1)
        } else {
            f32::from_bits(v.to_bits() + 1)
        }
    }
    dither_core::color::Rgba::new(step(c.r), step(c.g), step(c.b), c.a)
}

/// Swap two distinct weights in a fixed tap table, or displace a tap when every
/// weight is the same. `None` for a kernel with no tap table.
fn transpose_a_coefficient(kernel: &Kernel) -> Option<Kernel> {
    let Rule::Fixed { taps, divisor } = kernel.rule else {
        return None;
    };

    let mut swapped: Vec<Tap> = taps.to_vec();
    let distinct = (0..taps.len())
        .flat_map(|i| ((i + 1)..taps.len()).map(move |j| (i, j)))
        .find(|&(i, j)| taps[i].weight != taps[j].weight);

    match distinct {
        Some((i, j)) => {
            let (a, b) = (swapped[i].weight, swapped[j].weight);
            swapped[i].weight = b;
            swapped[j].weight = a;
        }
        None => {
            // Every weight equal — Atkinson. Move the last tap one column
            // along, which is the transcription error that is actually
            // available on a matrix of ones.
            let last = swapped.len() - 1;
            swapped[last].dx += 1;
        }
    }

    Some(Kernel {
        id: "perturbed",
        name: "perturbed",
        // Leaked deliberately: `Rule::Fixed` holds a `&'static [Tap]`, this
        // runs once per kernel in one test, and the alternative is threading a
        // lifetime through the registry type for the benefit of a test.
        rule: Rule::Fixed {
            taps: Box::leak(swapped.into_boxed_slice()),
            divisor,
        },
    })
}

fn fraction_changed(a: &DitherResult, b: &DitherResult) -> f64 {
    assert_eq!(a.indices.len(), b.indices.len());
    let differing = a
        .indices
        .iter()
        .zip(&b.indices)
        .filter(|(x, y)| x != y)
        .count();
    differing as f64 / a.indices.len() as f64
}

// ---------------------------------------------------------------------------
// Paths, PNG I/O and the loud banner
// ---------------------------------------------------------------------------

fn bless_requested() -> bool {
    match std::env::var(BLESS_VAR) {
        Ok(v) => !v.is_empty() && v != "0",
        Err(_) => false,
    }
}

/// `core/fixtures`, resolved from the crate rather than from the working
/// directory — `cargo test` runs the binary from wherever it likes.
///
/// Built by popping components rather than by joining `".."`, because these
/// paths end up in failure messages and `core/fixtures/golden/...` is something
/// a reader can find, while `core/crates/dither-core/../../fixtures/...` is
/// something a reader has to decode first.
fn reference_root() -> PathBuf {
    let mut root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    root.pop(); // crates/dither-core -> crates
    root.pop(); // crates -> core
    root.push("fixtures");
    root
}

fn golden_path(root: &Path, fixture: &Fixture, palette_id: &str, kernel_id: &str) -> PathBuf {
    root.join("golden")
        .join(fixture.id)
        .join(palette_id)
        .join(format!("{kernel_id}.png"))
}

fn expected_paths(root: &Path) -> BTreeSet<PathBuf> {
    let mut out = BTreeSet::new();
    for f in FIXTURES {
        out.insert(root.join("source").join(format!("{}.png", f.id)));
        for palette_id in PALETTE_IDS {
            for kernel in KERNELS {
                out.insert(golden_path(root, f, palette_id, kernel.id));
            }
        }
    }
    out
}

fn walk_png(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    for entry in entries {
        let path = entry.expect("directory entry is readable").path();
        if path.is_dir() {
            out.extend(walk_png(&path));
        } else if path.extension().is_some_and(|e| e == "png") {
            out.push(path);
        }
    }
    out
}

fn palette_by_id(id: &str) -> Palette {
    let entry = builtin::by_id(id).unwrap_or_else(|| panic!("no built-in palette {id:?}"));
    Palette::from_srgb_rgb(entry.srgb)
}

struct Reference {
    width: usize,
    height: usize,
    bytes: Vec<u8>,
}

fn write_png(path: &Path, width: usize, height: usize, bytes: &[u8]) {
    assert_eq!(bytes.len(), width * height * 4, "{}", path.display());
    let parent = path.parent().expect("reference paths have a directory");
    fs::create_dir_all(parent)
        .unwrap_or_else(|e| panic!("cannot create {}: {e}", parent.display()));

    let file =
        File::create(path).unwrap_or_else(|e| panic!("cannot write {}: {e}", path.display()));
    let mut encoder = png::Encoder::new(BufWriter::new(file), width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    // Dither output is high-entropy by construction and compresses badly; the
    // slowest setting is still milliseconds here and it is paid once per bless.
    encoder.set_compression(png::Compression::Best);
    let mut writer = encoder
        .write_header()
        .unwrap_or_else(|e| panic!("cannot write header of {}: {e}", path.display()));
    writer
        .write_image_data(bytes)
        .unwrap_or_else(|e| panic!("cannot write {}: {e}", path.display()));
}

fn read_png(path: &Path) -> Result<Reference, String> {
    let file = File::open(path).map_err(|e| {
        format!("no reference image ({e}). Generate one with {BLESS_VAR}=1 and review it.")
    })?;
    let mut reader = png::Decoder::new(file)
        .read_info()
        .map_err(|e| format!("unreadable PNG: {e}"))?;

    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut buf)
        .map_err(|e| format!("unreadable PNG data: {e}"))?;
    if info.color_type != png::ColorType::Rgba || info.bit_depth != png::BitDepth::Eight {
        return Err(format!(
            "reference is {:?}/{:?}; the harness writes 8-bit RGBA",
            info.color_type, info.bit_depth
        ));
    }
    buf.truncate(info.buffer_size());

    Ok(Reference {
        width: info.width as usize,
        height: info.height as usize,
        bytes: buf,
    })
}

/// Write a banner to the process's own stderr.
///
/// Not `eprintln!`: libtest captures the print macros and only replays them for
/// a test that fails, so a bless run — which passes — would say nothing at all.
/// Taking the handle directly bypasses the capture, which is the whole point of
/// a message that says "everything you were checking has just been overwritten".
fn announce(message: &str) {
    let bar = "=".repeat(78);
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "\n{bar}\n{BLESS_VAR}: {message}\n{bar}");
    let _ = err.flush();
}
