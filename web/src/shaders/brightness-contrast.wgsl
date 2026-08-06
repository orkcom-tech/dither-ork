// F-PP-02 — Brightness, contrast, exposure.
//
// Three controls, and the whole design is one question asked three times: **in
// which domain is this arithmetic defined?** The pipeline carries linear light,
// so "do it on the buffer" is available for all three and is the right answer
// for exactly one of them.
//
// **Exposure is linear light.** A stop is a doubling of the light that reached
// the sensor, so `rgb * 2^stops` is not a convention, it is the definition.
// There is no decision to record here beyond naming the unit.
//
// **Brightness and contrast are display-referred** and are applied to the
// sRGB-encoded value. Both are affine — brightness translates, contrast scales
// — and an affine transfer only means what its name says in a domain whose
// steps are evenly spaced to the eye. In linear light an offset of +0.1 is a
// wash across the shadows and invisible in the highlights, and a gain of 2
// about the midpoint sends visual mid-grey to linear 0.428, which displays at
// 69% — a "contrast" control that brightens the whole picture. Encoding first
// makes +0.1 a tenth of the visible range everywhere, and makes a gain about
// the midpoint symmetric around the tone the eye calls middle.
//
// This is the same move `invert.wgsl` makes, for the same reason and with the
// same consequence: the buffer is linear light on the way in and on the way
// out, and only the domain the operation is *defined* in is display-referred.
//
// **The contrast pivot is 0.5 in that encoded domain**, which is linear 0.2140
// — visual mid-grey. That single number decides what this control does, so it
// is stated rather than left implicit. The two alternatives are both wrong and
// both plausible: pivoting on linear 0.5 (73% bright on screen) drags nearly
// every pixel in a normal frame downwards, and pivoting on 0 is a pure gain,
// which is what exposure already is. It is fixed rather than exposed as a
// control, because an arbitrary pivot with an arbitrary gain is what a levels
// node is (F-PP-03), and a second way to say the same thing is worse than one.
//
// **Contrast runs before brightness.** Brightness is then a pure translate
// whose size does not depend on the contrast setting. The other order makes the
// brightness slider mean a different amount of light at every contrast value,
// which is the sort of coupling that is only ever discovered by fighting it.
//
// Nothing clamps to the sRGB cube. The transfer functions floor at zero on
// their own — a negative linear value is not a colour — and they round-trip
// values above 1 exactly, so a buffer left overbright by an upstream exposure
// is not quietly crushed by passing through this node at its defaults.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// The contrast pivot, in the encoded domain the contrast gain is applied in.
// srgb_to_linear(0.5) = 0.2140, i.e. visual mid-grey; see the header.
const MID_GREY : f32 = 0.5;

// Offsets must match BRIGHTNESS_CONTRAST_UNIFORMS in
// web/src/effects/brightness-contrast.effect.ts. The three pad members make the
// 32-byte size visible here rather than leaving it to WGSL's round-up rule.
struct Params {
  width      : u32,   //  0
  height     : u32,   //  4
  exposure   : f32,   //  8
  contrast   : f32,   // 12
  brightness : f32,   // 16
  pad0       : f32,   // 20
  pad1       : f32,   // 24
  pad2       : f32,   // 28
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

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);

  // Scene-referred, and the only step that belongs on the linear buffer.
  let exposed = texel.rgb * exp2(params.exposure);

  // Display-referred from here to the decode two lines down.
  let encoded = linear_to_srgb(exposed);
  let contrasted = (encoded - vec3<f32>(MID_GREY)) * params.contrast + vec3<f32>(MID_GREY);
  let brightened = contrasted + vec3<f32>(params.brightness);

  // Alpha is carried through untouched. Scaling it here would be a compositing
  // change wearing a tone control's name (F-IN-03).
  textureStore(dst, coord, vec4<f32>(srgb_to_linear(brightened), texel.a));
}
