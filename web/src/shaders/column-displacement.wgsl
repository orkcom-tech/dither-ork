// F-GL-03 — Column displacement.
//
// Row displacement turned ninety degrees: the image is cut into vertical slices
// of seeded width and each is shifted up or down by a seeded amount.
//
// Two dispatches for the same reason as F-GL-02. Slice widths are drawn one
// after another, so which slice a column belongs to depends on every slice to
// its left; `build_slices` is that sequential walk, run once by a single
// invocation into a per-column buffer, and `apply` is a lookup per pixel.
//
// This is a separate file from `row-displacement.wgsl` rather than an axis flag
// on it. The shaders are complete and constant by contract, and one file per
// effect is what lets the two be edited independently — see
// web/src/shaders/CONVENTIONS.md.
//
// Slice widths and offsets are **fractions of the image**, not pixels, because
// preview and export are the same graph at different resolutions.

const EDGE_CLAMP  : u32 = 0u;
const EDGE_WRAP   : u32 = 1u;
const EDGE_MIRROR : u32 = 2u;

// Offsets must match COLUMN_DISPLACEMENT_UNIFORMS in
// web/src/effects/column-displacement.effect.ts. Eight 4-byte scalars, so the
// block is exactly 32 bytes with no implicit padding anywhere in it.
struct Params {
  width            : u32,   //  0
  height           : u32,   //  4
  seed             : u32,   //  8
  edge             : u32,   // 12
  min_slice_width  : f32,   // 16
  max_slice_width  : f32,   // 20
  offset_range     : f32,   // 24
  probability      : f32,   // 28
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

// One signed pixel offset per column. Written by `build_slices`, read by
// `apply`. It needs `width` entries; the buffer is sized per-pixel because
// `ScratchSize` has a per-row rule and no per-column one, so the choice is
// between over-allocating and risking a buffer short of the columns it has to
// address — see the note in the effect module.
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
  // index backwards past the start of the column.
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
const SALT_WIDTH  : u32 = 0x00000000u;
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

  let width = i32(params.width);
  let height = f32(params.height);

  // min and max are two ends of one range, so an inverted pair is read as the
  // range the user described rather than refused. A slice is at least one
  // column.
  let low_fraction = min(params.min_slice_width, params.max_slice_width);
  let high_fraction = max(params.min_slice_width, params.max_slice_width);
  let low = max(1, i32(round(low_fraction * f32(width))));
  let high = max(low, i32(round(high_fraction * f32(width))));
  let span = f32(high - low + 1);

  var x : i32 = 0;
  var slice : u32 = 0u;
  loop {
    if (x >= width) { break; }

    // hash01 is strictly below 1, so the product is below `span`; the clamp
    // covers the one case it cannot — f32 rounding of `hash01 * span` at large
    // spans, where landing exactly on `span` would index one column too far.
    let drawn = low + i32(hash01(params.seed ^ SALT_WIDTH, slice) * span);
    let columns = clamp(drawn, low, high);

    var offset : i32 = 0;
    if (hash01(params.seed ^ SALT_ACTIVE, slice) < params.probability) {
      let signed = hash01(params.seed ^ SALT_OFFSET, slice) * 2.0 - 1.0;
      offset = i32(round(signed * params.offset_range * height));
    }

    for (var i : i32 = 0; i < columns && x + i < width; i = i + 1) {
      offsets[u32(x + i)] = offset;
    }

    x = x + columns;
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
  let offset = offsets[gid.x];
  let source_y = resolve_coord(coord.y - offset, i32(params.height), params.edge);

  // Alpha travels with the pixel; nothing is composited onto white (F-IN-03).
  textureStore(dst, coord, textureLoad(src, vec2<i32>(coord.x, source_y), 0));
}
