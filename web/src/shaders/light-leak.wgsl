// F-SP-15 — Soft light leak.
//
// Stray light reaching the film through a gap in the body: a soft coloured blob
// with a position, a colour and an amount, added to the frame.
//
// ## Why it adds, and adds in linear light
//
// A light leak is light that arrives at the emulsion in addition to the light
// from the lens. Two beams landing on the same grain add their radiances — that
// is what radiance is — so the operation is a sum, and the sum is taken in the
// buffer that holds radiance. Screen blending, which is what a compositor would
// reach for, is a saturating approximation of the same thing invented to keep
// 8-bit results in range; the working buffer is rgba16float and has no such
// problem, so the approximation would only cost accuracy. A leak strong enough
// to blow a highlight is a leak that blew a highlight.
//
// ## Why the colour is three floats and not a colour
//
// `ParameterValue` in web/src/types/document.ts is `number | boolean | string`
// and `resolveParam` in web/src/gpu/uniforms.ts handles only those, so a `color`
// parameter cannot reach a shader at all — gradient-map.effect.ts writes the gap
// up in full. The colour is therefore OKLab lightness, chroma and hue, which is
// the same axis set `ColorSurprise` already argues for and the same choice
// gradient-map made for its stops.
//
// OKLab is larger than sRGB, so a saturated draw can name a colour with a
// negative linear component. Negative light is not light; it is clamped at the
// call site, where the decision is visible.
//
// ## Why the falloff is a smoothstep and not a gaussian
//
// A gaussian never reaches zero, so every pixel in the frame gets some of the
// leak and the "position" control stops meaning anything at low intensities. The
// Hermite falloff has compact support and a continuous first derivative at both
// ends, so the blob has an edge you can place and no crease where it begins.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const TAU : f32 = 6.283185307179586;
const DEG_TO_TURNS : f32 = 1.0 / 360.0;

// The registry's legal range starts above zero, so this clamp only catches a
// malformed document — but `smoothstep` with edge0 >= edge1 is indeterminate in
// WGSL, and an indeterminate result is a frame of driver-dependent garbage
// rather than an error anywhere.
const MIN_SOFTNESS : f32 = 0.001;

// Offsets must match LIGHT_LEAK_UNIFORMS in
// web/src/effects/light-leak.effect.ts. The two pad members make the 48-byte
// size visible here rather than leaving it to WGSL's round-up rule.
struct Params {
  width      : u32,   //  0
  height     : u32,   //  4
  position_x : f32,   //  8
  position_y : f32,   // 12
  radius     : f32,   // 16
  softness   : f32,   // 20
  lightness  : f32,   // 24
  chroma     : f32,   // 28
  hue        : f32,   // 32
  intensity  : f32,   // 36
  pad0       : f32,   // 40
  pad1       : f32,   // 44
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

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);

  let size = vec2<f32>(f32(params.width), f32(params.height));
  let pixel = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);

  // Position is in frame fractions — (0,0) top left, (1,1) bottom right — and
  // its legal range goes outside that box on purpose: a leak comes through a gap
  // in the body, so its source is usually just off the edge of the picture.
  let origin = vec2<f32>(params.position_x, params.position_y) * size;

  // Distance in units of the half-diagonal, so the blob stays circular in pixels
  // rather than being stretched by the frame's aspect ratio. A leak is a
  // physical pool of light on the emulsion; it has no reason to know the format.
  let half_diagonal = length(size) * 0.5;
  let r = length(pixel - origin) / half_diagonal;

  let softness = max(params.softness, MIN_SOFTNESS);
  let falloff = 1.0 - smoothstep(params.radius, params.radius + softness, r);

  // Hue arrives in degrees so the UI and any modulator work in a unit people
  // read; a full turn is a full cycle, so a ramp of 0 -> 360 closes the loop.
  let angle = params.hue * DEG_TO_TURNS * TAU;
  let leak_oklab = vec3<f32>(
    params.lightness,
    params.chroma * cos(angle),
    params.chroma * sin(angle),
  );
  // The gamut decision, made where it is visible: a chroma OKLab can express but
  // sRGB cannot would otherwise put a negative radiance into the buffer, and a
  // negative channel survives every node after it.
  let leak_linear = max(oklab_to_linear(leak_oklab), vec3<f32>(0.0));

  let added = texel.rgb + leak_linear * (params.intensity * falloff);

  // Alpha is carried through untouched. The leak is light on the emulsion, not
  // coverage, and alpha is never composited anywhere in the stack (F-IN-03).
  textureStore(dst, coord, vec4<f32>(added, texel.a));
}
