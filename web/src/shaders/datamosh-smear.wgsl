// F-GL-07 — Datamosh smear: directional pixel drag.
//
// What a datamosh looks like is a region that has stopped receiving new picture
// and is being carried along by motion it no longer has any content for: it
// stretches in one direction and stops dead at whatever still has detail. This
// reproduces that on a still image as a gated back-trace.
//
// For each pixel:
//
//   - if the pixel is itself a *source* — on the chosen side of the luminance
//     threshold — it is the head of a drag and keeps its own colour;
//   - otherwise the shader walks backwards along the drag direction until it
//     finds the nearest source pixel within reach, and takes that colour.
//
// The nearest source behind wins, so a source region paints forward until the
// next one interrupts it. That is the whole effect: it is a drag, not a
// directional blur. A blur averages the trail and turns edges to mush; this
// keeps the source pixel's exact colour, which is why the result has the hard
// leading edges and flat streaks a real mosh has.
//
// `decay` fades the carried colour back towards the pixel's own the further it
// has travelled, which is the residual running out. At 1 the drag is hard for
// its whole length.
//
// DETERMINISM: the only randomness is `jitter`, and it is a hash of the trail
// index and the node's `seed` parameter. No clock, no frame counter, no
// unseeded draw — see CONVENTIONS.md, "Determinism".
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const TAU : f32 = 6.283185307179586;

// The walk is bounded at compile time, and the bound equals the legal maximum
// of `dragLength` in datamosh-smear.effect.ts. If that range ever grows past
// this, the drag silently stops short — so the two numbers are stated together
// in both files.
const MAX_STEPS : i32 = 128;

// Enum ordinals, in the order `values` declares them in the descriptor. The
// packer sends an enum as its position in that list, so the list is
// append-only.
const SOURCE_BRIGHT : u32 = 0u;
const SOURCE_DARK   : u32 = 1u;

// Keeps pow() away from 0^0 when decay is 0: the exponent is 0 on the first
// step, and a decay of exactly 0 should still replace the pixel at distance 1
// and nothing beyond it.
const MIN_DECAY : f32 = 1e-6;

// sRGB transfer, matching core/crates/dither-core/src/color.rs exactly. The two
// have to agree or a threshold set in the UI means one thing on the CPU path
// and another here.
const SRGB_KNEE : f32 = 0.040448237;

// Offsets must match DATAMOSH_UNIFORMS in
// web/src/effects/datamosh-smear.effect.ts. The three pad members make the
// 48-byte size visible here rather than leaving it to WGSL's round-up rule.
struct Params {
  width       : u32,   //  0
  height      : u32,   //  4
  seed        : u32,   //  8
  source      : u32,   // 12
  angle       : f32,   // 16
  drag_length : f32,   // 20
  threshold   : f32,   // 24
  decay       : f32,   // 28
  jitter      : f32,   // 32
  pad0        : f32,   // 36
  pad1        : f32,   // 40
  pad2        : f32,   // 44
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

// Rec.709 luma on linear light.
fn luminance(c : vec3<f32>) -> f32 {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

// --- shared: sRGB transfer (keep identical across shaders) ---------------

fn srgb_to_linear_scalar(c : f32) -> f32 {
  if (c <= SRGB_KNEE) {
    return c / 12.92;
  }
  return pow((c + 0.055) / 1.055, 2.4);
}

// --- end shared ----------------------------------------------------------

// Wellons' lowbias32 finalizer. A pure integer function of its input, so the
// same seed and the same trail give the same draw on every device and every
// frame — which is what makes an animated smear loop and a document reproduce.
fn hash_u32(x : u32) -> u32 {
  var h = x;
  h = h ^ (h >> 16u);
  h = h * 0x7feb352du;
  h = h ^ (h >> 15u);
  h = h * 0x846ca68bu;
  h = h ^ (h >> 16u);
  return h;
}

fn hash2(a : u32, b : u32) -> u32 {
  return hash_u32(hash_u32(a) ^ (b * 0x9e3779b9u));
}

// Whether this pixel is a drag source, measured against a threshold that has
// already been converted to linear light.
fn is_source(c : vec3<f32>, threshold_linear : f32) -> bool {
  let y = luminance(c);
  if (params.source == SOURCE_DARK) {
    return y <= threshold_linear;
  }
  return y >= threshold_linear;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);
  let base = texel.rgb;

  // The threshold is converted once, not the samples.
  //
  // A slider at 0.5 has to mean mid grey, and mid grey is 0.214 in linear
  // light — comparing a linear luminance against 0.5 directly would put the
  // control's whole useful travel into its bottom quarter. Since the transfer
  // is monotonic, moving the threshold into linear light is exactly equivalent
  // to moving every sample out of it, and it costs one pow() instead of one per
  // step of the walk.
  let threshold_linear = srgb_to_linear_scalar(clamp(params.threshold, 0.0, 1.0));

  // A source pixel is the head of a drag, not part of one. Returning here is
  // what keeps source regions in place; without it every drag would also shift
  // the regions producing it.
  if (is_source(base, threshold_linear)) {
    textureStore(dst, coord, texel);
    return;
  }

  let angle = params.angle * TAU;
  let dir = vec2<f32>(cos(angle), sin(angle));
  let here = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);

  // Trail identity: the coordinate perpendicular to the drag.
  //
  // It is constant along the walk, so every pixel of one trail draws the same
  // reach and the smear stays coherent along its own length. Hashing the pixel
  // instead would make each pixel's reach independent, and the streaks would
  // dissolve into noise — which is the difference between a smear and a
  // grain.
  let perp = -dir.y * here.x + dir.x * here.y;
  let trail = bitcast<u32>(i32(floor(perp)));
  let draw = f32(hash2(trail, params.seed)) * (1.0 / 4294967296.0);

  let reach = max(params.drag_length * (1.0 - clamp(params.jitter, 0.0, 1.0) * draw), 0.0);
  let steps = min(i32(reach), MAX_STEPS);
  let decay = max(clamp(params.decay, 0.0, 1.0), MIN_DECAY);

  var carried = base;
  for (var k : i32 = 1; k <= steps; k = k + 1) {
    let q = here - dir * f32(k);
    let qi = vec2<i32>(i32(floor(q.x)), i32(floor(q.y)));
    // The walk stops at the frame edge rather than wrapping. A drag that wraps
    // pulls the far side of the picture into this one, which is a different
    // effect (F-GL-11) and not one to get by accident.
    if (qi.x < 0 || qi.y < 0 || qi.x >= i32(params.width) || qi.y >= i32(params.height)) {
      break;
    }
    let sample = textureLoad(src, qi, 0).rgb;
    if (is_source(sample, threshold_linear)) {
      carried = mix(base, sample, pow(decay, f32(k - 1)));
      break;
    }
  }

  // Alpha is carried through untouched; nothing in the stack composites onto
  // white (F-IN-03).
  textureStore(dst, coord, vec4<f32>(carried, texel.a));
}
