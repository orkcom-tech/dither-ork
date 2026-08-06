// F-PP-07 — threshold map from an uploaded image: any image as a dither matrix.
//
// The same program as the five ordered dithers (F-OD-01..05) — sample a matrix
// at a transformed coordinate, perturb the pixel by the threshold, take the
// nearest of the two candidate palette entries — with one difference: the
// matrix is not a tile generated in Rust and shipped with the effect, it is an
// image the user chose for *this node*. So it arrives through the per-node bulk
// data channel (`InstanceDataBinding` in web/src/types/gpu.ts) rather than as a
// `table` binding, and it carries its own dimensions because they are a
// property of the upload rather than of the shader.
//
// **The buffer is self-describing, and the header is validated on the CPU.**
// A shader cannot refuse: the worst it can do with a malformed buffer is index
// out of bounds, which robust buffer access turns into zeroes — a black frame
// with no error anywhere. So `web/src/effects/threshold-map.effect.ts` checks
// the magic, the version and the declared extent against the byte length before
// the bytes ever reach a binding, and this file assumes what that guaranteed.
//
//   word 0      magic, 0x50414D54 ("TMAP" in little-endian byte order)
//   word 1      format version, 1
//   word 2      width in texels, at least 1
//   word 3      height in texels, at least 1
//   word 4..    width × height texels, 0xAABBGGRR — the byte order an
//               ImageData buffer already has, so the uploader copies rather
//               than repacks
//
// **The threshold is the encoded luma of the texel, used directly.** Two
// choices in that sentence, both deliberate.
//
// Encoded, not linear: the user picked this image by looking at it, and a
// threshold map is a statement about where each cell sits in the ordering they
// can see. Linearising it would move a mid-grey from 0.5 to 0.21 and bias every
// dither towards the dark entry of its pair, which is not what the picture they
// chose looks like.
//
// Directly, not rank-normalised: histogram-equalising the image would make
// every upload span (0, 1) evenly and would therefore make two different images
// produce nearly the same dither. The whole requirement is that *any* image
// works as a matrix, including a low-contrast one that barely dithers — and
// F-OD-CTL's `contrast` control is already the way to steepen it, applied to
// this matrix exactly as it is applied to a Bayer tile.
//
// Alpha is ignored. A matrix cell is an ordering, and a transparent cell has no
// meaningful place in one; using alpha to weight it would invent a rule the
// requirement does not state.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const TAU : f32 = 6.283185307179586;

// The header, in words. Restated as THRESHOLD_MAP_HEADER_WORDS in
// web/src/effects/threshold-map.effect.ts.
const HEADER_WORDS : u32 = 4u;

// tile_scale divides the sampling coordinate. The registry's legal range starts
// above zero, so this clamp only catches a malformed document — but a zero here
// paints the whole frame NaN, and NaN in a linear-light buffer survives every
// node after it.
const MIN_TILE_SCALE : f32 = 0.0009765625;

const METRIC_OKLAB : u32 = 0u;
const METRIC_SRGB  : u32 = 1u;

// Offsets must match ORDERED_DITHER_UNIFORMS in web/src/gpu/effects/ordered.ts:
// this node exposes F-OD-CTL, the same controls every ordered dither does, so
// it reads the same block. The three pad members make the 48-byte size visible
// here rather than leaving it to WGSL's round-up rule.
struct Params {
  width            : u32,   //  0
  height           : u32,   //  4
  threshold_offset : f32,   //  8
  contrast         : f32,   // 12
  spread           : f32,   // 16
  tile_scale       : f32,   // 20
  tile_rotation    : f32,   // 24
  offset_x         : f32,   // 28
  offset_y         : f32,   // 32
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
// The uploaded matrix, header and all. Read-only: the CPU validates these bytes
// and the shader samples them.
@group(0) @binding(6) var<storage, read> map : array<u32>;

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

// WGSL's % takes the sign of the dividend, so a negative offset would index
// backwards out of the matrix.
fn wrap_index(v : f32, n : i32) -> i32 {
  let k = i32(floor(v)) % n;
  return select(k + n, k, k >= 0);
}

// One matrix cell's threshold: the Rec.709 luma of its sRGB-encoded colour.
//
// The coefficients are the same three the linear-light `luminance` above uses.
// Applying them to encoded values is not that function in another space and is
// not meant to be — it is the standard luma of a display-referred pixel, which
// is what the ordering the user can see is made of.
fn cell_threshold(word : u32) -> f32 {
  let r = f32(word & 0xffu) / 255.0;
  let g = f32((word >> 8u) & 0xffu) / 255.0;
  let b = f32((word >> 16u) & 0xffu) / 255.0;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// F-OD-CTL: tile scale, tile rotation and X/Y offset are all transforms of the
// coordinate the matrix is sampled at, not of the image. Rotation is about the
// image centre so an animated rotation sweeps the frame evenly instead of
// pivoting on a corner, and it is measured in turns so a modulator that ramps
// 0 -> 1 closes the loop exactly.
//
// The matrix wraps on its own dimensions rather than on a compile-time tile
// size, which is the only structural difference from the Bayer shaders.
fn map_threshold(pixel : vec2<f32>) -> f32 {
  let map_width = i32(map[2]);
  let map_height = i32(map[3]);

  let centre = vec2<f32>(f32(params.width), f32(params.height)) * 0.5;
  let angle = params.tile_rotation * TAU;
  let sn = sin(angle);
  let cs = cos(angle);

  let d = pixel - centre;
  var q = vec2<f32>(d.x * cs - d.y * sn, d.x * sn + d.y * cs);
  q = q / max(params.tile_scale, MIN_TILE_SCALE);
  q = q + vec2<f32>(params.offset_x, params.offset_y);

  let ix = wrap_index(q.x, map_width);
  let iy = wrap_index(q.y, map_height);
  return cell_threshold(map[HEADER_WORDS + u32(iy * map_width + ix)]);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);
  let linear_rgb = texel.rgb;

  let t = map_threshold(vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5));

  // contrast steepens the matrix around its own midpoint — above 1 it pushes
  // cells towards the extremes and the texture hardens; below 1 it collapses
  // towards a plain threshold. On an uploaded image this is also the control
  // that rescues a low-contrast matrix, which is why nothing normalises it.
  let shaped = clamp(0.5 + (t - 0.5) * params.contrast, 0.0, 1.0);

  let pair = candidate_pair(match_coords(linear_rgb, palette.metric));
  let entry_a = palette.entries[pair.x].linear.rgb;
  let entry_b = palette.entries[pair.y].linear.rgb;

  // Where the pixel sits between the two candidates, measured in LINEAR LIGHT.
  //
  // This is the line the whole effect turns on. Dithering is tone reproduction:
  // the fraction of pixels that land on B has to equal the pixel's position
  // between A and B, or a flat field does not average back to itself. Averaging
  // is physical, so it happens in linear light — computing this fraction in a
  // perceptual space instead moves a mid grey from 21% white to 59% white on a
  // two-colour palette, which is not a look control, it is a broken image.
  //
  // The metric still decides *which two* entries are in play, above. It just
  // does not decide the ratio between them.
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
  // same thing at every dither strength: it slides the cut between the two
  // candidates, and +/-0.5 forces one of them everywhere. Since the pair is
  // ordered darker-first, positive is always towards the lighter entry.
  let decision =
    (f - 0.5) + (shaped - 0.5) * params.spread + params.threshold_offset;
  let index = select(pair.x, pair.y, decision > 0.0);

  // Alpha is carried through untouched. It is never composited onto white
  // anywhere in the stack (F-IN-03).
  textureStore(dst, coord, vec4<f32>(palette.entries[index].linear.rgb, texel.a));
  textureStore(dst_index, coord, vec4<u32>(index, 0u, 0u, 0u));
}
