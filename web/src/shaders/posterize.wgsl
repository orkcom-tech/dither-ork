// F-SP-06 — Posterize: collapse every tone onto N evenly spaced levels, per
// channel or on luma alone.
//
// The interesting decision here is *which space the levels are even in*, and it
// is exposed rather than hidden, because the two answers are both correct and
// they look completely different.
//
// Everything in this pipeline is linear light, so the obvious implementation
// quantizes linear values. Four levels in linear light land at 0, 0.333, 0.667
// and 1 — which is 0, 0.62, 0.84 and 1 on screen. Three of the four levels are
// bright, the shadows get one level to share, and the picture goes chalky. That
// is not what "posterize" has ever meant in an image editor: there the levels
// are even in the *encoded* value, which is why the bands land where the eye
// expects them.
//
// So `space` is a look control, exactly like the sRGB colour metric elsewhere
// in this repository is a look control and not a fallback. sRGB is the default
// because it is what the word means; linear is offered because evenly spaced
// *physical* levels is a real, different, defensible thing to want.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const MODE_RGB  : u32 = 0u;
const MODE_LUMA : u32 = 1u;

const SPACE_SRGB   : u32 = 0u;
const SPACE_LINEAR : u32 = 1u;

// The registry's legal range starts at 2, so this floor only catches a
// malformed document — but one level means dividing by zero, and a NaN in a
// linear-light buffer survives every node after it.
const MIN_LEVELS : u32 = 2u;

// Below this a pixel carries no luminance to redistribute and the luma mode's
// scale factor is 0/0. Such a pixel is black, and black posterizes to black.
const MIN_LUMINANCE : f32 = 1e-6;

// Offsets must match POSTERIZE_UNIFORMS in web/src/effects/posterize.effect.ts.
// The three pad members make the 32-byte size visible here rather than leaving
// it to WGSL's round-up rule.
struct Params {
  width  : u32,   //  0
  height : u32,   //  4
  levels : u32,   //  8
  mode   : u32,   // 12
  space  : u32,   // 16
  pad0   : u32,   // 20
  pad1   : u32,   // 24
  pad2   : u32,   // 28
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
// `srgb_to_linear` in core/crates/dither-core/src/color.rs. The ordered dithers
// never needed it — they only go one way — so this block is new; it is fenced
// so the next shader that needs it copies this text rather than growing a
// second set of constants.

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

fn encode(c : vec3<f32>) -> vec3<f32> {
  if (params.space == SPACE_LINEAR) {
    return c;
  }
  return linear_to_srgb(c);
}

fn decode(c : vec3<f32>) -> vec3<f32> {
  if (params.space == SPACE_LINEAR) {
    return c;
  }
  return srgb_to_linear(c);
}

// Nearest of N levels spread evenly across [0, 1] inclusive at both ends.
//
// `round` and not `floor`: flooring is what Photoshop does and it biases every
// tone down by half a step, so a flat field no longer averages back to itself.
// Nearest-level quantization is also what the rest of this pipeline does when
// it picks a palette entry, and posterize should not disagree with it.
fn quantize(v : vec3<f32>, levels : u32) -> vec3<f32> {
  let steps = f32(max(levels, MIN_LEVELS) - 1u);
  let clamped = clamp(v, vec3<f32>(0.0), vec3<f32>(1.0));
  return round(clamped * steps) / steps;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);
  let linear_rgb = texel.rgb;

  var out_rgb : vec3<f32>;
  if (params.mode == MODE_LUMA) {
    let y = luminance(linear_rgb);
    if (y <= MIN_LUMINANCE) {
      // No luminance to band, and no hue to preserve either.
      out_rgb = vec3<f32>(0.0);
    } else {
      let banded = decode(quantize(encode(vec3<f32>(y)), params.levels)).x;
      // Scaling rather than replacing is what makes this "posterize the tone"
      // instead of "posterize to grey": the ratio between the channels is
      // untouched, so hue and saturation survive and only the tone steps.
      //
      // The scale can push a saturated channel past 1. That is left alone
      // rather than clamped per channel, because a per-channel clamp changes
      // the hue — the one thing this branch exists to protect — and the working
      // surface is rgba16float, which holds it. Export clamps at the end.
      out_rgb = linear_rgb * (banded / y);
    }
  } else {
    out_rgb = decode(quantize(encode(linear_rgb), params.levels));
  }

  // Alpha is carried through untouched. It is never composited onto white
  // anywhere in the stack (F-IN-03).
  textureStore(dst, coord, vec4<f32>(out_rgb, texel.a));
}
