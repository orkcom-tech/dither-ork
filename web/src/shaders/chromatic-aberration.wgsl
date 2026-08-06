// F-GL-05 — Chromatic aberration, radial and linear.
//
// Lateral chromatic aberration: a lens focuses different wavelengths at
// different magnifications, so the red and blue records of the same scene do
// not sit on top of each other. Green is the reference channel and does not
// move — that is the optical model, and it is also what keeps the picture's
// detail sharp while the fringes appear.
//
//   radial — displacement points away from a centre and grows with distance
//            from it, which is what a real lens does. `falloff` is the exponent
//            on the normalised radius: at 1 the fringe grows linearly from the
//            centre, at 2 it stays out of the middle of the frame and gathers
//            in the corners, which is the photographic look.
//   linear — one constant displacement along `angle`, which is prism
//            separation rather than lens aberration and is the look people
//            reach for when they want the fringe even across the frame.
//
// `strength` is a fraction of the image: of the half-diagonal in radial mode
// (so it means the same thing at any aspect ratio) and of the width in linear
// mode. Preview and export are the same graph at two resolutions, so a
// pixel-valued displacement would export a different picture.
//
// Interpolation is four `textureLoad`s and a `mix`, not a sampler. The
// convention is that colour is read at integer coordinates
// (web/src/shaders/CONVENTIONS.md) — that rules out hardware filtering, not the
// arithmetic. Doing it here also means the edge rule is the node's own, and the
// working surface is linear light, which is the only space in which averaging
// two colours is physically meaningful.

const EDGE_CLAMP  : u32 = 0u;
const EDGE_WRAP   : u32 = 1u;
const EDGE_MIRROR : u32 = 2u;

// Mode ordinals: the order of `values` in the registry descriptor, which is
// what the uniform packer turns the document's string into.
const MODE_RADIAL : u32 = 0u;
const MODE_LINEAR : u32 = 1u;

const TAU : f32 = 6.283185307179586;

// Offsets must match CHROMATIC_ABERRATION_UNIFORMS in
// web/src/effects/chromatic-aberration.effect.ts. Twelve 4-byte scalars:
// nothing needs padding in front of it, and `pad0` makes the 48-byte size
// visible here rather than leaving it to WGSL's round-up rule.
struct Params {
  width    : u32,   //  0
  height   : u32,   //  4
  seed     : u32,   //  8
  mode     : u32,   // 12
  edge     : u32,   // 16
  strength : f32,   // 20
  angle    : f32,   // 24
  center_x : f32,   // 28
  center_y : f32,   // 32
  falloff  : f32,   // 36
  jitter   : f32,   // 40
  pad0     : f32,   // 44
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
// returns that texel unchanged, so a displacement of zero is bit-identical to a
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

// Displacement for one channel at one pixel.
//
// `polarity` is +1 for red and -1 for blue: the two channels separate in
// opposite directions about green, which is what makes the fringe a fringe
// rather than a shifted image.
fn aberration(centre : vec2<f32>, polarity : f32, row : u32) -> vec2<f32> {
  let w = f32(params.width);
  let h = f32(params.height);

  var displacement = vec2<f32>(0.0, 0.0);

  if (params.mode == MODE_LINEAR) {
    // Turns, not degrees, so a modulator ramping 0 -> 1 lands back where it
    // started and an animated angle closes the loop exactly.
    let theta = params.angle * TAU;
    displacement = vec2<f32>(cos(theta), sin(theta)) * (params.strength * w);
  } else {
    let focus = vec2<f32>(params.center_x * w, params.center_y * h);
    // Half the diagonal, so `strength` means the same fraction of the frame at
    // any aspect ratio and the corners reach exactly 1 on the radius.
    let half_diagonal = 0.5 * sqrt(w * w + h * h);
    let delta = centre - focus;
    // Not named `distance`: that is a predeclared WGSL function, and shadowing
    // one reads as a typo for the rest of the file.
    let radius_px = length(delta);
    // At the exact centre the direction is undefined and the displacement is
    // zero, which is the value the limit takes rather than a special case: a
    // radial aberration has no fringe on its own axis.
    if (radius_px > 1e-5) {
      let radius = clamp(radius_px / half_diagonal, 0.0, 1.0);
      let magnitude = params.strength * half_diagonal * pow(radius, params.falloff);
      displacement = (delta / radius_px) * magnitude;
    }
  }

  // The seed's only job. At 0 the aberration is exactly what the mode
  // describes and the seed does nothing; above 0 each scanline gets its own
  // extra separation, which is the electrical fault rather than the optical
  // one. Horizontal only — a vertical wobble moves a line onto its neighbour
  // and reads as noise rather than as a mistracked channel.
  let wobble = (hash01(params.seed, row) * 2.0 - 1.0) * params.jitter * w;

  return (displacement + vec2<f32>(wobble, 0.0)) * polarity;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let centre = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);
  let own = textureLoad(src, coord, 0);

  // Subtracting the displacement is what makes the channel appear to move
  // along it: this pixel reads from where that channel was.
  let red = fetch_rgb(centre - aberration(centre, 1.0, gid.y), params.edge).r;
  let blue = fetch_rgb(centre - aberration(centre, -1.0, gid.y), params.edge).b;

  // Green is the reference channel — it is not displaced, so it is read
  // straight from this texel rather than through the interpolator, which would
  // be four loads to arrive back at the same number. Alpha comes with it: the
  // shape does not move, the colour does (F-IN-03).
  textureStore(dst, coord, vec4<f32>(red, own.g, blue, own.a));
}
