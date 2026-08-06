// F-PT-04 — Cross-hatch: two to four line screens overlaid.
//
// Each layer is the grating of line-screen.wgsl: a triangle wave whose sublevel
// set {t_i < b} is exactly a band of relative width b. Overlaying them means
// inking where *any* layer inks, so the combined screen is the minimum of the
// layer thresholds, and the inked set is the union of the bands.
//
// The union is where the tone correction lives, and it is worth being precise
// about. n bands of relative width b each cover 1 - (1 - b)^n of the plane when
// the layers' phases are mutually equidistributed — so to demand an ink area of
// `a` the combined screen must be renormalised by that same law, which is the
// `1 - (1 - min)^n` at the end of screen_threshold(). Then {screen < a} has area
// exactly `a` and a flat field averages back to itself.
//
// The precondition is exactly true for two layers: two non-parallel gratings
// have independent phase coordinates, so their bands intersect in a set of
// measure b^2 by construction. It is what the layer geometry here is built to
// keep true for three and four:
//
//   - The layer angles are spread across a half-circle (`angle_spread`, over
//     `layers` steps) rather than stepped by a free angle. A free step is the
//     trap — the obvious values, 90 degrees at three layers and 60 at four, are
//     precisely the ones that put two layers back on the same direction, where
//     the union law is not just approximate but wrong.
//   - Three or more directions in a plane are always linearly dependent, so
//     their phases satisfy one relation. Whether that relation matters depends
//     on how nearly the pitches stand in a small-integer ratio: at
//     `pitch_ratio` = 1 the phases close on a lattice within a few periods and
//     the union law stops holding, while a ratio off a simple fraction pushes
//     that closure out past the size of any real image. Measured on a flat
//     field, worst tone error across 0.15..0.85 at a 9.3px pitch:
//
//       layers   ratio 1.0   ratio 1.3
//            2      0.3%        0.2%
//            3      6.2%        0.1%
//            4      0.8%        0.1%
//
//     which is why the descriptor defaults the ratio to 1.3 rather than to the
//     equal-pitch hatch. Exactly 1 stays legal: at two layers it is exact, and
//     it is the classical look.
//
// This is the same phenomenon that decides screen angles in print, which is why
// the parameters look like a printer's rather than an artist's.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const DEG_TO_RAD : f32 = 0.017453292519943295;

// Restated from CROSS_HATCH_MAX_LAYERS in
// web/src/effects/cross-hatch.effect.ts, which refuses to build the pass if the
// descriptor's legal range ever exceeds it. A document asking for more would
// otherwise render with layers silently missing.
const MAX_LAYERS : u32 = 4u;

// Pitch and ratio divide the sampling coordinate. Both legal ranges start well
// above zero, so these clamps only catch a malformed document — but a zero in
// either place paints the frame NaN, and NaN in a linear-light buffer survives
// every node after it.
const MIN_PITCH : f32 = 0.03125;
const MIN_RATIO : f32 = 0.03125;

// The duty control is anchored at half the pitch, so this is the divisor that
// makes 0.5 neutral rather than a magic 2.0 in the expression.
const NEUTRAL_DUTY : f32 = 0.5;

const METRIC_OKLAB : u32 = 0u;
const METRIC_SRGB  : u32 = 1u;

// Offsets must match CROSS_HATCH_UNIFORMS in
// web/src/effects/cross-hatch.effect.ts. The three pad members make the 48-byte
// size visible here rather than leaving it to WGSL's round-up rule.
struct Params {
  width        : u32,   //  0
  height       : u32,   //  4
  layers       : u32,   //  8
  pitch        : f32,   // 12
  angle        : f32,   // 16  degrees
  angle_spread : f32,   // 20  degrees, divided across the layers
  pitch_ratio  : f32,   // 24
  duty         : f32,   // 28
  spread       : f32,   // 32
  pad0         : f32,   // 36
  pad1         : f32,   // 40
  pad2         : f32,   // 44
};

struct PaletteEntry {
  linear : vec4<f32>,
  match_ : vec4<f32>,
};

struct PaletteData {
  count   : u32,
  metric  : u32,
  pad0    : u32,
  pad1    : u32,
  entries : array<PaletteEntry>,
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var dst_index : texture_storage_2d<r32uint, write>;
@group(0) @binding(4) var<storage, read> palette : PaletteData;
@group(0) @binding(5) var<uniform> params : Params;

// --- shared: colour and palette search (keep identical across shaders) ---

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

fn linear_to_srgb(c : vec3<f32>) -> vec3<f32> {
  let clamped = max(c, vec3<f32>(0.0));
  let lo = clamped * 12.92;
  let hi = 1.055 * pow(clamped, vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(hi, lo, clamped <= vec3<f32>(0.0031308));
}

// sRGB Euclidean is a look control, not a fallback: it reproduces what
// period-accurate tools did by doing the maths in gamma space.
fn match_coords(linear_rgb : vec3<f32>, metric : u32) -> vec3<f32> {
  if (metric == METRIC_SRGB) {
    return linear_to_srgb(linear_rgb);
  }
  return linear_to_oklab(linear_rgb);
}

// Rec.709 luma on linear light. Used only to give the candidate pair a stable
// order, never to decide a colour.
fn luminance(c : vec3<f32>) -> f32 {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

// The two palette entries the pixel sits between, measured with the palette's
// own metric. An ordered dither alternates between exactly two colours per
// pixel; which two is a perceptual question, and this is where the metric earns
// its place.
//
// Returned darker-first, and that ordering is the point. Returning them
// nearest-first would make the pair swap over as the image crosses the midpoint
// between two entries, and every control that is not symmetric about zero —
// threshold offset above all — would reverse direction at that line. On a
// gradient that reversal is a visible seam. Luminance orders them, with the
// palette index breaking a tie between two entries of equal luminance so the
// result is deterministic rather than dependent on iteration order.
fn candidate_pair(probe : vec3<f32>) -> vec2<u32> {
  var first  : u32 = 0u;
  var second : u32 = 0u;
  var d_first  : f32 = 1e30;
  var d_second : f32 = 1e30;
  for (var i : u32 = 0u; i < palette.count; i = i + 1u) {
    let delta = probe - palette.entries[i].match_.xyz;
    let d = dot(delta, delta);
    if (d < d_first) {
      d_second = d_first;
      second = first;
      d_first = d;
      first = i;
    } else if (d < d_second) {
      d_second = d;
      second = i;
    }
  }

  let lum_first = luminance(palette.entries[first].linear.rgb);
  let lum_second = luminance(palette.entries[second].linear.rgb);
  let swap = lum_second < lum_first || (lum_second == lum_first && second < first);
  return select(vec2<u32>(first, second), vec2<u32>(second, first), swap);
}

// --- end shared ----------------------------------------------------------

fn screen_threshold(pixel : vec2<f32>) -> f32 {
  let centre = vec2<f32>(f32(params.width), f32(params.height)) * 0.5;
  let d = pixel - centre;

  let count = clamp(params.layers, 1u, MAX_LAYERS);
  // Dividing the spread by the layer count is what keeps the last layer short
  // of the first one's own direction: n layers land at 0, s/n, ... (n-1)s/n,
  // which for s = 180 is an even spread across the half-circle and never
  // repeats a direction.
  let step = params.angle_spread / f32(count);
  let ratio = max(params.pitch_ratio, MIN_RATIO);

  var nearest : f32 = 1.0;
  var pitch = max(params.pitch, MIN_PITCH);
  for (var i : u32 = 0u; i < count; i = i + 1u) {
    let angle = (params.angle + f32(i) * step) * DEG_TO_RAD;
    let sn = sin(angle);
    let cs = cos(angle);
    let across = -d.x * sn + d.y * cs;
    let u = across / pitch;
    nearest = min(nearest, abs(fract(u) - 0.5) * 2.0);
    // Compounded rather than pow(ratio, i): the layers are a geometric series
    // by definition, and multiplying keeps each pitch derived from the one
    // before it instead of from a separate exponentiation.
    pitch = max(pitch * ratio, MIN_PITCH);
  }

  // Undo the order statistic. `nearest` is the minimum of `count` thresholds,
  // whose distribution is 1 - (1 - x)^count; applying that function makes the
  // combined screen uniform again, so {screen < a} is the union of the bands
  // and has area a. See the header for when that is exact.
  return clamp(1.0 - pow(max(1.0 - nearest, 0.0), f32(count)), 0.0, 1.0);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);
  let linear_rgb = texel.rgb;

  let t = screen_threshold(vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5));

  let pair = candidate_pair(match_coords(linear_rgb, palette.metric));
  let entry_a = palette.entries[pair.x].linear.rgb;   // darker
  let entry_b = palette.entries[pair.y].linear.rgb;   // lighter

  // Where the pixel sits between the two candidates, measured in LINEAR LIGHT.
  // The area given to the darker entry has to equal this, or a flat field does
  // not average back to itself, and averaging is physical.
  let axis = entry_b - entry_a;
  let axis_length_sq = dot(axis, axis);
  var f : f32 = 0.0;
  if (axis_length_sq > 1e-12) {
    f = clamp(dot(linear_rgb - entry_a, axis) / axis_length_sq, 0.0, 1.0);
  }

  // `duty` scales the demand rather than offsetting it, so paper white stays
  // paper white at every setting; 0.5 is neutral and reproduces tone exactly.
  let ink = clamp((1.0 - f) * (params.duty / NEUTRAL_DUTY), 0.0, 1.0);

  let decision = ((1.0 - ink) - 0.5) + (t - 0.5) * params.spread;
  let index = select(pair.x, pair.y, decision > 0.0);

  // Alpha is carried through untouched. It is never composited onto white
  // anywhere in the stack (F-IN-03).
  textureStore(dst, coord, vec4<f32>(palette.entries[index].linear.rgb, texel.a));
  textureStore(dst_index, coord, vec4<u32>(index, 0u, 0u, 0u));
}
