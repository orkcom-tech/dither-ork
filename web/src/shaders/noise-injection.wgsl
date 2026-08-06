// F-PP-06 — Noise injection.
//
// One compute pass, read-your-own-pixel. Three distributions — white, value,
// gaussian — added either as one field to all three channels or as three
// independent fields, at a controllable feature size.
//
// ## Determinism
//
// The noise is a hash of the lattice cell and the `seed` parameter and of
// nothing else. There is no clock, no frame counter and no `normalized-time`
// anywhere in this file, so the same seed produces the same field on every
// render, in every worker and in every export (F-AN-05).
//
// The hash is the five-shader `seeded hash` block copied verbatim, not a new
// one. CONVENTIONS.md records that the seeded hash is the one shared block that
// drifted into four variants and asks a new shader not to add a fifth; the
// three-input mixing this file needs is built by nesting the block's own
// `hash2` inside `hash01` rather than by editing the block.
//
// ## The relationship to film grain (F-SP-16)
//
// `grain.wgsl` is value noise too, and the overlap is deliberate rather than
// accidental. Grain is a simulation: its amplitude follows the midtones the way
// silver-halide density does, and its controls are named for what film does.
// This node is the plain tool the requirement asks for — a flat amplitude, three
// distributions, and a channel mode — and it is the one you reach for to perturb
// which side of its threshold each pixel falls on before a dither, which is what
// makes the dither render a gradient as texture instead of as a band.
//
// ## Why the noise is added in the sRGB encoding
//
// The same argument grain.wgsl makes at length, and it has to hold for both or
// the two nodes' `amount` controls would mean different things. Constant
// amplitude added to linear radiance is invisible in the highlights and
// catastrophic in the shadows, so the amplitude would mean a different thing at
// every brightness. Added in the encoding it means one thing everywhere, which
// is what makes it a control.
//
// Only the bottom is clamped, by `srgb_to_linear`'s own `max`. The top is left
// alone so a highlight an upstream node pushed above display white survives this
// node instead of being crushed to 1.0 by a noise pass.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// Ordinals, restated from NOISE_INJECTION_PARAMS in
// ../effects/noise-injection.effect.ts. Both lists are append-only: inserting a
// value in the middle renumbers every document already saved.
const KIND_WHITE    : u32 = 0u;
const KIND_VALUE    : u32 = 1u;
const KIND_GAUSSIAN : u32 = 2u;

const CHANNELS_RGB  : u32 = 0u;
const CHANNELS_LUMA : u32 = 1u;

const TAU : f32 = 6.283185307179586;

// Independent noise streams drawn from one seed. Odd 32-bit constants with
// well-mixed bits, XORed into the seed before it reaches the hash, so two fields
// that share a lattice cell diverge in the first round.
const DOMAIN_LUMA  : u32 = 0x9e3779b9u;
const DOMAIN_R     : u32 = 0x85ebca6bu;
const DOMAIN_G     : u32 = 0xc2b2ae35u;
const DOMAIN_B     : u32 = 0x27d4eb2fu;
// The second uniform Box-Muller needs. A separate stream rather than a second
// draw from the same one, because two consecutive values of a hash keyed on the
// same cell are the same value.
const DOMAIN_PHASE : u32 = 0x165667b1u;

// `scale` divides the sampling coordinate. The registry's legal range starts at
// 1, so this clamp only catches a malformed document — but a zero here paints
// the whole frame NaN, and NaN in a linear-light buffer survives every node
// after it.
const MIN_SCALE : f32 = 0.0009765625;

// A gaussian's excursions are unbounded. Clipping at three standard deviations
// — which 99.73% of draws are already inside — is what lets `amount` mean the
// same thing for all three distributions: the largest excursion it can produce.
// Without it the control would be a standard deviation for one mode and a
// half-range for the other two, and the three would not be comparable.
const SIGMA_CLIP : f32 = 3.0;

// Offsets must match NOISE_INJECTION_UNIFORMS in
// web/src/effects/noise-injection.effect.ts. The pad member makes the 32-byte
// size visible here rather than leaving it to WGSL's round-up rule.
struct Params {
  width    : u32,   //  0
  height   : u32,   //  4
  seed     : u32,   //  8
  kind     : u32,   // 12
  channels : u32,   // 16
  amount   : f32,   // 20
  scale    : f32,   // 24
  pad0     : u32,   // 28
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

// --- shared: linear -> sRGB transfer (keep identical across shaders) -----

fn linear_to_srgb(c : vec3<f32>) -> vec3<f32> {
  let clamped = max(c, vec3<f32>(0.0));
  let lo = clamped * 12.92;
  let hi = 1.055 * pow(clamped, vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(hi, lo, clamped <= vec3<f32>(0.0031308));
}

// --- end shared ---------------------------------------------------------

// --- shared: sRGB -> linear transfer (keep identical across shaders) -----
//
// The inverse of `linear_to_srgb`, with the same breakpoint as
// `srgb_to_linear` in core/crates/dither-core/src/color.rs.

fn srgb_to_linear(c : vec3<f32>) -> vec3<f32> {
  let clamped = max(c, vec3<f32>(0.0));
  let lo = clamped / 12.92;
  let hi = pow((clamped + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return select(hi, lo, clamped <= vec3<f32>(0.040448237));
}

// --- end shared ---------------------------------------------------------

// One draw in [0, 1) for a lattice cell on one stream. The cell coordinate is
// mixed first and the stream second, so the two cannot cancel.
fn unit_at(cell : vec2<u32>, domain : u32) -> f32 {
  return hash01(hash2(cell.x, cell.y), params.seed ^ domain);
}

// Value noise in [0, 1). `p` is already divided by the feature size, so one unit
// of `p` is one cell.
fn value_noise(p : vec2<f32>, domain : u32) -> f32 {
  let base = floor(p);
  let f = p - base;
  // Hermite weights. Linear weights would leave a first-derivative
  // discontinuity along every lattice line, and on a flat field that reads as a
  // faint grid rather than as noise.
  let w = f * f * (vec2<f32>(3.0) - 2.0 * f);

  // `p` is non-negative — a pixel coordinate divided by a positive scale — so
  // `base` is non-negative and the conversion is exact.
  let c = vec2<u32>(u32(base.x), u32(base.y));
  let n00 = unit_at(c,                     domain);
  let n10 = unit_at(c + vec2<u32>(1u, 0u), domain);
  let n01 = unit_at(c + vec2<u32>(0u, 1u), domain);
  let n11 = unit_at(c + vec2<u32>(1u, 1u), domain);

  return mix(mix(n00, n10, w.x), mix(n01, n11, w.x), w.y);
}

// Box-Muller. `u1` is taken as `1 - draw` so it lands in (0, 1] rather than
// [0, 1): the draw can be exactly zero and `log(0)` is negative infinity, which
// would paint the cell NaN. At `u1 = 1` the radius is zero, which is an ordinary
// sample and not a special case.
fn standard_normal(cell : vec2<u32>, domain : u32) -> f32 {
  let u1 = 1.0 - unit_at(cell, domain);
  let u2 = unit_at(cell, domain ^ DOMAIN_PHASE);
  return sqrt(-2.0 * log(u1)) * cos(TAU * u2);
}

// Symmetric about zero and bounded by [-1, 1] in every mode, so `amount` is the
// largest excursion and noise neither lifts nor lowers the mean of the frame.
fn signed_noise(p : vec2<f32>, domain : u32) -> f32 {
  if (params.kind == KIND_VALUE) {
    return value_noise(p, domain) * 2.0 - 1.0;
  }
  // White and gaussian are both one draw per cell with no interpolation: they
  // are distributions, not fields with a shape, and smoothing either of them
  // would turn it into value noise with a different histogram.
  let cell = vec2<u32>(u32(floor(p.x)), u32(floor(p.y)));
  if (params.kind == KIND_GAUSSIAN) {
    return clamp(standard_normal(cell, domain), -SIGMA_CLIP, SIGMA_CLIP) / SIGMA_CLIP;
  }
  // KIND_WHITE, written as the tail rather than as a default arm: the packer
  // refuses anything that is not a declared enum value, so no other ordinal can
  // arrive, and a catch-all would be a fallback branch for a condition that
  // cannot occur.
  return unit_at(cell, domain) * 2.0 - 1.0;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);

  let p = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5) / max(params.scale, MIN_SCALE);

  var noise : vec3<f32>;
  if (params.channels == CHANNELS_LUMA) {
    // One field added equally to all three encoded channels. That moves the
    // pixel along the tone axis rather than off it, which is what a small
    // palette can absorb — the dither downstream resolves it as pattern instead
    // of having to find a colour for a hue the picture never had.
    noise = vec3<f32>(signed_noise(p, DOMAIN_LUMA));
  } else {
    noise = vec3<f32>(
      signed_noise(p, DOMAIN_R),
      signed_noise(p, DOMAIN_G),
      signed_noise(p, DOMAIN_B),
    );
  }

  let encoded = linear_to_srgb(texel.rgb);

  // `srgb_to_linear` clamps the bottom at zero. Nothing clamps the top: a
  // highlight an upstream node pushed past display white belongs to that node,
  // not to this one.
  //
  // Alpha is carried through untouched. Noise on alpha is a compositing change
  // wearing a tone control's name (F-IN-03).
  textureStore(dst, coord, vec4<f32>(srgb_to_linear(encoded + noise * params.amount), texel.a));
}
