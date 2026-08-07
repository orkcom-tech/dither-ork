//! Vector tracing of an index map to SVG (F-EX-08, F-EX-09, F-EX-10).
//!
//! This is the reason the render graph carries an index map alongside colour at
//! all. Tracing a *raster* means guessing where one colour ends and the next
//! begins; tracing an index map means reading it. Every boundary this module
//! emits sits on an integer pixel corner, so two colours that share an edge in
//! the image share the identical coordinates in the output and there is no
//! seam — not a hairline, not a half-pixel overlap, nothing. A tracer that got
//! this wrong would look correct on screen and cut wrong on a machine.
//!
//! ## The pipeline
//!
//! `index map -> per-colour binary mask -> run-length runs + union-find ->
//! minimum-feature filter -> boundary extraction -> path union`.
//!
//! Each palette colour is traced independently and completely. That is what
//! makes the per-colour groups of F-EX-08/F-EX-10 real layers rather than a
//! presentation trick: nothing a cutter does to one layer can disturb another,
//! because the geometry of one colour was never derived from another's.
//!
//! ## Why outlines and not rectangles
//!
//! An earlier sketch of this stage emitted the run-length rectangles directly,
//! one subpath per run. That decomposition cannot express a hole — a rectangle
//! tiling has no inside to leave empty — and it is unusable for the machines
//! this feature exists for: stroke a rectangle tiling and a cutter follows every
//! internal rectangle edge, so a single filled region comes out as a grid of
//! cuts. Both modes therefore emit region **outlines**. Pixel-perfect emits the
//! exact staircase along pixel corners; simplified runs Douglas-Peucker over
//! that same staircase. The run-length + union-find pass is still here and still
//! load-bearing — it is what identifies connected regions and their areas, which
//! is what the minimum-feature filter of F-EX-10 needs.
//!
//! ## Coordinates and winding
//!
//! Pixel `(x, y)` occupies the square `[x, x+1] x [y, y+1]`, y downwards, which
//! is SVG's own convention and the image's row order. All emitted coordinates
//! are integers: the walker only ever visits pixel corners, and Douglas-Peucker
//! *selects* vertices rather than inventing them, so even simplified output
//! stays exactly on the pixel grid. There is nowhere for a half-pixel error to
//! come from.
//!
//! Boundary edges are oriented so the filled region is always on the right of
//! travel. That single rule gives outer contours a positive signed area and
//! holes a negative one, which is the winding a non-zero fill rule needs to
//! leave a hole empty instead of solid. `fill-rule="evenodd"` is also set, so
//! the output is right under either rule — a consumer that reorders or reverses
//! subpaths still gets the hole.
//!
//! Foreground regions are 4-connected and background 8-connected. That pairing
//! is the one that keeps the Jordan property on a square lattice: two pixels
//! touching only at a corner are two shapes, and the contour makes a tight turn
//! around each rather than one figure-eight that touches itself. To a cutter or
//! a needle they *are* two shapes.
//!
//! Nothing here logs. `dither-core` has no logger and must not grow one, so
//! everything an operation log would want to say travels back in [`Report`],
//! exactly as `quantize::Report` does.

use std::fmt::Write as _;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/// The two output modes of F-EX-09.
///
/// The tolerance rides inside the variant rather than sitting beside it in
/// [`Options`] because a tolerance that applies to only one of two modes is a
/// field that is meaningless half the time, and a meaningless field gets set and
/// then wondered about. `dither-wasm` flattens this for the boundary, where the
/// binding generator cannot carry data in an enum.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode {
    /// The exact pixel staircase. Rasterizing the result at 1:1 reproduces the
    /// index map cell for cell.
    PixelPerfect,
    /// Douglas-Peucker over the staircase, `tolerance` in pixels. Vertices are
    /// dropped, never moved, so the surviving points are still pixel corners.
    Simplified { tolerance: f32 },
}

/// Everything the tracer takes, as one object.
///
/// Same reasoning as `diffusion::Options`: this set only grows, and a call site
/// with five bare positionals of which two are floats is one transposition away
/// from silently exporting with the wrong tolerance.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Options {
    pub mode: Mode,
    /// Minimum-feature-size filter of F-EX-10, in whole pixels of area.
    ///
    /// Connected regions smaller than this are removed, and enclosed holes
    /// smaller than this are filled, **before** anything is traced. A value of
    /// 0 or 1 is a no-op without a special case, because no region has an area
    /// below 1. This is the difference between output a machine can use and a
    /// hundred thousand specks.
    pub min_feature_area: u32,
    /// Emit outlines only — `fill="none"` plus a stroke — for cutting and
    /// embroidery paths (F-EX-10).
    pub stroke_only: bool,
    /// Stroke width in pixel units. Only read when `stroke_only` is set.
    pub stroke_width: f32,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            mode: Mode::PixelPerfect,
            min_feature_area: 0,
            stroke_only: false,
            stroke_width: 1.0,
        }
    }
}

/// One closed subpath: an outer region boundary or the boundary of a hole
/// inside one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Contour {
    points: Vec<[i32; 2]>,
    area2: i64,
}

impl Contour {
    /// The vertices, in traversal order and without a repeated closing point —
    /// `Z` closes the subpath. Always pixel corners.
    pub fn points(&self) -> &[[i32; 2]] {
        &self.points
    }

    /// Twice the signed area, exactly. Twice, and integer, so it is exact: the
    /// hole test is a sign test and must not be decided by a rounding error.
    pub fn signed_area2(&self) -> i64 {
        self.area2
    }

    /// Whether this contour bounds a hole rather than a region.
    pub fn is_hole(&self) -> bool {
        self.area2 < 0
    }
}

/// Every contour of one palette colour. Becomes one `<g>` in the output.
#[derive(Clone, Debug)]
pub struct Layer {
    palette_index: u16,
    srgb: [u8; 3],
    contours: Vec<Contour>,
}

impl Layer {
    pub fn palette_index(&self) -> u16 {
        self.palette_index
    }

    /// The layer's colour as 8-bit sRGB. This is what names the group.
    pub fn srgb(&self) -> [u8; 3] {
        self.srgb
    }

    pub fn contours(&self) -> &[Contour] {
        &self.contours
    }
}

/// What the trace actually did.
///
/// Carried back rather than logged, because `dither-core` has no logger; the
/// `dither-wasm` boundary emits it. The dropped counts are the ones that matter
/// to a person: they are the difference between "the tracer lost my detail" and
/// "the minimum feature size you asked for removed 412 specks".
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Report {
    /// Palette colours that produced geometry. A colour absent from the index
    /// map produces no group at all rather than an empty one.
    pub layers: usize,
    pub contours: usize,
    /// Total emitted vertices. The input to a pre-export size estimate.
    pub points: usize,
    /// Connected regions removed by [`Options::min_feature_area`].
    pub regions_dropped: u32,
    /// Pixels those regions covered, summed over every colour.
    ///
    /// **Not** the area the output leaves bare, and the difference is large in
    /// practice: a pixel dropped from one colour is usually picked back up by
    /// the hole fill of whichever colour surrounded it. Use
    /// [`Report::uncovered_pixels`] for the number a person wants.
    pub region_pixels_dropped: u64,
    /// Enclosed holes filled in by [`Options::min_feature_area`].
    pub holes_filled: u32,
    /// Pixels those holes covered, summed over every colour.
    pub hole_pixels_filled: u64,
    /// Contours that Douglas-Peucker collapsed below three distinct points, or
    /// to zero area, and which were therefore dropped rather than emitted as a
    /// degenerate subpath. Non-zero means the tolerance is eating features.
    pub contours_dropped: u32,
}

impl Report {
    /// Pixels of the source that no emitted layer covers.
    ///
    /// Every pixel starts under exactly one colour, so the only way to lose one
    /// is [`Options::min_feature_area`] dropping the region it was in, and the
    /// only way to regain it is another colour's hole fill. The subtraction is
    /// therefore exact, and it needs two facts that are worth stating because
    /// neither is obvious:
    ///
    /// *No pixel is filled twice.* For two colours to both fill a pixel `p`,
    /// `p`'s background component would have to be enclosed by each of them —
    /// but the ring of colour `b` enclosing one component is itself non-`c`, so
    /// it belongs to the other component, and each component would have to
    /// strictly contain the other. It cannot.
    ///
    /// *Every filled pixel was dropped.* A region sitting inside an enclosed
    /// pocket cannot cross the pocket's wall, so it is a subset of the pocket
    /// and no larger. If the pocket was under the threshold, that region was
    /// too, and it went in the first pass.
    pub fn uncovered_pixels(&self) -> u64 {
        self.region_pixels_dropped - self.hole_pixels_filled
    }
}

/// A traced index map, ready to render as SVG.
#[derive(Clone, Debug)]
pub struct Traced {
    width: usize,
    height: usize,
    options: Options,
    layers: Vec<Layer>,
    report: Report,
}

impl Traced {
    pub fn width(&self) -> usize {
        self.width
    }

    pub fn height(&self) -> usize {
        self.height
    }

    /// One per palette colour present in the index map, in ascending palette
    /// order. Deterministic, because a `.dork` document that re-exports must
    /// produce a byte-identical file.
    pub fn layers(&self) -> &[Layer] {
        &self.layers
    }

    pub fn report(&self) -> &Report {
        &self.report
    }

    /// Render to an SVG document.
    ///
    /// Every group carries the Inkscape layer attributes as well as being a
    /// plain `<g>`. F-EX-10 asks for per-colour groups *as separate layers*, and
    /// a bare `<g>` is a group — Inkscape, Lightburn and the cutter front-ends
    /// that read SVG only see a layer when those two attributes are present.
    /// They are inert everywhere else.
    ///
    /// Nothing emitted here is caller-supplied text: coordinates are integers
    /// and colours are six hex digits, so there is nothing to escape and no way
    /// to inject markup through a palette.
    pub fn to_svg(&self) -> String {
        // Roughly eight bytes a point plus the group scaffolding. Overshooting
        // once beats growing a multi-megabyte string a dozen times.
        let mut out = String::with_capacity(self.report.points * 8 + self.layers.len() * 200 + 256);

        out.push_str(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" \
             xmlns:inkscape=\"http://www.inkscape.org/namespaces/inkscape\"",
        );
        let _ = write!(
            out,
            " width=\"{}\" height=\"{}\" viewBox=\"0 0 {} {}\"",
            self.width, self.height, self.width, self.height
        );
        if self.options.mode == Mode::PixelPerfect {
            // Pixel-perfect promises that rasterizing at 1:1 reproduces the
            // index map. Anti-aliasing along a region edge would blend two
            // colours into a pixel that had exactly one, and break that promise.
            // Simplified mode has genuine diagonals and wants the anti-aliasing.
            out.push_str(" shape-rendering=\"crispEdges\"");
        }
        out.push_str(">\n");

        for layer in &self.layers {
            let hex = hex6(layer.srgb);
            let _ = write!(
                out,
                "<g id=\"colour-{}-{}\" inkscape:groupmode=\"layer\" inkscape:label=\"#{}\" \
                 data-palette-index=\"{}\"",
                layer.palette_index, hex, hex, layer.palette_index
            );
            if self.options.stroke_only {
                let _ = write!(
                    out,
                    " fill=\"none\" stroke=\"#{}\" stroke-width=\"{}\"",
                    hex, self.options.stroke_width
                );
            } else {
                // Correct winding is emitted regardless; even-odd is stated as
                // well so a hole stays a hole even for a consumer that reorders
                // or reverses subpaths on its way through.
                let _ = write!(out, " fill=\"#{hex}\" fill-rule=\"evenodd\"");
            }
            out.push_str("><path d=\"");
            // One path per colour, every contour a subpath of it — the "path
            // union" of the documented pipeline. Splitting holes into their own
            // <path> would fill them solid under any fill rule.
            for contour in &layer.contours {
                append_subpath(&mut out, &contour.points);
            }
            out.push_str("\"/></g>\n");
        }

        out.push_str("</svg>\n");
        out
    }
}

/// Trace an index map to vector geometry (F-EX-08).
///
/// * `indices` — one palette index per pixel, row-major, `width * height` long.
/// * `palette_srgb` — packed 8-bit sRGB triplets, the same layout the rest of
///   this crate and the `.dork` document already use.
///
/// # Panics
///
/// On any caller error: empty dimensions, an index map whose length disagrees
/// with them, a palette that is not a non-empty multiple of three bytes, a
/// palette too large for a `u16` index, an index that names no palette entry, a
/// non-positive or non-finite simplification tolerance, or a non-positive stroke
/// width when stroke-only output was asked for. Each of those is a bug at the
/// call site with no defensible answer, so it is stated rather than worked
/// around — `dither-wasm` checks the same conditions first and turns them into
/// JS errors, which is the arrangement every other entry point here uses.
pub fn trace(
    indices: &[u16],
    width: usize,
    height: usize,
    palette_srgb: &[u8],
    options: Options,
) -> Traced {
    assert!(
        width > 0 && height > 0,
        "image dimensions must both be positive, got {width}x{height}"
    );
    assert_eq!(
        indices.len(),
        width * height,
        "index map length does not match {width}x{height}"
    );
    assert!(
        !palette_srgb.is_empty() && palette_srgb.len().is_multiple_of(3),
        "palette must be a non-empty multiple of 3 bytes, got {}",
        palette_srgb.len()
    );
    let entries = palette_srgb.len() / 3;
    assert!(
        entries <= usize::from(u16::MAX) + 1,
        "palette of {entries} entries does not fit a u16 index map"
    );
    if let Mode::Simplified { tolerance } = options.mode {
        assert!(
            tolerance.is_finite() && tolerance > 0.0,
            "simplification tolerance must be finite and positive, got {tolerance}"
        );
    }
    if options.stroke_only {
        assert!(
            options.stroke_width.is_finite() && options.stroke_width > 0.0,
            "stroke width must be finite and positive, got {}",
            options.stroke_width
        );
    }

    // One pass to learn which colours are actually in the image. Without it a
    // 256-entry palette over a two-colour picture would build 254 empty masks,
    // each a full sweep of the index map.
    let mut present = vec![false; entries];
    for &i in indices {
        let i = usize::from(i);
        assert!(
            i < entries,
            "index {i} names no entry in a palette of {entries}"
        );
        present[i] = true;
    }

    let mut report = Report::default();
    let mut layers: Vec<Layer> = Vec::new();
    let mut mask = vec![false; width * height];

    for (c, &is_present) in present.iter().enumerate() {
        if !is_present {
            continue;
        }
        let index = c as u16;
        for (m, &i) in mask.iter_mut().zip(indices) {
            *m = i == index;
        }

        if options.min_feature_area > 1 {
            apply_min_feature(
                &mut mask,
                width,
                height,
                options.min_feature_area,
                &mut report,
            );
        }

        let mut contours = extract_contours(&mask, width, height);
        if let Mode::Simplified { tolerance } = options.mode {
            contours = simplify(contours, f64::from(tolerance), &mut report);
        }
        if contours.is_empty() {
            // Every pixel of this colour was below the minimum feature size.
            // Reported, not silent: `regions_dropped` already counted them.
            continue;
        }

        report.contours += contours.len();
        report.points += contours.iter().map(|c| c.points.len()).sum::<usize>();
        layers.push(Layer {
            palette_index: index,
            srgb: [
                palette_srgb[c * 3],
                palette_srgb[c * 3 + 1],
                palette_srgb[c * 3 + 2],
            ],
            contours,
        });
    }

    report.layers = layers.len();
    Traced {
        width,
        height,
        options,
        layers,
        report,
    }
}

// ---------------------------------------------------------------------------
// Minimum feature size (F-EX-10)
// ---------------------------------------------------------------------------

/// A maximal horizontal span of equal mask values in one row. `x1` is exclusive.
struct Run {
    y: usize,
    x0: usize,
    x1: usize,
}

/// Runs of `value` in `mask`, row-major, plus the `h + 1` row boundaries into
/// them.
///
/// Run-length is the right shape for this because the two things that follow —
/// union-find labelling and the area sum — both work per run rather than per
/// pixel, so a flat field costs one entry per row instead of one per pixel.
fn runs_of(mask: &[bool], w: usize, h: usize, value: bool) -> (Vec<Run>, Vec<usize>) {
    let mut runs = Vec::new();
    let mut row_start = Vec::with_capacity(h + 1);
    for y in 0..h {
        row_start.push(runs.len());
        let row = &mask[y * w..(y + 1) * w];
        let mut x = 0;
        while x < w {
            if row[x] == value {
                let x0 = x;
                while x < w && row[x] == value {
                    x += 1;
                }
                runs.push(Run { y, x0, x1: x });
            } else {
                x += 1;
            }
        }
    }
    row_start.push(runs.len());
    (runs, row_start)
}

/// Union-find over run indices.
///
/// The smaller index always wins the union, so the root of a component is a
/// function of the runs alone and not of the order they were merged in. Every
/// count this module reports is keyed on a root, and a report that changed
/// between two identical traces would be worse than no report.
struct DisjointSet {
    parent: Vec<usize>,
}

impl DisjointSet {
    fn new(n: usize) -> Self {
        Self {
            parent: (0..n).collect(),
        }
    }

    fn find(&mut self, mut a: usize) -> usize {
        while self.parent[a] != a {
            // Path halving: one extra store per step, no second pass, no stack.
            self.parent[a] = self.parent[self.parent[a]];
            a = self.parent[a];
        }
        a
    }

    fn union(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            self.parent[ra.max(rb)] = ra.min(rb);
        }
    }
}

/// Component root for every run.
///
/// `diagonal` selects 8-connectivity, which the background needs so that its
/// topology is the complement of the 4-connected foreground the contour walker
/// produces. Mixing the two would let the filter fill a "hole" the walker never
/// saw, or leave one it did.
fn label_runs(runs: &[Run], row_start: &[usize], diagonal: bool) -> Vec<usize> {
    let mut ds = DisjointSet::new(runs.len());
    // row_start has h + 1 entries, so the last row index is len - 2.
    for y in 1..row_start.len().saturating_sub(1) {
        let (mut i, mut j) = (row_start[y - 1], row_start[y]);
        let (end_prev, end_cur) = (row_start[y], row_start[y + 1]);
        while i < end_prev && j < end_cur {
            let (a, b) = (&runs[i], &runs[j]);
            let touches = if diagonal {
                a.x0 <= b.x1 && b.x0 <= a.x1
            } else {
                a.x0 < b.x1 && b.x0 < a.x1
            };
            if touches {
                ds.union(i, j);
            }
            // Advance whichever run ends first. Runs within a row are separated
            // by at least one gap pixel, so the one that ends first cannot
            // reach any run the other has not been compared against yet.
            if a.x1 <= b.x1 {
                i += 1;
            } else {
                j += 1;
            }
        }
    }
    (0..runs.len()).map(|k| ds.find(k)).collect()
}

/// Pixel area per component, indexed by root.
fn accumulate_areas(runs: &[Run], roots: &[usize]) -> Vec<u64> {
    let mut areas = vec![0u64; runs.len()];
    for (run, &root) in runs.iter().zip(roots) {
        areas[root] += (run.x1 - run.x0) as u64;
    }
    areas
}

/// Remove regions and fill enclosed holes below `min_area`, in place.
///
/// Both halves, because a minimum feature size that only removed specks would
/// leave a speck-shaped hole in whatever surrounded it — and a hole below the
/// minimum feature size is exactly as uncuttable as a speck. Only holes that do
/// not reach the image border are filled; a background region touching the edge
/// is the outside of the picture, not a hole in it, however small.
fn apply_min_feature(mask: &mut [bool], w: usize, h: usize, min_area: u32, report: &mut Report) {
    let min = u64::from(min_area);

    {
        let (runs, row_start) = runs_of(mask, w, h, true);
        let roots = label_runs(&runs, &row_start, false);
        let areas = accumulate_areas(&runs, &roots);
        let mut counted = vec![false; runs.len()];
        for (k, run) in runs.iter().enumerate() {
            let root = roots[k];
            if areas[root] >= min {
                continue;
            }
            for x in run.x0..run.x1 {
                mask[run.y * w + x] = false;
            }
            if !counted[root] {
                counted[root] = true;
                report.regions_dropped += 1;
                report.region_pixels_dropped += areas[root];
            }
        }
    }

    {
        // Recomputed against the post-drop mask: a region that just left may
        // have opened a background component up to the border, and filling it
        // back in would undo the drop.
        let (runs, row_start) = runs_of(mask, w, h, false);
        let roots = label_runs(&runs, &row_start, true);
        let areas = accumulate_areas(&runs, &roots);
        let mut open = vec![false; runs.len()];
        for (k, run) in runs.iter().enumerate() {
            if run.y == 0 || run.y + 1 == h || run.x0 == 0 || run.x1 == w {
                open[roots[k]] = true;
            }
        }
        let mut counted = vec![false; runs.len()];
        for (k, run) in runs.iter().enumerate() {
            let root = roots[k];
            if open[root] || areas[root] >= min {
                continue;
            }
            for x in run.x0..run.x1 {
                mask[run.y * w + x] = true;
            }
            if !counted[root] {
                counted[root] = true;
                report.holes_filled += 1;
                report.hole_pixels_filled += areas[root];
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Boundary extraction
// ---------------------------------------------------------------------------

/// Direction index to lattice step: 0 = +x, 1 = +y, 2 = -x, 3 = -y.
///
/// The order is a quarter turn each time, which is what makes "turn right" the
/// arithmetic `(d + 1) % 4` and "turn left" `(d + 3) % 4`.
const DIR_DELTA: [(i32, i32); 4] = [(1, 0), (0, 1), (-1, 0), (0, -1)];

/// Every closed boundary of `mask`, as lattice polygons.
///
/// Each edge of the boundary is emitted once, oriented so the filled side is on
/// the right of travel, and the edges are then chained into loops. That is a
/// permutation on the edge set — every vertex has as many outgoing boundary
/// edges as incoming — so following it from any unused edge closes exactly one
/// loop and every edge lands in exactly one contour.
///
/// The only ambiguity is a vertex where two diagonally opposite pixels are
/// filled and the other two are not: four edges meet, and the walk has a choice.
/// It always turns right, i.e. hugs the region it is bounding. That is what
/// makes the foreground 4-connected — the two diagonal pixels come out as two
/// contours rather than one self-touching figure-eight, which is what they are
/// to anything that has to cut or stitch them.
fn extract_contours(mask: &[bool], w: usize, h: usize) -> Vec<Contour> {
    let vw = w + 1;
    // One bitmask per lattice vertex, bit d set when a boundary edge leaves it
    // in direction d.
    let mut edges = vec![0u8; vw * (h + 1)];
    for y in 0..h {
        for x in 0..w {
            if !mask[y * w + x] {
                continue;
            }
            // Top side, left to right, starting at the pixel's top-left corner.
            if y == 0 || !mask[(y - 1) * w + x] {
                edges[y * vw + x] |= 1;
            }
            // Right side, downwards, from the top-right corner.
            if x + 1 == w || !mask[y * w + x + 1] {
                edges[y * vw + x + 1] |= 1 << 1;
            }
            // Bottom side, right to left, from the bottom-right corner.
            if y + 1 == h || !mask[(y + 1) * w + x] {
                edges[(y + 1) * vw + x + 1] |= 1 << 2;
            }
            // Left side, upwards, from the bottom-left corner.
            if x == 0 || !mask[y * w + x - 1] {
                edges[(y + 1) * vw + x] |= 1 << 3;
            }
        }
    }

    let mut used = vec![0u8; edges.len()];
    let mut contours = Vec::new();
    let mut points: Vec<[i32; 2]> = Vec::new();

    for vi in 0..edges.len() {
        for d0 in 0u8..4 {
            let bit = 1u8 << d0;
            if edges[vi] & bit == 0 || used[vi] & bit != 0 {
                continue;
            }

            points.clear();
            let (mut cur, mut dir) = (vi, d0);
            loop {
                used[cur] |= 1 << dir;
                points.push([(cur % vw) as i32, (cur / vw) as i32]);

                let (dx, dy) = DIR_DELTA[usize::from(dir)];
                // A boundary edge never leaves the lattice: the +x edges are
                // only placed at vx < w, the -x edges at vx > 0, and likewise
                // for y. So this arithmetic cannot go out of range.
                let nx = (cur % vw) as i32 + dx;
                let ny = (cur / vw) as i32 + dy;
                let next = ny as usize * vw + nx as usize;

                // Right turn, then straight, then left turn. Never a reversal —
                // there is no configuration of four pixels around a vertex that
                // offers one.
                let mut chosen = None;
                for step in [1u8, 0, 3] {
                    let cand = (dir + step) % 4;
                    if edges[next] & (1 << cand) != 0 {
                        chosen = Some(cand);
                        break;
                    }
                }
                let nd = chosen.expect("a boundary vertex always has an outgoing boundary edge");

                if next == vi && nd == d0 {
                    break;
                }
                assert!(
                    used[next] & (1 << nd) == 0,
                    "boundary walk re-entered an edge it had already taken"
                );
                cur = next;
                dir = nd;
            }

            let collapsed = collapse_collinear(&points);
            let area2 = signed_area2(&collapsed);
            debug_assert!(area2 != 0, "a lattice contour cannot enclose zero area");
            contours.push(Contour {
                points: collapsed,
                area2,
            });
        }
    }

    contours
}

/// Drop vertices that lie on the straight line between their neighbours, treating
/// the sequence as a closed ring.
///
/// Exact, not an approximation: three collinear lattice points describe the same
/// segment as two. The walker emits a vertex at every unit step, so a
/// thousand-pixel straight edge arrives here as a thousand points and leaves as
/// none of them.
fn collapse_collinear(points: &[[i32; 2]]) -> Vec<[i32; 2]> {
    let n = points.len();
    if n < 3 {
        return points.to_vec();
    }
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let prev = points[(i + n - 1) % n];
        let cur = points[i];
        let next = points[(i + 1) % n];
        let (ax, ay) = ((cur[0] - prev[0]) as i64, (cur[1] - prev[1]) as i64);
        let (bx, by) = ((next[0] - cur[0]) as i64, (next[1] - cur[1]) as i64);
        if ax * by - ay * bx != 0 {
            out.push(cur);
        }
    }
    out
}

/// Twice the signed area of a closed polygon, exactly.
///
/// Integer arithmetic throughout: this decides whether a contour is a hole, and
/// a sign decided by a float rounding error is a region that fills in solid.
fn signed_area2(points: &[[i32; 2]]) -> i64 {
    let Some(&last) = points.last() else {
        return 0;
    };
    let mut sum = 0i64;
    let mut prev = last;
    for &p in points {
        sum += i64::from(prev[0]) * i64::from(p[1]) - i64::from(p[0]) * i64::from(prev[1]);
        prev = p;
    }
    sum
}

// ---------------------------------------------------------------------------
// Simplification (F-EX-09)
// ---------------------------------------------------------------------------

/// Douglas-Peucker over every contour, dropping any that collapses.
fn simplify(contours: Vec<Contour>, tolerance: f64, report: &mut Report) -> Vec<Contour> {
    let mut out = Vec::with_capacity(contours.len());
    for contour in contours {
        let Some(points) = simplify_ring(&contour.points, tolerance) else {
            report.contours_dropped += 1;
            continue;
        };
        // Recomputed rather than carried over: simplification cannot flip an
        // orientation, but it can flatten a contour to nothing, and a zero-area
        // subpath is a stray line in the output.
        let area2 = signed_area2(&points);
        if area2 == 0 {
            report.contours_dropped += 1;
            continue;
        }
        out.push(Contour { points, area2 });
    }
    out
}

/// Douglas-Peucker on a closed ring.
///
/// The algorithm is defined on an open chain, so the ring is cut at two points
/// that are far apart — the first vertex and whichever vertex is furthest from
/// it — and the two halves are simplified independently. Cutting at an arbitrary
/// adjacent pair instead would pin two neighbouring vertices and leave a visible
/// kink at the seam.
///
/// Returns `None` when the result has fewer than three distinct points, which
/// means the whole region was smaller than the tolerance. Dropping it is the
/// honest answer; the count goes in the report.
fn simplify_ring(points: &[[i32; 2]], tolerance: f64) -> Option<Vec<[i32; 2]>> {
    let n = points.len();
    if n < 4 {
        return Some(points.to_vec());
    }
    let first = points[0];
    let mut anchor = 0usize;
    let mut best = -1i64;
    for (i, p) in points.iter().enumerate() {
        let dx = i64::from(p[0] - first[0]);
        let dy = i64::from(p[1] - first[1]);
        let d = dx * dx + dy * dy;
        if d > best {
            best = d;
            anchor = i;
        }
    }
    if anchor == 0 {
        return None;
    }

    let mut ring = Vec::with_capacity(n);
    let head = douglas_peucker(&points[..=anchor], tolerance);
    ring.extend_from_slice(&head[..head.len() - 1]);

    let mut tail: Vec<[i32; 2]> = points[anchor..].to_vec();
    tail.push(first);
    let tail = douglas_peucker(&tail, tolerance);
    ring.extend_from_slice(&tail[..tail.len() - 1]);

    // The two halves can meet collinearly at either cut.
    let ring = collapse_collinear(&ring);
    if ring.len() < 3 {
        None
    } else {
        Some(ring)
    }
}

/// Douglas-Peucker on an open chain. Returns a subsequence including both ends.
///
/// Iterative with an explicit stack. A pixel-perfect contour of a large image can
/// run to millions of vertices, and the recursive formulation is `O(n)` deep in
/// the worst case — a blown stack in an export is not a failure mode worth
/// having.
fn douglas_peucker(chain: &[[i32; 2]], tolerance: f64) -> Vec<[i32; 2]> {
    let n = chain.len();
    if n <= 2 {
        return chain.to_vec();
    }
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;

    let tolerance_sq = tolerance * tolerance;
    let mut stack = vec![(0usize, n - 1)];
    while let Some((lo, hi)) = stack.pop() {
        if hi <= lo + 1 {
            continue;
        }
        let (ax, ay) = (f64::from(chain[lo][0]), f64::from(chain[lo][1]));
        let (bx, by) = (f64::from(chain[hi][0]), f64::from(chain[hi][1]));
        let (ex, ey) = (bx - ax, by - ay);
        let len_sq = ex * ex + ey * ey;

        let mut worst = 0usize;
        let mut worst_d = -1.0f64;
        for (offset, p) in chain[lo + 1..hi].iter().enumerate() {
            let (px, py) = (f64::from(p[0]) - ax, f64::from(p[1]) - ay);
            // Squared perpendicular distance, or squared distance to the shared
            // endpoint when the chain returns to where it started.
            let d = if len_sq > 0.0 {
                let cross = ex * py - ey * px;
                cross * cross / len_sq
            } else {
                px * px + py * py
            };
            if d > worst_d {
                worst_d = d;
                worst = lo + 1 + offset;
            }
        }

        if worst_d > tolerance_sq {
            keep[worst] = true;
            stack.push((lo, worst));
            stack.push((worst, hi));
        }
    }

    chain
        .iter()
        .zip(&keep)
        .filter(|(_, &k)| k)
        .map(|(p, _)| *p)
        .collect()
}

// ---------------------------------------------------------------------------
// SVG emission
// ---------------------------------------------------------------------------

fn hex6(srgb: [u8; 3]) -> String {
    format!("{:02x}{:02x}{:02x}", srgb[0], srgb[1], srgb[2])
}

/// Append one closed subpath.
///
/// `H` and `V` rather than `L` wherever a segment is axis-aligned. That is not
/// cosmetic: a pixel-perfect trace is almost entirely axis-aligned segments, and
/// halving each one's cost is the difference between a large file and an
/// unusable one.
fn append_subpath(out: &mut String, points: &[[i32; 2]]) {
    let Some(&first) = points.first() else {
        return;
    };
    let _ = write!(out, "M{} {}", first[0], first[1]);
    let mut prev = first;
    for &p in &points[1..] {
        if p[1] == prev[1] {
            let _ = write!(out, "H{}", p[0]);
        } else if p[0] == prev[0] {
            let _ = write!(out, "V{}", p[1]);
        } else {
            let _ = write!(out, "L{} {}", p[0], p[1]);
        }
        prev = p;
    }
    out.push('Z');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Grey ramp palette, enough entries for any fixture below.
    fn palette(n: usize) -> Vec<u8> {
        (0..n)
            .flat_map(|i| {
                let v = (i * 40 % 256) as u8;
                [v, v.wrapping_add(17), v.wrapping_add(99)]
            })
            .collect()
    }

    fn layer_path(svg: &str, palette_index: u16) -> String {
        let (_, paths) = parse_layers(svg)
            .into_iter()
            .find(|(i, _)| *i == palette_index)
            .unwrap_or_else(|| panic!("no layer for palette index {palette_index}"));
        paths
    }

    /// Pull `(palette index, raw path data)` out of our own output. Deliberately
    /// a string scan and not an XML parser: the point is to read back exactly
    /// what was written, including the attribute spelling.
    fn parse_layers(svg: &str) -> Vec<(u16, String)> {
        svg.split("<g ")
            .skip(1)
            .map(|chunk| {
                let index: u16 = attr(chunk, "data-palette-index=\"")
                    .expect("group carries a palette index")
                    .parse()
                    .expect("palette index parses");
                let d = attr(chunk, "<path d=\"").expect("group carries a path");
                (index, d.to_string())
            })
            .collect()
    }

    fn attr<'a>(chunk: &'a str, needle: &str) -> Option<&'a str> {
        let start = chunk.find(needle)? + needle.len();
        let end = chunk[start..].find('"')? + start;
        Some(&chunk[start..end])
    }

    // -- exact geometry -----------------------------------------------------

    #[test]
    fn single_pixel_becomes_the_unit_square() {
        let traced = trace(&[0], 1, 1, &palette(1), Options::default());
        let layers = traced.layers();
        assert_eq!(layers.len(), 1);
        let contours = layers[0].contours();
        assert_eq!(contours.len(), 1);
        assert_eq!(
            contours[0].points(),
            &[[0, 0], [1, 0], [1, 1], [0, 1]],
            "the boundary of one pixel is its four corners, in order"
        );
        assert_eq!(contours[0].signed_area2(), 2, "one pixel of area, doubled");
        assert!(!contours[0].is_hole());
        assert_eq!(layer_path(&traced.to_svg(), 0), "M0 0H1V1H0Z");
    }

    #[test]
    fn known_index_map_traces_to_known_paths() {
        // 0 0 1
        // 0 1 1
        let indices = [0u16, 0, 1, 0, 1, 1];
        let traced = trace(&indices, 3, 2, &palette(2), Options::default());
        let svg = traced.to_svg();

        // The L of colour 0 and the mirrored L of colour 1, both walked as one
        // closed outline with the collinear steps collapsed away.
        assert_eq!(layer_path(&svg, 0), "M0 0H2V1H1V2H0Z");
        assert_eq!(layer_path(&svg, 1), "M2 0H3V2H1V1H2Z");

        for layer in traced.layers() {
            assert_eq!(layer.contours().len(), 1);
            assert_eq!(
                layer.contours()[0].signed_area2(),
                6,
                "three pixels of area, doubled"
            );
        }
    }

    #[test]
    fn adjacent_colours_share_the_boundary_exactly() {
        // Two 2x2 blocks side by side. The seam test: both paths must name the
        // same integer x for the edge they share, not two values a hair apart.
        let indices = [0u16, 0, 1, 1, 0, 0, 1, 1];
        let svg = trace(&indices, 4, 2, &palette(2), Options::default()).to_svg();
        assert_eq!(layer_path(&svg, 0), "M0 0H2V2H0Z");
        assert_eq!(layer_path(&svg, 1), "M2 0H4V2H2Z");
    }

    // -- holes and winding --------------------------------------------------

    /// 5x5 of colour 1 with a single pixel of colour 0 at the centre.
    fn donut() -> Vec<u16> {
        let mut indices = vec![1u16; 25];
        indices[2 * 5 + 2] = 0;
        indices
    }

    #[test]
    fn hole_comes_out_with_opposite_winding() {
        let traced = trace(&donut(), 5, 5, &palette(2), Options::default());
        let ring = traced
            .layers()
            .iter()
            .find(|l| l.palette_index() == 1)
            .expect("the ring colour is present");
        assert_eq!(ring.contours().len(), 2, "an outer boundary and a hole");

        let outer = &ring.contours()[0];
        let hole = &ring.contours()[1];
        assert!(!outer.is_hole());
        assert_eq!(outer.signed_area2(), 50, "5x5 of area, doubled");
        assert!(
            hole.is_hole(),
            "the enclosed contour must wind the other way"
        );
        assert_eq!(hole.signed_area2(), -2);
        assert_eq!(hole.points(), &[[2, 2], [2, 3], [3, 3], [3, 2]]);

        // Both subpaths must live in one <path>, or no fill rule can leave the
        // hole empty.
        let svg = traced.to_svg();
        assert_eq!(layer_path(&svg, 1), "M0 0H5V5H0ZM2 2V3H3V2Z");
        assert!(svg.contains("fill-rule=\"evenodd\""));
    }

    #[test]
    fn hole_is_empty_when_rasterized_back() {
        let indices = donut();
        let svg = trace(&indices, 5, 5, &palette(2), Options::default()).to_svg();
        let raster = rasterize(&svg, 5, 5);
        assert_eq!(
            raster[2 * 5 + 2],
            Some(0),
            "the hole must show the colour behind it, not fill in solid"
        );
        assert_eq!(raster, indices.iter().map(|&i| Some(i)).collect::<Vec<_>>());
    }

    #[test]
    fn nested_regions_each_get_their_own_winding() {
        // A bullseye: a frame of colour 1, a ring of colour 0 inside it, and a
        // block of colour 1 inside that. Colour 1 is two separate regions, one
        // of which has a hole; colour 0 is one region with a hole. If the
        // winding of a nested contour were decided by nesting depth rather than
        // by the direction the boundary was walked, the middle block would come
        // out as a hole and disappear.
        let mut indices = vec![1u16; 49];
        for y in 1..6 {
            for x in 1..6 {
                indices[y * 7 + x] = 0;
            }
        }
        for y in 2..5 {
            for x in 2..5 {
                indices[y * 7 + x] = 1;
            }
        }
        let traced = trace(&indices, 7, 7, &palette(2), Options::default());

        let ring = traced
            .layers()
            .iter()
            .find(|l| l.palette_index() == 0)
            .expect("the ring colour is present");
        assert_eq!(ring.contours().len(), 2);
        assert_eq!(ring.contours()[0].signed_area2(), 50, "5x5 outer");
        assert_eq!(ring.contours()[1].signed_area2(), -18, "3x3 hole");

        let frame = traced
            .layers()
            .iter()
            .find(|l| l.palette_index() == 1)
            .expect("the frame colour is present");
        assert_eq!(
            frame.contours().len(),
            3,
            "an outer frame with a hole, plus the block sitting inside that hole"
        );
        let holes = frame.contours().iter().filter(|c| c.is_hole()).count();
        assert_eq!(holes, 1, "only the frame's own interior is a hole");

        assert_eq!(
            rasterize(&traced.to_svg(), 7, 7),
            indices.iter().map(|&i| Some(i)).collect::<Vec<_>>()
        );
    }

    #[test]
    fn diagonal_touch_is_two_regions_not_one() {
        // 0 1
        // 1 0
        let indices = [0u16, 1, 1, 0];
        let traced = trace(&indices, 2, 2, &palette(2), Options::default());
        for layer in traced.layers() {
            assert_eq!(
                layer.contours().len(),
                2,
                "pixels touching only at a corner are two shapes to a cutter"
            );
            for contour in layer.contours() {
                assert_eq!(contour.signed_area2(), 2);
            }
        }
        assert_eq!(
            rasterize(&traced.to_svg(), 2, 2),
            vec![Some(0), Some(1), Some(1), Some(0)]
        );
    }

    // -- minimum feature size (F-EX-10) -------------------------------------

    #[test]
    fn minimum_feature_filter_drops_small_regions() {
        // A 1-pixel speck of colour 0 in a field of colour 1.
        let mut indices = vec![1u16; 49];
        indices[3 * 7 + 3] = 0;
        let options = Options {
            min_feature_area: 2,
            ..Options::default()
        };
        let traced = trace(&indices, 7, 7, &palette(2), options);

        assert_eq!(traced.report().regions_dropped, 1);
        assert_eq!(traced.report().region_pixels_dropped, 1);
        assert!(
            traced.layers().iter().all(|l| l.palette_index() != 0),
            "a colour whose only region was filtered out produces no layer"
        );
        // The hole it left in the surrounding colour goes with it, or the output
        // would have a speck-shaped gap where the speck used to be.
        assert_eq!(traced.report().holes_filled, 1);
        let field = &traced.layers()[0];
        assert_eq!(field.contours().len(), 1);
        assert_eq!(field.contours()[0].signed_area2(), 98);
    }

    #[test]
    fn minimum_feature_filter_keeps_regions_at_the_threshold() {
        let mut indices = vec![1u16; 49];
        indices[3 * 7 + 3] = 0;
        indices[3 * 7 + 4] = 0;
        let options = Options {
            min_feature_area: 2,
            ..Options::default()
        };
        let traced = trace(&indices, 7, 7, &palette(2), options);
        assert_eq!(traced.report().regions_dropped, 0);
        assert_eq!(traced.report().holes_filled, 0);
        assert_eq!(traced.layers().len(), 2);
    }

    #[test]
    fn minimum_feature_filter_leaves_a_border_notch_alone() {
        // A background component that reaches the edge is the outside of the
        // picture, not a hole, however few pixels of it there are.
        let mut indices = vec![1u16; 49];
        indices[0] = 0;
        let options = Options {
            min_feature_area: 4,
            ..Options::default()
        };
        let traced = trace(&indices, 7, 7, &palette(2), options);
        assert_eq!(traced.report().regions_dropped, 1, "the corner speck goes");
        assert_eq!(
            traced.report().holes_filled,
            0,
            "the notch it leaves opens onto the border, so it is not filled"
        );
        let field = &traced.layers()[0];
        assert_eq!(field.contours()[0].signed_area2(), 96, "48 pixels, doubled");
    }

    #[test]
    fn uncovered_pixels_matches_what_the_output_actually_leaves_bare() {
        // The identity `dropped - filled` is only worth reporting if it is the
        // real bare area, so it is checked against a rasterization of the
        // emitted document rather than against the arithmetic that produced it.
        // A dithered-looking map is the case that matters: it is nearly all
        // specks, so the filter has plenty to drop and plenty of holes to close.
        let (w, h) = (23usize, 19usize);
        let indices = busy_map(w, h);
        for min_feature_area in [2u32, 3, 5, 9] {
            let traced = trace(
                &indices,
                w,
                h,
                &palette(4),
                Options {
                    min_feature_area,
                    ..Options::default()
                },
            );
            let bare = rasterize(&traced.to_svg(), w, h)
                .iter()
                .filter(|p| p.is_none())
                .count() as u64;
            assert_eq!(
                traced.report().uncovered_pixels(),
                bare,
                "min_feature_area {min_feature_area} reported the wrong bare area"
            );
        }
    }

    #[test]
    fn filtered_output_never_covers_a_pixel_twice() {
        // `rasterize` panics when two layers claim one pixel, so this is really
        // a statement that hole filling cannot make two colours overlap — the
        // fact `Report::uncovered_pixels` rests on.
        let (w, h) = (23usize, 19usize);
        let indices = busy_map(w, h);
        for min_feature_area in [2u32, 3, 5, 9, 40] {
            let traced = trace(
                &indices,
                w,
                h,
                &palette(4),
                Options {
                    min_feature_area,
                    ..Options::default()
                },
            );
            rasterize(&traced.to_svg(), w, h);
        }
    }

    #[test]
    fn a_pixel_the_filter_swallows_goes_to_the_colour_that_enclosed_it() {
        // A field of colour 1 with isolated specks of colours 2 and 3 well
        // inside the border, so every speck is a genuine enclosed hole.
        let (w, h) = (13usize, 11usize);
        let mut indices = vec![1u16; w * h];
        for (n, &(x, y)) in [(3usize, 3usize), (7, 4), (5, 7), (9, 8)]
            .iter()
            .enumerate()
        {
            indices[y * w + x] = if n % 2 == 0 { 2 } else { 3 };
        }
        let traced = trace(
            &indices,
            w,
            h,
            &palette(4),
            Options {
                min_feature_area: 4,
                ..Options::default()
            },
        );
        // The filter may leave a pixel bare or hand it to the colour that
        // enclosed it, but it must never hand it to some third colour.
        let raster = rasterize(&traced.to_svg(), w, h);
        let mut recoloured = 0usize;
        for (got, &want) in raster.iter().zip(&indices) {
            if let Some(index) = *got {
                if index != want {
                    recoloured += 1;
                }
            }
        }
        assert!(
            recoloured > 0,
            "this fixture should exercise hole filling at all"
        );
        // Everything recoloured must have been swallowed by a single
        // surrounding colour, which is what a filled hole is.
        assert_eq!(recoloured as u64, traced.report().hole_pixels_filled);
    }

    #[test]
    fn minimum_feature_filter_is_off_by_default() {
        let mut indices = vec![1u16; 49];
        indices[3 * 7 + 3] = 0;
        let traced = trace(&indices, 7, 7, &palette(2), Options::default());
        assert_eq!(traced.report().regions_dropped, 0);
        assert_eq!(traced.layers().len(), 2);
    }

    // -- pixel-perfect round trip -------------------------------------------

    /// A deterministic pattern with isolated pixels, diagonal contacts and
    /// enclosed regions — the three things a tracer gets wrong.
    fn busy_map(w: usize, h: usize) -> Vec<u16> {
        (0..w * h)
            .map(|i| {
                let (x, y) = (i % w, i / w);
                (((x * 7 + y * 11) / 3 + (x ^ y)) % 4) as u16
            })
            .collect()
    }

    #[test]
    fn pixel_perfect_output_rasterizes_back_to_the_index_map() {
        let (w, h) = (17usize, 13usize);
        let indices = busy_map(w, h);
        let svg = trace(&indices, w, h, &palette(4), Options::default()).to_svg();
        let raster = rasterize(&svg, w, h);
        for (i, (got, &want)) in raster.iter().zip(&indices).enumerate() {
            assert_eq!(
                *got,
                Some(want),
                "pixel ({}, {}) came back wrong",
                i % w,
                i / w
            );
        }
    }

    #[test]
    fn tracing_is_deterministic() {
        let (w, h) = (17usize, 13usize);
        let indices = busy_map(w, h);
        let a = trace(&indices, w, h, &palette(4), Options::default()).to_svg();
        let b = trace(&indices, w, h, &palette(4), Options::default()).to_svg();
        assert_eq!(a, b);
    }

    // -- simplification (F-EX-09) -------------------------------------------

    /// A diagonal split: colour 0 above the diagonal, colour 1 below.
    fn staircase(n: usize) -> Vec<u16> {
        (0..n * n).map(|i| u16::from(i % n >= i / n)).collect()
    }

    #[test]
    fn simplified_mode_removes_staircase_vertices() {
        let n = 24usize;
        let indices = staircase(n);
        let exact = trace(&indices, n, n, &palette(2), Options::default());
        let simplified = trace(
            &indices,
            n,
            n,
            &palette(2),
            Options {
                mode: Mode::Simplified { tolerance: 1.0 },
                ..Options::default()
            },
        );
        assert!(
            simplified.report().points * 4 < exact.report().points,
            "a 24-step staircase should collapse hard: {} points against {}",
            simplified.report().points,
            exact.report().points
        );
        assert_eq!(simplified.report().contours_dropped, 0);
    }

    #[test]
    fn simplified_output_stays_on_the_pixel_grid() {
        // Douglas-Peucker selects vertices, it never invents one, so there is no
        // way for a coordinate to land off the lattice and open a seam.
        let n = 24usize;
        let traced = trace(
            &staircase(n),
            n,
            n,
            &palette(2),
            Options {
                mode: Mode::Simplified { tolerance: 2.5 },
                ..Options::default()
            },
        );
        let svg = traced.to_svg();
        for (index, d) in parse_layers(&svg) {
            assert!(
                !d.contains('.'),
                "layer {index} carries a fractional coordinate: {d}"
            );
        }
        for layer in traced.layers() {
            for contour in layer.contours() {
                for p in contour.points() {
                    assert!(p[0] >= 0 && p[0] <= n as i32);
                    assert!(p[1] >= 0 && p[1] <= n as i32);
                }
            }
        }
    }

    #[test]
    fn simplified_mode_keeps_hole_winding() {
        // 9x9 ring with a 3x3 hole, so the hole survives a real tolerance.
        let mut indices = vec![1u16; 81];
        for y in 3..6 {
            for x in 3..6 {
                indices[y * 9 + x] = 0;
            }
        }
        let traced = trace(
            &indices,
            9,
            9,
            &palette(2),
            Options {
                mode: Mode::Simplified { tolerance: 1.0 },
                ..Options::default()
            },
        );
        let ring = traced
            .layers()
            .iter()
            .find(|l| l.palette_index() == 1)
            .expect("the ring colour survives");
        assert_eq!(ring.contours().len(), 2);
        assert!(!ring.contours()[0].is_hole());
        assert!(
            ring.contours()[1].is_hole(),
            "simplification must not flip the hole's winding"
        );
        assert_eq!(
            ring.contours()[1].signed_area2(),
            -18,
            "3x3, doubled, negative"
        );
    }

    #[test]
    fn simplification_that_eats_a_contour_reports_it() {
        // Single pixel against a tolerance far larger than the pixel: the ring
        // cannot survive, and the report says so instead of the output quietly
        // carrying a degenerate subpath.
        let mut indices = vec![1u16; 49];
        indices[3 * 7 + 3] = 0;
        let traced = trace(
            &indices,
            7,
            7,
            &palette(2),
            Options {
                mode: Mode::Simplified { tolerance: 8.0 },
                ..Options::default()
            },
        );
        assert!(traced.report().contours_dropped >= 1);
        assert!(traced.layers().iter().all(|l| l.palette_index() != 0));
    }

    // -- output shape (F-EX-08, F-EX-10) ------------------------------------

    #[test]
    fn groups_are_named_by_colour_and_marked_as_layers() {
        let indices = [0u16, 1];
        let mut pal = vec![0u8; 6];
        pal[0..3].copy_from_slice(&[0x1a, 0x2b, 0x3c]);
        pal[3..6].copy_from_slice(&[0xff, 0x00, 0x7f]);
        let svg = trace(&indices, 2, 1, &pal, Options::default()).to_svg();

        assert!(svg.contains("id=\"colour-0-1a2b3c\""), "{svg}");
        assert!(svg.contains("inkscape:label=\"#1a2b3c\""), "{svg}");
        assert!(svg.contains("inkscape:groupmode=\"layer\""), "{svg}");
        assert!(svg.contains("fill=\"#ff007f\""), "{svg}");
        assert!(svg.contains("viewBox=\"0 0 2 1\""), "{svg}");
        assert!(svg.contains("shape-rendering=\"crispEdges\""), "{svg}");
    }

    #[test]
    fn stroke_only_output_has_no_fill() {
        let svg = trace(
            &[0u16, 1],
            2,
            1,
            &palette(2),
            Options {
                stroke_only: true,
                stroke_width: 0.25,
                ..Options::default()
            },
        )
        .to_svg();
        assert!(svg.contains("fill=\"none\""), "{svg}");
        assert!(svg.contains("stroke-width=\"0.25\""), "{svg}");
        assert!(
            !svg.contains("fill-rule"),
            "a fill rule on an unfilled path is noise: {svg}"
        );
        assert_eq!(svg.matches("stroke=\"#").count(), 2);
    }

    #[test]
    fn simplified_mode_does_not_ask_for_crisp_edges() {
        let svg = trace(
            &staircase(8),
            8,
            8,
            &palette(2),
            Options {
                mode: Mode::Simplified { tolerance: 1.0 },
                ..Options::default()
            },
        )
        .to_svg();
        assert!(!svg.contains("shape-rendering"), "{svg}");
    }

    #[test]
    fn absent_palette_colours_produce_no_group() {
        let traced = trace(&[3u16; 4], 2, 2, &palette(8), Options::default());
        assert_eq!(traced.layers().len(), 1);
        assert_eq!(traced.report().layers, 1);
        assert_eq!(traced.layers()[0].palette_index(), 3);
    }

    #[test]
    fn report_counts_what_was_emitted() {
        let traced = trace(&donut(), 5, 5, &palette(2), Options::default());
        assert_eq!(traced.report().layers, 2);
        assert_eq!(
            traced.report().contours,
            3,
            "one for the speck, two for the ring"
        );
        assert_eq!(traced.report().points, 4 + 4 + 4);
    }

    // -- refusals -----------------------------------------------------------

    #[test]
    #[should_panic(expected = "index map length does not match")]
    fn mismatched_index_map_is_refused() {
        trace(&[0u16; 3], 2, 2, &palette(1), Options::default());
    }

    #[test]
    #[should_panic(expected = "names no entry in a palette")]
    fn index_outside_the_palette_is_refused() {
        trace(&[0u16, 5], 2, 1, &palette(2), Options::default());
    }

    #[test]
    #[should_panic(expected = "dimensions must both be positive")]
    fn empty_image_is_refused() {
        trace(&[], 0, 0, &palette(1), Options::default());
    }

    #[test]
    #[should_panic(expected = "non-empty multiple of 3")]
    fn ragged_palette_is_refused() {
        trace(&[0u16], 1, 1, &[1, 2], Options::default());
    }

    #[test]
    #[should_panic(expected = "tolerance must be finite and positive")]
    fn zero_tolerance_is_refused() {
        trace(
            &[0u16],
            1,
            1,
            &palette(1),
            Options {
                mode: Mode::Simplified { tolerance: 0.0 },
                ..Options::default()
            },
        );
    }

    #[test]
    #[should_panic(expected = "stroke width must be finite and positive")]
    fn zero_stroke_width_is_refused() {
        trace(
            &[0u16],
            1,
            1,
            &palette(1),
            Options {
                stroke_only: true,
                stroke_width: 0.0,
                ..Options::default()
            },
        );
    }

    // -- a rasterizer, so the round trip is a real one ----------------------

    /// Fill every pixel centre from the emitted SVG, even-odd, and report which
    /// layer owns it.
    ///
    /// This reads the path data back out of the string rather than looking at
    /// the in-memory contours, so it tests the emission as well as the geometry.
    /// It panics if two layers claim the same pixel — which is what a seam or an
    /// overlap would look like — and returns `None` for a pixel no layer covers.
    fn rasterize(svg: &str, w: usize, h: usize) -> Vec<Option<u16>> {
        let layers: Vec<(u16, Vec<Vec<[f64; 2]>>)> = parse_layers(svg)
            .into_iter()
            .map(|(i, d)| (i, parse_path_data(&d)))
            .collect();

        let mut out = vec![None; w * h];
        for (index, subpaths) in &layers {
            for y in 0..h {
                for x in 0..w {
                    if !contains(subpaths, x as f64 + 0.5, y as f64 + 0.5) {
                        continue;
                    }
                    assert!(
                        out[y * w + x].is_none(),
                        "pixel ({x}, {y}) is covered by two layers"
                    );
                    out[y * w + x] = Some(*index);
                }
            }
        }
        out
    }

    /// Even-odd, over every subpath of one path at once. Pixel centres are at
    /// half-integers and every vertex is at an integer, so no ray ever grazes a
    /// vertex and there are no degenerate cases to resolve.
    fn contains(subpaths: &[Vec<[f64; 2]>], x: f64, y: f64) -> bool {
        let mut inside = false;
        for ring in subpaths {
            let n = ring.len();
            for i in 0..n {
                let a = ring[i];
                let b = ring[(i + 1) % n];
                if (a[1] > y) == (b[1] > y) {
                    continue;
                }
                let t = (y - a[1]) / (b[1] - a[1]);
                if x < a[0] + t * (b[0] - a[0]) {
                    inside = !inside;
                }
            }
        }
        inside
    }

    fn parse_path_data(d: &str) -> Vec<Vec<[f64; 2]>> {
        let bytes = d.as_bytes();
        let mut subpaths = Vec::new();
        let mut current: Vec<[f64; 2]> = Vec::new();
        let mut pos = [0.0f64, 0.0];
        let mut i = 0usize;
        while i < bytes.len() {
            let command = bytes[i] as char;
            i += 1;
            match command {
                'M' | 'L' => {
                    let (x, next) = number(d, i);
                    let (y, next) = number(d, next);
                    i = next;
                    if command == 'M' && !current.is_empty() {
                        subpaths.push(std::mem::take(&mut current));
                    }
                    pos = [x, y];
                    current.push(pos);
                }
                'H' => {
                    let (x, next) = number(d, i);
                    i = next;
                    pos[0] = x;
                    current.push(pos);
                }
                'V' => {
                    let (y, next) = number(d, i);
                    i = next;
                    pos[1] = y;
                    current.push(pos);
                }
                'Z' => subpaths.push(std::mem::take(&mut current)),
                other => panic!("unexpected path command {other:?} in {d}"),
            }
        }
        assert!(current.is_empty(), "path data ended without a close: {d}");
        subpaths
    }

    fn number(d: &str, mut i: usize) -> (f64, usize) {
        let bytes = d.as_bytes();
        while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b',') {
            i += 1;
        }
        let start = i;
        while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'-' || bytes[i] == b'.')
        {
            i += 1;
        }
        let value = d[start..i]
            .parse::<f64>()
            .unwrap_or_else(|_| panic!("not a number at {start} in {d}"));
        (value, i)
    }
}
