// F-PP-03 — Levels: input black/white, gamma, output black/white.
//
// The classical three-part transfer, in order: clip the input range to
// [black, white] and renormalise, bend the midtones with gamma, then remap onto
// [output black, output white].
//
// **The domain is display-referred**, the same as brightness/contrast
// (F-PP-02). That is not an aesthetic choice here, it is what the numbers mean:
// an input black point of 0.25 is the 64th of 256 codes on a histogram anybody
// has ever looked at, and a levels dialog's gamma is defined against the
// encoded value. Running the same numbers on the linear buffer would clip
// roughly three times as much visible shadow as the black point says it does,
// because linear 0.25 is 54% on screen. The buffer is linear light on the way
// in and on the way out; only the transfer is defined in gamma space. See
// `invert.wgsl` for the same reasoning stated at length.
//
// Keeping this and F-PP-02 in one domain is also what makes them compose: two
// affine controls and a power curve stack into the single transfer a user is
// picturing, rather than into three curves fighting each other.
//
// **Gamma is Photoshop's midtone number**: the exponent applied is `1/gamma`,
// so above 1 brightens and below 1 darkens. Stated because the opposite
// convention is equally common and renders a perfectly plausible wrong picture.
//
// **This node clips headroom, and does so at its default settings.** The
// working surface is rgba16float and an upstream exposure (F-PP-02) can leave
// values above 1; an input white of 1 maps them all to the output white. That
// is not an oversight to be worked around, it is what a white point is — the
// place where white is — and it is the one difference between this node and its
// neighbours in the family, which go out of their way to pass headroom through.
// Anything above the white point is meant to be white.
//
// **Two modes.** Per-channel runs the transfer on R, G and B independently,
// which is what a levels dialog's composite channel does — and which shifts hue
// on saturated colours, since the three channels clip at different places. Luma
// runs it on the pixel's Rec.709 luminance and scales the linear triple by the
// ratio, which is a pure scale and therefore leaves chromaticity untouched.
// That difference is the whole reason the requirement asks for both.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// Ordinals are positions in the descriptor's `values` list, which is
// append-only: inserting a value in the middle renumbers every saved document.
const MODE_PER_CHANNEL : u32 = 0u;
const MODE_LUMA        : u32 = 1u;

// The registry describes parameters one at a time and cannot say "white must
// exceed black", so a document can arrive with the two crossed and the span
// zero or negative. One 8-bit code is the floor: at a span that narrow the
// transfer is already a hard threshold at the black point, so clamping turns a
// division by zero into the picture the numbers were converging on rather than
// into a NaN that survives every node downstream. A *crossed* pair therefore
// reads as that threshold and not as an inversion — inverting tone is what the
// output pair below does, and F-SP-08 does properly.
const MIN_INPUT_SPAN : f32 = 1.0 / 255.0;

// Below this a pixel carries no luminance to take a ratio against, so in luma
// mode the mapped grey is the answer rather than `linear_rgb * (0/0)`.
const MIN_LUMINANCE : f32 = 1.0e-5;

// Offsets must match LEVELS_UNIFORMS in web/src/effects/levels.effect.ts. Eight
// 4-byte scalars fill the block exactly, so there is no padding to state.
struct Params {
  width        : u32,   //  0
  height       : u32,   //  4
  input_black  : f32,   //  8
  input_white  : f32,   // 12
  gamma        : f32,   // 16
  output_black : f32,   // 20
  output_white : f32,   // 24
  mode         : u32,   // 28
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

// --- shared: linear -> sRGB transfer (keep identical across shaders) -----

fn linear_to_srgb(c : vec3<f32>) -> vec3<f32> {
  let clamped = max(c, vec3<f32>(0.0));
  let lo = clamped * 12.92;
  let hi = 1.055 * pow(clamped, vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(hi, lo, clamped <= vec3<f32>(0.0031308));
}

// --- end shared ---------------------------------------------------------

// --- shared: sRGB -> linear transfer (keep identical across shaders) -----
//
// The inverse of `linear_to_srgb`, with the same breakpoint as
// `srgb_to_linear` in core/crates/dither-core/src/color.rs.

fn srgb_to_linear(c : vec3<f32>) -> vec3<f32> {
  let clamped = max(c, vec3<f32>(0.0));
  let lo = clamped / 12.92;
  let hi = pow((clamped + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return select(hi, lo, clamped <= vec3<f32>(0.040448237));
}

// --- end shared ---------------------------------------------------------

// --- shared: Rec.709 luminance on linear light (keep identical) ----------

fn luminance(c : vec3<f32>) -> f32 {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

// --- end shared ---------------------------------------------------------

// The transfer itself, on encoded values.
//
// The clamp before `pow` is load-bearing twice over: it is the input clip the
// black and white points are asking for, and `pow` of a negative base is
// undefined in WGSL, which is reachable from any pixel darker than the black
// point.
//
// The output pair is a plain mix and is *not* clamped or ordered, so an output
// black above an output white is legal and inverts the tone scale. That is the
// one inversion a levels control has always supported and it costs nothing to
// keep.
fn levels_transfer(encoded : vec3<f32>) -> vec3<f32> {
  let span = max(params.input_white - params.input_black, MIN_INPUT_SPAN);
  let normalized = clamp(
    (encoded - vec3<f32>(params.input_black)) / span,
    vec3<f32>(0.0),
    vec3<f32>(1.0),
  );
  let corrected = pow(normalized, vec3<f32>(1.0 / params.gamma));
  return mix(vec3<f32>(params.output_black), vec3<f32>(params.output_white), corrected);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);
  let linear_rgb = texel.rgb;

  let y = luminance(linear_rgb);

  // One encode, one transfer, one decode whichever mode is on: luma mode sends
  // the grey carrying the pixel's own luminance through instead of the pixel,
  // so the two modes differ in what goes in and what comes out rather than in
  // how much arithmetic runs.
  let subject = select(linear_rgb, vec3<f32>(y), params.mode == MODE_LUMA);
  let mapped = srgb_to_linear(levels_transfer(linear_to_srgb(subject)));

  var out_rgb = mapped;
  if (params.mode == MODE_LUMA && y > MIN_LUMINANCE) {
    // A scale on the linear triple, which moves tone and leaves chromaticity
    // exactly where it was. Doing the same job by re-mixing towards the mapped
    // grey would desaturate as well, which is what the per-channel mode already
    // does for free.
    out_rgb = linear_rgb * (mapped.x / y);
  }

  // Alpha is carried through untouched: levels is a tone control, and remapping
  // alpha would be a compositing change under its name (F-IN-03).
  textureStore(dst, coord, vec4<f32>(out_rgb, texel.a));
}
