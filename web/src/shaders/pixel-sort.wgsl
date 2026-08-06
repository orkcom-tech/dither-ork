// F-GL-01 — Pixel sort.
//
// Sorting contiguous spans is not a pointwise operation, so this is three
// dispatches rather than one, and the split is the whole design:
//
//   1. `spans_rows`    — one invocation per row,    active when the direction
//   2. `spans_columns` — one invocation per column, is horizontal / vertical
//   3. `sort_scatter`  — one invocation per pixel
//
// Passes 1 and 2 are the serial half. Finding spans means walking a line from
// one end deciding where runs start and stop, and capping a run at the span
// limit makes that walk order-dependent — a pixel cannot know which span it is
// in by looking at its neighbours. So one invocation owns a whole line, writes
// every pixel's sort key into `keys`, and then writes every pixel's span bounds
// into `spans`. A line is entirely independent of every other line, so the
// parallelism is one invocation per line, which is what the `per-row` and
// `per-column` dispatch shapes exist for (web/src/types/gpu.ts).
//
// Only one of the two runs: the direction is a uniform and the dispatch shape
// is fixed at compile time, so the axis that is not selected returns on its
// first instruction. Two exact dispatches cost less than one per-pixel dispatch
// whose invocations almost all exist to fail a bounds check.
//
// Pass 3 is the parallel half and it *scatters*. Each pixel counts how many
// pixels of its own span sort below it — that count is its rank — and stores
// itself at the rank's position. Rank is computed from a strict total order
// (key, then position), so within a span it is a bijection onto the span's own
// positions: every output texel is written exactly once, which is what lets the
// pass write into a recycled pool texture without clearing it first. A gather
// would need to invert the ranking, which is a search per output pixel rather
// than a count.
//
// The keys are computed once, in the line pass, and read back from storage in
// pass 3. Recomputing them would put an OKLab conversion — three cube roots —
// inside pass 3's inner loop, which runs `spanLimit` times per pixel.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// Direction ordinals: the order of `values` in the registry descriptor, which
// is what the uniform packer turns the document's string into. Bit 0 is the
// sort order, bit 1 is the axis, and both entry points below rely on that.
const DIR_RIGHT : u32 = 0u;   // rows,    ascending towards +x
const DIR_LEFT  : u32 = 1u;   // rows,    descending towards +x
const DIR_DOWN  : u32 = 2u;   // columns, ascending towards +y
const DIR_UP    : u32 = 3u;   // columns, descending towards +y

// Sort-key ordinals, same rule.
const KEY_LUMA       : u32 = 0u;
const KEY_HUE        : u32 = 1u;
const KEY_SATURATION : u32 = 2u;

const INV_TAU : f32 = 0.15915494309189535;

// OKLab chroma of the most saturated sRGB colours is a little over 0.32. The
// key is normalised by a slightly larger figure so saturation lands inside
// [0, 1] like the other two keys and one threshold slider means the same thing
// whichever key is chosen.
const CHROMA_REF : f32 = 0.4;

// Offsets must match PIXEL_SORT_UNIFORMS in
// web/src/effects/pixel-sort.effect.ts. Eight 4-byte scalars, so nothing needs
// padding in front of it and the block is exactly 32 bytes.
struct Params {
  width      : u32,   //  0
  height     : u32,   //  4
  seed       : u32,   //  8
  direction  : u32,   // 12
  sort_key   : u32,   // 16
  span_limit : u32,   // 20
  threshold  : f32,   // 24
  jitter     : f32,   // 28
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

// `spans[y * width + x]` is (first, last + 1) along the active axis. Every
// pixel is in a span — a pixel below the threshold is a span of one, which
// sorts to itself — so there is no sentinel and no branch for "not sorted".
@group(0) @binding(6) var<storage, read_write> spans : array<vec2<u32>>;

// `keys[y * width + x]` is the sort key. Declared read_write rather than read
// in pass 3 because one WGSL file declares a binding once, and passes 1 and 2
// write it.
@group(0) @binding(7) var<storage, read_write> keys : array<f32>;

// --- shared: linear -> OKLab (keep identical across shaders) -------------

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

// --- end shared ----------------------------------------------------------

// --- shared: seeded hash (keep identical across shaders) -----------------
//
// Determinism, not quality: the only requirement is that the same (seed, index)
// gives the same number on every device and every run. Nothing here reads a
// clock or a frame counter — an animated glitch moves because a modulator moved
// a parameter, not because the shader sampled time (F-AN-05).

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

// All three keys land in [0, 1] so that one threshold control reads the same
// way whichever is selected, and all three are measured in OKLab so the
// threshold is perceptually spaced rather than bunched in the highlights the
// way a linear-light luminance would be.
fn sort_key_of(rgb : vec3<f32>) -> f32 {
  let lab = linear_to_oklab(rgb);
  let chroma = length(vec2<f32>(lab.y, lab.z));

  if (params.sort_key == KEY_HUE) {
    // A neutral has no hue, and `atan2(0, 0)` is indeterminate in WGSL — it may
    // be anything, including NaN. That is not a cosmetic worry: NaN compares
    // false against everything, so two neutrals would compute the same rank,
    // claim the same destination, and leave an output texel unwritten, which in
    // a recycled pool texture is a pixel of the previous frame. Zero is the
    // value the limit does not have, chosen once, so greys share a key and fall
    // back on the positional tie-break.
    if (chroma < 1e-6) {
      return 0.0;
    }
    return fract(atan2(lab.z, lab.y) * INV_TAU + 1.0);
  }
  if (params.sort_key == KEY_SATURATION) {
    return clamp(chroma / CHROMA_REF, 0.0, 1.0);
  }
  return clamp(lab.x, 0.0, 1.0);
}

// The seed's only job. With jitter at 0 the effect is exactly the published
// algorithm and the seed does nothing, which is the honest default; above 0
// each line gets its own threshold and the spans stop lining up into columns.
fn line_threshold(line : u32) -> f32 {
  let offset = (hash01(params.seed, line) - 0.5) * params.jitter;
  return clamp(params.threshold + offset, 0.0, 1.0);
}

// `line` is the row for a horizontal sort and the column for a vertical one;
// `pos` is the coordinate along the line.
fn pixel_at(line : i32, pos : i32, vertical : bool) -> vec2<i32> {
  return select(vec2<i32>(pos, line), vec2<i32>(line, pos), vertical);
}

fn buffer_index(line : i32, pos : i32, vertical : bool) -> u32 {
  let coord = pixel_at(line, pos, vertical);
  return u32(coord.y) * params.width + u32(coord.x);
}

// One line, start to finish: keys first, then spans.
//
// Two walks rather than one because the run-length cap makes the span decision
// depend on keys ahead of the current pixel, and reading them back out of
// storage is cheaper than converting to OKLab twice.
fn scan_line(line : i32, vertical : bool) {
  let len = select(i32(params.width), i32(params.height), vertical);
  let threshold = line_threshold(u32(line));
  // A limit of zero would make no progress; the registry's legal minimum is 2,
  // so this only catches a malformed document.
  let limit = max(i32(params.span_limit), 1);

  for (var pos : i32 = 0; pos < len; pos = pos + 1) {
    let coord = pixel_at(line, pos, vertical);
    keys[buffer_index(line, pos, vertical)] = sort_key_of(textureLoad(src, coord, 0).rgb);
  }

  var pos : i32 = 0;
  loop {
    if (pos >= len) { break; }

    if (keys[buffer_index(line, pos, vertical)] < threshold) {
      spans[buffer_index(line, pos, vertical)] = vec2<u32>(u32(pos), u32(pos + 1));
      pos = pos + 1;
      continue;
    }

    // Maximal run of pixels at or above the threshold, chopped at the span
    // limit. Chopping rather than skipping is what keeps the control usable:
    // a long run becomes several sorted blocks instead of vanishing.
    var end = pos + 1;
    loop {
      if (end >= len) { break; }
      if (end - pos >= limit) { break; }
      if (keys[buffer_index(line, end, vertical)] < threshold) { break; }
      end = end + 1;
    }

    for (var i = pos; i < end; i = i + 1) {
      spans[buffer_index(line, i, vertical)] = vec2<u32>(u32(pos), u32(end));
    }
    pos = end;
  }
}

@compute @workgroup_size(64, 1, 1)
fn spans_rows(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (params.direction >= DIR_DOWN) { return; }
  if (gid.x >= params.height) { return; }
  scan_line(i32(gid.x), false);
}

@compute @workgroup_size(64, 1, 1)
fn spans_columns(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (params.direction < DIR_DOWN) { return; }
  if (gid.x >= params.width) { return; }
  scan_line(i32(gid.x), true);
}

@compute @workgroup_size(8, 8, 1)
fn sort_scatter(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let index = gid.y * params.width + gid.x;
  let span = spans[index];
  let key = keys[index];

  let vertical = params.direction >= DIR_DOWN;
  let line = select(coord.y, coord.x, vertical);
  let me = select(coord.x, coord.y, vertical);

  let start = i32(span.x);
  let end = i32(span.y);

  // Rank under a strict total order: key first, position as the tie-break. The
  // tie-break is not cosmetic — without it two equal keys would claim the same
  // destination and leave one texel of the output unwritten, which in a
  // recycled pool texture is a pixel of the previous frame.
  var rank : i32 = 0;
  for (var j = start; j < end; j = j + 1) {
    let other = keys[buffer_index(line, j, vertical)];
    if (other < key || (other == key && j < me)) {
      rank = rank + 1;
    }
  }

  // Bit 0 of the direction reverses the order. `end - 1 - rank` is the same
  // permutation read backwards, so the guarantee that every position is
  // claimed exactly once holds in both.
  //
  // `destination` rather than the obvious name: `target` is a WGSL reserved
  // keyword.
  let descending = (params.direction & 1u) == 1u;
  let destination = select(start + rank, end - 1 - rank, descending);

  // Alpha travels with the pixel; the whole texel moves. Nothing is composited
  // onto white anywhere in the stack (F-IN-03).
  textureStore(dst, pixel_at(line, destination, vertical), textureLoad(src, coord, 0));
}
