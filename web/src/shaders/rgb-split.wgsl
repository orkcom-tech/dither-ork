// F-GL-04 — RGB split.
//
// Three independent translations, one per colour channel. Pointwise: each
// invocation decides where its own three channels came from and reads them.
//
// Offsets are **fractions of the image**, not pixels. Preview and export are
// the same graph at two resolutions (docs/ARCHITECTURE.md, "Render graph"), so
// a pixel-valued translation would export a different picture than the one on
// screen. A fractional offset is almost never a whole texel, which is why the
// fetch below interpolates.
//
// Interpolation is four `textureLoad`s and a `mix`, not a sampler. The
// convention is that colour is read at integer coordinates
// (web/src/shaders/CONVENTIONS.md) — that rules out handing the coordinate to
// hardware filtering, not the arithmetic. Doing it here also means the edge
// rule is the one the node declares rather than whatever address mode a sampler
// happened to be created with, and the working surface is linear light, which
// is the only space in which averaging two colours is physically meaningful.
//
// Alpha is taken from the pixel's own texel and never interpolated. The
// geometry does not move — only the chroma separates — and interpolating
// unassociated alpha across an edge mixes colours that were never composited.

const EDGE_CLAMP  : u32 = 0u;
const EDGE_WRAP   : u32 = 1u;
const EDGE_MIRROR : u32 = 2u;

// Offsets must match RGB_SPLIT_UNIFORMS in
// web/src/effects/rgb-split.effect.ts. Twelve 4-byte scalars: nothing needs
// padding in front of it, and `pad0` makes the 48-byte size visible here rather
// than leaving it to WGSL's round-up rule.
struct Params {
  width   : u32,   //  0
  height  : u32,   //  4
  seed    : u32,   //  8
  edge    : u32,   // 12
  red_x   : f32,   // 16
  red_y   : f32,   // 20
  green_x : f32,   // 24
  green_y : f32,   // 28
  blue_x  : f32,   // 32
  blue_y  : f32,   // 36
  jitter  : f32,   // 40
  pad0    : f32,   // 44
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

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
  // index backwards past the start of the line.
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

// --- shared: bilinear fetch (keep identical across shaders) --------------
//
// `p` is in texel-centre coordinates: pixel (x, y) has its centre at
// (x + 0.5, y + 0.5). At an exact centre the weights are 0 and 1 and this
// returns that texel unchanged, so an offset of zero is bit-identical to a
// plain load.

fn fetch_rgb(p : vec2<f32>, mode : u32) -> vec3<f32> {
  let w = i32(params.width);
  let h = i32(params.height);

  let q = p - vec2<f32>(0.5, 0.5);
  let base = floor(q);
  let f = q - base;

  let x0 = i32(base.x);
  let y0 = i32(base.y);
  let xa = resolve_coord(x0, w, mode);
  let xb = resolve_coord(x0 + 1, w, mode);
  let ya = resolve_coord(y0, h, mode);
  let yb = resolve_coord(y0 + 1, h, mode);

  let c00 = textureLoad(src, vec2<i32>(xa, ya), 0).rgb;
  let c10 = textureLoad(src, vec2<i32>(xb, ya), 0).rgb;
  let c01 = textureLoad(src, vec2<i32>(xa, yb), 0).rgb;
  let c11 = textureLoad(src, vec2<i32>(xb, yb), 0).rgb;

  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}

// --- end shared ----------------------------------------------------------

// One salt per channel so the three wobbles are independent rather than three
// copies of the same line of noise.
const SALT_RED   : u32 = 0x9e3779b9u;
const SALT_GREEN : u32 = 0x85ebca6bu;
const SALT_BLUE  : u32 = 0xc2b2ae35u;

// The seed's only job. `jitter` at 0 leaves the split exactly as the six
// offsets describe it and the seed does nothing, which is the honest default;
// above 0 each scanline gets its own extra horizontal displacement per channel,
// which is the tape-head wobble the effect is usually reaching for.
//
// Horizontal only: a vertical wobble moves a line onto its neighbour and reads
// as noise rather than as a mistracked channel.
fn channel_shift(offset : vec2<f32>, salt : u32, row : u32) -> vec2<f32> {
  let wobble = (hash01(params.seed ^ salt, row) * 2.0 - 1.0) * params.jitter;
  return vec2<f32>(
    (offset.x + wobble) * f32(params.width),
    offset.y * f32(params.height),
  );
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let centre = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);

  // Subtracting the shift is what makes a positive offset move the channel in
  // the positive direction: this pixel reads from where that channel was.
  let red = fetch_rgb(
    centre - channel_shift(vec2<f32>(params.red_x, params.red_y), SALT_RED, gid.y),
    params.edge,
  ).r;
  let green = fetch_rgb(
    centre - channel_shift(vec2<f32>(params.green_x, params.green_y), SALT_GREEN, gid.y),
    params.edge,
  ).g;
  let blue = fetch_rgb(
    centre - channel_shift(vec2<f32>(params.blue_x, params.blue_y), SALT_BLUE, gid.y),
    params.edge,
  ).b;

  // Alpha from this pixel's own texel: the shape does not move, the colour
  // does. Nothing is composited onto white anywhere in the stack (F-IN-03).
  let alpha = textureLoad(src, coord, 0).a;

  textureStore(dst, coord, vec4<f32>(red, green, blue, alpha));
}
