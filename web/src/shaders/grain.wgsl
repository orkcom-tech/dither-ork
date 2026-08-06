// F-SP-16 — Film grain.
//
// Seeded value noise at a controllable scale, added with an amplitude that
// follows the tone the way silver-halide grain does.
//
// ## Determinism
//
// The noise is a hash of the lattice coordinate and the `seed` parameter and of
// nothing else. There is no clock, no frame counter and no `normalized-time`
// anywhere in this file, so the same seed produces the same grain on every
// render, in every worker and in every export. F-AN-05 requires that; the loop
// seam test enforces it.
//
// ## Why the grain is added in the sRGB encoding
//
// The buffer is linear light and almost nothing in this pipeline leaves it. This
// does, for one paragraph, and the reason is physical rather than cosmetic.
//
// Film grain is a fluctuation in the number of developed silver grains, which
// shows up as a fluctuation in *density* — and density is log transmittance. A
// perturbation that is constant in density is therefore multiplicative in
// transmittance, not additive, and the constant-amplitude noise that reproduces
// it has to be added in a roughly logarithmic encoding. Adding a constant
// amplitude to linear radiance instead gives grain that is invisible in the
// highlights and catastrophic in the shadows, and makes `intensity` mean a
// different thing at every brightness. The sRGB transfer is a close, cheap,
// already-present stand-in for that log encoding, so the noise is added there.
//
// This is the same class of argument invert.wgsl makes for taking its complement
// in sRGB, and it is written out for the same reason: a shader that leaves
// linear light has to say why.
//
// Only the bottom is clamped, by `srgb_to_linear`'s own `max`. The top is left
// alone so that a highlight an upstream node pushed above display white survives
// this node instead of being crushed to 1.0 by a grain pass.
//
// ## Why the amplitude follows the midtones
//
// Grain in a print is strongest in the midtones and falls away at both ends:
// there are few developed grains in a clear highlight and the shadow is opaque
// enough to hide the ones it has. `4L(1-L)` is that curve, normalised to 1 at
// mid-grey, and `tonalResponse` mixes between it and a flat field so the
// physical behaviour is the default rather than the only option.
//
// ## Why value noise and not one hash per pixel
//
// A per-pixel hash is white noise, and white noise has no size — `size` would
// have nothing to control. Interpolating between hashed lattice points spaced
// `size` pixels apart gives blobs of that size with no visible grid, because the
// Hermite weights make the field C1 across every lattice line.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// Independent noise fields drawn from one seed. Odd 32-bit constants with
// well-mixed bits: the domain is XORed into the third hash input, so two fields
// that share a lattice coordinate still diverge in the first round.
const DOMAIN_LUMA : u32 = 0x9e3779b9u;
const DOMAIN_R    : u32 = 0x85ebca6bu;
const DOMAIN_G    : u32 = 0xc2b2ae35u;
const DOMAIN_B    : u32 = 0x27d4eb2fu;

// `size` divides the sampling coordinate. The registry's legal range starts at
// 1, so this clamp only catches a malformed document — but a zero here paints
// the whole frame NaN, and NaN in a linear-light buffer survives every node
// after it.
const MIN_SIZE : f32 = 0.0009765625;

// Offsets must match GRAIN_UNIFORMS in web/src/effects/grain.effect.ts. The pad
// member makes the 32-byte size visible here rather than leaving it to WGSL's
// round-up rule.
struct Params {
  width          : u32,   //  0
  height         : u32,   //  4
  seed           : u32,   //  8
  size           : f32,   // 12
  intensity      : f32,   // 16
  tonal_response : f32,   // 20
  monochrome     : u32,   // 24
  pad0           : u32,   // 28
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

// --- shared: seeded hashing (keep identical across shaders) ---------------
//
// PCG-RXS-M-XS, 32-bit state and 32-bit output. WGSL has no 64-bit integers, so
// this is not the PCG32 in core/crates/dither-core/src/rng.rs and does not
// produce its sequence; it is the same family, and it is integers-only for the
// same reason — no float rounding, nothing a driver may contract differently,
// so one device's output is reproducible on the next.

fn pcg_hash(v : u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

// Nested rather than a weighted sum of the three inputs: a linear combination
// lets a change in one coordinate cancel a change in another, and the visible
// symptom of that is a diagonal seam through the noise field.
fn hash3(a : u32, b : u32, c : u32) -> u32 {
  return pcg_hash(pcg_hash(pcg_hash(a) ^ b) ^ c);
}

// [0, 1). The top 24 bits scaled by 2^-24 — the same construction as
// Pcg32::next_f32 in the core, where both the numerator and the scale are
// exactly representable in f32, so the product is exact and can never round up
// to 1.0.
fn random_unit(h : u32) -> f32 {
  return f32(h >> 8u) * (1.0 / 16777216.0);
}

// --- end shared -----------------------------------------------------------

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
// --- shared: Rec.709 luminance on linear light (keep identical) ----------

fn luminance(c : vec3<f32>) -> f32 {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

// --- end shared ---------------------------------------------------------

fn lattice(cell : vec2<u32>, domain : u32) -> f32 {
  return random_unit(hash3(cell.x, cell.y, params.seed ^ domain));
}

// Value noise in [0, 1). `p` is already divided by the grain size, so one unit
// of `p` is one grain.
fn value_noise(p : vec2<f32>, domain : u32) -> f32 {
  let base = floor(p);
  let f = p - base;
  // Hermite weights. Linear weights would leave a first-derivative
  // discontinuity along every lattice line, and on a flat field that reads as
  // a faint grid rather than as grain.
  let w = f * f * (vec2<f32>(3.0) - 2.0 * f);

  // `p` is non-negative — it comes from a pixel coordinate divided by a positive
  // size — so `base` is non-negative and the conversion is exact.
  let c = vec2<u32>(u32(base.x), u32(base.y));
  let n00 = lattice(c,                        domain);
  let n10 = lattice(c + vec2<u32>(1u, 0u),    domain);
  let n01 = lattice(c + vec2<u32>(0u, 1u),    domain);
  let n11 = lattice(c + vec2<u32>(1u, 1u),    domain);

  return mix(mix(n00, n10, w.x), mix(n01, n11, w.x), w.y);
}

// Symmetric about zero, so grain neither lifts nor lowers the mean of the frame.
fn signed_noise(p : vec2<f32>, domain : u32) -> f32 {
  return value_noise(p, domain) * 2.0 - 1.0;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);

  let p = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5) / max(params.size, MIN_SIZE);

  var noise : vec3<f32>;
  if (params.monochrome != 0u) {
    // One field for all three channels: the fluctuation is in how much light got
    // through, not in its colour. This is the digital-grain look and the one
    // that survives a small palette, because it moves a pixel along the tone
    // axis rather than off it.
    noise = vec3<f32>(signed_noise(p, DOMAIN_LUMA));
  } else {
    // Three independent fields. Colour film has three dye layers with their own
    // grain, so the fluctuation really is chromatic — at the cost of pushing
    // pixels sideways in colour, which a palette match then has to resolve.
    noise = vec3<f32>(
      signed_noise(p, DOMAIN_R),
      signed_noise(p, DOMAIN_G),
      signed_noise(p, DOMAIN_B),
    );
  }

  // Tone measured as the display-encoded luminance, because "midtone" is a
  // statement about what the eye sees and the encoding is where that lives.
  let tone = clamp(linear_to_srgb(vec3<f32>(luminance(texel.rgb))).r, 0.0, 1.0);
  let midtone = 4.0 * tone * (1.0 - tone);
  let response = mix(1.0, midtone, params.tonal_response);

  let encoded = linear_to_srgb(texel.rgb);
  let grained = encoded + noise * (params.intensity * response);

  // `srgb_to_linear` clamps the bottom at zero. Nothing clamps the top: a
  // highlight an upstream node pushed past display white belongs to that node,
  // not to this one.
  //
  // Alpha is carried through untouched (F-IN-03).
  textureStore(dst, coord, vec4<f32>(srgb_to_linear(grained), texel.a));
}
