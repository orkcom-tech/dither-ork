//! Palettes and nearest-colour matching.

use crate::color::{linear_to_oklab, oklab_distance_sq, Oklab, Rgba};

/// How a pixel is matched to a palette entry. Both are legitimate outputs:
/// OKLab is perceptually correct, sRGB Euclidean reproduces the look of
/// period-accurate tools that did the maths in gamma space.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Metric {
    Oklab,
    SrgbEuclidean,
}

#[derive(Clone, Debug)]
pub struct Palette {
    colors: Vec<Rgba>,
    oklab: Vec<Oklab>,
}

impl Palette {
    /// Build from linear-light colours. Alpha is carried but not matched on.
    pub fn new(colors: Vec<Rgba>) -> Self {
        assert!(!colors.is_empty(), "palette must have at least one colour");
        let oklab = colors.iter().copied().map(linear_to_oklab).collect();
        Self { colors, oklab }
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
                    crate::color::linear_to_srgb(c.r),
                    crate::color::linear_to_srgb(c.g),
                    crate::color::linear_to_srgb(c.b),
                );
                let mut best = 0usize;
                let mut best_d = f32::INFINITY;
                for (i, p) in self.colors.iter().enumerate() {
                    let dr = crate::color::linear_to_srgb(p.r) - t.0;
                    let dg = crate::color::linear_to_srgb(p.g) - t.1;
                    let db = crate::color::linear_to_srgb(p.b) - t.2;
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
}

/// Built-in hardware palettes. Only factual hardware colour specifications are
/// bundled — see docs/ARCHITECTURE.md, "Palette library provenance". Curated
/// community palettes are imported by the user at runtime, never redistributed.
pub mod builtin {
    /// 1-bit black and white.
    pub const MONO: &[u8] = &[0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF];

    /// Game Boy DMG, four shades of the original LCD green.
    pub const GAMEBOY_DMG: &[u8] = &[
        0x08, 0x18, 0x20, //
        0x34, 0x68, 0x56, //
        0x88, 0xC0, 0x70, //
        0xE0, 0xF8, 0xD0,
    ];

    /// CGA palette 1, high intensity.
    pub const CGA_1_HIGH: &[u8] = &[
        0x00, 0x00, 0x00, //
        0x55, 0xFF, 0xFF, //
        0xFF, 0x55, 0xFF, //
        0xFF, 0xFF, 0xFF,
    ];
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_picks_the_obvious_entry() {
        let p = Palette::from_srgb_rgb(builtin::MONO);
        let black = Rgba::new(0.0, 0.0, 0.0, 1.0);
        let white = Rgba::new(1.0, 1.0, 1.0, 1.0);
        assert_eq!(p.nearest(black, Metric::Oklab), 0);
        assert_eq!(p.nearest(white, Metric::Oklab), 1);
    }
}
