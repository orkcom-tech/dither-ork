// F-GL-11 — Slice repeat: seeded band duplication.
//
// The image is cut into bands of seeded thickness along one axis. A seeded
// subset of those bands is replaced by a thin strip of the picture repeated
// down the band, taken from a seeded offset — the stuttering repeated-strip
// look, rather than a plain band displacement, which is F-GL-02/03's job.
//
// Everything is a pure function of the band index and the seed, so the whole
// effect is one gather pass with no scratch buffer and no ordering between
// invocations. Two properties make that possible:
//
//   * A band boundary moves by less than half a slot, so the band containing a
//     pixel is one of three candidates and no search over the image is needed.
//   * The source strip is addressed modulo its own length, so the repeat is
//     arithmetic rather than an iteration.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const AXIS_HORIZONTAL : u32 = 0u;

// slice_size divides the band coordinate. The registry's legal range starts at
// 1, so this only catches a malformed document — but a zero here paints the
// frame NaN, and NaN in a linear-light buffer survives every node after it.
const MIN_SLICE : f32 = 1.0;

// Offsets must match SLICE_REPEAT_UNIFORMS in
// web/src/effects/slice-repeat.effect.ts. The three pad members make the
// 48-byte size visible here rather than leaving it to WGSL's round-up rule.
struct Params {
  width        : u32,   //  0
  height       : u32,   //  4
  slice_size   : f32,   //  8
  size_jitter  : f32,   // 12
  probability  : f32,   // 16
  offset_range : f32,   // 20
  repeats      : u32,   // 24
  axis         : u32,   // 28
  seed         : u32,   // 32
  pad0         : u32,   // 36
  pad1         : u32,   // 40
  pad2         : u32,   // 44
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

// --- shared: integer hash (keep identical across shaders) ----------------
//
// PCG hash, from Jarzynski & Olano, "Hash Functions for GPU Rendering". A pure
// function of its argument: no clock, no frame counter, no state. That is what
// F-AN-05 requires and what makes the loop-seam test possible at all.

fn pcg_hash(input : u32) -> u32 {
  let state = input * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

// Nested rather than added, so hash2(a, b) and hash2(b, a) differ. An additive
// combiner collides on every pair with the same sum, which on a pixel grid is
// every anti-diagonal.
fn hash2(a : u32, b : u32) -> u32 {
  return pcg_hash(a ^ pcg_hash(b));
}

fn hash3(a : u32, b : u32, c : u32) -> u32 {
  return pcg_hash(a ^ pcg_hash(b ^ pcg_hash(c)));
}

// [0, 1). Twenty-four bits is exactly what an f32 mantissa carries, so no draw
// is quietly rounded onto its neighbour.
fn unit_float(h : u32) -> f32 {
  return f32(h >> 8u) * (1.0 / 16777216.0);
}

// --- end shared ----------------------------------------------------------

fn wrap_axis(v : i32, n : i32) -> i32 {
  let k = v % n;
  return select(k + n, k, k >= 0);
}

// Boundary between slot-1 and slot, jittered by at most half a slot.
//
// Half a slot is the ceiling that makes the whole scheme work: it keeps the
// boundaries monotone (so bands never cross) and it keeps every pixel's band
// within one slot of its nominal one (so band_of terminates in three steps).
// `bitcast` rather than a value conversion because slot -1 is a real case at
// the top edge and i32 -> u32 conversion of a negative number is not something
// to leave to the implementation.
fn boundary(slot : i32, h : f32) -> f32 {
  let r = unit_float(hash2(bitcast<u32>(slot), params.seed));
  return f32(slot) * h + (r - 0.5) * params.size_jitter * h;
}

fn band_of(u : f32, h : f32) -> i32 {
  let s0 = i32(floor(u / h));
  var s = s0 + 1;
  // boundary(s0 - 1) <= s0*h - h/2 < u always holds, so this walk stops at
  // s0 - 1 at the latest. It is a bounded search, not a fallback.
  while (s > s0 - 1 && boundary(s, h) > u) {
    s = s - 1;
  }
  return s;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));

  let horizontal = params.axis == AXIS_HORIZONTAL;
  // Horizontal bands stack down the image, so their coordinate is y.
  let extent = select(i32(params.width), i32(params.height), horizontal);
  let u = select(f32(gid.x) + 0.5, f32(gid.y) + 0.5, horizontal);

  let h = max(params.slice_size, MIN_SLICE);
  let slot = band_of(u, h);
  let top = boundary(slot, h);
  // At full jitter two boundaries can meet. Such a band contains no pixels, so
  // this floor is never the thickness of a band anyone sees — it exists to keep
  // the division below defined.
  let thickness = max(boundary(slot + 1, h) - top, 1.0);

  let band_hash = hash3(bitcast<u32>(slot), params.seed, 0x2545f491u);

  var source = select(i32(gid.x), i32(gid.y), horizontal);
  if (unit_float(band_hash) < params.probability) {
    // How many times the strip repeats inside this band. 1 is a plain
    // displacement of the band, which is why the legal range starts there
    // rather than at 2.
    let count = 1u + (pcg_hash(band_hash) % max(params.repeats, 1u));
    let strip = thickness / f32(count);

    // Where the strip is read from, relative to the band's own top. Wrapped
    // rather than clamped: a clamp would pile every large offset onto the same
    // edge strip and make the control stop working past the image bounds.
    let reach = (unit_float(pcg_hash(band_hash ^ 0x27d4eb2fu)) * 2.0 - 1.0) * params.offset_range;
    let local = u - top;
    let along = local - floor(local / strip) * strip;
    source = wrap_axis(i32(floor(top + reach + along)), extent);
  }

  let from_coord = select(vec2<i32>(source, i32(gid.y)), vec2<i32>(i32(gid.x), source), horizontal);

  // Alpha travels with the pixel it belongs to (F-IN-03).
  textureStore(dst, coord, textureLoad(src, from_coord, 0));
}
