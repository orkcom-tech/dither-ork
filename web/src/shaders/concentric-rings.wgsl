// F-PT-05 — Concentric rings pattern dither.
//
// A radial screen: the threshold is a periodic function of distance from a
// centre point, so the dither texture reads as rings expanding out of that
// point. Centre and pitch are the two controls the requirement names; phase is
// added because it is what makes the rings travel, and it is the only control
// here worth animating.
//
// **The ring profile is a triangle, not a sawtooth, and that is a tone
// decision rather than a taste one.** A screen reproduces tone correctly only
// when its threshold values are uniformly distributed over the area it covers.
// Ring area grows with radius, so within one ring of a sawtooth screen the
// outer part of the cycle covers more pixels than the inner part and the ring
// renders slightly light-biased. With a triangle, threshold t occurs twice per
// cycle — at fractional radii t/2 and 1 - t/2 — and the two radii are
// (k + t/2) and (k + 1 - t/2) pitches out, whose areas sum to a constant
// (2k + 1) independent of t. The bias cancels exactly, ring by ring.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// pitch divides the radius. The registry's legal range starts well above zero,
// so this clamp only catches a malformed document — but a zero here paints the
// frame NaN, and NaN in a linear-light buffer survives every node after it.
const MIN_PITCH : f32 = 0.03125;

const METRIC_OKLAB : u32 = 0u;
const METRIC_SRGB  : u32 = 1u;

// Offsets must match CONCENTRIC_RINGS_UNIFORMS in
// web/src/effects/concentric-rings.effect.ts. The three pad members make the
// 48-byte size visible here rather than leaving it to WGSL's round-up rule.
struct Params {
  width            : u32,   //  0
  height           : u32,   //  4
  centre_x         : f32,   //  8
  centre_y         : f32,   // 12
  pitch            : f32,   // 16
  phase            : f32,   // 20
  contrast         : f32,   // 24
  spread           : f32,   // 28
  threshold_offset : f32,   // 32
  pad0             : f32,   // 36
  pad1             : f32,   // 40
  pad2             : f32,   // 44
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

// The centre is stored in normalized image coordinates so a document keeps
// pointing at the same feature when the working resolution changes between
// preview and export.
fn ring_threshold(pixel : vec2<f32>) -> f32 {
  let centre = vec2<f32>(
    params.centre_x * f32(params.width),
    params.centre_y * f32(params.height),
  );
  let radius = length(pixel - centre);

  // phase is measured in whole ring cycles, so a modulator ramping 0 -> 1
  // advances the rings by exactly one pitch and lands back on frame 0.
  let cycles = radius / max(params.pitch, MIN_PITCH) + params.phase;

  // Triangle profile. See the header comment: this is what makes a flat field
  // average back to its own tone instead of drifting light.
  let saw = fract(cycles);
  return 1.0 - abs(2.0 * saw - 1.0);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);
  let linear_rgb = texel.rgb;

  let t = ring_threshold(vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5));

  // contrast steepens the screen around its own midpoint — above 1 it pushes
  // the profile towards the extremes and the rings harden into bands; below 1
  // it collapses towards a plain threshold.
  let shaped = clamp(0.5 + (t - 0.5) * params.contrast, 0.0, 1.0);

  let pair = candidate_pair(match_coords(linear_rgb, palette.metric));
  let entry_a = palette.entries[pair.x].linear.rgb;
  let entry_b = palette.entries[pair.y].linear.rgb;

  // Where the pixel sits between the two candidates, measured in LINEAR LIGHT.
  //
  // Dithering is tone reproduction: the fraction of pixels that land on B has
  // to equal the pixel's position between A and B, or a flat field does not
  // average back to itself. Averaging is physical, so it happens in linear
  // light. The metric still decides *which two* entries are in play, above; it
  // just does not decide the ratio between them.
  let axis = entry_b - entry_a;
  let axis_length_sq = dot(axis, axis);
  var f : f32 = 0.0;
  if (axis_length_sq > 1e-12) {
    f = clamp(dot(linear_rgb - entry_a, axis) / axis_length_sq, 0.0, 1.0);
  }

  // spread = 1 makes the tonal match exact for any palette, even and uneven
  // alike, because the threshold is compared against a *fraction* rather than
  // against an absolute step. 0 is plain nearest-colour with no dither; above 1
  // over-dithers on purpose.
  //
  // threshold_offset sits outside the spread scaling so its magnitude means the
  // same thing at every dither strength. Since the pair is ordered darker-first,
  // positive is always towards the lighter entry.
  let decision =
    (f - 0.5) + (shaped - 0.5) * params.spread + params.threshold_offset;
  let index = select(pair.x, pair.y, decision > 0.0);

  // Alpha is carried through untouched. It is never composited onto white
  // anywhere in the stack (F-IN-03).
  textureStore(dst, coord, vec4<f32>(palette.entries[index].linear.rgb, texel.a));
  textureStore(dst_index, coord, vec4<u32>(index, 0u, 0u, 0u));
}
