// F-PP-04 — Hue, saturation, lightness.
//
// **In OKLab, and that is the decision this file exists to record.**
//
// The obvious implementation is the textbook RGB↔HSL conversion, and it is the
// wrong one for this pipeline for three separate reasons.
//
// 1. HSL's "lightness" is `(max + min) / 2` of the sRGB channels, which is not
//    a measure of light at all: pure yellow and pure blue both come out at
//    L = 0.5 while one is about nine times brighter than the other. A lightness
//    slider built on it moves some hues far more than others.
// 2. HSL's hue is an angle on a hexagon, so a constant rotation is not a
//    constant perceptual step — the yellow-to-green arc is visually short and
//    the blue arc long. An animated hue sweep visibly accelerates.
// 3. Everything else in this repository already measures colour in OKLab:
//    palette matching (docs/ARCHITECTURE.md, "Colour"), palette synthesis, and
//    the `color` parameter kind's own surprise metadata. Sampling colour in one
//    space and editing it in another is how a hue rotation ends up walking a
//    picture off the palette it was chosen for.
//
// OKLab fixes all three at once. L is a perceptual lightness, so an offset is
// the same visible step at every hue; and (a, b) is a Euclidean plane, so a
// rotation of it is a constant-perceptual-rate hue rotation and a scale of it
// is chroma.
//
// **The rotation is done on (a, b) directly** rather than via atan2 and back.
// It is the same operation — a 2x2 rotation is what a hue shift *is* in this
// plane — and it costs two transcendentals per pixel instead of three plus a
// square root, with no discontinuity at the ±180° seam to reason about.
//
// **Saturation scales chroma at constant L.** The alternative reading, scaling
// C/L, would make the same slider setting mean a different chroma at every
// brightness, which is not what a saturation control does anywhere.
//
// **Gamut.** Rotating hue or raising chroma can name a colour sRGB cannot show
// — the result leaves the cube on the low side, as a negative linear component,
// which is not a dark colour but no colour. Those are floored at zero. The high
// side is deliberately *not* clamped, unlike `invert.wgsl`: the working surface
// is rgba16float and an upstream exposure (F-PP-02) legitimately leaves values
// above 1, so a ceiling here would mean this node quietly darkened an
// overbright frame while sitting at its defaults, which is the one thing an
// identity setting must never do.
//
// Angles are in turns, per CONVENTIONS.md: a hue parameter ramping 0 -> 1 lands
// exactly back where it started, so an animated rotation closes the loop by
// construction.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const TAU : f32 = 6.283185307179586;

// Offsets must match HSL_UNIFORMS in web/src/effects/hsl.effect.ts. The three
// pad members make the 32-byte size visible here rather than leaving it to
// WGSL's round-up rule.
struct Params {
  width      : u32,   //  0
  height     : u32,   //  4
  hue        : f32,   //  8
  saturation : f32,   // 12
  lightness  : f32,   // 16
  pad0       : f32,   // 20
  pad1       : f32,   // 24
  pad2       : f32,   // 28
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

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);
  let lab = linear_to_oklab(texel.rgb);

  // Hue and saturation are one operation on the (a, b) plane: rotate, then
  // scale. Order does not matter between them — a rotation and a uniform scale
  // commute — which is why neither needs to be declared as running first.
  let angle = params.hue * TAU;
  let cos_h = cos(angle);
  let sin_h = sin(angle);
  let rotated = vec2<f32>(
    lab.y * cos_h - lab.z * sin_h,
    lab.y * sin_h + lab.z * cos_h,
  );
  let chroma = rotated * params.saturation;

  // An offset rather than a multiplier: OKLab L is already perceptually
  // uniform, so +0.1 is the same visible step in the shadows and in the
  // highlights, which is exactly what a lightness slider is asking for. A
  // multiplier would be exposure, and F-PP-02 owns that.
  //
  // Floored at zero because a negative L is not darker than black; cubing it in
  // the inverse transform produces a colour nothing in the pipeline means.
  let lightness = max(lab.x + params.lightness, 0.0);

  // Gamut, low side only. See the header for why the high side is left alone.
  let out_rgb = max(
    oklab_to_linear(vec3<f32>(lightness, chroma.x, chroma.y)),
    vec3<f32>(0.0),
  );

  // Alpha is carried through untouched. Scaling it would be a compositing
  // change wearing a colour control's name (F-IN-03).
  textureStore(dst, coord, vec4<f32>(out_rgb, texel.a));
}
