//! Generated test images for the golden-image harness (docs/ARCHITECTURE.md,
//! "Testing" and build order step 1).
//!
//! Every fixture is a pure function of nothing at all: fixed dimensions, no
//! seed, no clock, no file on disk. That is the point. Golden images are only
//! worth anything if the *input* side of the comparison is beyond suspicion,
//! and a committed source PNG is a binary blob that cannot be reviewed, cannot
//! be diffed, and can be replaced by a re-encode that shifts a channel by one
//! level with nothing in the diff to show it. A generator can be read.
//!
//! The buffers come out in **linear light**, which is what every consumer in
//! this crate takes. Two of the five are defined by a linear-light expression
//! because that is what their name means; the other three are defined as 8-bit
//! sRGB and decoded through [`srgb_to_linear`], because that is how a real
//! source arrives (F-IN-02) and because "red" means the sRGB corner, not the
//! linear-light coordinates that happen to encode it. Each one says which it is.
//!
//! Sizes are small and odd on purpose. The harness renders every fixture
//! through every registered kernel against two palettes, so the whole set is
//! paid for on every test run; and [`HARD_EDGE_CHART`] is deliberately neither
//! square nor a power of two, which is where Riemersma's curve has to be pruned
//! to a rectangle and every raster kernel has to get its row ends right.

use crate::color::{srgb_to_linear, Rgba};

/// How a fixture's pixels are produced. Private: a fixture is identified by its
/// id, and the set of patterns is not something a caller should be matching on.
#[derive(Clone, Copy, Debug)]
enum Pattern {
    LinearRamp,
    RadialGradient,
    ColourWheel,
    HardEdgeChart,
    FlatMidGrey,
}

/// A generated test image with fixed dimensions.
#[derive(Clone, Copy, Debug)]
pub struct Fixture {
    /// Stable across releases: it names a directory of reference images.
    /// Renaming one orphans its whole golden set.
    pub id: &'static str,
    pub name: &'static str,
    pub width: usize,
    pub height: usize,
    pattern: Pattern,
}

impl Fixture {
    /// The image, row-major, linear light, alpha 1.0 throughout.
    ///
    /// Allocated fresh on every call rather than cached in a `static`. A cache
    /// would need interior mutability in a crate that deliberately has none,
    /// and the largest fixture here is 6767 pixels.
    pub fn render(&self) -> Vec<Rgba> {
        let (w, h) = (self.width, self.height);
        let mut out = Vec::with_capacity(w * h);
        for y in 0..h {
            for x in 0..w {
                out.push(match self.pattern {
                    Pattern::LinearRamp => linear_ramp(x, w),
                    Pattern::RadialGradient => radial_gradient(x, y, w, h),
                    Pattern::ColourWheel => colour_wheel(x, y, w, h),
                    Pattern::HardEdgeChart => hard_edge_chart(x, y, w, h),
                    Pattern::FlatMidGrey => flat_mid_grey(),
                });
            }
        }
        out
    }

    pub fn pixel_count(&self) -> usize {
        self.width * self.height
    }
}

/// A ramp from black to full white, **linear in light**, constant down each
/// column.
///
/// This is the input docs/ARCHITECTURE.md names for the colour-correctness
/// test: dithered to a two-colour palette it must average back to its own
/// luminance, band by band, and it does that only if the error is diffused in
/// linear light. Linear in light and not in the sRGB encoding, because a ramp
/// that is linear in the encoding has a curved luminance and the test would
/// then be checking the harness's own arithmetic rather than the pipeline's.
///
/// 128 columns so each column is a distinct level and 32 rows so the vertical
/// structure of a two- or three-row kernel is visible; wider than tall because
/// nothing about a horizontal ramp varies vertically.
pub const LINEAR_RAMP: Fixture = Fixture {
    id: "linear-ramp",
    name: "Linear ramp",
    width: 128,
    height: 32,
    pattern: Pattern::LinearRamp,
};

/// A neutral radial falloff, white at the centre and black at the corners,
/// linear in light.
///
/// The smooth-in-every-direction case. A horizontal ramp only ever asks a
/// kernel to carry error along the scan; a radial field asks it to carry error
/// across a gradient whose direction turns through 360 degrees, which is the
/// arrangement that makes directional worming obvious — the artefact serpentine
/// scanning exists to suppress and the one a transposed coefficient makes worse.
pub const RADIAL_GRADIENT: Fixture = Fixture {
    id: "radial-gradient",
    name: "Radial gradient",
    width: 80,
    height: 80,
    pattern: Pattern::RadialGradient,
};

/// A hue sweep: angle is hue, radius is saturation, outside the disc is black.
/// Defined in 8-bit sRGB and decoded.
///
/// The only fixture with chroma, and therefore the only one that exercises
/// per-channel error diffusion doing what it is for — pushing a neighbour
/// toward the complementary hue when a pixel is matched to the wrong one. A
/// greyscale-only fixture set would pass identically with the colour path
/// broken.
///
/// Odd dimensions so the centre is a pixel rather than a gap between four, which
/// is what puts an exact white at the middle and samples the hue axes exactly.
pub const COLOUR_WHEEL: Fixture = Fixture {
    id: "colour-wheel",
    name: "Colour wheel",
    width: 81,
    height: 81,
    pattern: Pattern::ColourWheel,
};

/// Flat patches, a one-pixel checkerboard and a one-pixel line screen, all at
/// 8-bit sRGB extremes.
///
/// Everything the gradients do not have: hard edges, saturated corners the
/// palette cannot reach, and detail at the Nyquist limit. This is where the
/// overshoot limit shows up — a saturated patch drags a long bright or dark
/// tail out of its trailing edge when the working buffer is allowed to climb
/// away from the palette — and where a kernel that mishandles a row end
/// misbehaves visibly.
///
/// 101 x 67: neither square, nor a power of two, nor even. Riemersma's Hilbert
/// curve is defined on a 128x128 square here and has to be pruned down to the
/// rectangle, and every raster kernel has to drop its error correctly off three
/// edges of a shape that lines up with nothing.
pub const HARD_EDGE_CHART: Fixture = Fixture {
    id: "hard-edge-chart",
    name: "Hard-edge chart",
    width: 101,
    height: 67,
    pattern: Pattern::HardEdgeChart,
};

/// A flat field at sRGB 0x80, decoded to linear light.
///
/// The plainest and the most revealing. A flat field has no detail for a
/// dither pattern to hide in, so structured artefacts — a repeating tile, a
/// diagonal grain, a bias that drifts across the image — are naked here and
/// nowhere else. It is also the input for the mean test: the dithered result
/// must average back to 0.2140, the linear luminance of sRGB mid-grey, not to
/// 0.5.
pub const FLAT_MID_GREY: Fixture = Fixture {
    id: "flat-mid-grey",
    name: "Flat mid-grey",
    width: 48,
    height: 48,
    pattern: Pattern::FlatMidGrey,
};

/// Every fixture the golden-image harness renders. The harness iterates this
/// rather than keeping its own list, so adding a fixture here adds it to the
/// suite and `DITHER_ORK_BLESS=1` generates its references.
pub const FIXTURES: &[Fixture] = &[
    LINEAR_RAMP,
    RADIAL_GRADIENT,
    COLOUR_WHEEL,
    HARD_EDGE_CHART,
    FLAT_MID_GREY,
];

pub fn by_id(id: &str) -> Option<&'static Fixture> {
    FIXTURES.iter().find(|f| f.id == id)
}

/// sRGB code value of the flat field: 0x80 over 0xFF.
///
/// Written as the byte it is rather than as 0.5. The two differ by a third of a
/// code value, and the whole point of this fixture is that its linear mean is a
/// number nobody guesses.
const MID_GREY_CODE: f32 = 128.0 / 255.0;

/// Fraction of the colour wheel's radius at which saturation reaches 1.
const SATURATED_FROM: f32 = 0.9;

fn linear_ramp(x: usize, w: usize) -> Rgba {
    // `w - 1` in the denominator so the ramp reaches both ends exactly: column
    // 0 is a true black and the last column a true white. Ending at
    // `(w-1)/w` instead would leave the brightest column a hair below white,
    // and the mean test would then be chasing a bias that is in the fixture.
    let v = x as f32 / (w - 1) as f32;
    Rgba::new(v, v, v, 1.0)
}

fn radial_gradient(x: usize, y: usize, w: usize, h: usize) -> Rgba {
    let cx = (w - 1) as f32 / 2.0;
    let cy = (h - 1) as f32 / 2.0;
    let dx = x as f32 - cx;
    let dy = y as f32 - cy;
    // Normalized against the distance to a corner, so the falloff reaches zero
    // exactly at the four corners and the whole unit range appears in the
    // image. Against the half-width instead, everything outside the inscribed
    // circle would clamp to black and a quarter of the fixture would be flat.
    let corner = (cx * cx + cy * cy).sqrt();
    let v = 1.0 - (dx * dx + dy * dy).sqrt() / corner;
    let v = v.clamp(0.0, 1.0);
    Rgba::new(v, v, v, 1.0)
}

fn colour_wheel(x: usize, y: usize, w: usize, h: usize) -> Rgba {
    let cx = (w - 1) as f32 / 2.0;
    let cy = (h - 1) as f32 / 2.0;
    let dx = x as f32 - cx;
    let dy = y as f32 - cy;
    let radius = (dx * dx + dy * dy).sqrt();
    // The largest disc that fits, minus a pixel, so the rim is a hard edge
    // against the background rather than a shape clipped by the frame.
    let rim = cx.min(cy) - 1.0;

    if radius > rim {
        return Rgba::new(0.0, 0.0, 0.0, 1.0);
    }

    // `atan2` is the one call in this module that the platform's libm may round
    // differently by an ulp. It feeds a hue, and a hue an ulp apart produces the
    // same 8-bit sRGB triple everywhere except on an exact rounding boundary, so
    // the exposure is the same one `srgb_to_linear`'s `powf` and OKLab's `cbrt`
    // already carry throughout the crate. It is named here rather than hidden,
    // and it is the reason the harness compares with a differing-pixel budget
    // instead of demanding bit equality across architectures.
    let angle = dy.atan2(dx);
    let hue = angle / std::f32::consts::TAU + 0.5;
    // Saturation reaches 1 at [`SATURATED_FROM`] of the rim rather than only on
    // the rim itself. On a wheel where saturation is exactly the radius, full
    // chroma exists on a circle of zero width and no pixel actually lands on it,
    // so the gamut corners — the colours the whole fixture is here to put in
    // front of the palette matcher — are approached and never reached. Holding
    // the outer band saturated puts them in the image.
    let saturation = (radius / (rim * SATURATED_FROM)).clamp(0.0, 1.0);

    let (r, g, b) = hsv_to_srgb(hue, saturation, 1.0);
    Rgba::new(srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), 1.0)
}

/// The eight patches of the chart's top half, as 8-bit sRGB. Black, white and
/// mid grey for the neutral axis; the three primaries and two of the secondaries
/// for the corners of the cube a palette of four greens cannot reach at all.
const PATCHES: [[u8; 3]; 8] = [
    [0x00, 0x00, 0x00],
    [0xFF, 0xFF, 0xFF],
    [0x80, 0x80, 0x80],
    [0xFF, 0x00, 0x00],
    [0x00, 0xFF, 0x00],
    [0x00, 0x00, 0xFF],
    [0x00, 0xFF, 0xFF],
    [0xFF, 0xFF, 0x00],
];

/// Pitch of the line screen in the chart's bottom-right quadrant.
const LINE_PITCH: usize = 3;

fn hard_edge_chart(x: usize, y: usize, w: usize, h: usize) -> Rgba {
    let half_h = h / 2;
    let code = if y < half_h {
        // Four across, two down. Integer division puts the remainder in the
        // last cell of each axis, which makes the patches unequal by a pixel or
        // two — that is fine, and it is honest about a 101-wide image not
        // dividing by four.
        let col = (x * 4 / w).min(3);
        let row = (y * 2 / half_h).min(1);
        PATCHES[row * 4 + col]
    } else if x < w / 2 {
        // One-pixel checkerboard: the highest frequency the grid can carry, and
        // the input on which a diffusion kernel has nothing to gain and every
        // opportunity to smear.
        if (x + y).is_multiple_of(2) {
            [0xFF, 0xFF, 0xFF]
        } else {
            [0x00, 0x00, 0x00]
        }
    } else if y.is_multiple_of(LINE_PITCH) {
        [0xFF, 0xFF, 0xFF]
    } else {
        [0x00, 0x00, 0x00]
    };

    decode(code)
}

fn flat_mid_grey() -> Rgba {
    let v = srgb_to_linear(MID_GREY_CODE);
    Rgba::new(v, v, v, 1.0)
}

/// 8-bit sRGB triple to linear light, exactly as [`crate::color::decode_srgb`]
/// would decode it out of a loaded PNG.
fn decode(code: [u8; 3]) -> Rgba {
    Rgba::new(
        srgb_to_linear(code[0] as f32 / 255.0),
        srgb_to_linear(code[1] as f32 / 255.0),
        srgb_to_linear(code[2] as f32 / 255.0),
        1.0,
    )
}

/// HSV to sRGB, all components in `0..=1`.
///
/// HSV and not OKLab: this fixture wants the saturated rim of the sRGB gamut at
/// every hue, which is what HSV at S=V=1 traces exactly and what a constant-
/// lightness OKLab ring does not — most of that ring falls outside the gamut and
/// would come back clamped, turning a hue sweep into a sweep of clipped corners.
fn hsv_to_srgb(hue: f32, saturation: f32, value: f32) -> (f32, f32, f32) {
    let h = (hue.fract() + 1.0).fract() * 6.0;
    let sector = h.floor();
    let f = h - sector;

    let p = value * (1.0 - saturation);
    let q = value * (1.0 - saturation * f);
    let t = value * (1.0 - saturation * (1.0 - f));

    match sector as u32 % 6 {
        0 => (value, t, p),
        1 => (q, value, p),
        2 => (p, value, t),
        3 => (p, q, value),
        4 => (t, p, value),
        _ => (value, p, q),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::linear_to_srgb;

    fn mean(pixels: &[Rgba]) -> (f32, f32, f32) {
        let n = pixels.len() as f32;
        (
            pixels.iter().map(|p| p.r).sum::<f32>() / n,
            pixels.iter().map(|p| p.g).sum::<f32>() / n,
            pixels.iter().map(|p| p.b).sum::<f32>() / n,
        )
    }

    #[test]
    fn the_registry_is_consistent() {
        let mut ids: Vec<&str> = FIXTURES.iter().map(|f| f.id).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "duplicate fixture id");

        for f in FIXTURES {
            assert!(!f.name.is_empty(), "{}: no display name", f.id);
            assert!(
                f.id.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "{}: id is not kebab-case",
                f.id
            );
            // The id becomes a directory name under core/fixtures.
            assert!(!f.id.starts_with('-') && !f.id.ends_with('-'), "{}", f.id);
            assert_eq!(by_id(f.id).map(|g| g.id), Some(f.id));
        }
        assert_eq!(by_id("no-such-fixture").map(|f| f.id), None);
    }

    #[test]
    fn every_fixture_fills_its_declared_dimensions() {
        for f in FIXTURES {
            let px = f.render();
            assert_eq!(px.len(), f.pixel_count(), "{}", f.id);
            assert_eq!(px.len(), f.width * f.height, "{}", f.id);
            assert!(f.width > 0 && f.height > 0, "{}", f.id);
        }
    }

    /// Every value has to be inside the unit cube and opaque. A fixture that
    /// leaked a negative or above-one channel would push the palette match into
    /// a region no real image reaches, and every golden built from it would be
    /// testing behaviour that cannot occur.
    #[test]
    fn every_fixture_stays_inside_the_unit_cube_and_is_opaque() {
        for f in FIXTURES {
            for (i, p) in f.render().iter().enumerate() {
                assert!(
                    (0.0..=1.0).contains(&p.r)
                        && (0.0..=1.0).contains(&p.g)
                        && (0.0..=1.0).contains(&p.b),
                    "{} pixel {i} is {p:?}",
                    f.id
                );
                assert_eq!(p.a, 1.0, "{} pixel {i} is not opaque", f.id);
            }
        }
    }

    /// The property the whole harness rests on: a fixture is a pure function.
    /// If one ever picked up a seed, a clock or an iteration order that is not
    /// specified, every reference image in the tree would silently stop meaning
    /// anything.
    #[test]
    fn every_fixture_is_bit_identical_when_rendered_twice() {
        for f in FIXTURES {
            let a = f.render();
            let b = f.render();
            assert!(
                a.iter().zip(&b).all(|(x, y)| x == y),
                "{} is not reproducible",
                f.id
            );
        }
    }

    #[test]
    fn the_ramp_spans_black_to_white_linearly() {
        let px = LINEAR_RAMP.render();
        let w = LINEAR_RAMP.width;
        assert_eq!(px[0].r, 0.0);
        assert_eq!(px[w - 1].r, 1.0);

        // Every row identical, and every step the same size: this is what makes
        // a band mean comparable to the band's own input level.
        let step = px[1].r - px[0].r;
        for x in 1..w {
            assert!((px[x].r - px[x - 1].r - step).abs() < 1e-6, "at column {x}");
        }
        for y in 1..LINEAR_RAMP.height {
            for x in 0..w {
                assert_eq!(px[y * w + x], px[x], "row {y} differs at column {x}");
            }
        }
    }

    #[test]
    fn the_radial_gradient_is_white_at_the_centre_and_black_at_the_corners() {
        let f = RADIAL_GRADIENT;
        let px = f.render();
        let (w, h) = (f.width, f.height);

        // Even dimensions, so the exact centre falls between four pixels; each
        // of them sits half a pixel out and comes back just under white.
        let centre = px[(h / 2) * w + w / 2];
        assert!(centre.r > 0.98, "centre is {centre:?}");

        for (x, y) in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)] {
            let corner = px[y * w + x];
            assert!(corner.r < 1e-6, "corner ({x}, {y}) is {corner:?}");
        }
        // Neutral throughout: any chroma here would be arithmetic drift.
        assert!(px.iter().all(|p| p.r == p.g && p.g == p.b));
    }

    /// The wheel has to actually reach the saturated corners of the gamut, or
    /// it is a pastel disc and it stops testing what per-channel diffusion does
    /// with a colour the palette cannot represent.
    ///
    /// Compared in the encoding, not in linear light, and with a stated slack.
    /// A wheel sampled on a pixel grid cannot land exactly on a sector boundary
    /// at every hue: the angular step at the rim is about 1/39 of a radian, so
    /// the nearest sample to a corner sits up to half a step away and one
    /// channel comes back a little short of full. That is a property of drawing
    /// a circle on a grid, not of the fixture, and the slack is sized to it
    /// rather than to whatever made the test pass.
    #[test]
    fn the_colour_wheel_reaches_every_primary_and_secondary() {
        const SLACK: f32 = 0.04;
        let px = COLOUR_WHEEL.render();
        let corners: [[u8; 3]; 6] = [
            [0xFF, 0x00, 0x00],
            [0xFF, 0xFF, 0x00],
            [0x00, 0xFF, 0x00],
            [0x00, 0xFF, 0xFF],
            [0x00, 0x00, 0xFF],
            [0xFF, 0x00, 0xFF],
        ];
        for want in corners {
            let closest = px
                .iter()
                .map(|p| {
                    let d = |v: f32, code: u8| (linear_to_srgb(v) - code as f32 / 255.0).abs();
                    d(p.r, want[0]).max(d(p.g, want[1])).max(d(p.b, want[2]))
                })
                .fold(f32::INFINITY, f32::min);
            assert!(
                closest < SLACK,
                "the wheel gets no nearer {want:?} than {closest} in the encoding"
            );
        }

        // And the centre is white: saturation goes to zero on the axis, and the
        // odd dimensions put a pixel exactly there.
        let f = COLOUR_WHEEL;
        let centre = px[(f.height / 2) * f.width + f.width / 2];
        assert_eq!(
            centre,
            Rgba::new(1.0, 1.0, 1.0, 1.0),
            "centre is {centre:?}"
        );
    }

    #[test]
    fn the_hard_edge_chart_carries_hard_edges_at_the_nyquist_limit() {
        let f = HARD_EDGE_CHART;
        let px = f.render();
        let (w, h) = (f.width, f.height);

        // The checkerboard quadrant alternates every pixel along a row.
        let y = h - 1;
        for x in 1..w / 2 {
            let a = px[y * w + x - 1].r;
            let b = px[y * w + x].r;
            assert_ne!(a, b, "checkerboard is flat at ({x}, {y})");
        }

        // The line screen repeats at its pitch and nowhere else.
        let x = w - 1;
        for y in h / 2..h {
            let lit = px[y * w + x].r > 0.5;
            assert_eq!(
                lit,
                y.is_multiple_of(LINE_PITCH),
                "line screen wrong at row {y}"
            );
        }

        // Every patch colour appears somewhere in the top half.
        for code in PATCHES {
            let want = decode(code);
            assert!(
                px[..(h / 2) * w].contains(&want),
                "patch {code:?} is missing"
            );
        }
    }

    /// The number this fixture exists to make true. sRGB 0x80 is 0.2159 in
    /// linear light, not 0.5, and dithering against 0.5 is the mistake the
    /// whole pipeline is arranged to avoid.
    #[test]
    fn the_flat_field_is_mid_grey_in_the_encoding_and_a_fifth_in_light() {
        let px = FLAT_MID_GREY.render();
        let first = px[0];
        assert!(px.iter().all(|p| *p == first), "the flat field is not flat");
        assert!(
            (first.r - 0.215_86).abs() < 1e-4,
            "linear value {}",
            first.r
        );
        assert!(
            (linear_to_srgb(first.r) - MID_GREY_CODE).abs() < 1e-5,
            "does not encode back to 0x80"
        );
    }

    /// Means, recorded because they are what the colour-correctness tests
    /// compare a dithered result against. A change here is a change to every
    /// reference image in the tree, and it should not be possible to make one
    /// by accident.
    #[test]
    fn the_fixture_means_are_what_the_colour_tests_expect() {
        // A linear ramp over 128 evenly spaced levels: (0 + 1) / 2 exactly.
        let (r, _, _) = mean(&LINEAR_RAMP.render());
        assert!((r - 0.5).abs() < 1e-5, "ramp mean {r}");

        // A cone over a square, normalized to the half-diagonal: the mean is
        // `1 - E[d]/corner`, and the mean distance from the centre of a square
        // to a point in it is about 0.5483 of the half-diagonal.
        let (r, _, _) = mean(&RADIAL_GRADIENT.render());
        assert!((0.44..0.46).contains(&r), "radial mean {r}");

        let (r, _, _) = mean(&FLAT_MID_GREY.render());
        assert!((r - 0.215_86).abs() < 1e-4, "flat mean {r}");
    }
}
