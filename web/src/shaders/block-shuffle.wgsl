// F-GL-12 — Block shuffle: grid size, seeded permutation, swap probability.
//
// The requirement is a *real* permutation of the grid, reproducible from the
// seed alone. That rules out the two things a shader is usually tempted into:
// hashing each block to a random destination (not a bijection — some blocks
// arrive twice and others never) and precomputing a shuffled table (there is no
// sort and no CPU round trip inside a dispatch).
//
// What every invocation can agree on without communicating is a *cipher*. A
// small Feistel network is a bijection on a power-of-two domain by
// construction, it is invertible in the same handful of integer operations, and
// it mixes well enough that the grid does not read as a pattern.
//
// The permutation is assembled in three steps:
//
//   1. `rank_of` maps a block index to a rank via the Feistel network, cycle
//      walking back into range when the power-of-two domain overshoots the
//      grid. Cycle walking preserves bijectivity: the orbit of a point under a
//      bijection is a cycle that returns to that point, so walking from inside
//      the grid must land back inside the grid.
//   2. Ranks are paired off, 2k with 2k+1. Each pair draws one coin against the
//      swap probability — one coin per *pair*, not per block, because two
//      halves of a pair that disagreed would stop the map being a permutation.
//   3. `block_of_rank` is the inverse of step 1, which is what turns a swapped
//      rank back into the block to gather from.
//
// The result is a product of disjoint transpositions: a genuine permutation,
// self-inverse, with exactly one fixed point when the grid holds an odd number
// of blocks. Self-inverse matters practically — a gather pass needs the inverse
// of the map it is expressing, and here they are the same function.
//
// Grid *counts* rather than a block size in pixels, deliberately. A pixel size
// would make the block count — and therefore the permutation — a function of
// the working resolution, so a preview and its export would be different
// pictures rather than the same picture at two sizes.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const FEISTEL_ROUNDS : u32 = 4u;
const MAX_HALF_BITS  : u32 = 8u;

// Offsets must match BLOCK_SHUFFLE_UNIFORMS in
// web/src/effects/block-shuffle.effect.ts. The two pad members make the 32-byte
// size visible here rather than leaving it to WGSL's round-up rule.
struct Params {
  width            : u32,   //  0
  height           : u32,   //  4
  columns          : u32,   //  8
  rows             : u32,   // 12
  swap_probability : f32,   // 16
  seed             : u32,   // 20
  pad0             : u32,   // 24
  pad1             : u32,   // 28
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

fn round_key(round : u32) -> u32 {
  return pcg_hash(params.seed ^ pcg_hash(round + 0x9e3779b9u));
}

// One round is (L, R) -> (R, L xor F(R)); the network is that, four times.
// Any round function gives a bijection — the structure, not the mixing, is what
// makes it invertible — so the hash only has to be good, not reversible.
fn feistel(v : u32, half_bits : u32) -> u32 {
  let mask = (1u << half_bits) - 1u;
  var l = v >> half_bits;
  var r = v & mask;
  for (var i : u32 = 0u; i < FEISTEL_ROUNDS; i = i + 1u) {
    let next = l ^ (pcg_hash(r ^ round_key(i)) & mask);
    l = r;
    r = next;
  }
  return (l << half_bits) | r;
}

// The same rounds undone in the opposite order: from (L', R') = (R, L xor F(R))
// we recover R = L' and L = R' xor F(L').
fn feistel_inverse(v : u32, half_bits : u32) -> u32 {
  let mask = (1u << half_bits) - 1u;
  var l = v >> half_bits;
  var r = v & mask;
  for (var i : u32 = 0u; i < FEISTEL_ROUNDS; i = i + 1u) {
    let prev = r ^ (pcg_hash(l ^ round_key(FEISTEL_ROUNDS - 1u - i)) & mask);
    r = l;
    l = prev;
  }
  return (l << half_bits) | r;
}

// Smallest half-width whose square domain covers the grid. The registry caps
// each grid axis at 256, so 65536 blocks is the largest possible count and
// eight bits per half always suffices.
fn half_bits_for(n : u32) -> u32 {
  var bits : u32 = 1u;
  while (bits < MAX_HALF_BITS && (1u << (2u * bits)) < n) {
    bits = bits + 1u;
  }
  return bits;
}

// Cycle walking, forward. The loop bound is the domain size because that bounds
// the cycle length; it is what the language needs to see rather than a case
// that occurs, since the domain is under twice the grid by construction and the
// expected number of steps is therefore below two.
fn rank_of(block : u32, n : u32, domain : u32, half_bits : u32) -> u32 {
  var v = feistel(block, half_bits);
  var k : u32 = 0u;
  while (v >= n && k < domain) {
    v = feistel(v, half_bits);
    k = k + 1u;
  }
  return v;
}

// Cycle walking, backward. Walking the inverse gives the inverse of the walk,
// which is what step 3 above needs.
fn block_of_rank(rank : u32, n : u32, domain : u32, half_bits : u32) -> u32 {
  var v = feistel_inverse(rank, half_bits);
  var k : u32 = 0u;
  while (v >= n && k < domain) {
    v = feistel_inverse(v, half_bits);
    k = k + 1u;
  }
  return v;
}

fn shuffle_source(block : u32, n : u32) -> u32 {
  let half_bits = half_bits_for(n);
  let domain = 1u << (2u * half_bits);

  let rank = rank_of(block, n, domain, half_bits);
  let partner = rank ^ 1u;
  // An odd number of blocks leaves exactly one rank unpaired. That block stays
  // where it is; there is no honest partner to give it.
  if (partner >= n) {
    return block;
  }
  // One coin per pair, keyed on the pair index, so both halves reach the same
  // verdict and the map stays a permutation at every probability.
  if (unit_float(hash2(rank >> 1u, params.seed ^ 0x51ed270bu)) >= params.swap_probability) {
    return block;
  }
  return block_of_rank(partner, n, domain, half_bits);
}

// First pixel of block `index` along an axis of `extent` pixels cut into
// `count` blocks. Integer division throughout, so blocks differ by at most one
// pixel and none is lost to rounding.
fn block_start(index : u32, count : u32, extent : u32) -> u32 {
  return (index * extent) / count;
}

// Inverse of block_start: the block a pixel belongs to. Written as
// ceil((x+1)*count/extent) - 1 rather than the more obvious x*count/extent,
// which disagrees with block_start whenever the grid does not divide the axis
// evenly and would offset the gather by a pixel along every seam.
fn block_index(pixel : u32, count : u32, extent : u32) -> u32 {
  return (pixel * count + count - 1u) / extent;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));

  // The registry's legal range starts at 1; these guard a malformed document,
  // where a zero would divide by zero rather than produce a visible mistake.
  let columns = max(params.columns, 1u);
  let rows = max(params.rows, 1u);

  let bx = block_index(gid.x, columns, params.width);
  let by = block_index(gid.y, rows, params.height);

  let source = shuffle_source(by * columns + bx, columns * rows);
  let sx = source % columns;
  let sy = source / columns;

  let dst_x0 = block_start(bx, columns, params.width);
  let dst_y0 = block_start(by, rows, params.height);
  let src_x0 = block_start(sx, columns, params.width);
  let src_y0 = block_start(sy, rows, params.height);

  // Source and destination blocks can differ by one pixel when the grid does
  // not divide the image evenly, and a grid finer than the image has empty
  // blocks. Both are handled by taking the offset the source block actually
  // has, which duplicates at most one row or column along a seam.
  let src_w = max(block_start(sx + 1u, columns, params.width) - src_x0, 1u);
  let src_h = max(block_start(sy + 1u, rows, params.height) - src_y0, 1u);

  let from_coord = vec2<i32>(
    i32(min(src_x0 + min(gid.x - dst_x0, src_w - 1u), params.width - 1u)),
    i32(min(src_y0 + min(gid.y - dst_y0, src_h - 1u), params.height - 1u)),
  );

  // Alpha travels with the pixel it belongs to (F-IN-03).
  textureStore(dst, coord, textureLoad(src, from_coord, 0));
}
