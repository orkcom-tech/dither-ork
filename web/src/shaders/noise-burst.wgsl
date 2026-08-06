// F-GL-17 — Noise burst.
//
// The frame is tiled into cells `cell_size * aspect` wide and `cell_size` tall.
// Each cell draws one number from a hash of its own grid coordinate and the
// seed; if that number falls under `density` the cell bursts and every pixel in
// it is replaced — by `intensity` of the way — with seeded noise. Cells that do
// not burst pass through untouched.
//
// Cell selection and pixel noise are drawn from the same seed through different
// domain constants, so raising the density does not also reshuffle the noise
// inside the cells that were already bursting. Two independent axes out of one
// control, which is what makes the seed slider behave like a seed slider.
//
// **The noise is uniform in the ENCODED domain, not in linear light.** What
// this effect imitates is corrupt sample values, and samples are stored
// gamma-encoded; drawing uniformly in linear light instead would put nearly
// every draw in the top two stops and the burst would read as a white block
// rather than as noise. So the draw is made in [0, 1) and pushed through the
// sRGB transfer function before it joins the buffer, which keeps the one rule
// the pipeline has — everything in the buffer is linear light — while producing
// the distribution the effect is named after.
//
// No time source anywhere: every random value is a pure function of the pixel
// (or cell) coordinate and the seed parameter, so the same document renders the
// same corruption on every machine and in every worker (F-AN-05).
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// Ordinals of the `mode` enum in noise-burst.effect.ts.
const MODE_RGB  : u32 = 0u;
const MODE_MONO : u32 = 1u;

// Domain separators. Arbitrary odd constants, fixed forever: changing one
// changes every frame this effect has ever produced.
const DOMAIN_CELL  : u32 = 0x632be59bu;
const DOMAIN_PIXEL : u32 = 0x9e3779b9u;
const DOMAIN_RED   : u32 = 0x85ebca6bu;
const DOMAIN_GREEN : u32 = 0xc2b2ae35u;
const DOMAIN_BLUE  : u32 = 0x27d4eb2fu;

// Cell extents divide a coordinate. The registry's legal ranges keep both
// factors above zero, so this floor only catches a malformed document — but a
// zero here paints the frame NaN, and NaN in a linear-light buffer survives
// every node after it.
const MIN_CELL_EXTENT : f32 = 0.0009765625;

// Offsets must match NOISE_BURST_UNIFORMS in noise-burst.effect.ts.
struct Params {
  width     : u32,   //  0
  height    : u32,   //  4
  seed      : u32,   //  8
  mode      : u32,   // 12
  cell_size : f32,   // 16
  aspect    : f32,   // 20
  density   : f32,   // 24
  intensity : f32,   // 28
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

// Matches srgbToLinear in web/src/gpu/resources.ts, including the crossover
// point. The draws feeding it are in [0, 1), so the negative half of the
// transfer function cannot be reached.
fn srgb_to_linear(c : vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92;
  let hi = pow((c + 0.055) / 1.055, vec3<f32>(2.4));
  return select(hi, lo, c <= vec3<f32>(0.040448237));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);

  let cell_w = max(params.cell_size * params.aspect, MIN_CELL_EXTENT);
  let cell_h = max(params.cell_size, MIN_CELL_EXTENT);
  let cell_x = u32(floor(f32(gid.x) / cell_w));
  let cell_y = u32(floor(f32(gid.y) / cell_h));

  let cell_draw = random_unit(hash3(cell_x, cell_y, params.seed ^ DOMAIN_CELL));
  if (cell_draw >= params.density) {
    // Not a burst cell. The image passes through; a pass that wrote nothing
    // here would leave whatever the previous node left in the target texture,
    // and the target is a recycled surface, not a copy of the input.
    textureStore(dst, coord, texel);
    return;
  }

  let n = hash3(gid.x, gid.y, params.seed ^ DOMAIN_PIXEL);
  let mono = random_unit(n);
  let encoded = select(
    vec3<f32>(
      random_unit(pcg_hash(n ^ DOMAIN_RED)),
      random_unit(pcg_hash(n ^ DOMAIN_GREEN)),
      random_unit(pcg_hash(n ^ DOMAIN_BLUE)),
    ),
    vec3<f32>(mono, mono, mono),
    params.mode == MODE_MONO,
  );

  let corrupted = srgb_to_linear(encoded);

  // Alpha is untouched. Corruption of the sample values is not corruption of
  // the coverage, and nothing in the stack composites alpha onto a background
  // (F-IN-03) — a burst that punched holes in it would be discovered on export.
  textureStore(
    dst,
    coord,
    vec4<f32>(mix(texel.rgb, corrupted, params.intensity), texel.a),
  );
}
