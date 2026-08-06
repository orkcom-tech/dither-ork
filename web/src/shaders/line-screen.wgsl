// F-PT-03 — Line screen: a rotated grating whose line width carries the tone.
//
// Same principle as the halftone (halftone.wgsl) in one dimension instead of
// two. The screen answers, for every point, what fraction of the pitch is
// enclosed by the line whose edge passes through it — a triangle wave across
// the grating. The set of points below `a` is then exactly a band of relative
// width `a`, centred on the line, so a region that has to print `a` ink gets a
// line `a` pitches wide. Tone comes out right at every width with no curve.
//
// `duty` is the line width, as a fraction of the pitch, at 50% tone. It scales
// the ink demand rather than offsetting it, so paper white stays paper white at
// every setting and only the mid and shadow tones thicken or thin. 0.5 is the
// neutral value and the only one that reproduces tone exactly — the rest is the
// look, the same way an under- or over-exposed screen behaves in print.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const DEG_TO_RAD : f32 = 0.017453292519943295;

// Pitch divides the sampling coordinate. The registry's legal range starts at
// 1, so this clamp only catches a malformed document — but a zero here paints
// the frame NaN, and NaN in a linear-light buffer survives every node after it.
const MIN_PITCH : f32 = 0.03125;

// The duty control is anchored at half the pitch, so this is the divisor that
// makes 0.5 neutral rather than a magic 2.0 in the expression.
const NEUTRAL_DUTY : f32 = 0.5;

const METRIC_OKLAB : u32 = 0u;
const METRIC_SRGB  : u32 = 1u;

// Offsets must match LINE_SCREEN_UNIFORMS in
// web/src/effects/line-screen.effect.ts. The pad member makes the 32-byte size
// visible here rather than leaving it to WGSL's round-up rule.
struct Params {
  width  : u32,   //  0
  height : u32,   //  4
  pitch  : f32,   //  8
  angle  : f32,   // 12  degrees
  duty   : f32,   // 16
  phase  : f32,   // 20  in pitches
  spread : f32,   // 24
  pad0   : f32,   // 28
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

// The fraction of the pitch enclosed by the line whose edge runs through this
// point: a triangle wave, centred so the line grows outward from the middle of
// its period. Rotation is about the image centre so an animated angle sweeps
// the frame evenly instead of pivoting on a corner; angle 0 gives horizontal
// lines, and with image y running downward a positive angle reads as clockwise
// on screen.
fn screen_threshold(pixel : vec2<f32>) -> f32 {
  let centre = vec2<f32>(f32(params.width), f32(params.height)) * 0.5;
  let angle = params.angle * DEG_TO_RAD;
  let sn = sin(angle);
  let cs = cos(angle);

  let d = pixel - centre;
  // Only the component across the lines matters; the one along them is what
  // makes this a grating rather than a dot screen.
  let across = -d.x * sn + d.y * cs;
  let u = across / max(params.pitch, MIN_PITCH) + params.phase;

  return abs(fract(u) - 0.5) * 2.0;
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
  // The fraction of the pitch given to the darker entry has to equal this, or a
  // flat field does not average back to itself, and averaging is physical.
  let axis = entry_b - entry_a;
  let axis_length_sq = dot(axis, axis);
  var f : f32 = 0.0;
  if (axis_length_sq > 1e-12) {
    f = clamp(dot(linear_rgb - entry_a, axis) / axis_length_sq, 0.0, 1.0);
  }

  let ink = clamp((1.0 - f) * (params.duty / NEUTRAL_DUTY), 0.0, 1.0);

  // {t < ink} is exactly the band of relative width `ink`. Written through the
  // same (value - 0.5) form the ordered dithers use so `spread` means the same
  // thing here: 1 reproduces tone, 0 collapses to plain nearest-colour.
  let decision = ((1.0 - ink) - 0.5) + (t - 0.5) * params.spread;
  let index = select(pair.x, pair.y, decision > 0.0);

  // Alpha is carried through untouched. It is never composited onto white
  // anywhere in the stack (F-IN-03).
  textureStore(dst, coord, vec4<f32>(palette.entries[index].linear.rgb, texel.a));
  textureStore(dst_index, coord, vec4<u32>(index, 0u, 0u, 0u));
}
