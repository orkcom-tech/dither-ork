//! Threshold matrices and noise sources (F-OD-01..05, F-PP-06).
//!
//! Ordered and pattern dithers are per-pixel independent, so they execute as
//! WebGPU compute passes — but the matrices they threshold against are built
//! here and handed across as textures. Generating them on this side is what
//! stops two implementations of the same matrix existing: a WGSL copy of the
//! Bayer recursion and a Rust one would drift, and the drift would surface as a
//! silent tone shift rather than as a failure. This module is the single source
//! of truth for every threshold value the GPU sees.
//!
//! Everything here is a pure function of its arguments (F-AN-05). The
//! blue-noise tile in particular depends only on `(size, seed)` — no wall
//! clock, no unseeded draw, no dependence on the iteration order of anything
//! unspecified. Same seed, same tile, in the main worker and in a batch worker.
//!
//! Two things are deliberately absent. There is no logging: `dither-core` has
//! zero dependencies and no logging facility by design, so the reporting
//! contract here is carried by panics with stated messages, exactly as in
//! `diffusion.rs` and `rng.rs`. And there is no interleaved-gradient-noise
//! [`ThresholdTexture`], because IGN does not tile at an arbitrary size and
//! handing the web layer a repeat-sampled texture of it would be a seam waiting
//! to happen; it is a per-pixel function and it is offered as one.

use crate::rng::{stream_of, Pcg32};

/// The largest `f32` strictly below 1.0, i.e. `1 - 2^-24`.
///
/// Values computed in `f64` are capped at this before the narrowing cast.
/// Without the cap an `f64` result of, say, `0.999999995` rounds *up* to
/// exactly `1.0` in `f32` and quietly escapes a range this module documents as
/// half-open — which for a dither threshold means a pixel that can never be
/// crossed.
const F32_JUST_BELOW_ONE: f32 = 0.999_999_94;

/// A threshold matrix, ready to hand to the GPU (task 4, F-OD-CTL).
///
/// Row-major, `width * height` values, every one in `[0, 1)`. Half-open on
/// purpose: an ordered dither compares `luminance > threshold`, so a threshold
/// of exactly 1.0 is a pixel that never lights, and a matrix whose top entry
/// were 1.0 would darken the image by one level in every tile.
#[derive(Clone, Debug, PartialEq)]
pub struct ThresholdTexture {
    width: usize,
    height: usize,
    values: Vec<f32>,
}

impl ThresholdTexture {
    /// Wrap a buffer of threshold values.
    ///
    /// Panics if the dimensions are empty, if they do not match the buffer, or
    /// if any value falls outside `[0, 1)`. The range check is not ceremony:
    /// that range is this type's entire contract with the shader, and a matrix
    /// that breaks it still produces a plausible image with a tone shift, which
    /// is the failure nobody notices.
    pub fn new(width: usize, height: usize, values: Vec<f32>) -> Self {
        assert!(width > 0 && height > 0, "threshold texture cannot be empty");
        assert_eq!(
            values.len(),
            width * height,
            "threshold buffer does not match dimensions"
        );
        for (i, v) in values.iter().enumerate() {
            assert!(
                (0.0..1.0).contains(v),
                "threshold {v} at index {i} is outside [0, 1)"
            );
        }
        Self {
            width,
            height,
            values,
        }
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn height(&self) -> usize {
        self.height
    }

    /// The exact values, row-major — the buffer to upload as `R32Float` when
    /// the tone response has to be exact.
    pub fn values(&self) -> &[f32] {
        &self.values
    }

    /// The same matrix quantized for an `R8Unorm` upload.
    ///
    /// Round-to-nearest, the convention the sRGB encode path already uses, so
    /// both 8-bit boundaries in this crate round the same way. It is **lossy**,
    /// and not only for matrices with more than 256 entries: a unorm sampler
    /// decodes byte `b` as `b / 255`, which cannot represent `k / 16` exactly
    /// for most `k`. The error stays under `1/510` of full scale — below one
    /// level of an 8-bit output — but it is a real difference from
    /// [`Self::values`], so the choice between the two is the caller's to make
    /// rather than one made silently here.
    pub fn to_u8(&self) -> Vec<u8> {
        self.values
            .iter()
            .map(|v| (v * 255.0 + 0.5) as u8)
            .collect()
    }

    /// One value. Panics if the coordinate is off the matrix — see
    /// [`Self::tiled`] for the wrapping form.
    pub fn at(&self, x: usize, y: usize) -> f32 {
        assert!(
            x < self.width && y < self.height,
            "({x}, {y}) is outside a {}x{} matrix",
            self.width,
            self.height
        );
        self.values[y * self.width + x]
    }

    /// One value, with the coordinate wrapped into the matrix.
    ///
    /// This is what a `repeat`-addressed GPU sampler does, so a CPU-side check
    /// of a shader's output can use identical addressing rather than an
    /// approximation of it. `rem_euclid` and not `%`, because `%` in Rust keeps
    /// the sign of the dividend — and F-OD-CTL's X/Y offset control produces a
    /// negative offset the moment it is animated below zero, which would then
    /// index the wrong side of the tile.
    pub fn tiled(&self, x: i32, y: i32) -> f32 {
        let wx = i64::from(x).rem_euclid(self.width as i64) as usize;
        let wy = i64::from(y).rem_euclid(self.height as i64) as usize;
        self.values[wy * self.width + wx]
    }
}

// ---------------------------------------------------------------------------
// Bayer (F-OD-01 .. F-OD-04)
// ---------------------------------------------------------------------------

/// The Bayer sizes the ordered dithers offer: F-OD-01 through F-OD-04.
pub const BAYER_SIZES: [usize; 4] = [2, 4, 8, 16];

/// A Bayer (recursive dispersed-dot) threshold matrix, `size` x `size`.
///
/// Generated from the standard recursion rather than transcribed, because
/// transcription is where the typos live: one swapped entry in a 16x16 table
/// still produces an image that looks like ordered dithering, and only a golden
/// image would catch it. The recursion has a single testable claim — the
/// classic 4x4 values — that pins all four sizes at once.
///
/// `size` must be a power of two, which is what the recursion produces. Any
/// other value has no Bayer matrix and panics rather than being quietly rounded
/// to one.
pub fn bayer(size: usize) -> ThresholdTexture {
    let ranks = bayer_ranks(size);
    let levels = (size * size) as f32;
    // Dividing by the number of levels rather than by `levels - 1` keeps the
    // top entry at `(n - 1) / n` instead of 1.0, inside the half-open range the
    // shader needs. Every quotient is a small integer over a power of two, so
    // each one is exact in `f32`.
    let values = ranks.iter().map(|&r| r as f32 / levels).collect();

    ThresholdTexture::new(size, size, values)
}

/// The integer ranks of a Bayer matrix, `0 .. size*size`.
///
/// The recursion: `M(1) = [0]`, and each doubling replaces every entry `v` with
/// the 2x2 block `[[4v, 4v+2], [4v+3, 4v+1]]`. That quadrant order *is* the
/// construction — it is what makes the pattern dispersed rather than clustered.
/// Permuting it still yields a valid permutation matrix, one that dithers
/// visibly worse.
///
/// Public because the GPU path uploads ranks, not thresholds: integers cross
/// the language boundary exactly, whereas two float implementations of this
/// recursion disagree in the last bit and put a visible seam between a CPU
/// preview and a GPU export (see `web/src/gpu/matrices.ts`).
pub fn bayer_ranks(size: usize) -> Vec<u32> {
    // The recursion only ever lands on powers of two, so any other `size` would
    // overshoot and hand back a tile of the wrong edge — a permutation of the
    // right shape for a matrix nobody asked for.
    assert!(
        size.is_power_of_two(),
        "Bayer matrices are powers of two; got {size}"
    );

    let mut ranks = vec![0u32];
    let mut n = 1usize;

    while n < size {
        let next = n * 2;
        let mut out = vec![0u32; next * next];
        for y in 0..n {
            for x in 0..n {
                let base = 4 * ranks[y * n + x];
                out[y * next + x] = base;
                out[y * next + x + n] = base + 2;
                out[(y + n) * next + x] = base + 3;
                out[(y + n) * next + x + n] = base + 1;
            }
        }
        ranks = out;
        n = next;
    }

    ranks
}

// ---------------------------------------------------------------------------
// Blue noise, via void-and-cluster (F-OD-05)
// ---------------------------------------------------------------------------

/// The blue-noise tile sizes the ordered dithers offer (F-OD-05).
///
/// Small tiles repeat visibly at low frequencies; large tiles cost `O(n^4)` to
/// build. 16 suits animation, where the tile is re-rolled per frame; 64 is the
/// still-image default.
pub const BLUE_NOISE_SIZES: [usize; 3] = [16, 32, 64];

/// `exp(-1 / (2 * sigma^2))` for Ulichney's published filter width, sigma 1.5.
///
/// This is the only transcendental value in the blue-noise path, and it is
/// pinned as a literal rather than computed because `exp` is *not* required to
/// be correctly rounded and does differ by an ulp between platform libms.
/// Almost everywhere an ulp is beneath notice; here it is not, because the
/// filter feeds a chain of `argmax` decisions, and one flipped near-tie
/// re-rolls the whole tile — macOS and Windows would ship different textures
/// for the same seed. Every other filter weight is an integer power of this
/// constant built by repeated IEEE multiplication, which is exactly
/// reproducible.
///
/// A test asserts this equals the platform's own `exp` to a tolerance far wider
/// than any libm disagreement and far narrower than a typo, so a mistyped digit
/// is a build failure rather than a silently different look.
const FILTER_BASE: f64 = 0.800_737_402_916_808_1;

/// Fraction of the tile the initial binary pattern fills, as a divisor.
/// Ulichney's suggestion: sparse enough that the homogenisation loop has room
/// to move points, dense enough that the energy field is not mostly flat.
const INITIAL_DENSITY_DIVISOR: usize = 10;

/// A void-and-cluster blue-noise tile (F-OD-05), seeded and reproducible.
///
/// This is Ulichney's method, not a white-noise texture with a blue name. The
/// difference is not cosmetic: white-noise thresholds produce exactly the
/// clumped, grainy result that ordered dithering exists to avoid, and the two
/// are indistinguishable in a directory listing and obvious in an image. The
/// tests assert the spectral and spacing properties directly rather than
/// trusting the label.
///
/// The tile wraps. Every distance in the construction is toroidal, so it
/// repeats seamlessly and the GPU can address it with a plain `repeat` sampler.
///
/// Cost is `O(size^4)` — each of `size^2` placements scans and splats across
/// the whole tile. 64x64 is a fraction of a second; 256x256 would not be. Build
/// these once and cache them.
///
/// Panics if `size` is not a power of two of at least 4.
pub fn blue_noise(size: usize, seed: u64) -> ThresholdTexture {
    let rank = blue_noise_ranks(size, seed);
    let levels = (size * size) as f32;
    let values = rank.iter().map(|&r| r as f32 / levels).collect();
    ThresholdTexture::new(size, size, values)
}

/// The integer ranks behind [`blue_noise`], `0 .. size*size`.
///
/// Same reason [`bayer_ranks`] is public: the GPU uploads ranks so that the
/// shader and the CPU preview derive their thresholds from bit-identical
/// integers instead of from two float divisions that agree to within an ulp.
///
/// Panics if `size` is not a power of two of at least 4.
pub fn blue_noise_ranks(size: usize, seed: u64) -> Vec<u32> {
    assert!(
        size >= 4 && size.is_power_of_two(),
        "blue-noise tiles are powers of two of at least 4; got {size}"
    );

    let pixels = size * size;
    let mut rng = Pcg32::new(seed, stream_of("noise/blue-noise"));
    let mut grid = VoidAndCluster::new(size, size, &mut rng);

    // The initial binary pattern: a random tenth of the tile, then swap the
    // tightest cluster into the largest void until the pattern stops moving.
    // The fixed point — Ulichney's "prototype binary pattern" — is what both
    // ranking directions start from, which is why the ranks below it and the
    // ranks above it join without a discontinuity at the seed density.
    let initial_ones = (pixels / INITIAL_DENSITY_DIVISOR).max(1);
    grid.scatter(initial_ones, &mut rng);
    grid.homogenize();

    let prototype = grid.clone();
    let mut rank = vec![u32::MAX; pixels];

    // Phase I — rank the prototype's own points from `initial_ones - 1` down to
    // 0 by repeatedly removing the tightest cluster. The most isolated point is
    // the last one standing and takes rank 0, so it is the first pixel to light
    // as the threshold rises.
    let mut remaining = initial_ones;
    while remaining > 0 {
        let index = grid.find(Extreme::Cluster);
        grid.set(index, false);
        remaining -= 1;
        rank[index] = remaining as u32;
    }

    // Phases II and III. Ulichney states them separately: up to half density
    // you fill the largest void in the 1s, and past half density the 0s are the
    // minority, so you switch to removing the tightest cluster of 0s. On a
    // torus those are the same rule. The filter is translation-invariant and
    // the grid wraps, so `sum over every q of filter(p - q)` is a constant `C`
    // independent of `p`; the energy of the 0s at `p` is therefore
    // `C - energy(p)`, and the argmax of that over the 0s is the argmin of
    // `energy` over the 0s — which is "largest void", verbatim. One loop is the
    // same algorithm, not a shortcut past half of it.
    grid = prototype;
    let mut placed = initial_ones;
    while placed < pixels {
        let index = grid.find(Extreme::Void);
        grid.set(index, true);
        rank[index] = placed as u32;
        placed += 1;
    }

    assert!(
        rank.iter().all(|&r| r != u32::MAX),
        "void-and-cluster left a pixel unranked"
    );

    rank
}

/// Which extreme of the energy field to search for.
#[derive(Clone, Copy, Debug)]
enum Extreme {
    /// The set pixel with the most filter energy around it — the middle of the
    /// tightest clump of 1s.
    Cluster,
    /// The unset pixel with the least filter energy around it — the middle of
    /// the emptiest region.
    Void,
}

/// One void-and-cluster run's working state.
#[derive(Clone)]
struct VoidAndCluster {
    width: usize,
    height: usize,
    /// The binary pattern. `true` is a "1" in Ulichney's terms.
    pattern: Vec<bool>,
    /// `energy[q]` is the filter summed over the toroidal offset from `q` to
    /// every set pixel. Maintained incrementally, because recomputing it after
    /// each of `size^2` placements would square an algorithm that is already
    /// `O(n^4)`.
    ///
    /// `f64` and not `f32` because adding then subtracting the same weight does
    /// not cancel exactly, and this field is added to and subtracted from tens
    /// of thousands of times. `f64` holds the drift near 1e-13, far below any
    /// margin the comparisons care about. The drift is identical on every
    /// platform — IEEE arithmetic, and Rust does not reassociate — so it costs
    /// reproducibility nothing.
    energy: Vec<f64>,
    /// Filter weights indexed by wrapped offset: `filter[dy * width + dx]`.
    filter: Vec<f64>,
    /// A fixed random key per pixel, used only to break exact ties.
    ///
    /// Ties are common and consequential. Early in a sparse pattern most of the
    /// tile shares one underflowed energy value, and taking the lowest index
    /// would bake a scan-order bias — a bias with a *direction*, in an
    /// algorithm whose entire output is a spatial arrangement — into the tile.
    /// A seeded key makes the choice arbitrary instead of directional and keeps
    /// it reproducible.
    tiebreak: Vec<u32>,
}

impl VoidAndCluster {
    fn new(width: usize, height: usize, rng: &mut Pcg32) -> Self {
        let pixels = width * height;

        // Toroidal offsets: the tile wraps, so what matters is the shorter way
        // round each axis. This is the line that makes the output tileable —
        // with a plain `dx` the two edges would be ranked as if they were far
        // apart, and abutting copies would clump along the seam.
        let max_offset_sq = (width / 2) * (width / 2) + (height / 2) * (height / 2);

        // filter(d) = exp(-d^2 / 2 sigma^2) = FILTER_BASE^(d^2). Squared
        // distances are integers, so every weight is an integer power of one
        // pinned constant, reachable by repeated multiplication and therefore
        // bit-identical everywhere. Nothing is truncated: at 64x64 the farthest
        // weight is around 1e-198, which `f64` still represents, so this is the
        // full convolution and not a windowed approximation of it.
        let mut powers = Vec::with_capacity(max_offset_sq + 1);
        powers.push(1.0f64);
        for k in 1..=max_offset_sq {
            let previous = powers[k - 1];
            powers.push(previous * FILTER_BASE);
        }

        let mut filter = vec![0.0f64; pixels];
        for dy in 0..height {
            let ty = dy.min(height - dy);
            for dx in 0..width {
                let tx = dx.min(width - dx);
                filter[dy * width + dx] = powers[tx * tx + ty * ty];
            }
        }

        let tiebreak = (0..pixels).map(|_| rng.next_u32()).collect();

        Self {
            width,
            height,
            pattern: vec![false; pixels],
            energy: vec![0.0; pixels],
            filter,
            tiebreak,
        }
    }

    /// Set or clear one pixel and update the energy field to match.
    ///
    /// Asserts the value actually changes. A no-op call would leave the pattern
    /// correct and the energy field silently wrong by one splat, and the tile
    /// would come out subtly worse with nothing failing.
    fn set(&mut self, index: usize, value: bool) {
        assert_ne!(
            self.pattern[index], value,
            "pixel {index} is already {value}"
        );
        self.pattern[index] = value;

        let (px, py) = (index % self.width, index / self.width);
        for dy in 0..self.height {
            let qy = (py + dy) % self.height;
            for dx in 0..self.width {
                let qx = (px + dx) % self.width;
                let weight = self.filter[dy * self.width + dx];
                let target = qy * self.width + qx;
                if value {
                    self.energy[target] += weight;
                } else {
                    self.energy[target] -= weight;
                }
            }
        }
    }

    /// Place `count` set pixels at distinct, uniformly chosen positions.
    ///
    /// Partial Fisher-Yates rather than draw-and-retry-on-collision: retrying
    /// makes the number of draws depend on the collisions, which makes the
    /// generator's position depend on data, which makes the rest of the tile
    /// depend on it too. This consumes exactly `count` draws, always.
    fn scatter(&mut self, count: usize, rng: &mut Pcg32) {
        let pixels = self.pattern.len();
        assert!(
            count <= pixels,
            "cannot scatter {count} into {pixels} pixels"
        );

        let mut order: Vec<u32> = (0..pixels as u32).collect();
        for i in 0..count {
            let j = i + rng.next_below((pixels - i) as u32) as usize;
            order.swap(i, j);
            self.set(order[i] as usize, true);
        }
    }

    /// Swap the tightest cluster into the largest void until the pattern is a
    /// fixed point of that operation — Ulichney's prototype binary pattern.
    ///
    /// Terminates when the void found after a removal is the point just
    /// removed, meaning no move improves the arrangement. The iteration cap
    /// exists because the alternative is an unbounded loop in library code; it
    /// can only fire for a `(size, seed)` pair that cycles, and since the whole
    /// function is deterministic that would be a reproducible panic covered by
    /// the tests for the sizes actually shipped, not an intermittent one.
    fn homogenize(&mut self) {
        let cap = 16 * self.pattern.len();
        for _ in 0..cap {
            let cluster = self.find(Extreme::Cluster);
            self.set(cluster, false);

            let void = self.find(Extreme::Void);
            if void == cluster {
                self.set(cluster, true);
                return;
            }
            self.set(void, true);
        }
        panic!("void-and-cluster homogenisation did not converge in {cap} swaps");
    }

    /// The tightest cluster or the largest void.
    ///
    /// Panics if the pattern holds no candidate of the required kind. That is a
    /// caller bug — ranking past the end of the pattern — and returning some
    /// arbitrary index would bury it in the texture.
    fn find(&self, what: Extreme) -> usize {
        let wants_set = matches!(what, Extreme::Cluster);

        let mut best_index = usize::MAX;
        let mut best_energy = if wants_set {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
        let mut best_key = u32::MAX;

        for (index, &is_set) in self.pattern.iter().enumerate() {
            if is_set != wants_set {
                continue;
            }
            let energy = self.energy[index];
            let key = self.tiebreak[index];

            let strictly_better = if wants_set {
                energy > best_energy
            } else {
                energy < best_energy
            };
            // The equality test is an exact float comparison on purpose: the
            // tie it catches is the literal one, chiefly whole regions whose
            // filter energy has underflowed to the same value. Near-ties are
            // settled by the energies themselves, which is what should settle
            // them.
            let better = strictly_better || (energy == best_energy && key < best_key);

            if better {
                best_index = index;
                best_energy = energy;
                best_key = key;
            }
        }

        assert!(
            best_index != usize::MAX,
            "no {what:?} exists in this pattern"
        );
        best_index
    }
}

// ---------------------------------------------------------------------------
// Interleaved gradient noise and the seeded noise sources (F-PP-06)
// ---------------------------------------------------------------------------

/// Jimenez's interleaved gradient noise at one pixel. Returns `[0, 1)`.
///
/// Cheap per-pixel dither noise whose spectrum sits between white and blue: two
/// multiplies and two fracts, no texture fetch, which is why it is the right
/// source for noise generated inside a shader rather than uploaded.
///
/// Computed in `f64`. The `fract(52.98 * fract(...))` chain is an amplifier —
/// the outer multiply discards the top ~6 bits of whatever the inner fract
/// produced — so in `f32` a coordinate in the low thousands leaves roughly
/// seven meaningful bits and the noise banks into visible bands. `f64` costs
/// nothing here, and its arithmetic is exact-rounded, so this stays
/// reproducible across platforms.
///
/// **The seed translates the field; it does not re-generate it.** Two seeds
/// give shifted copies of one pattern, because a function with two fixed
/// gradient constants has no other axis to vary. That is exactly what the
/// animated form of IGN does with its per-frame offset, and it is the right
/// tool for temporal variation. It is the wrong tool for decorrelating two
/// noise nodes in one stack — use [`white_noise`] or a second [`blue_noise`]
/// tile for that.
///
/// Seeding costs four multiplies per call. Filling a buffer should go through
/// [`interleaved_gradient_noise_field`], which seeds once.
pub fn interleaved_gradient_noise(x: u32, y: u32, seed: u64) -> f32 {
    let (offset_x, offset_y) = ign_offsets(seed);
    ign_at(f64::from(x) + offset_x, f64::from(y) + offset_y)
}

/// [`interleaved_gradient_noise`] over a whole buffer, row-major, seeded once.
///
/// Not a [`ThresholdTexture`]: IGN has a long quasi-period rather than a period,
/// so a buffer of it does not tile, and the type that promises tiling must not
/// be used to carry something that does not.
pub fn interleaved_gradient_noise_field(width: usize, height: usize, seed: u64) -> Vec<f32> {
    assert!(width > 0 && height > 0, "noise buffer cannot be empty");

    let (offset_x, offset_y) = ign_offsets(seed);
    let mut out = Vec::with_capacity(width * height);
    for y in 0..height {
        let fy = y as f64 + offset_y;
        for x in 0..width {
            out.push(ign_at(x as f64 + offset_x, fy));
        }
    }
    out
}

/// A pair of integer coordinate offsets in `[0, 4096)`.
///
/// Integers keep the coordinate exact going into the multiply, and the range is
/// wide enough that two seeds land on unrelated stretches of the pattern's
/// quasi-period. Drawn through [`Pcg32`] rather than sliced out of the seed
/// directly because document seeds are routinely small integers, and adjacent
/// small seeds would otherwise produce adjacent offsets — that is precisely the
/// low-entropy case the generator's seeding routine exists to absorb.
fn ign_offsets(seed: u64) -> (f64, f64) {
    let mut rng = Pcg32::new(seed, stream_of("noise/interleaved-gradient"));
    let x = f64::from(rng.next_u32() >> 20);
    let y = f64::from(rng.next_u32() >> 20);
    (x, y)
}

fn ign_at(x: f64, y: f64) -> f32 {
    let inner = (0.061_710_56 * x + 0.005_837_15 * y).fract();
    let value = (52.982_918_9 * inner).fract();
    // `fract` is always below 1.0, but the narrowing cast is not: a value just
    // under 1.0 in `f64` rounds up to exactly 1.0 in `f32`. Capping at the
    // largest representable `f32` below 1.0 keeps the documented range true
    // without a branch that only fires in the rare case.
    value.min(f64::from(F32_JUST_BELOW_ONE)) as f32
}

/// Uniform white noise, one value per pixel, in `[0, 1)` (F-PP-06).
///
/// Every generator in this section draws from its own named stream, so calling
/// two of them with one node seed gives independent fields rather than the same
/// numbers wearing different distributions.
pub fn white_noise(width: usize, height: usize, seed: u64) -> Vec<f32> {
    assert!(width > 0 && height > 0, "noise buffer cannot be empty");
    let mut rng = Pcg32::new(seed, stream_of("noise/white"));
    (0..width * height).map(|_| rng.next_f32()).collect()
}

/// Value noise: a random value per lattice point, smoothly interpolated
/// (F-PP-06). One value per pixel, in `[0, 1]`.
///
/// `cells` is the lattice resolution along each axis. The lattice wraps at
/// `cells`, so the buffer tiles seamlessly — the same reason the blue-noise
/// filter is toroidal, and the reason this can be scrolled as an animated
/// displacement source without a seam walking through the frame.
///
/// The upper endpoint is inclusive only through rounding: the lattice values
/// are all below 1.0 and the interpolation is a convex combination of them, so
/// the mathematical result is too, but `a + (b - a) * t` can round up to
/// exactly 1.0 at the very top of the range. Stated rather than clamped,
/// because a caller that needs `[0, 1)` should know it is choosing a clamp.
///
/// Panics if the dimensions or `cells` are zero.
pub fn value_noise(width: usize, height: usize, cells: usize, seed: u64) -> Vec<f32> {
    assert!(width > 0 && height > 0, "noise buffer cannot be empty");
    assert!(cells > 0, "value noise needs at least one lattice cell");

    // The whole lattice up front, in one pass. Hashing coordinates into the
    // generator would work too, but a table is `cells^2` values, is obviously a
    // bijection with the draw sequence, and needs no second hash function to
    // justify.
    let mut rng = Pcg32::new(seed, stream_of("noise/value"));
    let lattice: Vec<f32> = (0..cells * cells).map(|_| rng.next_f32()).collect();

    let scale_x = cells as f32 / width as f32;
    let scale_y = cells as f32 / height as f32;
    let mut out = Vec::with_capacity(width * height);

    for y in 0..height {
        let fy = y as f32 * scale_y;
        let gy = fy.floor();
        let ty = smoothstep(fy - gy);
        let y0 = (gy as usize) % cells;
        let y1 = (y0 + 1) % cells;

        for x in 0..width {
            let fx = x as f32 * scale_x;
            let gx = fx.floor();
            let tx = smoothstep(fx - gx);
            let x0 = (gx as usize) % cells;
            let x1 = (x0 + 1) % cells;

            let top = lerp(lattice[y0 * cells + x0], lattice[y0 * cells + x1], tx);
            let bottom = lerp(lattice[y1 * cells + x0], lattice[y1 * cells + x1], tx);
            out.push(lerp(top, bottom, ty));
        }
    }

    out
}

/// Gaussian noise, one standard-normal sample per pixel (F-PP-06).
///
/// Mean 0, standard deviation 1 — unscaled, because the amount belongs to the
/// node's parameters and baking a range in here would make two places to change
/// it.
///
/// Box-Muller, using both outputs of each pair. Discarding the sine term would
/// double the draws for no gain and make the generator's position depend on the
/// buffer length.
///
/// **Platform note.** `ln`, `sin` and `cos` come from the platform's libm,
/// which is not required to be correctly rounded, so a sample here can differ
/// in its last bit between macOS and Windows. The uniform draws feeding them
/// are bit-identical, and a last-bit difference in an additive noise term
/// cannot move an 8-bit output. This is the same exposure `srgb_to_linear`'s
/// `powf` and OKLab's `cbrt` already carry; it is named rather than hidden. It
/// is also exactly why [`blue_noise`] refuses to call `exp` — there the same
/// ulp would flip a discrete decision and re-roll an entire tile.
pub fn gaussian_noise(width: usize, height: usize, seed: u64) -> Vec<f32> {
    assert!(width > 0 && height > 0, "noise buffer cannot be empty");

    let count = width * height;
    let mut rng = Pcg32::new(seed, stream_of("noise/gaussian"));
    let mut out = Vec::with_capacity(count);

    while out.len() < count {
        // `1 - u` and not `u`: `next_f32` can return exactly 0.0, and `ln(0)`
        // is negative infinity, which would put a NaN in the buffer roughly
        // once per 16 million pixels — often enough to happen, rarely enough
        // never to be reproduced by hand.
        let u1 = 1.0 - rng.next_f32();
        let u2 = rng.next_f32();

        let radius = (-2.0 * u1.ln()).sqrt();
        let angle = std::f32::consts::TAU * u2;

        out.push(radius * angle.cos());
        if out.len() < count {
            out.push(radius * angle.sin());
        }
    }

    out
}

/// Hermite smoothstep. Value noise interpolated linearly shows its lattice as a
/// grid of creases, because the derivative jumps at every cell boundary; this
/// has zero derivative at both ends, so the cells join invisibly.
#[inline]
fn smoothstep(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

#[inline]
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The check that the Bayer recursion is right.
    ///
    /// These sixteen numbers are the published 4x4 matrix. If the quadrant
    /// order in `bayer_ranks` were permuted, the result would still be a valid
    /// permutation of 0..16 that still dithers — just worse, and only in a way
    /// a golden image would catch. Pinning the classic values catches it here.
    ///
    /// The comparison is exact because every value is a small integer over 16,
    /// which `f32` represents exactly; a tolerance would only hide a real
    /// difference.
    #[test]
    fn bayer_4x4_matches_the_classic_matrix() {
        #[rustfmt::skip]
        const CLASSIC: [u32; 16] = [
             0,  8,  2, 10,
            12,  4, 14,  6,
             3, 11,  1,  9,
            15,  7, 13,  5,
        ];

        let matrix = bayer(4);
        for y in 0..4 {
            for x in 0..4 {
                let expected = CLASSIC[y * 4 + x] as f32 / 16.0;
                assert_eq!(
                    matrix.at(x, y),
                    expected,
                    "entry ({x}, {y}) of the 4x4 matrix"
                );
            }
        }
    }

    #[test]
    fn bayer_2x2_is_the_base_of_the_recursion() {
        let matrix = bayer(2);
        assert_eq!(matrix.values(), [0.0, 0.5, 0.75, 0.25]);
    }

    /// Every size must use each rank exactly once. A recursion that duplicated
    /// or skipped a level would still fill the matrix and still look like a
    /// dither.
    #[test]
    fn every_bayer_size_is_a_complete_permutation_of_its_ranks() {
        for size in BAYER_SIZES {
            let matrix = bayer(size);
            let levels = size * size;
            let mut seen = vec![false; levels];
            for &v in matrix.values() {
                assert!((0.0..1.0).contains(&v), "{v} outside [0, 1) at size {size}");
                let rank = (v * levels as f32).round() as usize;
                assert!(!seen[rank], "rank {rank} appears twice at size {size}");
                seen[rank] = true;
            }
            assert!(seen.iter().all(|&s| s), "size {size} skipped a rank");
        }
    }

    #[test]
    #[should_panic(expected = "Bayer matrices are powers of two")]
    fn bayer_rejects_a_size_that_has_no_matrix() {
        bayer(6);
    }

    /// The GPU uploads [`bayer_ranks`] and [`blue_noise_ranks`]; the CPU side
    /// reads the [`ThresholdTexture`] values. If those two ever stopped being
    /// the same ordering, a stack that ran partly on each would put a seam down
    /// the middle of the image, and every existing test would still pass —
    /// each half is internally consistent and individually correct.
    ///
    /// Equality is exact, not approximate. Every quotient here is a small
    /// integer over a power of two, so `f32` represents it exactly, and a
    /// tolerance would only hide the drift this test exists to catch.
    #[test]
    fn the_exported_ranks_are_the_ordering_the_threshold_matrices_encode() {
        fn check(ranks: &[u32], tile: &ThresholdTexture, size: usize, what: &str) {
            let levels = size * size;
            assert_eq!(ranks.len(), levels, "{what}: wrong rank count at {size}");

            let mut seen = vec![false; levels];
            for (i, &rank) in ranks.iter().enumerate() {
                let rank = rank as usize;
                assert!(rank < levels, "{what}: rank {rank} out of range at {size}");
                assert!(!seen[rank], "{what}: rank {rank} repeats at {size}");
                seen[rank] = true;
                assert_eq!(
                    tile.values()[i],
                    rank as f32 / levels as f32,
                    "{what}: rank and threshold disagree at index {i}, size {size}"
                );
            }
        }

        for size in BAYER_SIZES {
            check(&bayer_ranks(size), &bayer(size), size, "bayer");
        }
        for size in BLUE_NOISE_SIZES {
            let seed = 0x5eed;
            check(
                &blue_noise_ranks(size, seed),
                &blue_noise(size, seed),
                size,
                "blue-noise",
            );
        }
    }

    #[test]
    fn blue_noise_is_a_complete_permutation_at_every_shipped_size() {
        for size in BLUE_NOISE_SIZES {
            let tile = blue_noise(size, 0x5eed);
            let levels = size * size;
            let mut seen = vec![false; levels];
            for &v in tile.values() {
                let rank = (v * levels as f32).round() as usize;
                assert!(!seen[rank], "rank {rank} appears twice at size {size}");
                seen[rank] = true;
            }
            assert!(seen.iter().all(|&s| s), "size {size} skipped a rank");
        }
    }

    #[test]
    fn blue_noise_is_reproducible_and_seed_dependent() {
        let a = blue_noise(16, 7);
        let b = blue_noise(16, 7);
        let c = blue_noise(16, 8);
        assert_eq!(a, b, "same seed must give the same tile");
        assert_ne!(a, c, "different seeds must give different tiles");
    }

    /// The test that separates blue noise from white noise wearing its name.
    ///
    /// Take the lowest-ranked tenth of the tile — the points that light first
    /// as the threshold rises, which is where clumping shows worst — and
    /// measure each one's toroidal distance to its nearest neighbour. A
    /// void-and-cluster pattern spaces those points evenly, so the *smallest*
    /// nearest-neighbour distance sits close to the mean and the spread is
    /// narrow. A uniformly random set of the same size has touching pairs
    /// almost surely, so its smallest is 1 and its spread is wide.
    ///
    /// Distances are toroidal, which makes this the seam test too: a tile built
    /// with non-wrapping distances clumps along its edges, and points on
    /// opposite edges would show up here as near-coincident.
    #[test]
    fn blue_noise_spaces_its_first_points_far_more_evenly_than_white_noise() {
        const SIZE: usize = 32;
        let pixels = SIZE * SIZE;
        let sample = pixels / 10;

        let tile = blue_noise(SIZE, 0xb10e);
        let mut ordered: Vec<usize> = (0..pixels).collect();
        ordered.sort_by(|&a, &b| {
            tile.values()[a]
                .partial_cmp(&tile.values()[b])
                .expect("threshold values are never NaN")
        });
        let blue_points = &ordered[..sample];

        let mut rng = Pcg32::seeded(0xb10e);
        let mut chosen: Vec<usize> = (0..pixels).collect();
        for i in 0..sample {
            let j = i + rng.next_below((pixels - i) as u32) as usize;
            chosen.swap(i, j);
        }
        let white_points = &chosen[..sample];

        let (blue_min, blue_mean, blue_spread) = spacing_stats(blue_points, SIZE);
        let (white_min, white_mean, white_spread) = spacing_stats(white_points, SIZE);

        // A random set of 102 points in 1024 cells has, in expectation, dozens
        // of touching pairs, so its minimum is 1.0. Two claims about blue
        // noise, both with room in them: no two of the first-lit points are
        // even diagonally adjacent (a minimum above sqrt(2), measured at 2.0),
        // and they sit at a decent fraction of the ideal spacing for this
        // density, which is about 3.4 (mean measured at 2.57).
        assert!(
            blue_min > 1.5,
            "blue-noise nearest-neighbour minimum {blue_min}, mean {blue_mean}"
        );
        assert!(
            blue_mean > 2.2,
            "blue-noise mean nearest-neighbour distance {blue_mean}"
        );
        assert!(
            white_min < blue_min,
            "white-noise minimum {white_min} did not fall below blue's {blue_min}"
        );

        // Uniformity, not merely separation: the coefficient of variation of
        // the nearest-neighbour distances. Even spacing means a small one.
        let blue_cv = blue_spread / blue_mean;
        let white_cv = white_spread / white_mean;
        assert!(
            blue_cv < white_cv / 2.0,
            "spacing spread: blue cv {blue_cv}, white cv {white_cv}"
        );
    }

    /// The independent check on the same claim: the spectrum.
    ///
    /// Threshold the tile at 50% and take the power spectrum of the binary
    /// pattern that falls out. Blue noise, by definition, has its energy pushed
    /// to high frequencies — at half density the principal frequency sits at
    /// Nyquist, so the low band should be close to empty. White noise is flat,
    /// so its bands match. This catches a failure the spacing test cannot: a
    /// pattern that is well separated but periodic.
    #[test]
    fn blue_noise_has_a_blue_spectrum_and_white_noise_does_not() {
        const SIZE: usize = 32;

        let tile = blue_noise(SIZE, 0x5bec);
        let blue = threshold_at_half(tile.values());
        let white = threshold_at_half(&white_noise(SIZE, SIZE, 0x5bec));

        let blue_ratio = low_to_high_power_ratio(&blue, SIZE);
        let white_ratio = low_to_high_power_ratio(&white, SIZE);

        // Measured: blue 0.016, white 1.07. The bounds sit an order of
        // magnitude off each measurement, so this fails on a real regression
        // and not on a rounding difference.
        assert!(
            blue_ratio < 0.15,
            "blue-noise low/high power ratio {blue_ratio} is not blue"
        );
        assert!(
            white_ratio > 0.6,
            "white-noise control ratio {white_ratio} — the measure itself is wrong"
        );
        assert!(
            blue_ratio < white_ratio / 4.0,
            "blue {blue_ratio} against white {white_ratio}"
        );
    }

    #[test]
    #[should_panic(expected = "blue-noise tiles are powers of two")]
    fn blue_noise_rejects_a_size_it_cannot_tile() {
        blue_noise(24, 1);
    }

    /// Pins the one constant that cannot be recomputed at runtime without
    /// reintroducing the platform's `exp`. The tolerance is far wider than any
    /// libm disagreement and far narrower than a typo.
    #[test]
    fn the_filter_base_is_the_gaussian_it_claims_to_be() {
        // Ulichney's published filter width.
        const SIGMA: f64 = 1.5;
        let expected = (-1.0 / (2.0 * SIGMA * SIGMA)).exp();
        assert!(
            (FILTER_BASE - expected).abs() < 1e-15,
            "FILTER_BASE {FILTER_BASE} against exp {expected}"
        );
    }

    #[test]
    fn threshold_texture_wraps_the_way_a_repeat_sampler_does() {
        let matrix = bayer(4);
        assert_eq!(matrix.width(), 4);
        assert_eq!(matrix.height(), 4);
        assert_eq!(matrix.tiled(0, 0), matrix.tiled(4, 4));
        assert_eq!(matrix.tiled(1, 2), matrix.tiled(-3, -2));
        assert_eq!(matrix.tiled(3, 1), matrix.at(3, 1));
    }

    #[test]
    fn the_u8_form_keeps_the_order_of_the_exact_form() {
        for size in BAYER_SIZES {
            let matrix = bayer(size);
            let bytes = matrix.to_u8();
            assert_eq!(bytes.len(), matrix.values().len());

            let mut pairs: Vec<(f32, u8)> = matrix
                .values()
                .iter()
                .copied()
                .zip(bytes.iter().copied())
                .collect();
            pairs.sort_by(|a, b| a.0.partial_cmp(&b.0).expect("no NaN"));
            for window in pairs.windows(2) {
                assert!(
                    window[0].1 <= window[1].1,
                    "quantization inverted {:?} and {:?} at size {size}",
                    window[0],
                    window[1]
                );
            }
        }
    }

    #[test]
    #[should_panic(expected = "outside [0, 1)")]
    fn threshold_texture_refuses_a_value_the_shader_cannot_use() {
        ThresholdTexture::new(2, 1, vec![0.5, 1.0]);
    }

    #[test]
    fn interleaved_gradient_noise_is_in_range_and_reproducible() {
        let mut max = 0.0f32;
        for y in 0..64u32 {
            for x in 0..64u32 {
                let v = interleaved_gradient_noise(x, y, 42);
                assert!((0.0..1.0).contains(&v), "{v} outside [0, 1)");
                assert_eq!(v, interleaved_gradient_noise(x, y, 42));
                max = max.max(v);
            }
        }
        assert!(max > 0.95, "largest of 4096 samples was only {max}");
    }

    /// The buffer form must agree with the per-pixel form value for value, or
    /// the two would be two implementations of one function — the exact thing
    /// this module exists to avoid.
    #[test]
    fn the_ign_buffer_form_agrees_with_the_per_pixel_form() {
        let field = interleaved_gradient_noise_field(8, 5, 1234);
        assert_eq!(field.len(), 40);
        for y in 0..5u32 {
            for x in 0..8u32 {
                assert_eq!(
                    field[y as usize * 8 + x as usize],
                    interleaved_gradient_noise(x, y, 1234)
                );
            }
        }
    }

    /// The seed must actually move the field. It shifts rather than re-rolls it
    /// — documented on the function — but a seed that did nothing at all would
    /// be a lie in the signature.
    #[test]
    fn interleaved_gradient_noise_responds_to_its_seed() {
        let a = interleaved_gradient_noise_field(16, 16, 1);
        let b = interleaved_gradient_noise_field(16, 16, 2);
        assert_ne!(a, b);
        let shared = a.iter().zip(&b).filter(|(x, y)| x == y).count();
        assert!(
            shared < 8,
            "{shared} of 256 samples were unchanged by the seed"
        );
    }

    #[test]
    fn white_noise_is_uniform_seeded_and_stream_separated() {
        let a = white_noise(64, 64, 3);
        assert_eq!(a, white_noise(64, 64, 3));
        assert_ne!(a, white_noise(64, 64, 4));
        assert!(a.iter().all(|v| (0.0..1.0).contains(v)));

        let mean = a.iter().sum::<f32>() / a.len() as f32;
        assert!((mean - 0.5).abs() < 0.02, "mean {mean}");

        // Same seed, different generator: the named streams must keep these
        // apart, or every noise node in a document would move together.
        let g = gaussian_noise(64, 64, 3);
        assert!(
            a.iter().zip(&g).filter(|(x, y)| x == y).count() < 4,
            "white and gaussian noise share draws at the same seed"
        );
    }

    #[test]
    fn value_noise_tiles_seamlessly_and_stays_in_range() {
        const SIZE: usize = 64;
        const CELLS: usize = 4;
        let field = value_noise(SIZE, SIZE, CELLS, 11);

        assert!(field.iter().all(|v| (0.0..=1.0).contains(v)));
        assert_eq!(field, value_noise(SIZE, SIZE, CELLS, 11));
        assert_ne!(field, value_noise(SIZE, SIZE, CELLS, 12));

        let mut worst_interior = 0.0f32;
        for y in 0..SIZE {
            for x in 1..SIZE {
                let step = (field[y * SIZE + x] - field[y * SIZE + x - 1]).abs();
                worst_interior = worst_interior.max(step);
            }
        }

        // Across the seam the field must be as continuous as it is anywhere
        // else: the step from the last column back to the first can be no
        // larger than the largest step inside a row.
        for y in 0..SIZE {
            let seam = (field[y * SIZE] - field[y * SIZE + SIZE - 1]).abs();
            assert!(
                seam <= worst_interior,
                "row {y} jumps {seam} across the seam against {worst_interior} inside"
            );
        }

        // Smooth, not white. Smoothstep's steepest slope is 1.5, over a cell of
        // `SIZE / CELLS` pixels spanning at most the full unit range, so no
        // neighbouring pair can differ by more than 1.5 / 16 if this is really
        // interpolating a lattice.
        let cell = (SIZE / CELLS) as f32;
        assert!(
            worst_interior < 1.5 / cell,
            "value noise is not interpolating; worst neighbour step {worst_interior}"
        );
    }

    #[test]
    fn gaussian_noise_is_standard_normal_and_finite() {
        let samples = gaussian_noise(128, 128, 9001);
        assert!(
            samples.iter().all(|v| v.is_finite()),
            "a sample was not finite"
        );

        let n = samples.len() as f32;
        let mean = samples.iter().sum::<f32>() / n;
        let variance = samples.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / n;
        assert!(mean.abs() < 0.03, "mean {mean}");
        assert!((variance - 1.0).abs() < 0.06, "variance {variance}");
    }

    #[test]
    fn gaussian_noise_fills_an_odd_length_buffer() {
        // Box-Muller produces pairs; the final sample of an odd-length buffer
        // is the one a carelessly written loop drops.
        let samples = gaussian_noise(3, 1, 5);
        assert_eq!(samples.len(), 3);
        assert!(samples.iter().all(|v| v.is_finite()));
    }

    // -- test helpers --------------------------------------------------------

    fn threshold_at_half(field: &[f32]) -> Vec<f32> {
        field
            .iter()
            .map(|&v| if v >= 0.5 { 1.0 } else { 0.0 })
            .collect()
    }

    /// Minimum, mean and standard deviation of each point's toroidal distance
    /// to its nearest other point in the set.
    fn spacing_stats(points: &[usize], size: usize) -> (f32, f32, f32) {
        let mut distances = Vec::with_capacity(points.len());
        for &p in points {
            let (px, py) = ((p % size) as i32, (p / size) as i32);
            let mut nearest = f32::INFINITY;
            for &q in points {
                if q == p {
                    continue;
                }
                let dx = torus_delta(px, (q % size) as i32, size);
                let dy = torus_delta(py, (q / size) as i32, size);
                nearest = nearest.min(((dx * dx + dy * dy) as f32).sqrt());
            }
            distances.push(nearest);
        }

        let n = distances.len() as f32;
        let mean = distances.iter().sum::<f32>() / n;
        let variance = distances
            .iter()
            .map(|d| (d - mean) * (d - mean))
            .sum::<f32>()
            / n;
        let min = distances.iter().copied().fold(f32::INFINITY, f32::min);
        (min, mean, variance.sqrt())
    }

    fn torus_delta(a: i32, b: i32, size: usize) -> i32 {
        let raw = (a - b).abs();
        raw.min(size as i32 - raw)
    }

    /// Mean power in the low-frequency band over mean power in the high band,
    /// from a direct DFT. Direct because with a twiddle table this is a few
    /// million multiplies for a 32x32 tile, and an FFT here would be both a
    /// dependency and a second thing to get right.
    fn low_to_high_power_ratio(field: &[f32], size: usize) -> f32 {
        assert_eq!(field.len(), size * size);
        let n = size as f32;
        let mean = field.iter().sum::<f32>() / field.len() as f32;

        let cos_table: Vec<f32> = (0..size)
            .map(|k| (std::f32::consts::TAU * k as f32 / n).cos())
            .collect();
        let sin_table: Vec<f32> = (0..size)
            .map(|k| (std::f32::consts::TAU * k as f32 / n).sin())
            .collect();

        let mut low_sum = 0.0f32;
        let mut low_count = 0usize;
        let mut high_sum = 0.0f32;
        let mut high_count = 0usize;

        for u in 0..size {
            for v in 0..size {
                let fu = u.min(size - u);
                let fv = v.min(size - v);
                let radius = ((fu * fu + fv * fv) as f32).sqrt();
                let low = radius > 0.0 && radius <= 3.0;
                let high = radius >= 6.0;
                if !low && !high {
                    continue;
                }

                let mut re = 0.0f32;
                let mut im = 0.0f32;
                for y in 0..size {
                    let vy = (v * y) % size;
                    let (cb, sb) = (cos_table[vy], sin_table[vy]);
                    for x in 0..size {
                        let ux = (u * x) % size;
                        // cos(a + b) and sin(a + b) out of the two tables, so
                        // the trig cost is size^2 rather than size^4.
                        let (ca, sa) = (cos_table[ux], sin_table[ux]);
                        let sample = field[y * size + x] - mean;
                        re += sample * (ca * cb - sa * sb);
                        im -= sample * (sa * cb + ca * sb);
                    }
                }

                let power = re * re + im * im;
                if low {
                    low_sum += power;
                    low_count += 1;
                } else {
                    high_sum += power;
                    high_count += 1;
                }
            }
        }

        assert!(low_count > 0 && high_count > 0, "empty frequency band");
        (low_sum / low_count as f32) / (high_sum / high_count as f32)
    }
}
