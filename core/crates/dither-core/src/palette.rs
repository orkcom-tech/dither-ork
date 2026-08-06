//! Palettes, nearest-colour matching, the built-in hardware library (F-CO-04)
//! and the sorting and ramp helpers of F-CO-06.

use crate::color::{linear_to_oklab, linear_to_srgb, oklab_distance_sq, Oklab, Rgba};

/// How a pixel is matched to a palette entry. Both are legitimate outputs:
/// OKLab is perceptually correct, sRGB Euclidean reproduces the look of
/// period-accurate tools that did the maths in gamma space.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Metric {
    Oklab,
    SrgbEuclidean,
}

/// An sRGB-encoded palette entry, precomputed once in [`Palette::new`].
#[derive(Clone, Copy, Debug)]
struct SrgbTriple {
    r: f32,
    g: f32,
    b: f32,
}

#[derive(Clone, Debug)]
pub struct Palette {
    colors: Vec<Rgba>,
    oklab: Vec<Oklab>,
    /// sRGB-encoded copies of `colors`.
    ///
    /// Encoding them inside the match loop cost three `powf` calls per palette
    /// entry per pixel — 192 million for a 4-megapixel image against 16
    /// colours, in the one loop the whole preview waits on, and every one of
    /// them recomputing a value that had not changed since the palette was
    /// built. The OKLab branch has always precomputed; this is the same trade.
    /// `linear_to_srgb` is pure, so the table holds bit-identical values to the
    /// ones the loop used to produce and no match moves.
    srgb: Vec<SrgbTriple>,
}

impl Palette {
    /// Build from linear-light colours. Alpha is carried but not matched on.
    pub fn new(colors: Vec<Rgba>) -> Self {
        assert!(!colors.is_empty(), "palette must have at least one colour");
        let oklab = colors.iter().copied().map(linear_to_oklab).collect();
        let srgb = colors
            .iter()
            .map(|c| SrgbTriple {
                r: linear_to_srgb(c.r),
                g: linear_to_srgb(c.g),
                b: linear_to_srgb(c.b),
            })
            .collect();
        Self {
            colors,
            oklab,
            srgb,
        }
    }

    /// Build from packed 8-bit sRGB triplets (`[r, g, b, r, g, b, ...]`).
    pub fn from_srgb_rgb(bytes: &[u8]) -> Self {
        assert!(
            bytes.len().is_multiple_of(3),
            "palette bytes must be a multiple of 3"
        );
        let colors = bytes
            .chunks_exact(3)
            .map(|c| {
                Rgba::new(
                    crate::color::srgb_to_linear(c[0] as f32 / 255.0),
                    crate::color::srgb_to_linear(c[1] as f32 / 255.0),
                    crate::color::srgb_to_linear(c[2] as f32 / 255.0),
                    1.0,
                )
            })
            .collect();
        Self::new(colors)
    }

    pub fn len(&self) -> usize {
        self.colors.len()
    }

    pub fn is_empty(&self) -> bool {
        self.colors.is_empty()
    }

    pub fn color(&self, index: usize) -> Rgba {
        self.colors[index]
    }

    /// Every entry, in palette order. The palette editor and the swatch list
    /// read this rather than calling [`Palette::color`] in a loop.
    pub fn colors(&self) -> &[Rgba] {
        &self.colors
    }

    /// Index of the nearest palette entry under `metric`.
    ///
    /// Linear scan. Correct and cache-friendly for the palette sizes this tool
    /// deals with (typically 2..64); a k-d tree only pays off far above that.
    pub fn nearest(&self, c: Rgba, metric: Metric) -> usize {
        match metric {
            Metric::Oklab => {
                let target = linear_to_oklab(c);
                let mut best = 0usize;
                let mut best_d = f32::INFINITY;
                for (i, p) in self.oklab.iter().enumerate() {
                    let d = oklab_distance_sq(target, *p);
                    if d < best_d {
                        best_d = d;
                        best = i;
                    }
                }
                best
            }
            Metric::SrgbEuclidean => {
                let t = (
                    linear_to_srgb(c.r),
                    linear_to_srgb(c.g),
                    linear_to_srgb(c.b),
                );
                let mut best = 0usize;
                let mut best_d = f32::INFINITY;
                for (i, p) in self.srgb.iter().enumerate() {
                    let dr = p.r - t.0;
                    let dg = p.g - t.1;
                    let db = p.b - t.2;
                    let d = dr * dr + dg * dg + db * db;
                    if d < best_d {
                        best_d = d;
                        best = i;
                    }
                }
                best
            }
        }
    }

    /// Order the palette by `key`, returning a permutation rather than a new
    /// palette (F-CO-06).
    ///
    /// `order[new_position] == old_index`. The permutation is the useful form
    /// because reordering a palette without putting the index map through
    /// [`remap_indices`] silently corrupts every downstream index-map
    /// operation — outline, dilate/erode, hue-targeted recolour, the tracer.
    ///
    /// Ties break on the original index, so the result is a total order and two
    /// runs cannot disagree.
    pub fn sort_order(&self, key: SortKey<'_>) -> Vec<usize> {
        let mut order: Vec<usize> = (0..self.len()).collect();
        match key {
            SortKey::Hue => {
                let hue: Vec<f32> = self.oklab.iter().map(|c| hue_angle(*c)).collect();
                order.sort_unstable_by(|&x, &y| {
                    hue[x]
                        .total_cmp(&hue[y])
                        .then(self.oklab[x].l.total_cmp(&self.oklab[y].l))
                        .then(x.cmp(&y))
                });
            }
            SortKey::Luminance => {
                order.sort_unstable_by(|&x, &y| {
                    self.oklab[x].l.total_cmp(&self.oklab[y].l).then(x.cmp(&y))
                });
            }
            SortKey::Population(counts) => {
                assert_eq!(
                    counts.len(),
                    self.len(),
                    "population sort needs one count per palette entry"
                );
                order.sort_unstable_by(|&x, &y| counts[y].cmp(&counts[x]).then(x.cmp(&y)));
            }
        }
        order
    }

    /// Apply a permutation from [`Palette::sort_order`].
    pub fn reordered(&self, order: &[usize]) -> Palette {
        assert_permutation(order, self.len());
        Palette::new(order.iter().map(|&i| self.colors[i]).collect())
    }
}

/// How a palette is ordered by [`Palette::sort_order`] (F-CO-06).
#[derive(Clone, Copy, Debug)]
pub enum SortKey<'a> {
    /// OKLab hue angle, ascending from red through yellow, green, blue.
    ///
    /// Neutral entries have no meaningful hue — `atan2(0.0, 0.0)` is zero — so
    /// they collect at the start of the order and sort among themselves by
    /// lightness. That is inherent to ordering by hue rather than a defect, and
    /// it beats splitting neutrals out with a chroma threshold, which would put
    /// an arbitrary constant in the middle of a user-visible ordering.
    Hue,
    /// OKLab lightness, ascending: dark to light.
    Luminance,
    /// Pixel count, descending: most-used entry first.
    ///
    /// Population is not a property of a palette — it belongs to the extraction
    /// that produced it, and the same palette applied to another image has
    /// different counts — so the counts travel with the key instead of being
    /// stored on `Palette`. [`crate::quantize::Quantized::populations`] is the
    /// slice to pass.
    Population(&'a [u32]),
}

/// Rewrite an index map so it addresses a palette reordered by `order`.
///
/// Must be called on every index map that belongs to a palette passed through
/// [`Palette::reordered`]. Panics on an index outside the palette rather than
/// remapping it to something plausible.
pub fn remap_indices(indices: &mut [u16], order: &[usize]) {
    let n = order.len();
    assert_permutation(order, n);
    assert!(
        n <= usize::from(u16::MAX) + 1,
        "an index map cannot address {n} entries"
    );

    // `order` maps new position -> old index; an index map needs the inverse.
    let mut inverse = vec![0u16; n];
    for (new_pos, &old) in order.iter().enumerate() {
        inverse[old] = new_pos as u16;
    }
    for i in indices.iter_mut() {
        let old = usize::from(*i);
        assert!(old < n, "index {old} is outside a palette of {n} entries");
        *i = inverse[old];
    }
}

/// A generated colour ramp (F-CO-06).
pub struct Ramp {
    pub colors: Vec<Rgba>,
    /// How many steps left the sRGB cube and were clamped back into it.
    ///
    /// A straight line in OKLab between two in-gamut endpoints can leave the
    /// gamut, because the gamut is a cube in linear light and OKLab bends it.
    /// The clamp is reported rather than applied silently, so the palette
    /// editor can say that a ramp is not fully reproducible instead of the user
    /// discovering it at export.
    pub clamped: usize,
}

/// Interpolate `steps` colours from `from` to `to` along a straight line in
/// OKLab (F-CO-06).
///
/// OKLab and not linear light: a linear-light interpolation between two
/// saturated colours passes through a desaturated, wrongly-lit middle, which is
/// exactly what a ramp must not do. Endpoints are emitted verbatim rather than
/// round-tripped through OKLab, so an in-gamut locked swatch at either end
/// comes back bit-identical.
///
/// Panics if `steps < 2` — a ramp between two colours has two ends.
pub fn oklab_ramp(from: Rgba, to: Rgba, steps: usize) -> Ramp {
    assert!(steps >= 2, "a ramp needs at least two steps, got {steps}");

    let a = linear_to_oklab(from);
    let b = linear_to_oklab(to);
    let last = steps - 1;

    let mut colors = Vec::with_capacity(steps);
    let mut clamped = 0usize;
    for i in 0..steps {
        let t = i as f32 / last as f32;
        let alpha = from.a + (to.a - from.a) * t;
        let (r, g, bl) = if i == 0 {
            (from.r, from.g, from.b)
        } else if i == last {
            (to.r, to.g, to.b)
        } else {
            oklab_to_linear(Oklab {
                l: a.l + (b.l - a.l) * t,
                a: a.a + (b.a - a.a) * t,
                b: a.b + (b.b - a.b) * t,
            })
        };

        let inside =
            (0.0..=1.0).contains(&r) && (0.0..=1.0).contains(&g) && (0.0..=1.0).contains(&bl);
        if !inside {
            clamped += 1;
        }
        colors.push(Rgba::new(
            r.clamp(0.0, 1.0),
            g.clamp(0.0, 1.0),
            bl.clamp(0.0, 1.0),
            alpha.clamp(0.0, 1.0),
        ));
    }

    Ramp { colors, clamped }
}

/// OKLab hue angle in `[0, 2pi)`.
fn hue_angle(c: Oklab) -> f32 {
    let h = c.b.atan2(c.a);
    if h < 0.0 {
        h + std::f32::consts::TAU
    } else {
        h
    }
}

/// OKLab -> linear-light sRGB primaries.
///
/// The inverse of [`crate::color::linear_to_oklab`], with Ottosson's published
/// inverse matrices. It belongs in `color.rs` next to the forward transform and
/// should be moved there; it lives here only because ramp generation needed it
/// and `color.rs` is owned by another build step. Nothing outside this module
/// uses it.
///
/// The result may fall outside `0..=1`: OKLab is larger than the sRGB gamut, so
/// an interpolated coordinate can name a colour sRGB cannot show. Callers
/// decide what to do about that; this function does not clamp, because
/// clamping here would hide the fact from them.
fn oklab_to_linear(c: Oklab) -> (f32, f32, f32) {
    let l_ = c.l + 0.396_337_78 * c.a + 0.215_803_76 * c.b;
    let m_ = c.l - 0.105_561_346 * c.a - 0.063_854_17 * c.b;
    let s_ = c.l - 0.089_484_18 * c.a - 1.291_485_5 * c.b;

    let l = l_ * l_ * l_;
    let m = m_ * m_ * m_;
    let s = s_ * s_ * s_;

    (
        4.076_741_7 * l - 3.307_711_6 * m + 0.230_969_94 * s,
        -1.268_438 * l + 2.609_757_4 * m - 0.341_319_38 * s,
        -0.004_196_086_3 * l - 0.703_418_6 * m + 1.707_614_7 * s,
    )
}

/// Panics unless `order` is a permutation of `0..n`. A malformed permutation
/// would silently drop or duplicate palette entries, and the damage would only
/// show up as wrong colours several nodes downstream.
fn assert_permutation(order: &[usize], n: usize) {
    assert_eq!(order.len(), n, "permutation must cover every palette entry");
    let mut seen = vec![false; n];
    for &i in order {
        assert!(i < n, "permutation entry {i} is outside 0..{n}");
        assert!(!seen[i], "permutation repeats entry {i}");
        seen[i] = true;
    }
}

/// Built-in hardware palettes (F-CO-04).
///
/// Only factual hardware colour specifications are bundled — see the vault-side
/// architecture note, "Palette library provenance". Curated community palettes
/// are imported by the user at runtime (F-CO-11, F-CO-12), never redistributed,
/// which removes the sourcing question rather than answering it.
///
/// Every constant records where its values come from. A palette whose real
/// values could not be established is **not** shipped with invented numbers; it
/// is left out until a citable table is available. The NES (no digital RGB
/// spec — the PPU emits composite, so every RGB table is one particular
/// measurement or simulation) and the Apple II (likewise NTSC artefact colours,
/// with several mutually incompatible published tables) are the two omissions.
pub mod builtin {
    /// A shipped palette, with a stable id so documents and the web layer can
    /// name it without a parallel hard-coded copy — the same arrangement
    /// `diffusion::KERNELS` uses for effects.
    #[derive(Clone, Copy, Debug)]
    pub struct BuiltinPalette {
        /// Stable across releases. `.dork` documents store it.
        pub id: &'static str,
        pub name: &'static str,
        /// Packed 8-bit sRGB triplets — the layout `.dork` and the WASM
        /// boundary already use, so nothing converts in between.
        pub srgb: &'static [u8],
    }

    /// 1-bit black and white.
    pub const MONO: &[u8] = &[0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF];

    /// The Macintosh 128K through Classic screen: 512x342, one bit per pixel,
    /// no greys. The same two values as [`MONO`], listed separately because the
    /// requirement names it and because that is what a user searches for.
    pub const MAC_1BIT: &[u8] = MONO;

    /// Game Boy DMG, four shades of the original LCD green.
    ///
    /// Source: the widely reproduced rendering of the DMG panel. The hardware
    /// itself specifies two bits per pixel and no colour — the green is the
    /// panel's appearance, which varies between units and is not a published
    /// specification.
    pub const GAMEBOY_DMG: &[u8] = &[
        0x08, 0x18, 0x20, //
        0x34, 0x68, 0x56, //
        0x88, 0xC0, 0x70, //
        0xE0, 0xF8, 0xD0,
    ];

    /// Game Boy Pocket (MGB): the same two-bits-per-pixel framebuffer as the
    /// DMG behind a neutral grey STN panel instead of the green one.
    ///
    /// Source: the hardware specification is "four shades, no colour", so these
    /// are the four evenly spaced 8-bit grey levels. The panel's exact measured
    /// tint differs per unit and is not specified anywhere; nothing is invented
    /// here beyond even spacing, which is stated rather than implied.
    pub const GAMEBOY_POCKET: &[u8] = &[
        0x00, 0x00, 0x00, //
        0x55, 0x55, 0x55, //
        0xAA, 0xAA, 0xAA, //
        0xFF, 0xFF, 0xFF,
    ];

    /// IBM CGA, the full 16-colour RGBI set (text modes and 160x100).
    ///
    /// Source: the IBM Color/Graphics Monitor Adaptor specification. Each of
    /// R, G, B is on at 0xAA or off, and the I line lifts an on channel to 0xFF
    /// and an off channel to 0x55. Entry 6 is the documented exception: its
    /// green is halved to 0x55 so that "dark yellow" reads as brown, a fix
    /// wired into the monitor rather than the adaptor.
    pub const CGA_16: &[u8] = &[
        0x00, 0x00, 0x00, // 0  black
        0x00, 0x00, 0xAA, // 1  blue
        0x00, 0xAA, 0x00, // 2  green
        0x00, 0xAA, 0xAA, // 3  cyan
        0xAA, 0x00, 0x00, // 4  red
        0xAA, 0x00, 0xAA, // 5  magenta
        0xAA, 0x55, 0x00, // 6  brown
        0xAA, 0xAA, 0xAA, // 7  light grey
        0x55, 0x55, 0x55, // 8  dark grey
        0x55, 0x55, 0xFF, // 9  light blue
        0x55, 0xFF, 0x55, // 10 light green
        0x55, 0xFF, 0xFF, // 11 light cyan
        0xFF, 0x55, 0x55, // 12 light red
        0xFF, 0x55, 0xFF, // 13 light magenta
        0xFF, 0xFF, 0x55, // 14 yellow
        0xFF, 0xFF, 0xFF, // 15 white
    ];

    /// CGA 320x200 four-colour graphics, palette 0, low intensity: the
    /// background (black here; it is selectable) plus CGA colours 2, 4 and 6.
    pub const CGA_0_LOW: &[u8] = &[
        0x00, 0x00, 0x00, //
        0x00, 0xAA, 0x00, //
        0xAA, 0x00, 0x00, //
        0xAA, 0x55, 0x00,
    ];

    /// CGA 320x200, palette 0, high intensity: CGA colours 10, 12 and 14.
    pub const CGA_0_HIGH: &[u8] = &[
        0x00, 0x00, 0x00, //
        0x55, 0xFF, 0x55, //
        0xFF, 0x55, 0x55, //
        0xFF, 0xFF, 0x55,
    ];

    /// CGA 320x200, palette 1, low intensity: CGA colours 3, 5 and 7.
    pub const CGA_1_LOW: &[u8] = &[
        0x00, 0x00, 0x00, //
        0x00, 0xAA, 0xAA, //
        0xAA, 0x00, 0xAA, //
        0xAA, 0xAA, 0xAA,
    ];

    /// CGA palette 1, high intensity.
    pub const CGA_1_HIGH: &[u8] = &[
        0x00, 0x00, 0x00, //
        0x55, 0xFF, 0xFF, //
        0xFF, 0x55, 0xFF, //
        0xFF, 0xFF, 0xFF,
    ];

    /// CGA mode 5 — the 320x200 mode that appears when colour burst is disabled
    /// on a composite display: CGA colours 3, 4 and 7. Undocumented by IBM at
    /// the time and used heavily anyway, which is why it is here.
    pub const CGA_MODE_5: &[u8] = &[
        0x00, 0x00, 0x00, //
        0x00, 0xAA, 0xAA, //
        0xAA, 0x00, 0x00, //
        0xAA, 0xAA, 0xAA,
    ];

    /// EGA, the default 16 of its 64 colours.
    ///
    /// Source: the EGA's master palette is two bits per channel — every
    /// combination of 0x00, 0x55, 0xAA and 0xFF — and the palette registers
    /// come up selecting exactly the CGA RGBI set for compatibility. Same
    /// sixteen values, therefore the same table; the difference is that on EGA
    /// they are reprogrammable.
    pub const EGA_16: &[u8] = CGA_16;

    /// Commodore 64, VIC-II.
    ///
    /// Source: Philip "Pepto" Timmermann's derivation of the VIC-II's colour
    /// generator from the chip's own luma/chroma circuit, which is the
    /// reference the emulator authors converged on. Ordered by the VIC-II's
    /// own colour numbering.
    pub const C64: &[u8] = &[
        0x00, 0x00, 0x00, // 0  black
        0xFF, 0xFF, 0xFF, // 1  white
        0x68, 0x37, 0x2B, // 2  red
        0x70, 0xA4, 0xB2, // 3  cyan
        0x6F, 0x3D, 0x86, // 4  purple
        0x58, 0x8D, 0x43, // 5  green
        0x35, 0x28, 0x79, // 6  blue
        0xB8, 0xC7, 0x6F, // 7  yellow
        0x6F, 0x4F, 0x25, // 8  orange
        0x43, 0x39, 0x00, // 9  brown
        0x9A, 0x67, 0x59, // 10 light red
        0x44, 0x44, 0x44, // 11 dark grey
        0x6C, 0x6C, 0x6C, // 12 grey
        0x9A, 0xD2, 0x84, // 13 light green
        0x6C, 0x5E, 0xB5, // 14 light blue
        0x95, 0x95, 0x95, // 15 light grey
    ];

    /// ZX Spectrum, ULA output.
    ///
    /// Source: the ULA drives three digital colour lines plus a BRIGHT line
    /// through a resistor network, so a channel is off, on at roughly 0.84 of
    /// full scale (0xD7), or on at full scale when BRIGHT is set. That gives
    /// sixteen attribute combinations but only fifteen distinct colours —
    /// BRIGHT black is black — and the duplicate is dropped rather than shipped
    /// as a wasted palette slot.
    pub const ZX_SPECTRUM: &[u8] = &[
        0x00, 0x00, 0x00, // black
        0x00, 0x00, 0xD7, // blue
        0xD7, 0x00, 0x00, // red
        0xD7, 0x00, 0xD7, // magenta
        0x00, 0xD7, 0x00, // green
        0x00, 0xD7, 0xD7, // cyan
        0xD7, 0xD7, 0x00, // yellow
        0xD7, 0xD7, 0xD7, // white
        0x00, 0x00, 0xFF, // bright blue
        0xFF, 0x00, 0x00, // bright red
        0xFF, 0x00, 0xFF, // bright magenta
        0x00, 0xFF, 0x00, // bright green
        0x00, 0xFF, 0xFF, // bright cyan
        0xFF, 0xFF, 0x00, // bright yellow
        0xFF, 0xFF, 0xFF, // bright white
    ];

    /// PICO-8.
    ///
    /// Source: the console's own published palette. A fantasy console rather
    /// than silicon, but it is a fixed specification with exact values, which
    /// is the property the provenance rule is actually about.
    pub const PICO8: &[u8] = &[
        0x00, 0x00, 0x00, // 0  black
        0x1D, 0x2B, 0x53, // 1  dark blue
        0x7E, 0x25, 0x53, // 2  dark purple
        0x00, 0x87, 0x51, // 3  dark green
        0xAB, 0x52, 0x36, // 4  brown
        0x5F, 0x57, 0x4F, // 5  dark grey
        0xC2, 0xC3, 0xC7, // 6  light grey
        0xFF, 0xF1, 0xE8, // 7  white
        0xFF, 0x00, 0x4D, // 8  red
        0xFF, 0xA3, 0x00, // 9  orange
        0xFF, 0xEC, 0x27, // 10 yellow
        0x00, 0xE4, 0x36, // 11 green
        0x29, 0xAD, 0xFF, // 12 blue
        0x83, 0x76, 0x9C, // 13 lavender
        0xFF, 0x77, 0xA8, // 14 pink
        0xFF, 0xCC, 0xAA, // 15 light peach
    ];

    /// World System Teletext.
    ///
    /// Source: ETS 300 706. Each of R, G and B is fully on or fully off, giving
    /// eight colours, in the standard's own code order.
    pub const TELETEXT: &[u8] = &[
        0x00, 0x00, 0x00, // 0 black
        0xFF, 0x00, 0x00, // 1 red
        0x00, 0xFF, 0x00, // 2 green
        0xFF, 0xFF, 0x00, // 3 yellow
        0x00, 0x00, 0xFF, // 4 blue
        0xFF, 0x00, 0xFF, // 5 magenta
        0x00, 0xFF, 0xFF, // 6 cyan
        0xFF, 0xFF, 0xFF, // 7 white
    ];

    /// Everything shipped, in the order the browser lists it. The web layer
    /// reads this table; it does not keep a copy.
    pub const BUILTINS: &[BuiltinPalette] = &[
        BuiltinPalette {
            id: "mono",
            name: "1-bit Mono",
            srgb: MONO,
        },
        BuiltinPalette {
            id: "mac-1bit",
            name: "Macintosh 1-bit",
            srgb: MAC_1BIT,
        },
        BuiltinPalette {
            id: "gameboy-dmg",
            name: "Game Boy DMG",
            srgb: GAMEBOY_DMG,
        },
        BuiltinPalette {
            id: "gameboy-pocket",
            name: "Game Boy Pocket",
            srgb: GAMEBOY_POCKET,
        },
        BuiltinPalette {
            id: "cga-16",
            name: "CGA 16",
            srgb: CGA_16,
        },
        BuiltinPalette {
            id: "cga-0-low",
            name: "CGA Palette 0 Low",
            srgb: CGA_0_LOW,
        },
        BuiltinPalette {
            id: "cga-0-high",
            name: "CGA Palette 0 High",
            srgb: CGA_0_HIGH,
        },
        BuiltinPalette {
            id: "cga-1-low",
            name: "CGA Palette 1 Low",
            srgb: CGA_1_LOW,
        },
        BuiltinPalette {
            id: "cga-1-high",
            name: "CGA Palette 1 High",
            srgb: CGA_1_HIGH,
        },
        BuiltinPalette {
            id: "cga-mode-5",
            name: "CGA Mode 5",
            srgb: CGA_MODE_5,
        },
        BuiltinPalette {
            id: "ega-16",
            name: "EGA 16",
            srgb: EGA_16,
        },
        BuiltinPalette {
            id: "c64",
            name: "Commodore 64",
            srgb: C64,
        },
        BuiltinPalette {
            id: "zx-spectrum",
            name: "ZX Spectrum",
            srgb: ZX_SPECTRUM,
        },
        BuiltinPalette {
            id: "pico-8",
            name: "PICO-8",
            srgb: PICO8,
        },
        BuiltinPalette {
            id: "teletext",
            name: "Teletext",
            srgb: TELETEXT,
        },
    ];

    pub fn by_id(id: &str) -> Option<&'static BuiltinPalette> {
        BUILTINS.iter().find(|p| p.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::srgb_to_linear;

    #[test]
    fn nearest_picks_the_obvious_entry() {
        let p = Palette::from_srgb_rgb(builtin::MONO);
        let black = Rgba::new(0.0, 0.0, 0.0, 1.0);
        let white = Rgba::new(1.0, 1.0, 1.0, 1.0);
        assert_eq!(p.nearest(black, Metric::Oklab), 0);
        assert_eq!(p.nearest(white, Metric::Oklab), 1);
    }

    /// The precomputed sRGB table must not move a single match. Recomputes the
    /// encode-inside-the-loop form the optimisation replaced and compares it
    /// against the shipped one over a dense sweep of the cube.
    #[test]
    fn precomputed_srgb_matching_is_identical_to_encoding_in_the_loop() {
        for bytes in [builtin::CGA_16, builtin::C64, builtin::PICO8, builtin::MONO] {
            let pal = Palette::from_srgb_rgb(bytes);
            for ri in 0..12u32 {
                for gi in 0..12u32 {
                    for bi in 0..12u32 {
                        let c = Rgba::new(
                            srgb_to_linear(ri as f32 / 11.0),
                            srgb_to_linear(gi as f32 / 11.0),
                            srgb_to_linear(bi as f32 / 11.0),
                            1.0,
                        );

                        let t = (
                            linear_to_srgb(c.r),
                            linear_to_srgb(c.g),
                            linear_to_srgb(c.b),
                        );
                        let mut want = 0usize;
                        let mut want_d = f32::INFINITY;
                        for (i, p) in pal.colors().iter().enumerate() {
                            let dr = linear_to_srgb(p.r) - t.0;
                            let dg = linear_to_srgb(p.g) - t.1;
                            let db = linear_to_srgb(p.b) - t.2;
                            let d = dr * dr + dg * dg + db * db;
                            if d < want_d {
                                want_d = d;
                                want = i;
                            }
                        }

                        assert_eq!(pal.nearest(c, Metric::SrgbEuclidean), want, "{c:?}");
                    }
                }
            }
        }
    }

    #[test]
    fn every_builtin_is_well_formed_and_uniquely_named() {
        let mut ids: Vec<&str> = builtin::BUILTINS.iter().map(|p| p.id).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "builtin palette ids must be unique");

        for p in builtin::BUILTINS {
            assert!(!p.srgb.is_empty(), "{} is empty", p.id);
            assert!(p.srgb.len().is_multiple_of(3), "{} is misaligned", p.id);
            assert!(!p.name.is_empty(), "{} has no display name", p.id);
            assert_eq!(builtin::by_id(p.id).map(|b| b.id), Some(p.id));
            // Must actually build; `Palette::new` asserts on an empty list.
            let built = Palette::from_srgb_rgb(p.srgb);
            assert_eq!(built.len(), p.srgb.len() / 3);
        }
        assert!(builtin::by_id("no-such-palette").is_none());
    }

    /// The F-CO-04 minimum, by id. A rename that broke a saved document would
    /// otherwise only show up when someone opened an old `.dork`.
    #[test]
    fn the_required_minimum_palettes_are_present_under_stable_ids() {
        for id in [
            "mono",
            "mac-1bit",
            "gameboy-dmg",
            "gameboy-pocket",
            "cga-16",
            "cga-0-low",
            "cga-0-high",
            "cga-1-low",
            "cga-1-high",
            "cga-mode-5",
            "ega-16",
            "c64",
            "zx-spectrum",
            "pico-8",
            "teletext",
        ] {
            assert!(builtin::by_id(id).is_some(), "{id} is missing");
        }
    }

    #[test]
    fn no_hardware_palette_repeats_a_colour() {
        for p in builtin::BUILTINS {
            let mut seen: Vec<&[u8]> = p.srgb.chunks_exact(3).collect();
            let count = seen.len();
            seen.sort_unstable();
            seen.dedup();
            assert_eq!(seen.len(), count, "{} repeats a colour", p.id);
        }
    }

    #[test]
    fn luminance_sort_runs_dark_to_light() {
        let pal = Palette::from_srgb_rgb(builtin::CGA_16);
        let order = pal.sort_order(SortKey::Luminance);
        let sorted = pal.reordered(&order);
        let ls: Vec<f32> = sorted
            .colors()
            .iter()
            .map(|c| linear_to_oklab(*c).l)
            .collect();
        assert!(ls.windows(2).all(|w| w[0] <= w[1]), "{ls:?}");
        assert_eq!(sorted.len(), pal.len());
    }

    #[test]
    fn hue_sort_puts_neutrals_first_then_walks_the_wheel() {
        let pal = Palette::from_srgb_rgb(builtin::CGA_16);
        let order = pal.sort_order(SortKey::Hue);
        let sorted = pal.reordered(&order);
        let hues: Vec<f32> = sorted
            .colors()
            .iter()
            .map(|c| hue_angle(linear_to_oklab(*c)))
            .collect();
        assert!(hues.windows(2).all(|w| w[0] <= w[1]), "{hues:?}");
        // Black converts to exactly OKLab (0, 0, 0), so `atan2` returns a hard
        // zero for it and it sorts first. The greys do not: the forward matrix
        // rows do not sum to exactly one in f32, so a grey carries a few ulps
        // of chroma and lands at whatever angle those ulps point in. That is
        // the documented consequence of ordering neutrals by hue.
        assert_eq!(hues[0], 0.0);
    }

    #[test]
    fn population_sort_is_most_used_first() {
        let pal = Palette::from_srgb_rgb(builtin::CGA_1_HIGH);
        let counts = [3u32, 40, 1, 40];
        let order = pal.sort_order(SortKey::Population(&counts));
        // 40s first, and the tie between entries 1 and 3 breaks on the lower
        // original index so the ordering cannot flip between runs.
        assert_eq!(order, vec![1, 3, 0, 2]);
    }

    #[test]
    fn reordering_a_palette_and_its_index_map_preserves_every_pixel_colour() {
        let pal = Palette::from_srgb_rgb(builtin::C64);
        let counts: Vec<u32> = (0..pal.len() as u32).map(|i| i * 7 % 13).collect();
        let order = pal.sort_order(SortKey::Population(&counts));

        let mut indices: Vec<u16> = (0..pal.len() as u16).cycle().take(64).collect();
        let before: Vec<Rgba> = indices.iter().map(|&i| pal.color(usize::from(i))).collect();

        let sorted = pal.reordered(&order);
        remap_indices(&mut indices, &order);
        let after: Vec<Rgba> = indices
            .iter()
            .map(|&i| sorted.color(usize::from(i)))
            .collect();

        assert_eq!(before, after);
    }

    #[test]
    #[should_panic(expected = "permutation repeats entry")]
    fn a_malformed_permutation_panics_rather_than_dropping_entries() {
        let pal = Palette::from_srgb_rgb(builtin::CGA_1_HIGH);
        pal.reordered(&[0, 0, 1, 2]);
    }

    #[test]
    fn oklab_round_trips_through_its_inverse() {
        for ri in 0..8u32 {
            for gi in 0..8u32 {
                for bi in 0..8u32 {
                    let c = Rgba::new(
                        srgb_to_linear(ri as f32 / 7.0),
                        srgb_to_linear(gi as f32 / 7.0),
                        srgb_to_linear(bi as f32 / 7.0),
                        1.0,
                    );
                    let (r, g, b) = oklab_to_linear(linear_to_oklab(c));
                    assert!((r - c.r).abs() < 1e-4, "{c:?} -> {r}");
                    assert!((g - c.g).abs() < 1e-4, "{c:?} -> {g}");
                    assert!((b - c.b).abs() < 1e-4, "{c:?} -> {b}");
                }
            }
        }
    }

    #[test]
    fn a_ramp_hits_its_endpoints_exactly_and_rises_evenly_in_lightness() {
        let from = Rgba::new(0.02, 0.01, 0.05, 1.0);
        let to = Rgba::new(0.9, 0.85, 0.4, 1.0);
        let ramp = oklab_ramp(from, to, 9);

        assert_eq!(ramp.colors.len(), 9);
        assert_eq!(ramp.colors[0], from);
        assert_eq!(ramp.colors[8], to);

        // Even perceptual spacing is the whole point of ramping in OKLab.
        let ls: Vec<f32> = ramp.colors.iter().map(|c| linear_to_oklab(*c).l).collect();
        let steps: Vec<f32> = ls.windows(2).map(|w| w[1] - w[0]).collect();
        let first = steps[0];
        for s in &steps {
            assert!(
                (s - first).abs() < 1e-3,
                "uneven lightness steps: {steps:?}"
            );
        }
        assert_eq!(ramp.clamped, 0);
    }

    #[test]
    fn a_ramp_that_leaves_the_gamut_says_so() {
        // An endpoint outside the sRGB cube is a linear-light colour the
        // display cannot show. It gets clamped like any other out-of-gamut
        // step, and the count is what lets the palette editor tell the user
        // instead of the clamp appearing silently at export.
        let from = Rgba::new(-0.4, 0.9, -0.2, 1.0);
        let to = Rgba::new(0.2, 0.2, 0.2, 1.0);
        let ramp = oklab_ramp(from, to, 16);

        assert!(ramp.clamped > 0, "expected out-of-gamut steps");
        assert!(ramp.colors.iter().all(|c| {
            (0.0..=1.0).contains(&c.r) && (0.0..=1.0).contains(&c.g) && (0.0..=1.0).contains(&c.b)
        }));
        assert_eq!(ramp.colors[15], to, "the in-gamut endpoint is untouched");
    }

    #[test]
    #[should_panic(expected = "a ramp needs at least two steps")]
    fn a_one_step_ramp_panics() {
        oklab_ramp(
            Rgba::new(0.0, 0.0, 0.0, 1.0),
            Rgba::new(1.0, 1.0, 1.0, 1.0),
            1,
        );
    }
}
