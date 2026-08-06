// F-GL-02 — Row displacement.
//
// The image is cut into horizontal slices of seeded height and each slice is
// shifted sideways by a seeded amount.
//
// Two dispatches, because slice heights are drawn one after another and a row
// cannot tell which slice it is in without knowing where every slice above it
// ended. `build_slices` is that walk — a single invocation stepping down the
// image, drawing a height and an offset per slice and writing the resolved
// offset for every row it covers. `apply` is then a pure lookup, one invocation
// per pixel.
//
// A single-invocation dispatch is deliberate. The walk is one iteration per
// row — a few thousand, once — against a per-pixel pass that is millions, and
// the alternative formulations either give up control of the slice heights
// (jittering a fixed grid) or make every pixel repeat the walk.
//
// Offsets and slice heights are **fractions of the image**, not pixels.
// Preview and export are the same graph at different resolutions
// (docs/ARCHITECTURE.md, "Render graph"), so a pixel-valued displacement would
// make the exported picture a different picture.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const EDGE_CLAMP  : u32 = 0u;
const EDGE_WRAP   : u32 = 1u;
const EDGE_MIRROR : u32 = 2u;

// Offsets must match ROW_DISPLACEMENT_UNIFORMS in
// web/src/effects/row-displacement.effect.ts. Eight 4-byte scalars, so the
// block is exactly 32 bytes with no implicit padding anywhere in it.
struct Params {
  width             : u32,   //  0
  height            : u32,   //  4
  seed              : u32,   //  8
  edge              : u32,   // 12
  min_slice_height  : f32,   // 16
  max_slice_height  : f32,   // 20
  offset_range      : f32,   // 24
  probability       : f32,   // 28
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

// One signed pixel offset per row. Written by `build_slices`, read by `apply`.
@group(0) @binding(6) var<storage, read_write> offsets : array<i32>;

// --- shared: seeded hash (keep identical across shaders) -----------------
//
// Determinism, not quality: the same (seed, index) must give the same number on
// every device and every run. Nothing here reads a clock or a frame counter —
// an animated glitch moves because a modulator moved a parameter (F-AN-05).

fn pcg_hash(v : u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn hash2(a : u32, b : u32) -> u32 {
  // The odd multiplier decorrelates the two arguments, so seed 0 with index 1
  // and seed 1 with index 0 are different draws rather than the same one.
  return pcg_hash(a ^ (b * 0x9e3779b9u));
}

// Strictly below 1. Taking the top 24 bits makes the division exact in f32;
// scaling the full 32 bits would round 0xffffffff up to exactly 1.0 and let an
// index derived from it fall one past the end of its range.
fn hash01(a : u32, b : u32) -> f32 {
  return f32(hash2(a, b) >> 8u) * 5.9604645e-8;
}

// --- end shared ----------------------------------------------------------

// --- shared: edge handling (keep identical across shaders) ---------------

fn wrap_coord(v : i32, n : i32) -> i32 {
  // WGSL's % takes the sign of the dividend, so a negative coordinate would
  // index backwards past the start of the row.
  let m = v % n;
  return select(m + n, m, m >= 0);
}

fn mirror_coord(v : i32, n : i32) -> i32 {
  // Triangle wave of period 2n: ... 2, 1, 0, 0, 1, 2 ... n-1, n-1, n-2 ...
  let period = 2 * n;
  var m = v % period;
  m = select(m + period, m, m >= 0);
  return select(period - 1 - m, m, m < n);
}

fn resolve_coord(v : i32, n : i32, mode : u32) -> i32 {
  if (mode == EDGE_WRAP) { return wrap_coord(v, n); }
  if (mode == EDGE_MIRROR) { return mirror_coord(v, n); }
  return clamp(v, 0, n - 1);
}

// --- end shared ----------------------------------------------------------

// Three independent draws per slice. Separate salts rather than consecutive
// indices, so raising the slice count does not reshuffle the offsets of the
// slices that were already there.
const SALT_HEIGHT : u32 = 0x00000000u;
const SALT_ACTIVE : u32 = 0x5bd1e995u;
const SALT_OFFSET : u32 = 0x27d4eb2fu;

@compute @workgroup_size(1, 1, 1)
fn build_slices(@builtin(global_invocation_id) gid : vec3<u32>) {
  // The dispatch is a single workgroup of a single invocation. Stated rather
  // than assumed: this walk is inherently sequential and running it twice would
  // write the same buffer from two invocations.
  if (gid.x != 0u || gid.y != 0u || gid.z != 0u) {
    return;
  }

  let height = i32(params.height);
  let width = f32(params.width);

  // min and max are two ends of one range, so an inverted pair is read as the
  // range the user described rather than refused. A slice is at least one row.
  let low_fraction = min(params.min_slice_height, params.max_slice_height);
  let high_fraction = max(params.min_slice_height, params.max_slice_height);
  let low = max(1, i32(round(low_fraction * f32(height))));
  let high = max(low, i32(round(high_fraction * f32(height))));
  let span = f32(high - low + 1);

  var y : i32 = 0;
  var slice : u32 = 0u;
  loop {
    if (y >= height) { break; }

    // hash01 is strictly below 1, so the product is below `span`; the clamp
    // covers the one case it cannot — f32 rounding of `hash01 * span` at large
    // spans, where landing exactly on `span` would index one row too far.
    let drawn = low + i32(hash01(params.seed ^ SALT_HEIGHT, slice) * span);
    let rows = clamp(drawn, low, high);

    var offset : i32 = 0;
    if (hash01(params.seed ^ SALT_ACTIVE, slice) < params.probability) {
      let signed = hash01(params.seed ^ SALT_OFFSET, slice) * 2.0 - 1.0;
      offset = i32(round(signed * params.offset_range * width));
    }

    for (var i : i32 = 0; i < rows && y + i < height; i = i + 1) {
      offsets[u32(y + i)] = offset;
    }

    y = y + rows;
    slice = slice + 1u;
  }
}

@compute @workgroup_size(8, 8, 1)
fn apply(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));

  // A whole number of texels moves. Slices tear, they do not smear, so there is
  // nothing to interpolate and the source pixel arrives intact.
  let offset = offsets[gid.y];
  let source_x = resolve_coord(coord.x - offset, i32(params.width), params.edge);

  // Alpha travels with the pixel; nothing is composited onto white (F-IN-03).
  textureStore(dst, coord, textureLoad(src, vec2<i32>(source_x, coord.y), 0));
}
