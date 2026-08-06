// F-SP-09 — Gradient map / duotone: replace every pixel's colour with a colour
// looked up from a three-stop ramp indexed by the pixel's tone.
//
// Three decisions are worth stating.
//
// **The index is display-referred tone.** Luminance is Rec.709 on linear light,
// as everywhere else, and then encoded before it indexes the ramp. Indexing on
// raw linear luminance would put visual mid-grey at 0.216 of the way along, so
// the mid stop would sit under the shadows and the control would be unusable in
// its middle two thirds.
//
// **The ramp is interpolated in OKLab.** A straight line between two saturated
// colours in linear light passes through a desaturated, wrongly-lit middle —
// the same reason `oklab_ramp` in core/crates/dither-core/src/palette.rs
// interpolates there and not here. Doing it in OKLab is what makes a duotone
// read as one gradient rather than as two colours with mud between them.
//
// **The stops arrive as OKLCh, three floats each.** Not a colour picker: the
// registry's `color` parameter kind cannot reach a shader, because a document
// parameter value is `number | boolean | string` and the uniform packer has no
// path for a triplet. Three floats per stop is what actually works end to end,
// and expressing them as lightness / chroma / hue rather than as R, G and B is
// what keeps Surprise Me's draws perceptually even instead of clumped around
// muddy mid-greys — the same argument `ColorSurprise` makes in
// web/src/types/registry.ts.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const TAU : f32 = 6.283185307179586;

// The registry's legal range for the mid stop's position is [0.05, 0.95], so
// this only catches a malformed document — but a position at either end divides
// by zero, and a NaN in a linear-light buffer survives every node after it.
const MIN_MID_POSITION : f32 = 0.001;

// Offsets must match GRADIENT_MAP_UNIFORMS in
// web/src/effects/gradient-map.effect.ts. The three pad members make the
// 64-byte size visible here rather than leaving it to WGSL's round-up rule.
struct Params {
  width           : u32,   //  0
  height          : u32,   //  4
  shadow_l        : f32,   //  8
  shadow_c        : f32,   // 12
  shadow_h        : f32,   // 16
  mid_l           : f32,   // 20
  mid_c           : f32,   // 24
  mid_h           : f32,   // 28
  highlight_l     : f32,   // 32
  highlight_c     : f32,   // 36
  highlight_h     : f32,   // 40
  mid_position    : f32,   // 44
  amount          : f32,   // 48
  pad0            : f32,   // 52
  pad1            : f32,   // 56
  pad2            : f32,   // 60
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

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

// --- shared: Rec.709 luminance on linear light (keep identical) ----------

fn luminance(c : vec3<f32>) -> f32 {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

// --- end shared ---------------------------------------------------------

// A stop, from the polar form the parameters carry to the rectangular form the
// interpolation needs. Hue is in degrees so the UI reads in degrees; nothing
// wraps it, because sin and cos are periodic and 370 and 10 are the same stop.
fn stop_to_oklab(lightness : f32, chroma : f32, hue_degrees : f32) -> vec3<f32> {
  let hue = hue_degrees * (TAU / 360.0);
  return vec3<f32>(lightness, chroma * cos(hue), chroma * sin(hue));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);
  let linear_rgb = texel.rgb;

  // Clamped because a node upstream may have pushed a channel past 1, and a
  // tone outside [0, 1] would extrapolate the ramp past its own end stops.
  let tone = clamp(linear_to_srgb(vec3<f32>(luminance(linear_rgb))).x, 0.0, 1.0);

  let shadow    = stop_to_oklab(params.shadow_l,    params.shadow_c,    params.shadow_h);
  let mid       = stop_to_oklab(params.mid_l,       params.mid_c,       params.mid_h);
  let highlight = stop_to_oklab(params.highlight_l, params.highlight_c, params.highlight_h);

  let position = clamp(params.mid_position, MIN_MID_POSITION, 1.0 - MIN_MID_POSITION);

  var lab : vec3<f32>;
  if (tone <= position) {
    lab = mix(shadow, mid, tone / position);
  } else {
    lab = mix(mid, highlight, (tone - position) / (1.0 - position));
  }

  // A straight line in OKLab between two in-gamut stops can still leave the
  // sRGB cube, because the cube is a box in linear light and OKLab bends it.
  // Clipped, which is what `oklab_ramp` does in the core for the same reason. A
  // shader has nowhere to report the clip the way the core's `Ramp.clamped`
  // does, so the surprise chroma ranges are kept conservative enough that a
  // random gradient does not spend its middle pinned to a face of the cube.
  let mapped = clamp(oklab_to_linear(lab), vec3<f32>(0.0), vec3<f32>(1.0));

  // Blending against the source is what makes this a duotone control rather
  // than only a replacement: partway is the original tinted towards the ramp.
  let out_rgb = mix(linear_rgb, mapped, params.amount);

  // Alpha is carried through untouched. It is never composited onto white
  // anywhere in the stack (F-IN-03).
  textureStore(dst, coord, vec4<f32>(out_rgb, texel.a));
}
