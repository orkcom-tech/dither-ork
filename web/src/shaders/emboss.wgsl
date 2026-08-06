// F-SP-05 — Emboss: angle, depth.
//
// A directional derivative of lightness, rendered as relief. The pixel is
// replaced by a neutral grey lit from `angle`: bright where lightness rises
// towards the light, dark where it falls away, flat mid-grey where the picture
// is flat. That grey is the whole output — an emboss discards colour, which is
// what makes it an emboss and not a directional sharpen.
//
// The two taps are one pixel either side of the centre along the light
// direction, sampled bilinearly from the four texels around each. `textureLoad`
// takes integer coordinates and there is no sampler on this path
// (CONVENTIONS.md), so the interpolation is written out. Rounding the offset to
// the nearest texel instead would make the angle control snap through eight
// positions and an animated sweep judder through them.
//
// Everything is computed in LIGHTNESS and written back as linear light through
// the exact inverse, so the relief is perceptually even across the tonal range
// rather than collapsing in the shadows the way a linear-light difference does.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const TAU : f32 = 6.283185307179586;

// Distance of each tap from the centre, in pixels. Fixed rather than exposed:
// the requirement names angle and depth, and a control that moved this would
// be a second radius with nothing to distinguish it from a blur.
const TAP_DISTANCE : f32 = 1.0;

// Lightness of a surface facing neither towards nor away from the light. The
// midpoint of the lightness range, so highlight and shadow have equal room
// before they clip — not sRGB 128, which sits at lightness 0.598 and would give
// the shadows a third less headroom than the highlights.
const NEUTRAL_LIGHTNESS : f32 = 0.5;

// Offsets must match EMBOSS_UNIFORMS in web/src/effects/emboss.effect.ts. Four
// 4-byte scalars are exactly the 16 bytes WGSL rounds a uniform struct up to,
// so this struct needs no padding member.
struct Params {
  width  : u32,   //  0
  height : u32,   //  4
  angle  : f32,   //  8
  depth  : f32,   // 12
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

// --- shared: clamped texel fetch (keep identical across shaders) ----------
//
// Every neighbourhood effect needs this and none of them may use a sampler:
// the working surface is linear-light rgba16float read at integer coordinates.
// Out-of-bounds `textureLoad` returns zero, so an unclamped kernel paints a
// dark frame one radius wide around the image. Clamp-to-edge is the standard
// answer and the only one that leaves a flat field flat.
fn load_clamped(coord : vec2<i32>) -> vec4<f32> {
  let last = vec2<i32>(i32(params.width) - 1, i32(params.height) - 1);
  return textureLoad(src, clamp(coord, vec2<i32>(0, 0), last), 0);
}
// --- end shared ----------------------------------------------------------

// --- shared: perceptual lightness (keep identical across shaders) ---------
//
// The cube root of Rec.709 luminance. This is the classical lightness curve —
// CIE L* and OKLab's L are both this shape — and for a neutral colour it is
// exactly OKLab's L, because each row of OKLab's LMS matrix sums to one, so a
// grey of linear value v has l = m = s = v and L = v^(1/3).
//
// Used rather than the full OKLab transform because these effects evaluate
// lightness per TAP, not per pixel: a glow's bright-pass at radius 24 asks for
// it 49 times per invocation, and the full transform is three `pow` calls to
// this one's one. The two agree exactly where it matters — on the neutral axis
// — and the quantity being measured here is relief and edge contrast, not
// colour difference, so no palette decision depends on the difference.
fn rec709_luminance(linear_rgb : vec3<f32>) -> f32 {
  return 0.2126 * linear_rgb.r + 0.7152 * linear_rgb.g + 0.0722 * linear_rgb.b;
}

fn perceptual_lightness(linear_rgb : vec3<f32>) -> f32 {
  // `pow` of a negative base is undefined in WGSL, and a previous node with
  // headroom can leave a channel slightly below zero.
  return pow(max(rec709_luminance(linear_rgb), 0.0), 1.0 / 3.0);
}
// --- end shared ----------------------------------------------------------

// --- shared: neutral grey from lightness (keep identical across shaders) --
//
// Exact inverse of `perceptual_lightness` on the neutral axis: a grey of
// lightness l is linear l^3. That is what lets an effect compute in lightness
// and write linear light without an approximation sitting between the two.
fn lightness_to_linear_grey(lightness : f32) -> vec3<f32> {
  let l = clamp(lightness, 0.0, 1.0);
  return vec3<f32>(l * l * l);
}
// --- end shared ----------------------------------------------------------

// Bilinear fetch at a fractional pixel position, integer coordinates being
// texel centres. Built on `load_clamped`, so it inherits clamp-to-edge and the
// frame does not darken where the offset leaves the image.
fn load_bilinear(position : vec2<f32>) -> vec4<f32> {
  let base = floor(position);
  let frac = position - base;
  let corner = vec2<i32>(base);

  let c00 = load_clamped(corner);
  let c10 = load_clamped(corner + vec2<i32>(1, 0));
  let c01 = load_clamped(corner + vec2<i32>(0, 1));
  let c11 = load_clamped(corner + vec2<i32>(1, 1));

  return mix(mix(c00, c10, frac.x), mix(c01, c11, frac.x), frac.y);
}

@compute @workgroup_size(8, 8, 1)
fn relief(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));

  // Angle is in TURNS so a modulator ramping 0 -> 1 closes the loop exactly,
  // and the y component is negated so the angle runs counter-clockwise on
  // screen: 0 is light from the right, 0.25 from the top, matching how anyone
  // reading the slider expects an angle to behave in a y-down buffer.
  let theta = params.angle * TAU;
  let direction = vec2<f32>(cos(theta), -sin(theta)) * TAP_DISTANCE;

  let centre = vec2<f32>(f32(gid.x), f32(gid.y));
  let towards = perceptual_lightness(load_bilinear(centre + direction).rgb);
  let away = perceptual_lightness(load_bilinear(centre - direction).rgb);

  // Positive where lightness rises towards the light — the face of a ridge —
  // and negative on the far side of it.
  let lit = NEUTRAL_LIGHTNESS + params.depth * (towards - away);

  // Alpha is carried through untouched (F-IN-03). The relief replaces colour;
  // it does not replace coverage.
  let texel = textureLoad(src, coord, 0);
  textureStore(dst, coord, vec4<f32>(lightness_to_linear_grey(lit), texel.a));
}
