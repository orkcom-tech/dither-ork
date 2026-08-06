//! Error-diffusion dithering.
//!
//! These kernels are inherently serial — each pixel's value depends on error
//! propagated from pixels already processed — so they cannot be expressed as a
//! shader and live here on the CPU. The ~48 per-pixel-independent effects run
//! as WebGPU compute passes instead; see docs/ARCHITECTURE.md.
//!
//! Scaffold status: Floyd-Steinberg and Atkinson are implemented against the
//! shared kernel machinery. The remaining 13 kernels of F-ED-01..15 are added
//! by declaring their coefficient tables — no new code paths.

use crate::color::Rgba;
use crate::palette::{Metric, Palette};

/// One error-distribution term: an offset from the current pixel and the share
/// of the quantization error it receives.
#[derive(Clone, Copy, Debug)]
pub struct Tap {
    pub dx: i32,
    pub dy: i32,
    pub weight: f32,
}

/// A named diffusion kernel. `divisor` is applied to every tap weight so the
/// tables below can be written as the integers they are published as.
#[derive(Clone, Copy, Debug)]
pub struct Kernel {
    pub id: &'static str,
    pub name: &'static str,
    pub taps: &'static [Tap],
    pub divisor: f32,
}

macro_rules! tap {
    ($dx:expr, $dy:expr, $w:expr) => {
        Tap { dx: $dx, dy: $dy, weight: $w }
    };
}

/// F-ED-01. Floyd & Steinberg, 1976.
pub const FLOYD_STEINBERG: Kernel = Kernel {
    id: "floyd-steinberg",
    name: "Floyd-Steinberg",
    taps: &[
        tap!(1, 0, 7.0),
        tap!(-1, 1, 3.0),
        tap!(0, 1, 5.0),
        tap!(1, 1, 1.0),
    ],
    divisor: 16.0,
};

/// F-ED-09. Atkinson, Apple, mid-1980s. Distributes only 6/8 of the error,
/// which is why it blows out highlights and shadows the way it does — that
/// loss is the look, not a bug.
pub const ATKINSON: Kernel = Kernel {
    id: "atkinson",
    name: "Atkinson",
    taps: &[
        tap!(1, 0, 1.0),
        tap!(2, 0, 1.0),
        tap!(-1, 1, 1.0),
        tap!(0, 1, 1.0),
        tap!(1, 1, 1.0),
        tap!(0, 2, 1.0),
    ],
    divisor: 8.0,
};

/// Every kernel registered so far. The web layer reads this to build its effect
/// list rather than keeping a parallel copy.
pub const KERNELS: &[Kernel] = &[FLOYD_STEINBERG, ATKINSON];

pub fn kernel_by_id(id: &str) -> Option<&'static Kernel> {
    KERNELS.iter().find(|k| k.id == id)
}

/// Shared controls for every diffusion kernel (F-ED-CTL).
#[derive(Clone, Copy, Debug)]
pub struct Options {
    /// 0.0 = no diffusion (plain nearest-colour quantization), 1.0 = full.
    pub strength: f32,
    /// Alternate scan direction per row. Removes the directional worming that
    /// left-to-right-only scanning produces.
    pub serpentine: bool,
    /// Clamp accumulated error into this symmetric range before quantizing.
    pub error_clamp: f32,
    pub metric: Metric,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            strength: 1.0,
            serpentine: true,
            error_clamp: 1.0,
            metric: Metric::Oklab,
        }
    }
}

/// Result of a dither pass.
///
/// Both buffers are returned deliberately. The index map is what makes
/// hue-targeted recolour, index remap, outline, dilate/erode and the SVG
/// tracer lossless and cheap downstream; carrying it is a chosen memory cost.
pub struct DitherResult {
    pub pixels: Vec<Rgba>,
    pub indices: Vec<u16>,
}

/// Run `kernel` over a linear-light buffer, quantizing to `palette`.
///
/// Panics if `pixels.len() != width * height`.
pub fn dither(
    pixels: &[Rgba],
    width: usize,
    height: usize,
    palette: &Palette,
    kernel: &Kernel,
    opts: Options,
) -> DitherResult {
    assert_eq!(pixels.len(), width * height, "buffer does not match dimensions");

    let mut work: Vec<Rgba> = pixels.to_vec();
    let mut out = vec![Rgba::new(0.0, 0.0, 0.0, 0.0); pixels.len()];
    let mut indices = vec![0u16; pixels.len()];
    let strength = opts.strength.clamp(0.0, 1.0);

    for y in 0..height {
        let reversed = opts.serpentine && y % 2 == 1;
        for step in 0..width {
            let x = if reversed { width - 1 - step } else { step };
            let i = y * width + x;

            let current = work[i];
            let idx = palette.nearest(current, opts.metric);
            let chosen = palette.color(idx);

            indices[i] = idx as u16;
            out[i] = Rgba::new(chosen.r, chosen.g, chosen.b, current.a);

            if strength <= 0.0 {
                continue;
            }

            let err = (
                (current.r - chosen.r) * strength,
                (current.g - chosen.g) * strength,
                (current.b - chosen.b) * strength,
            );

            for tap in kernel.taps {
                // Mirror the horizontal offset when scanning right-to-left,
                // otherwise serpentine scanning pushes error the wrong way.
                let dx = if reversed { -tap.dx } else { tap.dx };
                let nx = x as i32 + dx;
                let ny = y as i32 + tap.dy;
                if nx < 0 || ny < 0 || nx >= width as i32 || ny >= height as i32 {
                    continue;
                }
                let ni = ny as usize * width + nx as usize;
                let w = tap.weight / kernel.divisor;
                let c = opts.error_clamp;
                work[ni].r = (work[ni].r + err.0 * w).clamp(-c, 1.0 + c);
                work[ni].g = (work[ni].g + err.1 * w).clamp(-c, 1.0 + c);
                work[ni].b = (work[ni].b + err.2 * w).clamp(-c, 1.0 + c);
            }
        }
    }

    DitherResult { pixels: out, indices }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::palette::builtin;

    /// The colour-correctness test from docs/ARCHITECTURE.md: a flat mid-grey
    /// dithered to 1-bit must average back to its own luminance. This is the
    /// test that fails when the pipeline diffuses in sRGB instead of linear.
    #[test]
    fn flat_grey_averages_back_to_itself() {
        let (w, h) = (64usize, 64usize);
        let level = crate::color::srgb_to_linear(0.5);
        let src = vec![Rgba::new(level, level, level, 1.0); w * h];
        let pal = Palette::from_srgb_rgb(builtin::MONO);

        let res = dither(&src, w, h, &pal, &FLOYD_STEINBERG, Options::default());
        let mean: f32 = res.pixels.iter().map(|p| p.r).sum::<f32>() / (w * h) as f32;

        assert!((mean - level).abs() < 0.02, "mean {mean} vs target {level}");
    }

    #[test]
    fn indices_stay_inside_the_palette() {
        let (w, h) = (16usize, 16usize);
        let src = vec![Rgba::new(0.3, 0.6, 0.2, 1.0); w * h];
        let pal = Palette::from_srgb_rgb(builtin::GAMEBOY_DMG);
        let res = dither(&src, w, h, &pal, &ATKINSON, Options::default());
        assert!(res.indices.iter().all(|&i| (i as usize) < pal.len()));
    }

    #[test]
    fn zero_strength_is_plain_quantization() {
        let (w, h) = (8usize, 8usize);
        let src = vec![Rgba::new(0.9, 0.9, 0.9, 1.0); w * h];
        let pal = Palette::from_srgb_rgb(builtin::MONO);
        let opts = Options { strength: 0.0, ..Options::default() };
        let res = dither(&src, w, h, &pal, &FLOYD_STEINBERG, opts);
        assert!(res.indices.iter().all(|&i| i == 1));
    }
}
