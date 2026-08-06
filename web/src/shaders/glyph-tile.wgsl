// F-PT-08 — Glyph / tile dither.
//
// The image is divided into cells; each cell's mean colour picks a pair of
// palette entries and a position between them, and a glyph whose ink coverage
// matches that position is stamped into the cell. That is what makes it a
// dither rather than an ASCII-art filter: the glyph is chosen so the cell's
// average comes back to the cell's own tone.
//
// **Everything is decided from the cell mean, not the pixel.** Every pixel of a
// cell must agree on which glyph is being drawn, and the only way to guarantee
// that without a second pass is for every pixel to compute the same mean. So
// each invocation walks its own cell — up to 16x16 texels of redundant, but
// perfectly cache-local, loads. The pass is declared `neighbourhood` for that
// reason.
//
// The glyph sheets arrive as a table of row bitmasks built in
// web/src/effects/glyph-tile.effect.ts, which is where the sets and their
// coverages are written out. Table layout, all u32:
//
//   [0] set_count
//   [1] glyph_size       glyph raster edge, in texels
//   [2] stride           words per glyph: one coverage count plus glyph_size rows
//   [3] reserved
//   [4 + 2s]  glyph count of set s
//   [5 + 2s]  word offset of set s's glyphs
//   ...       per glyph: [set bits, row 0, row 1, ...], ordered by coverage
//
// Bit x of a row word is column x, counting from the left.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const HEADER_WORDS : u32 = 4u;

const METRIC_OKLAB : u32 = 0u;
const METRIC_SRGB  : u32 = 1u;

// Offsets must match GLYPH_TILE_UNIFORMS in
// web/src/effects/glyph-tile.effect.ts. The three pad members make the 48-byte
// size visible here rather than leaving it to WGSL's round-up rule.
struct Params {
  width            : u32,   //  0
  height           : u32,   //  4
  glyph_set        : u32,   //  8
  cell_size        : u32,   // 12
  invert           : u32,   // 16
  offset_x         : f32,   // 20
  offset_y         : f32,   // 24
  contrast         : f32,   // 28
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
@group(0) @binding(6) var<storage, read> glyphs : array<u32>;

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

// WGSL's / truncates towards zero, which puts two cells' worth of pixels into
// the cell at the origin once the offset pushes a coordinate negative.
fn floor_div(a : i32, b : i32) -> i32 {
  let q = a / b;
  return select(q, q - 1, (a % b) < 0);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));

  let set_count  = glyphs[0];
  let glyph_size = glyphs[1];
  let stride     = glyphs[2];

  // The registry's legal range already bounds the set ordinal, so this only
  // catches a malformed document; without it a bad value reads header words as
  // a glyph count and stamps a plausible-looking wrong image.
  //
  // `set` and `target` are WGSL reserved words and `read` is a predeclared
  // enumerant, which is why the obvious names are not the ones used below.
  let set_index = min(params.glyph_set, set_count - 1u);
  let entry = HEADER_WORDS + set_index * 2u;
  let glyph_count = glyphs[entry];
  let base = glyphs[entry + 1u];

  // The cell grid is locked to whole pixels — a fractional origin would resample
  // the glyph raster and blur its edges, which is the one thing a glyph dither
  // must not do — so the offsets floor.
  let cs = i32(max(params.cell_size, 1u));
  let ox = i32(floor(params.offset_x));
  let oy = i32(floor(params.offset_y));
  let x0 = floor_div(coord.x - ox, cs) * cs + ox;
  let y0 = floor_div(coord.y - oy, cs) * cs + oy;

  // Mean of the cell, in LINEAR LIGHT. Cells at the right and bottom edges are
  // clipped by the image, so the divisor is the count actually read rather than
  // the cell area — averaging in the missing texels as black would darken every
  // edge cell.
  var sum = vec3<f32>(0.0);
  var sampled : f32 = 0.0;
  for (var dy = 0; dy < cs; dy = dy + 1) {
    let y = y0 + dy;
    if (y >= 0 && y < i32(params.height)) {
      for (var dx = 0; dx < cs; dx = dx + 1) {
        let x = x0 + dx;
        if (x >= 0 && x < i32(params.width)) {
          sum = sum + textureLoad(src, vec2<i32>(x, y), 0).rgb;
          sampled = sampled + 1.0;
        }
      }
    }
  }
  // sampled is at least 1: this invocation's own pixel is inside its own cell.
  let mean = sum / sampled;

  let pair = candidate_pair(match_coords(mean, palette.metric));
  let entry_a = palette.entries[pair.x].linear.rgb;
  let entry_b = palette.entries[pair.y].linear.rgb;

  // Where the cell mean sits between the two candidates, measured in LINEAR
  // LIGHT. Dithering is tone reproduction: the fraction of the cell that lands
  // on B has to equal this, or a flat field does not average back to itself.
  let axis = entry_b - entry_a;
  let axis_length_sq = dot(axis, axis);
  var f : f32 = 0.0;
  if (axis_length_sq > 1e-12) {
    f = clamp(dot(mean - entry_a, axis) / axis_length_sq, 0.0, 1.0);
  }

  // contrast steepens the mapping around its midpoint, which is what pushes an
  // ASCII rendering towards a smaller, harder-edged set of characters.
  let shaped = clamp(0.5 + (f - 0.5) * params.contrast + params.threshold_offset, 0.0, 1.0);

  // Ink is the darker candidate by default, so a dark cell is dense ink on a
  // light ground. Inverting swaps them, which is the light-on-black terminal
  // look — and it swaps the coverage the glyph has to hit along with it.
  let inverted = params.invert != 0u;
  let ink = select(pair.x, pair.y, inverted);
  let paper = select(pair.y, pair.x, inverted);
  let wanted = select(1.0 - shaped, shaped, inverted);

  // Nearest coverage rather than an even split of the index range: the sets are
  // not evenly spaced in coverage, and matching on coverage is what keeps the
  // tone right. Note that no ASCII glyph fills its cell, so a set whose densest
  // glyph covers 56% cannot reach solid ink — that is a property of the set and
  // it is why the block set exists.
  let area = f32(glyph_size * glyph_size);
  var best : u32 = 0u;
  var best_delta : f32 = 2.0;
  for (var g : u32 = 0u; g < glyph_count; g = g + 1u) {
    let coverage = f32(glyphs[base + g * stride]) / area;
    let delta = abs(coverage - wanted);
    if (delta < best_delta) {
      best_delta = delta;
      best = g;
    }
  }

  // Nearest-neighbour sampling of the glyph raster into the cell. The glyph
  // sheet is a fixed raster and the cell is a parameter, so a cell smaller than
  // the raster drops rows and columns; below about six pixels the letterforms
  // stop being readable, which the registry hint says.
  let lx = coord.x - x0;
  let ly = coord.y - y0;
  let gx = u32((lx * i32(glyph_size)) / cs);
  let gy = u32((ly * i32(glyph_size)) / cs);
  let row = glyphs[base + best * stride + 1u + gy];
  let on = ((row >> gx) & 1u) == 1u;

  let index = select(paper, ink, on);

  // Alpha is carried through untouched, per pixel rather than per cell. It is
  // never composited onto white anywhere in the stack (F-IN-03).
  let alpha = textureLoad(src, coord, 0).a;
  textureStore(dst, coord, vec4<f32>(palette.entries[index].linear.rgb, alpha));
  textureStore(dst_index, coord, vec4<u32>(index, 0u, 0u, 0u));
}
