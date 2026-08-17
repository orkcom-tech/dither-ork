// F-PT-10 — Wave field with obstacle interaction.
//
// Wavefronts emanating from a source, and the picture's subject either bends
// them or blocks them. This is the effect that made F-INF-01 necessary:
// `concentric-rings` and `spiral` already draw radial patterns, and they take no
// account whatever of what is in the picture. The difference is not a
// parameter. A pattern that responds to the subject has to know **where the
// subject is as a shape** — how far every texel is from it and in which
// direction — and that is a global property no per-pixel read can compute.
//
// So this shader is nineteen passes and one of them draws. Eighteen build a
// signed distance field out of the picture — two smoothing the subject mask,
// one seeding its boundary, fifteen jump flooding (the shared block below,
// canonical text in web/src/gpu/sdf.ts); the last one reads the field and
// paints.
//
// ## The two interaction modes, and how each uses the field
//
// **Flow around** DELAYS the wave near the subject. The delay is added to the
// distance the wave has travelled, so a front that passes close to the obstacle
// is drawn where a slower one would have got to — which is what a wave doing
// anything other than ignoring an obstacle looks like. It decays with the
// distance to the boundary on both sides, so the fronts bend around the
// silhouette and carry over the figure rather than stopping at its edge.
//
// **It is a scalar added to the radius, not a displacement of the sample point,
// and that is a correctness decision that was measured.** The obvious
// construction is to move the point at which the wave is measured along the
// field's outward normal. It does not survive a real subject: the gradient of a
// distance field is continuous across the boundary but *discontinuous on the
// medial axis* — the skeleton where two parts of the boundary are equidistant,
// which on any real shape runs right through the middle of it — so neighbouring
// texels there sample points a whole wavelength apart and the interior comes out
// as confetti. It did, on a lit figure, at every reach and magnitude tried. A
// scalar delay has no such failure: it is a continuous function of one
// continuous quantity.
//
// The gradient is still what makes it a diffraction rather than a uniform
// ripple, and it is read for its SIGN against the direction back to the source.
// A texel whose outward normal points away from the source is one the wave had
// to get around, so it lags; one facing the source is reached directly, so it
// leads. That is a bounded factor in [-1, 1] rather than a distance, so the
// medial axis costs a crease at worst and only where the decay has not already
// taken the delay to nothing.
//
// The reach is measured in wavelengths, and that is physics rather than a magic
// number: a wave bends around an obstacle over a distance of the order of its
// own wavelength. Tying it to the wavelength also means dragging the wavelength
// keeps the picture coherent instead of leaving a bend sized for the old one.
//
// **Shadow** uses the field's VALUE, by sphere tracing. March from the texel
// back towards the source, stepping by the distance to the nearest boundary —
// the largest step guaranteed to hit nothing — and the subject is between them
// if the march ever lands inside it. The ratio of clearance to distance
// travelled gives the penumbra for free, so the shadow has a soft edge that
// widens with distance the way a real one does. A mask alone could not do this
// at any sane cost: it would be a per-texel walk along the whole ray.
//
// ## What it draws
//
// Crests, as strokes, in the palette's lightest and darkest entries — the same
// ink-and-ground argument as `ridgeline`. The wave's strength decays with
// distance from the source and with occlusion, and strength scales the STROKE
// WIDTH, so a fading wave thins out and disappears rather than dimming into a
// mid-tone the palette does not have.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const TAU : f32 = 6.28318530717958647692;

// Wavelength divides the distance. The registry's legal range starts well above
// this, so the clamp only catches a malformed document — but a zero here paints
// the frame NaN, and NaN in a linear-light buffer survives every node after it.
const MIN_WAVELENGTH : f32 = 0.5;

// How many sphere-tracing steps the shadow march may take.
//
// Each step advances by at least one texel and usually by far more — that is
// the point of tracing a distance field rather than a mask — so 64 crosses a
// 4K frame comfortably whenever the ray is not grazing a boundary. A ray that
// exhausts the budget while still grazing has been running parallel to a
// boundary, and the penumbra it accumulated is the right answer for that.
const SHADOW_STEPS : i32 = 64;

// How far from the subject the delay is felt, in wavelengths, on either side of
// the boundary. See the header: this is the diffraction scale.
const BEND_REACH_WAVELENGTHS : f32 = 1.5;

// The largest delay, in wavelengths, at strength 1. A whole wavelength puts a
// front where its neighbour was, which is as far as a bend can go before the
// fronts stop reading as one family of curves.
const BEND_MAX_WAVELENGTHS : f32 = 1.0;

// Ordinals restate the `values` lists in wave-field.effect.ts. Append-only.
const SOURCE_POINT : u32 = 0u;
const SOURCE_LINE  : u32 = 1u;
const SOURCE_EDGE  : u32 = 2u;

const MODE_FLOW   : u32 = 0u;
const MODE_SHADOW : u32 = 1u;

// Offsets must match WAVE_FIELD_UNIFORMS in
// web/src/effects/wave-field.effect.ts. The pad members make the 80-byte size
// visible here rather than leaving it to WGSL's round-up rule.
struct Params {
  width         : u32,   //  0
  height        : u32,   //  4
  source_kind   : u32,   //  8
  source_x      : f32,   // 12  fraction of the width
  source_y      : f32,   // 16  fraction of the height
  source_angle  : f32,   // 20  turns; the line source only
  wavelength    : f32,   // 24  texels
  amplitude     : f32,   // 28
  falloff       : f32,   // 32  fraction of the frame diagonal
  thickness     : f32,   // 36  texels, at full strength
  mode          : u32,   // 40
  strength      : f32,   // 44  how strongly the subject acts on the wave
  phase         : f32,   // 48  cycles
  invert        : u32,   // 52
  sdf_source    : u32,   // 56  <- sdfTransformUniformFields(56)
  sdf_threshold : f32,   // 60
  sdf_invert    : u32,   // 64
  sdf_smooth    : f32,   // 68  texels
  pad0          : u32,   // 72
  pad1          : u32,   // 76
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
@group(0) @binding(6) var<storage, read_write> sdf_seed_a : array<u32>;
@group(0) @binding(7) var<storage, read_write> sdf_seed_b : array<u32>;
@group(0) @binding(8) var<storage, read_write> sdf_mask : array<f32>;

// --- shared: signed distance transform of the picture (keep identical across shaders) ---
// A field transformed out of the picture (F-INF-01, the second producer).
//
// Four stages, and the third is fifteen passes:
//
//   1. sdf_smooth_*  — box-average the mask value along each axis, so that what
//                      is thresholded is a SHAPE and not one texel's brightness.
//                      Radius 0 is the identity.
//   2. sdf_seed      — mark the texels that sit ON the subject's boundary, and
//                      only those. One jump flood over the boundary gives the
//                      distance to it in both directions at once; flooding the
//                      subject and its complement separately would be two.
//   3. sdf_jfa_NN    — jump flood: each texel takes the best seed among the
//                      eight neighbours a step away, the step halving each
//                      pass. log2(extent) passes instead of a search per texel.
//   4. sdf_field     — read the answer: signed distance in texels, negative
//                      inside, plus the gradient of that signed distance.

// The seed of a texel that has not been reached. 0xFFFFFFFF rather than a
// sentinel coordinate, because every coordinate in range is a legal seed.
const SDF_NO_SEED : u32 = 0xFFFFFFFFu;

// What sdf_field returns where the picture has no boundary at all — a mask that
// is empty, or one that covers the frame. Finite and far past any real texel
// distance, so a consumer that forgets to check gets a wave it can see is wrong
// rather than a NaN that survives every node after it.
const SDF_FAR : f32 = 1.0e9;

// Ordinals restate SDF_MASK_SOURCES in web/src/gpu/sdf.ts. Append-only.
const SDF_MASK_LUMINANCE : u32 = 0u;
const SDF_MASK_ALPHA     : u32 = 1u;

fn sdf_pack_seed(p : vec2<i32>) -> u32 {
  return (u32(p.x) & 0xFFFFu) | ((u32(p.y) & 0xFFFFu) << 16u);
}

fn sdf_unpack_seed(s : u32) -> vec2<i32> {
  return vec2<i32>(i32(s & 0xFFFFu), i32((s >> 16u) & 0xFFFFu));
}

fn sdf_offset(p : vec2<i32>) -> u32 {
  return u32(p.y) * params.width + u32(p.x);
}

// Perceptual lightness, so the threshold slider means what the eye sees it
// mean: 0.5 in linear light is already a light grey, and a subject picked at
// "half brightness" would come out as the highlights alone. The cube root is
// the same curve web/src/gpu/resources.ts uses; it is spelled out here under an
// sdf_ name so a carrier may also hold the perceptual-lightness block.
fn sdf_lightness(c : vec3<f32>) -> f32 {
  let y = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return pow(max(y, 0.0), 1.0 / 3.0);
}

// The raw mask value at a texel, before smoothing and before the threshold.
// The whole of "what is the subject made of" is this function, and the source is
// a parameter rather than an assumption.
fn sdf_mask_value(p : vec2<i32>) -> f32 {
  let texel = textureLoad(src, p, 0);
  if (params.sdf_source == SDF_MASK_ALPHA) {
    return texel.a;
  }
  return sdf_lightness(texel.rgb);
}

// The smoothing radius in whole texels. 0 makes the pair below the identity, so
// a consumer that wants the raw threshold pays two buffer copies and nothing
// else.
fn sdf_smooth_radius() -> i32 {
  return i32(round(clamp(params.sdf_smooth, 0.0, 32.0)));
}

// Box average along the rows, into the seed buffer.
//
// **The mask is smoothed before it is thresholded, and that is what makes it a
// subject rather than a texture.** A per-texel threshold on a photograph is a
// few hundred islands — every seam, every highlight, its own closed boundary
// with its own field around it — and a wave field over that comes out as
// fragments. Averaging first says how big a thing has to be to count.
//
// A running sum along the line rather than a gather per texel: O(1) per texel at
// any radius, which is why this is a `per-row` dispatch with one invocation per
// line instead of a per-pixel pass with a loop in it. Edges are clamped, so a
// flat field stays flat.
//
// `sdf_seed_a` is the scratch here, bit for bit as an f32. It holds nothing yet
// — the flood does not start until `sdf_seed` — so the smoothing costs one
// buffer rather than two.
@compute @workgroup_size(64, 1, 1)
fn sdf_smooth_h(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.height) {
    return;
  }
  let y = i32(gid.x);
  let w = i32(params.width);
  let r = sdf_smooth_radius();
  let n = f32(2 * r + 1);

  var sum : f32 = 0.0;
  for (var k : i32 = -r; k <= r; k = k + 1) {
    sum = sum + sdf_mask_value(vec2<i32>(clamp(k, 0, w - 1), y));
  }
  sdf_seed_a[sdf_offset(vec2<i32>(0, y))] = bitcast<u32>(sum / n);

  for (var x : i32 = 1; x < w; x = x + 1) {
    sum = sum
        + sdf_mask_value(vec2<i32>(clamp(x + r, 0, w - 1), y))
        - sdf_mask_value(vec2<i32>(clamp(x - r - 1, 0, w - 1), y));
    sdf_seed_a[sdf_offset(vec2<i32>(x, y))] = bitcast<u32>(sum / n);
  }
}

// The other axis, out of the row scratch and into the mask buffer that survives
// the flood. Separable, so a radius of 32 costs two linear scans rather than a
// 65x65 gather.
@compute @workgroup_size(64, 1, 1)
fn sdf_smooth_v(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width) {
    return;
  }
  let x = i32(gid.x);
  let h = i32(params.height);
  let r = sdf_smooth_radius();
  let n = f32(2 * r + 1);

  var sum : f32 = 0.0;
  for (var k : i32 = -r; k <= r; k = k + 1) {
    sum = sum + bitcast<f32>(sdf_seed_a[sdf_offset(vec2<i32>(x, clamp(k, 0, h - 1)))]);
  }
  sdf_mask[sdf_offset(vec2<i32>(x, 0))] = sum / n;

  for (var y : i32 = 1; y < h; y = y + 1) {
    sum = sum
        + bitcast<f32>(sdf_seed_a[sdf_offset(vec2<i32>(x, clamp(y + r, 0, h - 1)))])
        - bitcast<f32>(sdf_seed_a[sdf_offset(vec2<i32>(x, clamp(y - r - 1, 0, h - 1)))]);
    sdf_mask[sdf_offset(vec2<i32>(x, y))] = sum / n;
  }
}

// Whether a texel belongs to the subject. Reads the SMOOTHED mask, so this is a
// question about a shape rather than about one texel's brightness.
fn sdf_subject(p : vec2<i32>) -> bool {
  let inside = sdf_mask[sdf_offset(p)] >= params.sdf_threshold;
  return select(inside, !inside, params.sdf_invert != 0u);
}

// Seed the boundary, and nothing else.
//
// A texel is a seed when it is in the subject and touches something that is
// not, or the reverse. Flooding from the boundary rather than from the subject
// is what makes ONE flood produce a SIGNED field: the distance is to the
// boundary from either side, and the sign is a local question sdf_subject
// answers at the reading texel.
//
// Neighbours are clamped to the frame rather than treated as background. A
// subject running off the edge of the picture has no boundary there — it
// continues past what was photographed — and seeding one would draw a
// wavefront along the frame's edge that nothing in the picture put there.
@compute @workgroup_size(8, 8, 1)
fn sdf_seed(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let p = vec2<i32>(i32(gid.x), i32(gid.y));
  let w = i32(params.width);
  let h = i32(params.height);

  let here = sdf_subject(p);
  let west  = sdf_subject(vec2<i32>(max(p.x - 1, 0), p.y));
  let east  = sdf_subject(vec2<i32>(min(p.x + 1, w - 1), p.y));
  let north = sdf_subject(vec2<i32>(p.x, max(p.y - 1, 0)));
  let south = sdf_subject(vec2<i32>(p.x, min(p.y + 1, h - 1)));

  var seed : u32 = SDF_NO_SEED;
  if (here != west || here != east || here != north || here != south) {
    seed = sdf_pack_seed(p);
  }
  sdf_seed_a[sdf_offset(p)] = seed;
}

// The step this level jumps, computed from the extent rather than baked in.
//
// Level 0 jumps half the longest side, and each level halves it. Deriving it
// here is what makes every pass do work at every resolution: a baked 2048 would
// be four full-frame copies before anything happened on a 1600px preview.
// Levels past log2(extent) clamp to 1, which is JFA+1 — extra refinement, never
// a no-op.
fn sdf_jfa_step(level : u32) -> i32 {
  let longest = max(i32(params.width), i32(params.height));
  return max(longest >> (level + 1u), 1);
}

// One flood step. `from_a` says which buffer holds the previous round; the
// caller alternates, and the two never alias.
fn sdf_jfa(p : vec2<i32>, level : u32, from_a : bool) {
  let w = i32(params.width);
  let h = i32(params.height);
  let step = sdf_jfa_step(level);

  var best : u32 = SDF_NO_SEED;
  var best_d : f32 = 3.0e38;

  for (var dy : i32 = -1; dy <= 1; dy = dy + 1) {
    for (var dx : i32 = -1; dx <= 1; dx = dx + 1) {
      let q = p + vec2<i32>(dx * step, dy * step);
      if (q.x < 0 || q.y < 0 || q.x >= w || q.y >= h) {
        continue;
      }
      var candidate : u32;
      if (from_a) {
        candidate = sdf_seed_a[sdf_offset(q)];
      } else {
        candidate = sdf_seed_b[sdf_offset(q)];
      }
      if (candidate == SDF_NO_SEED) {
        continue;
      }
      let delta = vec2<f32>(sdf_unpack_seed(candidate) - p);
      let d = dot(delta, delta);
      // Ties broken on the packed coordinate, so the answer does not depend on
      // the order the nine taps happen to be written in. Two texels equidistant
      // from one point is common on an axis-aligned mask edge.
      if (d < best_d || (d == best_d && candidate < best)) {
        best_d = d;
        best = candidate;
      }
    }
  }

  if (from_a) {
    sdf_seed_b[sdf_offset(p)] = best;
  } else {
    sdf_seed_a[sdf_offset(p)] = best;
  }
}

// The field at a texel, as F-INF-01 fixes it.
//
//   .x  signed distance to the nearest boundary, in working-resolution texels,
//       NEGATIVE INSIDE the subject.
//   .yz the gradient of that signed distance: a unit vector.
//
// **The gradient's sign is the part that is easy to get backwards.** Outside,
// distance grows as you move away from the boundary, so the gradient points
// away from the nearest boundary texel. Inside, the distance is negative and
// grows *towards* the boundary, so it is the same vector negated — and the
// result is that the gradient points out of the subject on both sides, exactly
// as sdf_normal's central difference does for an analytic shape. Consumers are
// written against one convention; two producers disagreeing about it is a
// wavefront that bends the wrong way and no error anywhere.
//
// Zero gradient is returned at a boundary texel itself and where the picture
// has no boundary at all. It is the honest answer — there is no direction to a
// boundary you are standing on, and none to one that does not exist — and it is
// the same answer, checked the same way, that sdf_normal returns at a local
// extremum.
fn sdf_field(p : vec2<i32>) -> vec3<f32> {
  let packed = sdf_seed_b[sdf_offset(p)];
  let sign_out = select(1.0, -1.0, sdf_subject(p));

  if (packed == SDF_NO_SEED) {
    return vec3<f32>(sign_out * SDF_FAR, 0.0, 0.0);
  }

  let delta = vec2<f32>(sdf_unpack_seed(packed) - p);
  let d = length(delta);
  if (d < 1e-6) {
    return vec3<f32>(0.0, 0.0, 0.0);
  }
  let gradient = delta * (-sign_out / d);
  return vec3<f32>(sign_out * d, gradient.x, gradient.y);
}

// Whether the field says anything at all here. A mask that caught everything or
// nothing has no boundary, and a consumer must take its no-obstacle branch
// rather than dividing by a distance of 1e9.
fn sdf_has_boundary(field : vec3<f32>) -> bool {
  return abs(field.x) < SDF_FAR;
}

// The fifteen flood levels. One entry point each, because the level and the
// buffer parity are the only things that differ and WGSL has no way to pass a
// constant into an entry point. Even levels read A and write B, so an odd
// count leaves the answer in B — which is what sdf_field reads and what
// sdfTransformPasses asserts.
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_00(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 0u, true);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_01(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 1u, false);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_02(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 2u, true);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_03(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 3u, false);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_04(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 4u, true);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_05(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 5u, false);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_06(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 6u, true);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_07(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 7u, false);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_08(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 8u, true);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_09(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 9u, false);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_10(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 10u, true);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_11(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 11u, false);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_12(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 12u, true);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_13(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 13u, false);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_14(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 14u, true);
}
// --- end shared ---------------------------------------------------------

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

// The palette's lightest and darkest entries, in that order. Same argument as
// `ridgeline`: this is a drawing, so it has an ink and a ground and no use for
// the entries between them. The lowest index wins a tie, so the answer does not
// depend on the loop.
fn ink_and_ground() -> vec2<u32> {
  var lightest : u32 = 0u;
  var darkest  : u32 = 0u;
  var most  : f32 = -1.0;
  var least : f32 = 1.0e30;
  for (var i : u32 = 0u; i < palette.count; i = i + 1u) {
    let y = rec709_luminance(palette.entries[i].linear.rgb);
    if (y > most) {
      most = y;
      lightest = i;
    }
    if (y < least) {
      least = y;
      darkest = i;
    }
  }
  return vec2<u32>(lightest, darkest);
}

fn source_point() -> vec2<f32> {
  // Normalized, so a document keeps pointing at the same feature when the
  // working resolution changes between preview and export (F-UI-03).
  return vec2<f32>(
    params.source_x * f32(params.width),
    params.source_y * f32(params.height),
  );
}

/// The normal of a line source: the direction its wavefronts travel in.
fn line_normal() -> vec2<f32> {
  let a = params.source_angle * TAU;
  // The line runs along (cos, sin); the wave travels across it.
  return vec2<f32>(-sin(a), cos(a));
}

/// Distance from the source, in texels — the quantity the wave is periodic in.
fn wave_distance(p : vec2<f32>) -> f32 {
  if (params.source_kind == SOURCE_LINE) {
    return abs(dot(p - source_point(), line_normal()));
  }
  if (params.source_kind == SOURCE_EDGE) {
    // The nearest edge of the frame, so the waves come inward from all four
    // sides at once and the pattern is a frame rather than a point.
    let w = f32(params.width);
    let h = f32(params.height);
    return min(min(p.x, w - p.x), min(p.y, h - p.y));
  }
  return length(p - source_point());
}

/// The unit vector pointing from a texel back towards the source.
fn towards_source(p : vec2<f32>) -> vec2<f32> {
  if (params.source_kind == SOURCE_LINE) {
    let n = line_normal();
    return select(n, -n, dot(p - source_point(), n) > 0.0);
  }
  if (params.source_kind == SOURCE_EDGE) {
    let w = f32(params.width);
    let h = f32(params.height);
    let left = p.x;
    let right = w - p.x;
    let top = p.y;
    let bottom = h - p.y;
    let least = min(min(left, right), min(top, bottom));
    if (least == left)  { return vec2<f32>(-1.0, 0.0); }
    if (least == right) { return vec2<f32>(1.0, 0.0); }
    if (least == top)   { return vec2<f32>(0.0, -1.0); }
    return vec2<f32>(0.0, 1.0);
  }
  let delta = source_point() - p;
  let d = length(delta);
  // At the source itself there is no direction back to it, and no ray to trace.
  return select(vec2<f32>(0.0), delta / d, d > 1e-6);
}

/// How much of the wave survives the journey from the source to this texel.
///
/// Sphere tracing over the distance field: step by the clearance, which is the
/// largest step guaranteed to cross nothing, so a clear ray costs a handful of
/// taps however far it runs. A step that lands inside the subject means the
/// subject is between this texel and the source, and the wave is blocked.
///
/// **The penumbra is one wavelength wide, and it does NOT widen with the length
/// of the ray.** The standard soft-shadow estimator from rendering is
/// `min(k * clearance / travelled)`, which grows the penumbra with distance
/// because a light source has a size. It is wrong here twice over: a wave has a
/// wavelength rather than a diameter, and — measured, on a figure lit from above
/// — with several small obstacles in the frame *every* long ray passes near one,
/// so the whole picture darkens with distance and no silhouette appears
/// anywhere. Diffraction blurs a shadow edge over about one wavelength; that is
/// what is used, it is a constant, and it puts the subject's outline in the
/// picture where the other one put a vignette.
fn shadow_term(p : vec2<f32>, coord : vec2<i32>, wavelength : f32) -> f32 {
  let direction = towards_source(p);
  if (dot(direction, direction) < 0.5) {
    return 1.0;
  }
  let limit = wave_distance(p);

  // A texel inside the subject is behind the whole of it.
  let here = sdf_field(coord);
  if (!sdf_has_boundary(here)) {
    // No boundary anywhere: the mask caught everything or nothing, so there is
    // no obstacle and nothing casts a shadow. That is the honest answer, not a
    // fallback — a picture with no subject in it has no shadow in it.
    return 1.0;
  }
  if (here.x <= 0.0) {
    return 0.0;
  }

  var travelled : f32 = max(here.x, 1.0);
  var least : f32 = 1.0;

  for (var i : i32 = 0; i < SHADOW_STEPS; i = i + 1) {
    if (travelled >= limit) {
      break;
    }
    let q = p + direction * travelled;
    let c = vec2<i32>(i32(floor(q.x)), i32(floor(q.y)));
    if (c.x < 0 || c.y < 0 || c.x >= i32(params.width) || c.y >= i32(params.height)) {
      break;
    }
    let field = sdf_field(c);
    if (field.x <= 0.0) {
      return 0.0;
    }
    // A ray that cleared the subject by a whole wavelength is not shadowed at
    // all, however far it has come; one that grazed it is. See the header.
    least = min(least, clamp(field.x / wavelength, 0.0, 1.0));
    travelled = travelled + max(field.x, 1.0);
  }

  return clamp(least, 0.0, 1.0);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let alpha = textureLoad(src, coord, 0).a;

  let p = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);
  let wavelength = max(params.wavelength, MIN_WAVELENGTH);

  var delay : f32 = 0.0;
  var occlusion : f32 = 1.0;

  if (params.mode == MODE_FLOW) {
    let field = sdf_field(coord);
    if (sdf_has_boundary(field)) {
      // The wave is DELAYED near the obstacle, and the delay decays with the
      // distance to it on both sides. See the header for why this is a scalar
      // added to the radius rather than a vector displacement of the sample
      // point: the gradient is discontinuous on the medial axis and a
      // displacement along it shatters the interior of any real subject.
      //
      // The `strength` control is signed. Positive delays the wave, so the
      // fronts bulge away from the source around the subject — a slower medium,
      // contour lines parting around a hill. Negative advances it and they
      // pinch inward instead.
      delay =
        params.strength * wavelength * BEND_MAX_WAVELENGTHS *
        exp(-abs(field.x) / (wavelength * BEND_REACH_WAVELENGTHS));
      // The gradient's sign against the direction back to the source is what
      // makes the delay a DIFFRACTION rather than a uniform ripple: a texel on
      // the far side of the subject, where the outward normal points away from
      // the source, is the one the wave had to travel around, so it is the one
      // that lags. A texel on the near side is reached directly and leads.
      let towards = towards_source(p);
      if (dot(towards, towards) > 0.5) {
        delay = delay * -dot(field.yz, towards);
      }
    }
  } else {
    occlusion = mix(1.0, shadow_term(p, coord, wavelength), clamp(abs(params.strength), 0.0, 1.0));
  }

  let r = wave_distance(p) + delay;

  // The frame diagonal, so `falloff` means the same fraction of the picture at
  // preview resolution and at export resolution.
  let diagonal = length(vec2<f32>(f32(params.width), f32(params.height)));
  let reach = max(params.falloff, 0.001) * diagonal;

  // phase is in whole cycles, so a modulator ramping 0 -> 1 advances the field
  // by exactly one wavelength and lands back on frame 0 (F-AN-03).
  let cycles = r / wavelength + params.phase;
  // Texels from here to the nearest crest.
  let to_crest = abs(fract(cycles + 0.5) - 0.5) * wavelength;

  // Strength scales the stroke WIDTH rather than its colour. A drawing has two
  // colours, so a fading wave has to fade by getting thinner and going out; a
  // dimmed stroke would need a mid-tone the palette may not contain.
  let strength = params.amplitude * exp(-r / reach) * occlusion;
  let half_t = 0.5 * params.thickness * clamp(strength, 0.0, 1.0);

  let ink = to_crest <= half_t;

  let pair = ink_and_ground();
  let stroke = select(pair.x, pair.y, params.invert != 0u);
  let ground = select(pair.y, pair.x, params.invert != 0u);
  let index = select(ground, stroke, ink);

  // Alpha is carried through untouched. It is never composited onto white
  // anywhere in the stack (F-IN-03).
  textureStore(dst, coord, vec4<f32>(palette.entries[index].linear.rgb, alpha));
  textureStore(dst_index, coord, vec4<u32>(index, 0u, 0u, 0u));
}
