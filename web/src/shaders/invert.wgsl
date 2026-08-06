// F-SP-08 — Invert.
//
// Trivial arithmetic, one non-trivial decision: **inverting in linear light is
// not inverting in sRGB, and this effect does the sRGB one.**
//
// The whole pipeline works in linear light, so `1 - v` on the buffer is the
// tempting implementation. It is wrong for this effect. Visual mid-grey is
// linear 0.216; inverting that in linear light gives 0.784, which is 90% bright
// on screen. Every mid-tone in the picture lands in the top decile, the result
// is a washed-out negative with no shadows, and a second invert does return the
// original — so it is self-consistent and still not what anyone means.
//
// Inverting the *encoded* value sends visual mid-grey to visual mid-grey and
// reproduces the photographic negative, which is what "invert" has meant in
// every image editor and what F-SP-08 is asking for. So: encode, complement,
// decode. The buffer stays linear light throughout; only the domain the
// complement is defined in is display-referred, exactly as the sRGB colour
// metric elsewhere in this repository is a look defined in gamma space.
//
// It is a decision and not an option: a `space` control here would offer one
// setting that means "negative" and one that means "washed out", and a control
// whose second position is nobody's intent is worse than no control.
//
// The `mode` control is a different axis. Per-channel complement is the
// negative. Lightness-only complement inverts OKLab L and leaves a and b alone,
// so tone flips while hue and chroma survive — dark blue becomes light blue
// rather than orange.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const MODE_RGB       : u32 = 0u;
const MODE_LIGHTNESS : u32 = 1u;

// Offsets must match INVERT_UNIFORMS in web/src/effects/invert.effect.ts. Four
// 4-byte scalars fill the block exactly, so there is no padding to state.
struct Params {
  width  : u32,   //  0
  height : u32,   //  4
  amount : f32,   //  8
  mode   : u32,   // 12
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

// --- shared: linear -> OKLab (keep identical across shaders) -------------

fn linear_to_oklab(c : vec3<f32>) -> vec3<f32> {
  let clamped = max(c, vec3<f32>(0.0));
  let l = 0.41222146 * clamped.r + 0.53633255 * clamped.g + 0.051445995 * clamped.b;
  let m = 0.2119035  * clamped.r + 0.6806995  * clamped.g + 0.10739696  * clamped.b;
  let s = 0.08830246 * clamped.r + 0.28171884 * clamped.g + 0.6299785   * clamped.b;

  let l_ = pow(l, 1.0 / 3.0);
  let m_ = pow(m, 1.0 / 3.0);
  let s_ = pow(s, 1.0 / 3.0);

  return vec3<f32>(
    0.21045426  * l_ + 0.7936178  * m_ - 0.004072047 * s_,
    1.9779985   * l_ - 2.4285922  * m_ + 0.4505937   * s_,
    0.025904037 * l_ + 0.78277177 * m_ - 0.80867577  * s_,
  );
}

// --- end shared ---------------------------------------------------------

// --- shared: OKLab -> linear (keep identical across shaders) -------------
//
// Ottosson's published inverse matrices, the same numbers as `oklab_to_linear`
// in core/crates/dither-core/src/palette.rs. The result may leave the sRGB
// cube, because OKLab is larger than the gamut, and this function does not
// clamp — the caller's gamut decision stays visible at the call site.

fn oklab_to_linear(c : vec3<f32>) -> vec3<f32> {
  let l_ = c.x + 0.39633778  * c.y + 0.21580376 * c.z;
  let m_ = c.x - 0.105561346 * c.y - 0.06385417 * c.z;
  let s_ = c.x - 0.08948418  * c.y - 1.2914855  * c.z;

  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;

  return vec3<f32>(
     4.0767417    * l - 3.3077116 * m + 0.23096994 * s,
    -1.268438     * l + 2.6097574 * m - 0.34131938 * s,
    -0.0041960863 * l - 0.7034186 * m + 1.7076147  * s,
  );
}

// --- end shared ---------------------------------------------------------

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

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);
  let linear_rgb = texel.rgb;

  var inverted : vec3<f32>;
  if (params.mode == MODE_LIGHTNESS) {
    var lab = linear_to_oklab(linear_rgb);
    lab.x = 1.0 - lab.x;
    // Holding a and b while L moves can name a colour sRGB cannot show — a
    // saturated dark blue lightened at constant chroma leaves the cube. Clipped
    // to the cube, which is the same thing `oklab_ramp` does in the core when
    // an interpolated step falls outside it. A shader has nowhere to report the
    // clip the way the core's `Ramp.clamped` does; the surprise chroma ranges
    // are the reason it stays rare rather than a thing to notice.
    inverted = clamp(oklab_to_linear(lab), vec3<f32>(0.0), vec3<f32>(1.0));
  } else {
    inverted = srgb_to_linear(vec3<f32>(1.0) - linear_to_srgb(linear_rgb));
  }

  // Partial amounts are a real setting, not a crossfade for its own sake: the
  // half-way point of a per-channel invert is flat grey, and the approach to it
  // is the solarized look.
  let out_rgb = mix(linear_rgb, inverted, params.amount);

  // Alpha is carried through untouched and is never inverted. Inverting it
  // would turn the transparent parts of the frame opaque, which is a
  // compositing change wearing a colour control's name (F-IN-03).
  textureStore(dst, coord, vec4<f32>(out_rgb, texel.a));
}
