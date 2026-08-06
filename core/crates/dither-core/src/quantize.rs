//! Automatic palette extraction from a source image (F-CO-02).
//!
//! Three algorithms — median cut, Wu's moment-based quantizer, and k-means with
//! k-means++ initialisation — all producing a palette **and** an index map,
//! because every downstream index-map operation (hue-targeted recolour, index
//! remap, outline, dilate/erode, the SVG tracer) depends on having one.
//!
//! Two decisions shape all three.
//!
//! **Everything measures distance in OKLab and averages in linear light.**
//! Partitioning and cluster assignment happen in OKLab because that is where
//! "these two colours look alike" is a Euclidean question; the colour that
//! represents a cluster is the linear-light mean of its pixels, because that is
//! the average that conserves light and keeps a quantized flat field averaging
//! back to the luminance it started from. Doing the reverse — averaging in a
//! perceptual or gamma space — is the same class of mistake as diffusing error
//! in sRGB, and produces the same muddy result.
//!
//! **All three work off one shared 3D histogram over OKLab.** Feeding megapixel
//! buffers straight into a median cut or a Lloyd iteration is not affordable in
//! a browser, and the histogram bounds the work at the number of occupied bins
//! instead of the number of pixels. The grid is laid out over the image's own
//! OKLab bounding box rather than a fixed one, so a low-chroma photograph gets
//! its resolution spent where its colours actually are, and an out-of-range
//! input is not clipped into the corner of a fixed cube. The bins decide only
//! where partitions may fall; every returned colour is the true mean of the
//! pixels behind it, never a bin centre.
//!
//! The consequence to know about: the palette cannot come back larger than the
//! number of occupied bins. That is the correct answer — an image with four
//! distinct colours has no fifth to extract — and [`Report`] states both
//! numbers so the caller can say so rather than the caller wondering.
//!
//! Nothing here logs directly; `dither-core` has no logger and must not grow
//! one, since a logger is exactly the kind of dependency that would let this
//! crate reach for a clock or a console. [`Quantized::report`] carries what an
//! operation log needs and the `wasm` channel emits it at the boundary.

use crate::color::{linear_to_oklab, oklab_distance_sq, Oklab, Rgba};
use crate::palette::{Metric, Palette};
use crate::rng::{stream_of, Pcg32};

/// Bins per OKLab axis in the shared histogram.
///
/// 32 is the size Wu's published implementation uses, and the reasoning carries
/// over: 32^3 bins is a few megabytes of moments, it is far more partition
/// positions than a 256-entry palette can consume, and the representative
/// colours do not lose precision to it because they are computed from the
/// summed pixel values rather than from bin coordinates.
const GRID: usize = 32;

/// Side of the moment arrays. One larger than [`GRID`]: index 0 is the zero
/// margin that makes the cumulative moments' inclusion-exclusion arithmetic
/// work without a special case at the low face of a box.
const SIDE: usize = GRID + 1;

/// Largest palette a `u16` index map can address.
const MAX_K: usize = u16::MAX as usize + 1;

/// Which extraction algorithm to run (F-CO-02).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    /// Heckbert's median cut: repeatedly halve the most populous box along its
    /// longest axis. Cheap, and it gives every colour region a slot in
    /// proportion to how much of the image it covers, which is why it survived.
    MedianCut,
    /// Wu's moment-based quantizer: greedily split whichever box loses the most
    /// variance by being split, using cumulative moments so the cost of
    /// evaluating a candidate cut does not depend on how many pixels are in it.
    /// Generally the best of the three per unit of time.
    Wu,
    /// Lloyd's algorithm from a k-means++ seeding. The only one that iterates
    /// towards a local optimum rather than committing to a partition in one
    /// pass, and the only one that draws from the RNG.
    KMeans,
}

/// Extraction settings.
#[derive(Clone, Copy, Debug)]
pub struct Options {
    pub method: Method,
    /// Requested palette size. The result may be smaller when the image does
    /// not contain that many distinguishable colours; see [`Report`].
    pub k: usize,
    /// Explicit seed, from the document.
    ///
    /// Only [`Method::KMeans`] draws from it today. All three take one anyway,
    /// so the document records a seed for every extraction and a later change
    /// that adds a stochastic step to another method cannot quietly become
    /// unseeded — which is the failure this project treats as a defect rather
    /// than a quirk.
    pub seed: u64,
    /// Ceiling on Lloyd iterations. Reached rarely; k-means normally stops
    /// earlier because no point changed cluster.
    pub max_iterations: u32,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            method: Method::Wu,
            k: 16,
            seed: 0,
            max_iterations: 64,
        }
    }
}

/// What an extraction did. Returned so the caller can log it — see the module
/// note on why this crate has no logger of its own.
#[derive(Clone, Copy, Debug)]
pub struct Report {
    pub method: Method,
    pub requested_k: usize,
    /// Occupied bins in the shared histogram: the ceiling on palette size for
    /// this image. A `palette_len` below `requested_k` is explained by this
    /// being below it too.
    pub occupied_bins: usize,
    pub palette_len: usize,
    /// Lloyd iterations actually run. Zero for the single-pass methods.
    pub iterations: u32,
    /// Clusters that lost every member during k-means and were re-seeded on the
    /// worst-fitting point. Re-seeding is deterministic — the point is chosen
    /// by distance, not by a fresh draw.
    pub empty_cluster_repairs: u32,
    /// Clusters that were still empty at the end and produced no palette entry.
    /// Only reachable when the image holds fewer distinct colours than `k`.
    pub empty_clusters_dropped: u32,
}

/// An extracted palette and the index map that goes with it.
#[derive(Clone, Debug)]
pub struct Quantized {
    pub palette: Palette,
    /// One palette index per source pixel, in source order.
    ///
    /// Defined as `palette.nearest(pixel, Metric::Oklab)` rather than as
    /// whatever cluster the algorithm happened to assign. The two can differ,
    /// because a cluster's representative colour is a mean and a pixel at the
    /// edge of one cluster can sit nearer the mean of its neighbour. Nearest
    /// matching is the definition the rest of the pipeline uses — it is exactly
    /// what a diffusion pass at strength 0 produces — so extraction and
    /// dithering agree about what index a pixel has.
    pub indices: Vec<u16>,
    /// Pixels matched to each palette entry. Pass to
    /// [`crate::palette::SortKey::Population`].
    pub populations: Vec<u32>,
    pub report: Report,
}

/// Extract a palette of up to `opts.k` colours from a linear-light buffer.
///
/// Alpha is ignored when clustering and every entry comes back opaque, matching
/// [`Palette::new`], which carries alpha but does not match on it. Alpha
/// handling is its own control (F-CO-08) and folding it in here would silently
/// make two transparency levels of one colour compete for palette slots.
///
/// Panics on an empty buffer, on `k == 0`, on a `k` a `u16` index map cannot
/// address, and on `max_iterations == 0` — all caller errors with no defensible
/// answer, and the WASM boundary turns them into JS errors before they reach
/// here.
pub fn extract(pixels: &[Rgba], opts: Options) -> Quantized {
    assert!(
        !pixels.is_empty(),
        "cannot extract a palette from an empty image"
    );
    assert!(
        u32::try_from(pixels.len()).is_ok(),
        "image of {} pixels is larger than the population counters address",
        pixels.len()
    );
    assert!(opts.k > 0, "palette size must be at least 1");
    assert!(
        opts.k <= MAX_K,
        "palette size {} exceeds the {MAX_K} a u16 index map can address",
        opts.k
    );
    assert!(
        opts.max_iterations > 0,
        "k-means needs at least one iteration"
    );

    let mut grid = Grid::build(pixels);
    let occupied_bins = grid.occupied();

    let outcome = match opts.method {
        Method::MedianCut => median_cut(&grid.points(), opts.k),
        Method::Wu => Outcome::single_pass(wu(&mut grid, opts.k)),
        Method::KMeans => kmeans(&grid.points(), opts.k, opts.seed, opts.max_iterations),
    };

    let palette = Palette::new(outcome.colors);
    let mut indices = Vec::with_capacity(pixels.len());
    let mut populations = vec![0u32; palette.len()];
    for p in pixels {
        let i = palette.nearest(*p, Metric::Oklab);
        populations[i] += 1;
        indices.push(i as u16);
    }

    let report = Report {
        method: opts.method,
        requested_k: opts.k,
        occupied_bins,
        palette_len: palette.len(),
        iterations: outcome.iterations,
        empty_cluster_repairs: outcome.empty_cluster_repairs,
        empty_clusters_dropped: outcome.empty_clusters_dropped,
    };

    Quantized {
        palette,
        indices,
        populations,
        report,
    }
}

/// What one algorithm produced, before the index map is built.
struct Outcome {
    colors: Vec<Rgba>,
    iterations: u32,
    empty_cluster_repairs: u32,
    empty_clusters_dropped: u32,
}

impl Outcome {
    /// For the two methods that partition in one pass and have nothing to
    /// iterate or repair.
    fn single_pass(colors: Vec<Rgba>) -> Self {
        Self {
            colors,
            iterations: 0,
            empty_cluster_repairs: 0,
            empty_clusters_dropped: 0,
        }
    }
}

/// One axis of OKLab.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Axis {
    L,
    A,
    B,
}

#[inline]
fn coord(c: Oklab, axis: Axis) -> f32 {
    match axis {
        Axis::L => c.l,
        Axis::A => c.a,
        Axis::B => c.b,
    }
}

#[inline]
fn gidx(l: usize, a: usize, b: usize) -> usize {
    (l * SIDE + a) * SIDE + b
}

/// One occupied histogram bin, as the clustering algorithms see it: a weighted
/// point in OKLab that also remembers the linear light behind it.
#[derive(Clone, Copy, Debug)]
struct Point {
    /// Mean OKLab of the pixels in the bin. Used for every distance.
    lab: Oklab,
    /// Summed linear-light R, G and B of those pixels. Divided by `weight` this
    /// is the colour the bin contributes to a palette entry.
    lin: [f64; 3],
    /// Pixel count.
    weight: f64,
}

/// The shared histogram: per-bin moments over the image's OKLab bounding box.
///
/// `f64` accumulators throughout. The sums run to the pixel count and Wu then
/// takes differences of nearly-equal cumulative sums, which is where an `f32`
/// accumulator would lose the low bits that decide a cut position — and a cut
/// position that moves is a palette that moves.
struct Grid {
    wt: Vec<f64>,
    ml: Vec<f64>,
    ma: Vec<f64>,
    mb: Vec<f64>,
    /// Sum of `l^2 + a^2 + b^2`. Wu needs it and nothing else does.
    m2: Vec<f64>,
    lr: Vec<f64>,
    lg: Vec<f64>,
    lb: Vec<f64>,
}

impl Grid {
    fn build(pixels: &[Rgba]) -> Self {
        // Pass one establishes the bounding box; pass two bins against it.
        // Two passes and therefore two OKLab conversions per pixel, rather than
        // one pass into a cached `Vec<Oklab>` — the cache would be 12 bytes per
        // pixel, 48 MB on a 4-megapixel image, in a browser tab that is already
        // holding float buffers and an index map. Extraction runs when the user
        // asks for a palette, not per frame, so the conversion is the cheaper
        // side of that trade.
        let mut lo = Oklab {
            l: f32::INFINITY,
            a: f32::INFINITY,
            b: f32::INFINITY,
        };
        let mut hi = Oklab {
            l: f32::NEG_INFINITY,
            a: f32::NEG_INFINITY,
            b: f32::NEG_INFINITY,
        };
        for p in pixels {
            let c = linear_to_oklab(*p);
            lo.l = lo.l.min(c.l);
            lo.a = lo.a.min(c.a);
            lo.b = lo.b.min(c.b);
            hi.l = hi.l.max(c.l);
            hi.a = hi.a.max(c.a);
            hi.b = hi.b.max(c.b);
        }
        let extent = [hi.l - lo.l, hi.a - lo.a, hi.b - lo.b];

        let cells = SIDE * SIDE * SIDE;
        let mut grid = Self {
            wt: vec![0.0; cells],
            ml: vec![0.0; cells],
            ma: vec![0.0; cells],
            mb: vec![0.0; cells],
            m2: vec![0.0; cells],
            lr: vec![0.0; cells],
            lg: vec![0.0; cells],
            lb: vec![0.0; cells],
        };

        for p in pixels {
            let c = linear_to_oklab(*p);
            // Bin coordinates are 1-based; row 0 stays zero as the margin.
            let i = gidx(
                bin(c.l, lo.l, extent[0]) + 1,
                bin(c.a, lo.a, extent[1]) + 1,
                bin(c.b, lo.b, extent[2]) + 1,
            );
            let (l, a, b) = (f64::from(c.l), f64::from(c.a), f64::from(c.b));
            grid.wt[i] += 1.0;
            grid.ml[i] += l;
            grid.ma[i] += a;
            grid.mb[i] += b;
            grid.m2[i] += l * l + a * a + b * b;
            grid.lr[i] += f64::from(p.r);
            grid.lg[i] += f64::from(p.g);
            grid.lb[i] += f64::from(p.b);
        }

        grid
    }

    fn occupied(&self) -> usize {
        self.wt.iter().filter(|w| **w > 0.0).count()
    }

    /// The occupied bins, in grid order. Must be taken before [`Grid::cumulate`]
    /// turns the per-bin moments into running totals.
    fn points(&self) -> Vec<Point> {
        let mut out = Vec::new();
        for l in 1..=GRID {
            for a in 1..=GRID {
                for b in 1..=GRID {
                    let i = gidx(l, a, b);
                    let w = self.wt[i];
                    if w <= 0.0 {
                        continue;
                    }
                    out.push(Point {
                        lab: Oklab {
                            l: (self.ml[i] / w) as f32,
                            a: (self.ma[i] / w) as f32,
                            b: (self.mb[i] / w) as f32,
                        },
                        lin: [self.lr[i], self.lg[i], self.lb[i]],
                        weight: w,
                    });
                }
            }
        }
        out
    }

    /// Turn every moment into a 3D running total, in place.
    ///
    /// This is what makes Wu's quantizer affordable: afterwards the moment of
    /// any axis-aligned box is eight array reads regardless of how many bins or
    /// pixels the box contains, so scanning all 31 candidate cuts along an axis
    /// costs the same whether the box holds a hundred pixels or a million.
    fn cumulate(&mut self) {
        for m in [
            &mut self.wt,
            &mut self.ml,
            &mut self.ma,
            &mut self.mb,
            &mut self.m2,
            &mut self.lr,
            &mut self.lg,
            &mut self.lb,
        ] {
            cumulate_one(m);
        }
    }

    /// Moment of `c` by inclusion-exclusion over its eight corners.
    fn volume(&self, c: &Cube, m: &[f64]) -> f64 {
        m[gidx(c.l1, c.a1, c.b1)] - m[gidx(c.l1, c.a1, c.b0)] - m[gidx(c.l1, c.a0, c.b1)]
            + m[gidx(c.l1, c.a0, c.b0)]
            - m[gidx(c.l0, c.a1, c.b1)]
            + m[gidx(c.l0, c.a1, c.b0)]
            + m[gidx(c.l0, c.a0, c.b1)]
            - m[gidx(c.l0, c.a0, c.b0)]
    }

    /// The part of the moment below `c`'s low face on `axis`, negated — the
    /// term that combines with [`Grid::top`] to give the moment of the slab
    /// from that face up to a candidate cut.
    fn bottom(&self, c: &Cube, axis: Axis, m: &[f64]) -> f64 {
        match axis {
            Axis::L => {
                -(m[gidx(c.l0, c.a1, c.b1)] - m[gidx(c.l0, c.a1, c.b0)] - m[gidx(c.l0, c.a0, c.b1)]
                    + m[gidx(c.l0, c.a0, c.b0)])
            }
            Axis::A => {
                -(m[gidx(c.l1, c.a0, c.b1)] - m[gidx(c.l1, c.a0, c.b0)] - m[gidx(c.l0, c.a0, c.b1)]
                    + m[gidx(c.l0, c.a0, c.b0)])
            }
            Axis::B => {
                -(m[gidx(c.l1, c.a1, c.b0)] - m[gidx(c.l1, c.a0, c.b0)] - m[gidx(c.l0, c.a1, c.b0)]
                    + m[gidx(c.l0, c.a0, c.b0)])
            }
        }
    }

    /// Moment from the origin up to plane `pos` on `axis`, within `c`'s other
    /// two extents.
    fn top(&self, c: &Cube, axis: Axis, pos: usize, m: &[f64]) -> f64 {
        match axis {
            Axis::L => {
                m[gidx(pos, c.a1, c.b1)] - m[gidx(pos, c.a1, c.b0)] - m[gidx(pos, c.a0, c.b1)]
                    + m[gidx(pos, c.a0, c.b0)]
            }
            Axis::A => {
                m[gidx(c.l1, pos, c.b1)] - m[gidx(c.l1, pos, c.b0)] - m[gidx(c.l0, pos, c.b1)]
                    + m[gidx(c.l0, pos, c.b0)]
            }
            Axis::B => {
                m[gidx(c.l1, c.a1, pos)] - m[gidx(c.l1, c.a0, pos)] - m[gidx(c.l0, c.a1, pos)]
                    + m[gidx(c.l0, c.a0, pos)]
            }
        }
    }

    /// Total squared OKLab deviation of `c` from its own mean.
    fn variance(&self, c: &Cube) -> f64 {
        let w = self.volume(c, &self.wt);
        if w <= 0.0 {
            return 0.0;
        }
        let dl = self.volume(c, &self.ml);
        let da = self.volume(c, &self.ma);
        let db = self.volume(c, &self.mb);
        self.volume(c, &self.m2) - (dl * dl + da * da + db * db) / w
    }

    /// Variance, but zero for a box holding a single pixel — such a box has
    /// nothing to gain from being split and must not win the selection.
    fn split_priority(&self, c: &Cube) -> f64 {
        if self.volume(c, &self.wt) > 1.0 {
            self.variance(c)
        } else {
            0.0
        }
    }

    /// Best cut of `c` along `axis`, as `(objective, plane)`.
    ///
    /// The objective is the sum over the two halves of `|sum|^2 / weight`.
    /// Maximising it minimises the total variance of the pair, which is the
    /// same choice expressed without recomputing the constant part. `None` when
    /// no plane in range leaves pixels on both sides.
    fn maximize(
        &self,
        c: &Cube,
        axis: Axis,
        first: usize,
        last: usize,
        whole: Whole,
    ) -> Option<(f64, usize)> {
        let base_l = self.bottom(c, axis, &self.ml);
        let base_a = self.bottom(c, axis, &self.ma);
        let base_b = self.bottom(c, axis, &self.mb);
        let base_w = self.bottom(c, axis, &self.wt);

        let mut best: Option<(f64, usize)> = None;
        for pos in first..last {
            let hl = base_l + self.top(c, axis, pos, &self.ml);
            let ha = base_a + self.top(c, axis, pos, &self.ma);
            let hb = base_b + self.top(c, axis, pos, &self.mb);
            let hw = base_w + self.top(c, axis, pos, &self.wt);
            if hw <= 0.0 {
                continue;
            }
            let (tl, ta, tb, tw) = (whole.l - hl, whole.a - ha, whole.b - hb, whole.w - hw);
            if tw <= 0.0 {
                continue;
            }
            let score = (hl * hl + ha * ha + hb * hb) / hw + (tl * tl + ta * ta + tb * tb) / tw;
            // Strictly greater, so the lowest plane wins a tie and two runs
            // cannot pick different cuts.
            if best.is_none_or(|(v, _)| score > v) {
                best = Some((score, pos));
            }
        }
        best
    }

    /// Split `c` on whichever axis gains the most. `None` when it cannot be
    /// split at all — a box covering a single bin.
    fn cut(&self, c: Cube) -> Option<(Cube, Cube)> {
        let whole = Whole {
            l: self.volume(&c, &self.ml),
            a: self.volume(&c, &self.ma),
            b: self.volume(&c, &self.mb),
            w: self.volume(&c, &self.wt),
        };

        let candidates = [
            (Axis::L, self.maximize(&c, Axis::L, c.l0 + 1, c.l1, whole)),
            (Axis::A, self.maximize(&c, Axis::A, c.a0 + 1, c.a1, whole)),
            (Axis::B, self.maximize(&c, Axis::B, c.b0 + 1, c.b1, whole)),
        ];

        // Ties fall to L, then A — a fixed order, matching the reference
        // implementation's preference for the first axis it tests.
        let mut chosen: Option<(Axis, f64, usize)> = None;
        for (axis, found) in candidates {
            let Some((score, pos)) = found else {
                continue;
            };
            if chosen.is_none_or(|(_, best, _)| score > best) {
                chosen = Some((axis, score, pos));
            }
        }
        let (axis, _, pos) = chosen?;

        let mut lower = c;
        let mut upper = c;
        match axis {
            Axis::L => {
                lower.l1 = pos;
                upper.l0 = pos;
            }
            Axis::A => {
                lower.a1 = pos;
                upper.a0 = pos;
            }
            Axis::B => {
                lower.b1 = pos;
                upper.b0 = pos;
            }
        }
        Some((lower, upper))
    }

    /// Linear-light mean colour of `c`.
    fn representative(&self, c: &Cube) -> Rgba {
        let w = self.volume(c, &self.wt);
        assert!(
            w > 0.0,
            "an empty box reached palette construction; every accepted cut \
             leaves pixels on both sides, so this means the moments are wrong"
        );
        Rgba::new(
            (self.volume(c, &self.lr) / w) as f32,
            (self.volume(c, &self.lg) / w) as f32,
            (self.volume(c, &self.lb) / w) as f32,
            1.0,
        )
    }
}

/// A box of bins. `*0` is the exclusive low face and `*1` the inclusive high
/// face, the convention the cumulative moments' zero margin is built for.
#[derive(Clone, Copy, Debug, Default)]
struct Cube {
    l0: usize,
    l1: usize,
    a0: usize,
    a1: usize,
    b0: usize,
    b1: usize,
}

/// The moments of a whole box, hoisted out of the per-plane loop.
#[derive(Clone, Copy)]
struct Whole {
    l: f64,
    a: f64,
    b: f64,
    w: f64,
}

fn cumulate_one(m: &mut [f64]) {
    for l in 1..=GRID {
        let mut area = [0.0f64; SIDE];
        for a in 1..=GRID {
            let mut line = 0.0f64;
            for b in 1..=GRID {
                line += m[gidx(l, a, b)];
                area[b] += line;
                m[gidx(l, a, b)] = m[gidx(l - 1, a, b)] + area[b];
            }
        }
    }
}

#[inline]
fn bin(v: f32, lo: f32, extent: f32) -> usize {
    if extent <= 0.0 {
        // A flat axis: every pixel shares one bin, which is the truthful answer
        // rather than a special case bolted on.
        return 0;
    }
    (((v - lo) / extent * GRID as f32) as usize).min(GRID - 1)
}

/// Wu's moment-based quantizer.
fn wu(grid: &mut Grid, k: usize) -> Vec<Rgba> {
    grid.cumulate();

    let mut cubes = vec![Cube::default(); k];
    cubes[0] = Cube {
        l0: 0,
        l1: GRID,
        a0: 0,
        a1: GRID,
        b0: 0,
        b1: GRID,
    };
    let mut priority = vec![0.0f64; k];
    let mut count = 1usize;
    let mut next = 0usize;

    while count < k {
        match grid.cut(cubes[next]) {
            Some((lower, upper)) => {
                cubes[next] = lower;
                cubes[count] = upper;
                priority[next] = grid.split_priority(&lower);
                priority[count] = grid.split_priority(&upper);
                count += 1;
            }
            // Indivisible: one bin. Take it out of contention rather than
            // retrying it forever.
            None => priority[next] = 0.0,
        }

        let mut best = 0usize;
        let mut best_p = priority[0];
        for (j, p) in priority.iter().enumerate().take(count).skip(1) {
            if *p > best_p {
                best_p = *p;
                best = j;
            }
        }
        if best_p <= 0.0 {
            // Nothing left worth splitting: the image has fewer separable
            // colour regions than `k`.
            break;
        }
        next = best;
    }

    cubes[..count]
        .iter()
        .map(|c| grid.representative(c))
        .collect()
}

/// Heckbert's median cut.
fn median_cut(points: &[Point], k: usize) -> Outcome {
    // `order` is permuted in place; a box owns the contiguous run
    // `order[start..end]`, so splitting one is a sort of that run plus a
    // boundary, and no box ever copies its members.
    let mut order: Vec<usize> = (0..points.len()).collect();
    let mut boxes = vec![MedianBox {
        start: 0,
        end: points.len(),
        weight: points.iter().map(|p| p.weight).sum(),
    }];

    while boxes.len() < k {
        // The textbook rule: split whichever box holds the most pixels, so
        // palette slots go where the picture is. Ties break on the lower box
        // index, which makes the whole run reproducible.
        let mut chosen: Option<(usize, f64)> = None;
        for (i, b) in boxes.iter().enumerate() {
            if b.end - b.start < 2 {
                continue;
            }
            if chosen.is_none_or(|(_, w)| b.weight > w) {
                chosen = Some((i, b.weight));
            }
        }
        let Some((bi, total)) = chosen else {
            // Every box is a single bin. Splitting further would mean inventing
            // a colour the image does not contain.
            break;
        };
        let (start, end) = (boxes[bi].start, boxes[bi].end);

        let axis = longest_axis(points, &order[start..end]);
        order[start..end].sort_unstable_by(|&x, &y| {
            coord(points[x].lab, axis)
                .total_cmp(&coord(points[y].lab, axis))
                .then(x.cmp(&y))
        });

        // Split at the weighted median, so the two halves carry a similar share
        // of the image rather than a similar number of distinct colours.
        let mut acc = 0.0f64;
        let mut split = end - 1;
        for i in start..(end - 1) {
            acc += points[order[i]].weight;
            if acc * 2.0 >= total {
                split = i + 1;
                break;
            }
        }

        boxes[bi] = MedianBox {
            start,
            end: split,
            weight: order[start..split].iter().map(|&i| points[i].weight).sum(),
        };
        boxes.push(MedianBox {
            start: split,
            end,
            weight: order[split..end].iter().map(|&i| points[i].weight).sum(),
        });
    }

    let colors = boxes
        .iter()
        .map(|b| {
            let members = &order[b.start..b.end];
            let mut lin = [0.0f64; 3];
            let mut w = 0.0f64;
            for &i in members {
                lin[0] += points[i].lin[0];
                lin[1] += points[i].lin[1];
                lin[2] += points[i].lin[2];
                w += points[i].weight;
            }
            assert!(w > 0.0, "median cut produced an empty box");
            Rgba::new(
                (lin[0] / w) as f32,
                (lin[1] / w) as f32,
                (lin[2] / w) as f32,
                1.0,
            )
        })
        .collect();

    Outcome::single_pass(colors)
}

/// A run of `order`, plus the pixel count it covers.
#[derive(Clone, Copy, Debug)]
struct MedianBox {
    start: usize,
    end: usize,
    weight: f64,
}

fn longest_axis(points: &[Point], members: &[usize]) -> Axis {
    let mut lo = [f32::INFINITY; 3];
    let mut hi = [f32::NEG_INFINITY; 3];
    for &i in members {
        let c = points[i].lab;
        for (axis, v) in [c.l, c.a, c.b].into_iter().enumerate() {
            lo[axis] = lo[axis].min(v);
            hi[axis] = hi[axis].max(v);
        }
    }
    let extent = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    // Compared without weighting because OKLab is built so that a unit step
    // means the same size of perceived change on every axis; that is the whole
    // reason the partitioning happens in it.
    if extent[0] >= extent[1] && extent[0] >= extent[2] {
        Axis::L
    } else if extent[1] >= extent[2] {
        Axis::A
    } else {
        Axis::B
    }
}

/// Lloyd's algorithm in OKLab, seeded by k-means++ from the document seed.
fn kmeans(points: &[Point], k: usize, seed: u64, max_iterations: u32) -> Outcome {
    let mut centres = kmeans_pp_init(points, k, seed);
    let mut assign = vec![usize::MAX; points.len()];
    let mut iterations = 0u32;
    let mut empty_cluster_repairs = 0u32;

    for _ in 0..max_iterations {
        iterations += 1;

        let mut changed = false;
        for (i, p) in points.iter().enumerate() {
            let best = nearest_centre(p.lab, &centres);
            if assign[i] != best {
                assign[i] = best;
                changed = true;
            }
        }
        if !changed {
            break;
        }

        // New centres in OKLab, because that is the space the assignment step
        // measures in; moving them anywhere else would break the guarantee that
        // each iteration lowers the objective. The linear-light means that
        // become the actual palette are taken once, at the end.
        let sums = accumulate_oklab(points, &assign, centres.len());
        for (j, s) in sums.iter().enumerate() {
            if s[3] > 0.0 {
                centres[j] = Oklab {
                    l: (s[0] / s[3]) as f32,
                    a: (s[1] / s[3]) as f32,
                    b: (s[2] / s[3]) as f32,
                };
            }
        }

        // A centre can lose every point. Leaving it where it is wastes a
        // palette entry, so it moves to the point currently fitting worst —
        // chosen by distance, not by a draw, so the repair is as reproducible
        // as the rest of the run.
        let mut taken: Vec<usize> = Vec::new();
        for (j, s) in sums.iter().enumerate() {
            if s[3] > 0.0 {
                continue;
            }
            let mut worst: Option<(f64, usize)> = None;
            for (i, p) in points.iter().enumerate() {
                if taken.contains(&i) {
                    continue;
                }
                let cost = f64::from(oklab_distance_sq(p.lab, centres[assign[i]])) * p.weight;
                if worst.is_none_or(|(c, _)| cost > c) {
                    worst = Some((cost, i));
                }
            }
            if let Some((_, i)) = worst {
                centres[j] = points[i].lab;
                taken.push(i);
                empty_cluster_repairs += 1;
            }
        }
    }

    // One last assignment, so the returned colours are the means of the
    // clusters these centres actually describe. Without it a run that stopped
    // on `max_iterations` would report means for the assignment before the
    // final centre move.
    for (i, p) in points.iter().enumerate() {
        assign[i] = nearest_centre(p.lab, &centres);
    }

    let mut lin = vec![[0.0f64; 4]; centres.len()];
    for (i, p) in points.iter().enumerate() {
        let s = &mut lin[assign[i]];
        s[0] += p.lin[0];
        s[1] += p.lin[1];
        s[2] += p.lin[2];
        s[3] += p.weight;
    }

    let mut colors = Vec::with_capacity(centres.len());
    let mut empty_clusters_dropped = 0u32;
    for s in &lin {
        if s[3] > 0.0 {
            colors.push(Rgba::new(
                (s[0] / s[3]) as f32,
                (s[1] / s[3]) as f32,
                (s[2] / s[3]) as f32,
                1.0,
            ));
        } else {
            empty_clusters_dropped += 1;
        }
    }
    assert!(
        !colors.is_empty(),
        "k-means ended with no populated cluster, which cannot happen for a \
         non-empty image"
    );

    Outcome {
        colors,
        iterations,
        empty_cluster_repairs,
        empty_clusters_dropped,
    }
}

/// Weighted OKLab sums per cluster, plus the cluster weight in slot 3.
fn accumulate_oklab(points: &[Point], assign: &[usize], clusters: usize) -> Vec<[f64; 4]> {
    let mut sums = vec![[0.0f64; 4]; clusters];
    for (i, p) in points.iter().enumerate() {
        let s = &mut sums[assign[i]];
        s[0] += f64::from(p.lab.l) * p.weight;
        s[1] += f64::from(p.lab.a) * p.weight;
        s[2] += f64::from(p.lab.b) * p.weight;
        s[3] += p.weight;
    }
    sums
}

/// k-means++ seeding: first centre proportional to weight, each subsequent one
/// proportional to weight times squared distance to the nearest centre so far.
///
/// The initialisation is the only stochastic part of the extraction, which is
/// why it takes the document seed and its own named stream rather than sharing
/// a generator with anything else.
fn kmeans_pp_init(points: &[Point], k: usize, seed: u64) -> Vec<Oklab> {
    let mut rng = Pcg32::new(seed, stream_of("palette-kmeans-init"));

    let weights: Vec<f64> = points.iter().map(|p| p.weight).collect();
    let first = weighted_pick(&weights, &mut rng)
        .expect("every occupied bin holds at least one pixel, so the weights sum above zero");

    let mut centres = Vec::with_capacity(k.min(points.len()));
    centres.push(points[first].lab);

    let mut d2: Vec<f64> = points
        .iter()
        .map(|p| f64::from(oklab_distance_sq(p.lab, points[first].lab)))
        .collect();

    while centres.len() < k {
        let spread: Vec<f64> = points.iter().zip(&d2).map(|(p, d)| p.weight * d).collect();
        let Some(pick) = weighted_pick(&spread, &mut rng) else {
            // Every point already sits on a centre: the image has fewer
            // distinct colours than `k`. Stopping here is the honest answer;
            // padding the palette would mean adding colours the image does not
            // contain.
            break;
        };
        let chosen = points[pick].lab;
        centres.push(chosen);
        for (d, p) in d2.iter_mut().zip(points) {
            *d = d.min(f64::from(oklab_distance_sq(p.lab, chosen)));
        }
    }

    centres
}

/// Sample an index with probability proportional to `weights`. `None` when
/// every weight is zero, which is a real outcome for the k-means++ spread and
/// not an error.
fn weighted_pick(weights: &[f64], rng: &mut Pcg32) -> Option<usize> {
    let total: f64 = weights.iter().sum();
    if total <= 0.0 {
        return None;
    }

    let target = f64::from(rng.next_f32()) * total;
    let mut acc = 0.0f64;
    for (i, w) in weights.iter().enumerate() {
        acc += w;
        if acc > target {
            return Some(i);
        }
    }

    // Unreachable today: `acc` retraces the same additions in the same order as
    // `total`, and `next_f32` is strictly below 1.0, so some prefix always
    // exceeds `target`. Kept so that a later change to either cannot turn a
    // rounding edge into a wrong index.
    weights.iter().rposition(|w| *w > 0.0)
}

fn nearest_centre(c: Oklab, centres: &[Oklab]) -> usize {
    let mut best = 0usize;
    let mut best_d = f32::INFINITY;
    for (i, k) in centres.iter().enumerate() {
        let d = oklab_distance_sq(c, *k);
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::srgb_to_linear;

    const METHODS: [Method; 3] = [Method::MedianCut, Method::Wu, Method::KMeans];

    /// A deterministic test image with a few thousand distinct colours.
    fn gradient(w: usize, h: usize) -> Vec<Rgba> {
        let mut out = Vec::with_capacity(w * h);
        for y in 0..h {
            for x in 0..w {
                let fx = x as f32 / (w - 1) as f32;
                let fy = y as f32 / (h - 1) as f32;
                out.push(Rgba::new(
                    srgb_to_linear(fx),
                    srgb_to_linear(fy),
                    srgb_to_linear(1.0 - fx * fy),
                    1.0,
                ));
            }
        }
        out
    }

    fn opts(method: Method, k: usize) -> Options {
        Options {
            method,
            k,
            seed: 0x5eed_1234,
            max_iterations: 64,
        }
    }

    /// Determinism is the property the whole project is built on: same
    /// document, same seed, same build, byte-identical output. An extraction
    /// that drifted would move every downstream pixel.
    #[test]
    fn every_method_reproduces_itself_exactly() {
        let src = gradient(64, 48);
        for method in METHODS {
            let a = extract(&src, opts(method, 16));
            let b = extract(&src, opts(method, 16));
            assert_eq!(a.palette.colors(), b.palette.colors(), "{method:?} palette");
            assert_eq!(a.indices, b.indices, "{method:?} indices");
            assert_eq!(a.populations, b.populations, "{method:?} populations");
        }
    }

    /// k-means is the one method that draws from the RNG, so the seed has to be
    /// what decides the draw — not a hidden source of entropy.
    #[test]
    fn kmeans_seeding_comes_only_from_the_seed() {
        let src = gradient(48, 48);
        let grid = Grid::build(&src);
        let points = grid.points();

        let a = kmeans_pp_init(&points, 8, 1);
        let again = kmeans_pp_init(&points, 8, 1);
        let other = kmeans_pp_init(&points, 8, 2);

        assert_eq!(a.len(), 8);
        assert_eq!(a, again, "one seed must always give one seeding");
        assert_ne!(a, other, "a different seed must give a different seeding");
    }

    #[test]
    fn every_method_reduces_to_exactly_k_colors() {
        let src = gradient(64, 64);
        for method in METHODS {
            for k in [2usize, 4, 16, 64] {
                let q = extract(&src, opts(method, k));
                assert_eq!(q.palette.len(), k, "{method:?} at k={k}");
                assert_eq!(q.report.palette_len, k);
                assert!(q.report.occupied_bins >= k);
            }
        }
    }

    #[test]
    fn the_index_map_is_nearest_matching_against_the_returned_palette() {
        let src = gradient(32, 32);
        for method in METHODS {
            let q = extract(&src, opts(method, 12));
            assert_eq!(q.indices.len(), src.len());
            for (i, p) in src.iter().enumerate() {
                let want = q.palette.nearest(*p, Metric::Oklab);
                assert_eq!(usize::from(q.indices[i]), want, "{method:?} pixel {i}");
            }
        }
    }

    #[test]
    fn populations_account_for_every_pixel() {
        let src = gradient(40, 30);
        for method in METHODS {
            let q = extract(&src, opts(method, 8));
            assert_eq!(q.populations.len(), q.palette.len());
            let total: u32 = q.populations.iter().sum();
            assert_eq!(total as usize, src.len(), "{method:?}");
        }
    }

    #[test]
    fn a_flat_image_extracts_the_one_colour_it_has() {
        let level = srgb_to_linear(0.5);
        let src = vec![Rgba::new(level, level, level, 1.0); 256];
        for method in METHODS {
            let q = extract(&src, opts(method, 8));
            assert_eq!(q.palette.len(), 1, "{method:?}");
            assert_eq!(q.report.occupied_bins, 1);
            let c = q.palette.color(0);
            assert!((c.r - level).abs() < 1e-5, "{method:?} got {c:?}");
            assert!(q.indices.iter().all(|&i| i == 0));
        }
    }

    /// Four exact colours, four requested: the extraction must return those
    /// four and not four averages of them. This is what catches a
    /// representative colour taken from a bin centre instead of from the pixels
    /// in the bin.
    #[test]
    fn an_image_of_k_colours_comes_back_as_those_k_colours() {
        let sources = [
            Rgba::new(0.0, 0.0, 0.0, 1.0),
            Rgba::new(0.8, 0.05, 0.05, 1.0),
            Rgba::new(0.05, 0.7, 0.1, 1.0),
            Rgba::new(0.1, 0.1, 0.9, 1.0),
        ];
        let mut src = Vec::new();
        for _ in 0..64 {
            src.extend_from_slice(&sources);
        }

        for method in METHODS {
            let q = extract(&src, opts(method, 4));
            assert_eq!(q.palette.len(), 4, "{method:?}");
            for want in sources {
                let found = q.palette.colors().iter().any(|c| {
                    (c.r - want.r).abs() < 1e-4
                        && (c.g - want.g).abs() < 1e-4
                        && (c.b - want.b).abs() < 1e-4
                });
                assert!(found, "{method:?} lost {want:?}: {:?}", q.palette.colors());
            }
        }
    }

    /// An image with four colours has no fifth to extract. The palette comes
    /// back short and the report says why, rather than the palette being padded
    /// with colours that are not in the picture.
    #[test]
    fn asking_for_more_colours_than_the_image_holds_returns_what_is_there() {
        let sources = [
            Rgba::new(0.0, 0.0, 0.0, 1.0),
            Rgba::new(0.9, 0.0, 0.0, 1.0),
            Rgba::new(0.0, 0.9, 0.0, 1.0),
            Rgba::new(1.0, 1.0, 1.0, 1.0),
        ];
        let mut src = Vec::new();
        for _ in 0..32 {
            src.extend_from_slice(&sources);
        }

        for method in METHODS {
            let q = extract(&src, opts(method, 32));
            assert_eq!(q.report.requested_k, 32);
            assert_eq!(q.report.occupied_bins, 4, "{method:?}");
            assert_eq!(q.palette.len(), 4, "{method:?}");
        }
    }

    #[test]
    fn quantizing_preserves_average_light() {
        // The colour-correctness claim, applied to extraction: a two-colour
        // palette taken from a linear ramp and mapped back must land close to
        // the ramp's own mean. It fails if the representative colours are
        // averaged anywhere other than linear light.
        let n = 512;
        let src: Vec<Rgba> = (0..n)
            .map(|i| {
                let v = srgb_to_linear(i as f32 / (n - 1) as f32);
                Rgba::new(v, v, v, 1.0)
            })
            .collect();
        let want: f32 = src.iter().map(|p| p.r).sum::<f32>() / n as f32;

        for method in METHODS {
            let q = extract(&src, opts(method, 2));
            let got: f32 = q
                .indices
                .iter()
                .map(|&i| q.palette.color(usize::from(i)).r)
                .sum::<f32>()
                / n as f32;
            assert!((got - want).abs() < 0.03, "{method:?}: {got} vs {want}");
        }
    }

    #[test]
    fn population_counts_drive_a_palette_sort() {
        use crate::palette::SortKey;

        let src = gradient(32, 32);
        let q = extract(&src, opts(Method::Wu, 8));
        let order = q.palette.sort_order(SortKey::Population(&q.populations));
        let counts: Vec<u32> = order.iter().map(|&i| q.populations[i]).collect();
        assert!(counts.windows(2).all(|w| w[0] >= w[1]), "{counts:?}");
    }

    #[test]
    fn default_options_are_a_usable_extraction() {
        let src = gradient(24, 24);
        let q = extract(&src, Options::default());
        assert_eq!(q.report.method, Method::Wu);
        assert_eq!(q.palette.len(), 16);
    }

    #[test]
    #[should_panic(expected = "cannot extract a palette from an empty image")]
    fn an_empty_image_panics_rather_than_returning_an_empty_palette() {
        extract(&[], Options::default());
    }

    #[test]
    #[should_panic(expected = "palette size must be at least 1")]
    fn a_zero_size_palette_panics() {
        let src = gradient(4, 4);
        extract(&src, opts(Method::Wu, 0));
    }

    #[test]
    #[should_panic(expected = "k-means needs at least one iteration")]
    fn zero_iterations_panics() {
        let src = gradient(4, 4);
        extract(
            &src,
            Options {
                method: Method::KMeans,
                k: 4,
                seed: 1,
                max_iterations: 0,
            },
        );
    }
}
