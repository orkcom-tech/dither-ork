//! Colour conversion. Everything in the pipeline works in linear light; sRGB
//! transfer is removed on load and reapplied on export. Diffusing error in sRGB
//! instead of linear light is the single most common reason naive dither
//! implementations look muddy.

/// Linear-light RGBA, unassociated alpha, nominal range 0..=1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgba {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Rgba {
    pub const fn new(r: f32, g: f32, b: f32, a: f32) -> Self {
        Self { r, g, b, a }
    }
}

/// sRGB electro-optical transfer function: encoded value -> linear light.
#[inline]
pub fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.040_448_237 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// Inverse of [`srgb_to_linear`]: linear light -> encoded value.
#[inline]
pub fn linear_to_srgb(c: f32) -> f32 {
    if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

/// Decode 8-bit sRGB RGBA bytes into a linear-light buffer.
pub fn decode_srgb(bytes: &[u8]) -> Vec<Rgba> {
    assert!(bytes.len() % 4 == 0, "RGBA buffer length must be a multiple of 4");
    bytes
        .chunks_exact(4)
        .map(|p| {
            Rgba::new(
                srgb_to_linear(p[0] as f32 / 255.0),
                srgb_to_linear(p[1] as f32 / 255.0),
                srgb_to_linear(p[2] as f32 / 255.0),
                p[3] as f32 / 255.0,
            )
        })
        .collect()
}

/// Encode a linear-light buffer back to 8-bit sRGB RGBA bytes.
pub fn encode_srgb(pixels: &[Rgba]) -> Vec<u8> {
    let mut out = Vec::with_capacity(pixels.len() * 4);
    for p in pixels {
        out.push(quantize_u8(linear_to_srgb(p.r)));
        out.push(quantize_u8(linear_to_srgb(p.g)));
        out.push(quantize_u8(linear_to_srgb(p.b)));
        out.push(quantize_u8(p.a));
    }
    out
}

#[inline]
fn quantize_u8(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}

/// OKLab coordinates. Used for perceptual colour distance when matching a pixel
/// to a palette entry; the alternative metric (plain sRGB Euclidean) is exposed
/// as a deliberate look control, not as a correctness fallback.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Oklab {
    pub l: f32,
    pub a: f32,
    pub b: f32,
}

/// Linear-light sRGB primaries -> OKLab.
pub fn linear_to_oklab(c: Rgba) -> Oklab {
    let l = 0.412_221_46 * c.r + 0.536_332_55 * c.g + 0.051_445_995 * c.b;
    let m = 0.211_903_5 * c.r + 0.680_699_5 * c.g + 0.107_396_96 * c.b;
    let s = 0.088_302_46 * c.r + 0.281_718_84 * c.g + 0.629_978_5 * c.b;

    let l_ = l.cbrt();
    let m_ = m.cbrt();
    let s_ = s.cbrt();

    Oklab {
        l: 0.210_454_26 * l_ + 0.793_617_8 * m_ - 0.004_072_047 * s_,
        a: 1.977_998_5 * l_ - 2.428_592_2 * m_ + 0.450_593_7 * s_,
        b: 0.025_904_037 * l_ + 0.782_771_77 * m_ - 0.808_675_77 * s_,
    }
}

/// Squared perceptual distance. Squared because only ordering matters when
/// picking the nearest palette entry, and the square root costs a call per
/// pixel per palette entry.
#[inline]
pub fn oklab_distance_sq(a: Oklab, b: Oklab) -> f32 {
    let dl = a.l - b.l;
    let da = a.a - b.a;
    let db = a.b - b.b;
    dl * dl + da * da + db * db
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srgb_roundtrip_is_stable() {
        for i in 0..=255u16 {
            let v = i as f32 / 255.0;
            let round = linear_to_srgb(srgb_to_linear(v));
            assert!((round - v).abs() < 1e-4, "{v} -> {round}");
        }
    }

    #[test]
    fn midgrey_is_not_half_in_linear_light() {
        // The whole reason the pipeline works in linear light: sRGB 0.5 is
        // roughly 0.214 linear, not 0.5. Dithering against 0.5 is the bug.
        let linear = srgb_to_linear(0.5);
        assert!((linear - 0.2140).abs() < 1e-3, "got {linear}");
    }
}
