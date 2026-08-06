//! WebAssembly bindings for dither-core.
//!
//! The API surface is documented in docs/API.md. Buffers cross the boundary as
//! flat typed arrays; nothing here allocates on the JS side.

use dither_core::color::{decode_srgb, encode_srgb};
use dither_core::diffusion::{self, Options};
use dither_core::palette::{Metric, Palette};
use wasm_bindgen::prelude::*;

/// Version of the compiled core. The web layer logs this at startup so a stale
/// WASM build is visible rather than mysterious.
#[wasm_bindgen]
pub fn version() -> String {
    dither_core::VERSION.to_string()
}

/// Ids of every registered diffusion kernel, newline separated.
///
/// The web layer builds its effect list from this rather than keeping a
/// parallel copy that can drift.
#[wasm_bindgen]
pub fn kernel_ids() -> String {
    diffusion::KERNELS
        .iter()
        .map(|k| k.id)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Result of a dither pass, held on the WASM side so the caller can take the
/// buffers it actually wants without copying both.
#[wasm_bindgen]
pub struct DitherOutput {
    pixels: Vec<u8>,
    indices: Vec<u16>,
    width: u32,
    height: u32,
}

#[wasm_bindgen]
impl DitherOutput {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }

    /// 8-bit sRGB RGBA, ready for `ImageData` or a texture upload.
    #[wasm_bindgen(getter)]
    pub fn pixels(&self) -> Vec<u8> {
        self.pixels.clone()
    }

    /// One palette index per pixel. Downstream index-map operations — outline,
    /// dilate/erode, hue-targeted recolour, the SVG tracer — consume this.
    #[wasm_bindgen(getter)]
    pub fn indices(&self) -> Vec<u16> {
        self.indices.clone()
    }
}

/// Run an error-diffusion kernel over an sRGB RGBA image.
///
/// * `rgba` — 8-bit sRGB RGBA, `width * height * 4` bytes.
/// * `palette_rgb` — packed 8-bit sRGB triplets, length a multiple of 3.
/// * `kernel_id` — an id from [`kernel_ids`].
/// * `metric` — `"oklab"` (perceptual) or `"srgb"` (period-accurate).
///
/// Decodes to linear light, dithers, and re-encodes. Returns an error rather
/// than panicking on bad input, so a malformed call surfaces as a rejected
/// promise instead of an aborted WASM instance.
#[wasm_bindgen]
pub fn dither_image(
    rgba: &[u8],
    width: u32,
    height: u32,
    palette_rgb: &[u8],
    kernel_id: &str,
    strength: f32,
    serpentine: bool,
    metric: &str,
) -> Result<DitherOutput, JsError> {
    let (w, h) = (width as usize, height as usize);

    if rgba.len() != w * h * 4 {
        return Err(JsError::new(&format!(
            "rgba length {} does not match {}x{} (expected {})",
            rgba.len(),
            w,
            h,
            w * h * 4
        )));
    }
    if palette_rgb.is_empty() || palette_rgb.len() % 3 != 0 {
        return Err(JsError::new(
            "palette_rgb must be a non-empty multiple of 3 bytes",
        ));
    }

    let kernel = diffusion::kernel_by_id(kernel_id)
        .ok_or_else(|| JsError::new(&format!("unknown kernel id: {kernel_id}")))?;

    let metric = match metric {
        "oklab" => Metric::Oklab,
        "srgb" => Metric::SrgbEuclidean,
        other => {
            return Err(JsError::new(&format!(
                "unknown metric: {other} (expected \"oklab\" or \"srgb\")"
            )))
        }
    };

    let pixels = decode_srgb(rgba);
    let palette = Palette::from_srgb_rgb(palette_rgb);
    let opts = Options {
        strength,
        serpentine,
        metric,
        ..Options::default()
    };

    let result = diffusion::dither(&pixels, w, h, &palette, kernel, opts);

    Ok(DitherOutput {
        pixels: encode_srgb(&result.pixels),
        indices: result.indices,
        width,
        height,
    })
}
