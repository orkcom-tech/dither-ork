// F-SP-07 — Threshold: everything above the level goes white, everything below
// goes black, with an optional soft edge.
//
// Two things about where the numbers live.
//
// The **decision variable is display-referred**. Luminance is measured in
// linear light with Rec.709, as everything else in this pipeline does, and then
// put through the sRGB transfer before it is compared. That is what makes the
// level slider mean what it looks like it means: 0.5 lands on visual mid-grey,
// not on linear 0.5, which is the 74%-bright value nobody would call middle.
// The alternative — comparing linear luminance against a linear level — gives a
// control whose useful travel is all crowded into its bottom fifth.
//
// The **output is linear light**, black and white being 0 and 1 there. The soft
// edge mixes between them linearly, because a soft edge is coverage and
// coverage averages physically.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// Below this the soft band has no width and `smoothstep` would divide by zero.
// Softness 0 is a legal, wanted setting — a hard threshold — so this is the
// definition of the control at its endpoint, not a guard against a bad one.
const MIN_SOFT_BAND : f32 = 1e-6;

// Offsets must match THRESHOLD_UNIFORMS in web/src/effects/threshold.effect.ts.
// Four 4-byte scalars fill the block exactly, so there is no padding to state.
struct Params {
  width    : u32,   //  0
  height   : u32,   //  4
  level    : f32,   //  8
  softness : f32,   // 12
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

// --- shared: Rec.709 luminance on linear light (keep identical) ----------

fn luminance(c : vec3<f32>) -> f32 {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

// --- end shared ---------------------------------------------------------

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);

  let tone = linear_to_srgb(vec3<f32>(luminance(texel.rgb))).x;

  // Softness is the full width of the ramp, centred on the level, so moving the
  // level never moves the edge sideways as well.
  let half_band = params.softness * 0.5;
  let lo = params.level - half_band;
  let hi = params.level + half_band;

  var coverage : f32;
  if (hi - lo <= MIN_SOFT_BAND) {
    // Strictly greater: a pixel sitting exactly on the level goes dark, which
    // makes level = 1 an all-black frame and level = 0 an all-white one rather
    // than leaving either endpoint ambiguous.
    coverage = select(0.0, 1.0, tone > params.level);
  } else {
    coverage = smoothstep(lo, hi, tone);
  }

  // Alpha is carried through untouched. It is never composited onto white
  // anywhere in the stack (F-IN-03).
  textureStore(dst, coord, vec4<f32>(vec3<f32>(coverage), texel.a));
}
