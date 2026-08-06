//! WebAssembly bindings for dither-core.
//!
//! The API surface is documented in docs/API.md. Buffers cross the boundary as
//! flat typed arrays; nothing here allocates on the JS side.
//!
//! Nothing in this crate decides anything. It validates what came in, names the
//! failure when it is bad, and hands the work to `dither-core` — which is why
//! the core can stay free of any notion that a browser exists.

use dither_core::color::{decode_srgb, encode_srgb, Rgba};
use dither_core::diffusion::{self, Options};
use dither_core::noise;
use dither_core::palette::{builtin, Metric, Palette};
use dither_core::quantize;
use wasm_bindgen::prelude::*;

/// Version of the compiled core. The web layer logs this at startup so a stale
/// WASM build is visible rather than mysterious.
#[wasm_bindgen]
pub fn version() -> String {
    dither_core::VERSION.to_string()
}

/// One registered diffusion kernel: the id the API takes, and the name a person
/// reads.
#[wasm_bindgen]
pub struct KernelInfo {
    id: String,
    name: String,
}

#[wasm_bindgen]
impl KernelInfo {
    /// Stable id. This is what goes in a `.dork` document and in a share URL,
    /// so it never changes once shipped.
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> String {
        self.id.clone()
    }

    /// Display name. Free to change; nothing is keyed on it.
    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.name.clone()
    }
}

/// Every registered error-diffusion kernel, in catalogue order.
///
/// The web layer builds its effect list from this rather than keeping a
/// parallel copy that can drift. It carries the display name as well as the id
/// for exactly that reason — a UI that has only ids has to invent labels, and
/// invented labels are a second list.
#[wasm_bindgen]
pub fn kernels() -> Vec<KernelInfo> {
    diffusion::KERNELS
        .iter()
        .map(|k| KernelInfo {
            id: k.id.to_string(),
            name: k.name.to_string(),
        })
        .collect()
}

/// Colour distance metric. A look control, not a correctness switch: `Oklab` is
/// perceptually correct, `Srgb` reproduces what period-accurate tools did by
/// doing the maths in gamma space.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColorMetric {
    Oklab = 0,
    Srgb = 1,
}

/// Whether error is diffused per channel or as a single luminance term
/// (F-ED-CTL).
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiffusionChannels {
    PerChannel = 0,
    Luma = 1,
}

/// Every control of F-ED-CTL, as one object.
///
/// This replaces the eight positional parameters `dither_image` used to take.
/// The controls only grow — threshold jitter, the overshoot clamp and the
/// channel mode arrived together and would have made it eleven — and a call
/// site with eleven bare positionals is one transposition away from silently
/// dithering with the wrong strength. Named properties cannot be transposed.
///
/// The kernel is a constructor argument rather than a settable property because
/// it is the one choice the object cannot be built without, and because
/// resolving it once means an unknown id is reported where it was written
/// instead of at render time.
#[wasm_bindgen]
pub struct DitherOptions {
    kernel: &'static diffusion::Kernel,
    strength: f32,
    serpentine: bool,
    jitter: f32,
    seed: u64,
    overshoot_limit: f32,
    channels: DiffusionChannels,
    metric: ColorMetric,
}

#[wasm_bindgen]
impl DitherOptions {
    /// Build the options for `kernel_id`, with every control at its default.
    ///
    /// Throws on an unrecognised id, listing nothing — the caller has
    /// [`kernels`] and should not be guessing.
    #[wasm_bindgen(constructor)]
    pub fn new(kernel_id: &str) -> Result<DitherOptions, JsError> {
        let kernel = diffusion::kernel_by_id(kernel_id)
            .ok_or_else(|| JsError::new(&format!("unknown kernel id: {kernel_id}")))?;
        let defaults = Options::default();
        Ok(DitherOptions {
            kernel,
            strength: defaults.strength,
            serpentine: defaults.serpentine,
            jitter: defaults.jitter,
            seed: defaults.seed,
            overshoot_limit: defaults.overshoot_limit,
            channels: DiffusionChannels::PerChannel,
            metric: ColorMetric::Oklab,
        })
    }

    /// Id of the kernel these options were built for.
    #[wasm_bindgen(getter, js_name = kernelId)]
    pub fn kernel_id(&self) -> String {
        self.kernel.id.to_string()
    }

    /// Diffusion strength, 0..=1. 0 is plain nearest-colour quantization.
    #[wasm_bindgen(getter)]
    pub fn strength(&self) -> f32 {
        self.strength
    }

    #[wasm_bindgen(setter)]
    pub fn set_strength(&mut self, value: f32) {
        self.strength = value;
    }

    /// Alternate the scan direction per row. Ignored by Riemersma, which does
    /// not scan in rows at all.
    #[wasm_bindgen(getter)]
    pub fn serpentine(&self) -> bool {
        self.serpentine
    }

    #[wasm_bindgen(setter)]
    pub fn set_serpentine(&mut self, value: bool) {
        self.serpentine = value;
    }

    /// Seeded threshold jitter, 0..=1.
    #[wasm_bindgen(getter)]
    pub fn jitter(&self) -> f32 {
        self.jitter
    }

    #[wasm_bindgen(setter)]
    pub fn set_jitter(&mut self, value: f32) {
        self.jitter = value;
    }

    /// Seed for the jitter draws, as a `BigInt`.
    ///
    /// 64 bits and explicit, because the document seed is 64 bits (F-SM-02) and
    /// nothing in a render path is allowed to invent one (F-AN-05). Narrowing
    /// it to a JS `number` here would quietly throw away half of it.
    #[wasm_bindgen(getter)]
    pub fn seed(&self) -> u64 {
        self.seed
    }

    #[wasm_bindgen(setter)]
    pub fn set_seed(&mut self, value: u64) {
        self.seed = value;
    }

    /// How far outside `[0, 1]` an accumulated working value may travel before
    /// it is pinned. Bounds the working buffer, not the error term.
    #[wasm_bindgen(getter, js_name = overshootLimit)]
    pub fn overshoot_limit(&self) -> f32 {
        self.overshoot_limit
    }

    #[wasm_bindgen(setter, js_name = overshootLimit)]
    pub fn set_overshoot_limit(&mut self, value: f32) {
        self.overshoot_limit = value;
    }

    /// Per-channel or luma diffusion.
    #[wasm_bindgen(getter)]
    pub fn channels(&self) -> DiffusionChannels {
        self.channels
    }

    #[wasm_bindgen(setter)]
    pub fn set_channels(&mut self, value: DiffusionChannels) {
        self.channels = value;
    }

    /// Palette-matching metric.
    #[wasm_bindgen(getter)]
    pub fn metric(&self) -> ColorMetric {
        self.metric
    }

    #[wasm_bindgen(setter)]
    pub fn set_metric(&mut self, value: ColorMetric) {
        self.metric = value;
    }
}

impl DitherOptions {
    /// Validate and convert to the core's options.
    ///
    /// Range checks live here rather than in the setters because a setter that
    /// silently clamps is a setter that lies about what it stored, and one that
    /// throws makes a property assignment a `try` block. Both are worse than
    /// one refusal at the point the values are actually used.
    fn to_core(&self) -> Result<Options, JsError> {
        fn unit(name: &str, value: f32) -> Result<f32, JsError> {
            if value.is_finite() && (0.0..=1.0).contains(&value) {
                Ok(value)
            } else {
                Err(JsError::new(&format!(
                    "{name} must be within 0..=1, got {value}"
                )))
            }
        }

        if !self.overshoot_limit.is_finite() || self.overshoot_limit < 0.0 {
            return Err(JsError::new(&format!(
                "overshootLimit must be finite and not negative, got {}",
                self.overshoot_limit
            )));
        }

        Ok(Options {
            strength: unit("strength", self.strength)?,
            serpentine: self.serpentine,
            jitter: unit("jitter", self.jitter)?,
            seed: self.seed,
            overshoot_limit: self.overshoot_limit,
            channels: match self.channels {
                DiffusionChannels::PerChannel => diffusion::ChannelMode::PerChannel,
                DiffusionChannels::Luma => diffusion::ChannelMode::Luma,
            },
            metric: match self.metric {
                ColorMetric::Oklab => Metric::Oklab,
                ColorMetric::Srgb => Metric::SrgbEuclidean,
            },
        })
    }
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
/// * `options` — a [`DitherOptions`], which carries the kernel.
///
/// Decodes to linear light, dithers, and re-encodes. Returns an error rather
/// than panicking on bad input, so a malformed call surfaces as a rejected
/// promise instead of an aborted WASM instance.
#[wasm_bindgen(js_name = ditherImage)]
pub fn dither_image(
    rgba: &[u8],
    width: u32,
    height: u32,
    palette_rgb: &[u8],
    options: &DitherOptions,
) -> Result<DitherOutput, JsError> {
    let (w, h) = (width as usize, height as usize);

    if w == 0 || h == 0 {
        return Err(JsError::new(&format!(
            "image dimensions must both be positive, got {w}x{h}"
        )));
    }
    // Checked against the product rather than trusting the multiplication:
    // `width * height * 4` can overflow a u32 long before it runs out of
    // memory, and an overflowed length that happened to match would read past
    // the buffer.
    let expected = (w as u64) * (h as u64) * 4;
    if rgba.len() as u64 != expected {
        return Err(JsError::new(&format!(
            "rgba length {} does not match {w}x{h} (expected {expected})",
            rgba.len()
        )));
    }
    if palette_rgb.is_empty() || !palette_rgb.len().is_multiple_of(3) {
        return Err(JsError::new(
            "palette_rgb must be a non-empty multiple of 3 bytes",
        ));
    }
    // The index map is u16, so a palette that cannot be named by one would be
    // silently wrapped by the core. Refused here, where the caller can see it.
    let entries = palette_rgb.len() / 3;
    if entries > u16::MAX as usize + 1 {
        return Err(JsError::new(&format!(
            "palette of {entries} entries does not fit a u16 index map"
        )));
    }

    let opts = options.to_core()?;
    let pixels = decode_srgb(rgba);
    let palette = Palette::from_srgb_rgb(palette_rgb);

    let result = diffusion::dither(&pixels, w, h, &palette, options.kernel, opts);

    Ok(DitherOutput {
        pixels: encode_srgb(&result.pixels),
        indices: result.indices,
        width,
        height,
    })
}

// ---------------------------------------------------------------------------
// Palette library (F-CO-04)
// ---------------------------------------------------------------------------

/// One shipped hardware palette.
#[wasm_bindgen]
pub struct PaletteInfo {
    id: String,
    name: String,
    srgb: Vec<u8>,
}

#[wasm_bindgen]
impl PaletteInfo {
    /// Stable id. `.dork` documents store it, so it never changes once shipped.
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> String {
        self.id.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.name.clone()
    }

    /// Packed 8-bit sRGB triplets — the layout `.dork`, [`dither_image`] and the
    /// GPU palette upload all already take, so nothing converts in between.
    #[wasm_bindgen(getter)]
    pub fn srgb(&self) -> Vec<u8> {
        self.srgb.clone()
    }
}

/// Every built-in hardware palette, in catalogue order (F-CO-04).
///
/// Same arrangement as [`kernels`]: the web layer reads this table instead of
/// keeping a copy that can drift out of sync with the values the renderer
/// actually uses.
#[wasm_bindgen(js_name = builtinPalettes)]
pub fn builtin_palettes() -> Vec<PaletteInfo> {
    builtin::BUILTINS
        .iter()
        .map(|p| PaletteInfo {
            id: p.id.to_string(),
            name: p.name.to_string(),
            srgb: p.srgb.to_vec(),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Palette extraction (F-CO-02)
// ---------------------------------------------------------------------------

/// Which extraction algorithm to run (F-CO-02).
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExtractMethod {
    MedianCut = 0,
    Wu = 1,
    KMeans = 2,
}

/// Extraction settings, as one object for the same reason [`DitherOptions`] is
/// one: the set only grows, and four bare positionals of which three are
/// integers is a transposition waiting to happen.
#[wasm_bindgen]
pub struct ExtractOptions {
    method: ExtractMethod,
    k: usize,
    seed: u64,
    max_iterations: u32,
}

#[wasm_bindgen]
impl ExtractOptions {
    /// Defaults straight from the core: Wu, 16 colours, seed 0, 64 iterations.
    #[wasm_bindgen(constructor)]
    pub fn new() -> ExtractOptions {
        let defaults = quantize::Options::default();
        ExtractOptions {
            method: ExtractMethod::Wu,
            k: defaults.k,
            seed: defaults.seed,
            max_iterations: defaults.max_iterations,
        }
    }

    #[wasm_bindgen(getter)]
    pub fn method(&self) -> ExtractMethod {
        self.method
    }

    #[wasm_bindgen(setter)]
    pub fn set_method(&mut self, value: ExtractMethod) {
        self.method = value;
    }

    /// Requested palette size. The result may be smaller when the image does
    /// not hold that many distinguishable colours — [`ExtractedPalette::report_palette_len`]
    /// against [`ExtractedPalette::report_occupied_bins`] says why.
    #[wasm_bindgen(getter)]
    pub fn k(&self) -> usize {
        self.k
    }

    #[wasm_bindgen(setter)]
    pub fn set_k(&mut self, value: usize) {
        self.k = value;
    }

    /// Explicit 64-bit seed, as a `BigInt`. Only k-means draws from it today;
    /// all three take one so a later stochastic step cannot arrive unseeded.
    #[wasm_bindgen(getter)]
    pub fn seed(&self) -> u64 {
        self.seed
    }

    #[wasm_bindgen(setter)]
    pub fn set_seed(&mut self, value: u64) {
        self.seed = value;
    }

    /// Ceiling on Lloyd iterations. Ignored by the single-pass methods.
    #[wasm_bindgen(getter, js_name = maxIterations)]
    pub fn max_iterations(&self) -> u32 {
        self.max_iterations
    }

    #[wasm_bindgen(setter, js_name = maxIterations)]
    pub fn set_max_iterations(&mut self, value: u32) {
        self.max_iterations = value;
    }
}

impl Default for ExtractOptions {
    fn default() -> Self {
        Self::new()
    }
}

/// An extracted palette, its index map, and what the extraction actually did.
///
/// The report travels with the result rather than being logged inside the core:
/// `dither-core` has no logger, because a crate that must not know a browser
/// exists must not pick the browser's logging story either.
#[wasm_bindgen]
pub struct ExtractedPalette {
    srgb: Vec<u8>,
    indices: Vec<u16>,
    populations: Vec<u32>,
    report: quantize::Report,
}

#[wasm_bindgen]
impl ExtractedPalette {
    /// Packed 8-bit sRGB triplets, ready to hand straight back to
    /// [`dither_image`].
    #[wasm_bindgen(getter)]
    pub fn srgb(&self) -> Vec<u8> {
        self.srgb.clone()
    }

    /// One palette index per source pixel, in source order.
    #[wasm_bindgen(getter)]
    pub fn indices(&self) -> Vec<u16> {
        self.indices.clone()
    }

    /// Pixels matched to each entry. The input to a population sort (F-CO-06).
    #[wasm_bindgen(getter)]
    pub fn populations(&self) -> Vec<u32> {
        self.populations.clone()
    }

    /// Entries actually produced. Below `k` when the image had fewer
    /// distinguishable colours than were asked for.
    #[wasm_bindgen(getter, js_name = paletteLen)]
    pub fn palette_len(&self) -> usize {
        self.report.palette_len
    }

    /// Occupied bins in the shared histogram: the ceiling on palette size for
    /// this image, and the explanation for a short palette.
    #[wasm_bindgen(getter, js_name = occupiedBins)]
    pub fn occupied_bins(&self) -> usize {
        self.report.occupied_bins
    }

    /// Lloyd iterations run. Zero for the single-pass methods.
    #[wasm_bindgen(getter)]
    pub fn iterations(&self) -> u32 {
        self.report.iterations
    }

    /// Clusters that lost every member and were re-seeded deterministically.
    #[wasm_bindgen(getter, js_name = emptyClusterRepairs)]
    pub fn empty_cluster_repairs(&self) -> u32 {
        self.report.empty_cluster_repairs
    }

    /// Clusters still empty at the end, which produced no palette entry.
    #[wasm_bindgen(getter, js_name = emptyClustersDropped)]
    pub fn empty_clusters_dropped(&self) -> u32 {
        self.report.empty_clusters_dropped
    }
}

/// Extract a palette from an sRGB RGBA image (F-CO-02).
///
/// Decodes to linear light, clusters there, and hands back sRGB triplets — the
/// same round trip [`dither_image`] does, so an extracted palette fed straight
/// back in matches what the extraction saw.
///
/// Every one of `extract`'s panics is a caller error with no defensible answer,
/// so each is checked here and returned as a JS error instead of aborting the
/// WASM instance.
#[wasm_bindgen(js_name = extractPalette)]
pub fn extract_palette(
    rgba: &[u8],
    width: u32,
    height: u32,
    options: &ExtractOptions,
) -> Result<ExtractedPalette, JsError> {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 {
        return Err(JsError::new(&format!(
            "image dimensions must both be positive, got {w}x{h}"
        )));
    }
    let expected = (w as u64) * (h as u64) * 4;
    if rgba.len() as u64 != expected {
        return Err(JsError::new(&format!(
            "rgba length {} does not match {w}x{h} (expected {expected})",
            rgba.len()
        )));
    }
    // `populations` counts pixels in a u32, and the core asserts on the same
    // bound; refused here so the message names the image rather than the assert.
    if u32::try_from(w * h).is_err() {
        return Err(JsError::new(&format!(
            "{w}x{h} is more pixels than the population counters address"
        )));
    }
    if options.k == 0 || options.k > usize::from(u16::MAX) + 1 {
        return Err(JsError::new(&format!(
            "palette size {} must be between 1 and {}",
            options.k,
            usize::from(u16::MAX) + 1
        )));
    }
    if options.max_iterations == 0 {
        return Err(JsError::new("maxIterations must be at least 1"));
    }

    let pixels = decode_srgb(rgba);
    let quantized = quantize::extract(
        &pixels,
        quantize::Options {
            method: match options.method {
                ExtractMethod::MedianCut => quantize::Method::MedianCut,
                ExtractMethod::Wu => quantize::Method::Wu,
                ExtractMethod::KMeans => quantize::Method::KMeans,
            },
            k: options.k,
            seed: options.seed,
            max_iterations: options.max_iterations,
        },
    );

    Ok(ExtractedPalette {
        srgb: pack_srgb_triplets(quantized.palette.colors()),
        indices: quantized.indices,
        populations: quantized.populations,
        report: quantized.report,
    })
}

/// Linear-light palette entries to packed 8-bit sRGB triplets.
///
/// Goes through the core's own [`encode_srgb`] and drops alpha rather than
/// rounding independently: a palette that came back one level off the one the
/// renderer uses would show up as a barely-wrong colour and nothing else.
fn pack_srgb_triplets(colors: &[Rgba]) -> Vec<u8> {
    encode_srgb(colors)
        .chunks_exact(4)
        .flat_map(|rgba| [rgba[0], rgba[1], rgba[2]])
        .collect()
}

// ---------------------------------------------------------------------------
// Threshold matrices (F-OD-01..05)
// ---------------------------------------------------------------------------

/// Bayer ranks for a `size` x `size` tile, row-major (F-OD-01..04).
///
/// Ranks and not thresholds. The shader turns rank `k` into `(k + 0.5) / n`
/// itself, so the CPU and GPU halves of one stack derive their thresholds from
/// bit-identical integers instead of from two float divisions that agree only
/// to within an ulp — see `web/src/gpu/matrices.ts`.
#[wasm_bindgen(js_name = bayerRanks)]
pub fn bayer_ranks(size: u32) -> Result<Vec<u32>, JsError> {
    let size = size as usize;
    if size < 2 || !size.is_power_of_two() {
        return Err(JsError::new(&format!(
            "Bayer tiles are powers of two of at least 2; got {size}"
        )));
    }
    Ok(noise::bayer_ranks(size))
}

/// Void-and-cluster blue-noise ranks for a `size` x `size` tile (F-OD-05).
///
/// `seed` is explicit and 64-bit for the same reason every other seed in this
/// boundary is: nothing in a render path invents one (F-AN-05), and the same
/// seed must give a byte-identical tile on every platform.
///
/// Cost is `O(size^4)`. 64x64 is a fraction of a second; build once and cache.
#[wasm_bindgen(js_name = blueNoiseRanks)]
pub fn blue_noise_ranks(size: u32, seed: u64) -> Result<Vec<u32>, JsError> {
    let size = size as usize;
    if size < 4 || !size.is_power_of_two() {
        return Err(JsError::new(&format!(
            "blue-noise tiles are powers of two of at least 4; got {size}"
        )));
    }
    Ok(noise::blue_noise_ranks(size, seed))
}
