// F-GN-01 — Noise source.
//
// A generator: it binds no `input-color` and produces its picture from its
// parameters alone. See `web/src/types/document.ts` on the `source` slot.
//
// Five fields — value, gradient (Perlin), simplex, Worley and Worley edges —
// summed over octaves as fractional Brownian motion. They are one effect rather
// than five because everything around the field is identical: the same domain,
// the same octave sum, the same ridge fold, the same encoding. What differs is
// one function call.
//
// ## Why the fields are three-dimensional when the picture is flat
//
// The third coordinate is `evolve`, and it is the whole animation story. A
// two-dimensional field can only be *panned*: bind a modulator to the offset
// and the texture slides, which reads as a moving photograph of noise. Binding
// a modulator to a third coordinate instead makes the field *boil* — every
// feature grows, shifts and dissolves in place — and that is what a noise
// source is animated for. It costs 8 lattice corners instead of 4, and 27
// Worley cells instead of 9, which is the honest price and is stated on the
// parameter.
//
// It also closes the loop for free. `cyclesPerLoop` is an integer (F-AN-03), so
// a sine bound to `evolve` returns to its own starting value at frame N and the
// field is bit-identical to frame 0. A generator has no reason to be the thing
// that breaks loop closure, unlike feedback, and this one is not.
//
// ## Why every kind is normalised to [0, 1] before the octave sum
//
// The five fields have genuinely different natural ranges — value noise is
// already [0, 1], Perlin and simplex are signed and roughly [-1, 1], Worley's
// F1 is an unbounded distance. Folding each one to [0, 1] at the point it is
// produced means the octave sum, the ridge fold and the gain all mean the same
// thing whichever kind is selected, so switching the kind changes the texture
// and not the exposure. The alternative — a per-kind correction after the sum —
// is five constants that drift the moment anyone touches the octave weights.
//
// ## Determinism
//
// Every value here is a hash of an integer lattice coordinate and the `seed`
// parameter. There is no clock, no frame counter and no `normalized-time` in
// this file (F-AN-05); `evolve` is a document parameter like any other, which
// is exactly why it may be animated. The same seed gives the same field in
// every worker and every export.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// Ordinals restate the `kind` enum's `values` list in
// web/src/effects/gen-noise.effect.ts. Append-only: inserting one in the middle
// renumbers every saved document naming a later value.
const KIND_VALUE        : u32 = 0u;
const KIND_PERLIN       : u32 = 1u;
const KIND_SIMPLEX      : u32 = 2u;
const KIND_WORLEY       : u32 = 3u;
const KIND_WORLEY_EDGES : u32 = 4u;

// `scale` divides the sampling coordinate. The legal range starts at 1, so this
// only catches a malformed document — but a zero here paints the whole frame
// NaN, and NaN in a linear-light buffer survives every node after it.
const MIN_SCALE : f32 = 0.0009765625;

// Decorrelates the octaves. Without a per-octave shift every octave samples the
// *same* lattice at a different frequency, and the sum shows a visible cross
// where the lattice lines of every octave coincide at the origin.
const OCTAVE_SALT : u32 = 0x6a09e667u;

// Perlin's 3D output with the 12-gradient set reaches about ±1.0 at its
// extremes but is concentrated well inside that; 0.5 is the scale the reference
// implementation uses to land the bulk of the distribution in [-1, 1], and the
// clamp below catches the tail rather than letting one lattice cell blow out.
const PERLIN_SCALE : f32 = 0.9;

// The standard normalisation for this simplex formulation: the four corner
// contributions with the 0.6 support radius and the r^4 falloff sum to about
// 1/32 of the intended [-1, 1].
const SIMPLEX_SCALE : f32 = 32.0;

// Worley F1 is a distance to the nearest of one feature point per unit cell, so
// its practical maximum is a little over half the cell diagonal. Dividing by
// this lands the bulk of the distribution in [0, 1]; the clamp catches the rest.
const WORLEY_SCALE : f32 = 1.1;

// Offsets must match GEN_NOISE_UNIFORMS in
// web/src/effects/gen-noise.effect.ts. Twelve 4-byte scalars in one run, so
// nothing needs padding: 48 bytes exactly.
struct Params {
  width      : u32,   //  0
  height     : u32,   //  4
  kind       : u32,   //  8
  octaves    : u32,   // 12
  seed       : u32,   // 16
  ridged     : u32,   // 20
  scale      : f32,   // 24
  lacunarity : f32,   // 28
  gain       : f32,   // 32
  offset_x   : f32,   // 36
  offset_y   : f32,   // 40
  evolve     : f32,   // 44
};

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

// One more round on the same construction, for the third lattice axis. Outside
// the fence because it is not part of the shared block; nesting it the same way
// keeps the mixing property the comment above depends on.
fn hash4(a : u32, b : u32, c : u32, d : u32) -> u32 {
  return pcg_hash(hash3(a, b, c) ^ d);
}

// The lattice is signed and the hash takes u32.
//
// **Through i32 and a bitcast, never by biasing in f32.** The obvious version of
// this function adds 2^31 before converting, so that negative coordinates land
// on their own hash inputs instead of wrapping onto the positive ones — and it
// is silently, totally wrong: f32 carries 24 bits of mantissa, so 2^31 + 8 and
// 2^31 + 9 are the *same float*. Every lattice point in the frame collapses onto
// one key, every hash returns one number, and the whole field comes out a flat
// mid-grey. It does not error and it does not look like a hash bug; it looks
// like the noise is switched off.
//
// The bitcast has none of that. `v` is already `floor`ed, so it is an exact
// integer and `i32()` truncates nothing, and the two's-complement reading of a
// signed integer is a bijection onto u32 — which is all a hash input has to be.
fn lattice_key(v : vec3<f32>) -> vec3<u32> {
  return bitcast<vec3<u32>>(vec3<i32>(i32(v.x), i32(v.y), i32(v.z)));
}

// --- value noise ---------------------------------------------------------
//
// A hash per lattice point, interpolated. Hermite weights rather than linear:
// linear weights leave a first-derivative discontinuity along every lattice
// plane, and on a flat field that reads as a faint grid rather than as noise.
// The same argument grain.wgsl makes for the 2D case.

fn value_at(cell : vec3<f32>, seed : u32) -> f32 {
  let k = lattice_key(cell);
  return random_unit(hash4(k.x, k.y, k.z, seed));
}

/** [0, 1]. */
fn value_noise(p : vec3<f32>, seed : u32) -> f32 {
  let base = floor(p);
  let f = p - base;
  let w = f * f * (vec3<f32>(3.0) - 2.0 * f);

  let n000 = value_at(base + vec3<f32>(0.0, 0.0, 0.0), seed);
  let n100 = value_at(base + vec3<f32>(1.0, 0.0, 0.0), seed);
  let n010 = value_at(base + vec3<f32>(0.0, 1.0, 0.0), seed);
  let n110 = value_at(base + vec3<f32>(1.0, 1.0, 0.0), seed);
  let n001 = value_at(base + vec3<f32>(0.0, 0.0, 1.0), seed);
  let n101 = value_at(base + vec3<f32>(1.0, 0.0, 1.0), seed);
  let n011 = value_at(base + vec3<f32>(0.0, 1.0, 1.0), seed);
  let n111 = value_at(base + vec3<f32>(1.0, 1.0, 1.0), seed);

  let x00 = mix(n000, n100, w.x);
  let x10 = mix(n010, n110, w.x);
  let x01 = mix(n001, n101, w.x);
  let x11 = mix(n011, n111, w.x);
  return mix(mix(x00, x10, w.y), mix(x01, x11, w.y), w.z);
}

// --- gradient (Perlin) noise ---------------------------------------------
//
// A pseudo-random *direction* per lattice point, dotted with the offset to the
// sample. The value is therefore zero at every lattice point, which is what
// makes Perlin read as smooth billows where value noise reads as blobs.

// Perlin's improved-noise gradient set: the twelve midpoints of a cube's edges,
// selected by four bits, written as the reference implementation's branch-free
// form rather than as a table lookup — a `switch` over twelve cases in an inner
// loop that already runs eight times per octave is a lot of divergence for the
// same twelve vectors.
fn perlin_grad(h : u32, d : vec3<f32>) -> f32 {
  let bits = h & 15u;
  let u = select(d.y, d.x, bits < 8u);
  let v = select(select(d.x, d.z, bits == 12u || bits == 14u), d.y, bits < 4u);
  let su = select(-u, u, (bits & 1u) == 0u);
  let sv = select(-v, v, (bits & 2u) == 0u);
  return su + sv;
}

fn perlin_at(cell : vec3<f32>, d : vec3<f32>, seed : u32) -> f32 {
  let k = lattice_key(cell);
  return perlin_grad(hash4(k.x, k.y, k.z, seed), d);
}

/** [0, 1] after the fold at the end. */
fn perlin_noise(p : vec3<f32>, seed : u32) -> f32 {
  let base = floor(p);
  let f = p - base;
  // The quintic fade, which is Perlin's own correction: the Hermite weights
  // used by value noise have a non-zero second derivative at the lattice
  // planes, and on a *gradient* field that shows as visible creases.
  let w = f * f * f * (f * (f * 6.0 - vec3<f32>(15.0)) + vec3<f32>(10.0));

  let n000 = perlin_at(base + vec3<f32>(0.0, 0.0, 0.0), f - vec3<f32>(0.0, 0.0, 0.0), seed);
  let n100 = perlin_at(base + vec3<f32>(1.0, 0.0, 0.0), f - vec3<f32>(1.0, 0.0, 0.0), seed);
  let n010 = perlin_at(base + vec3<f32>(0.0, 1.0, 0.0), f - vec3<f32>(0.0, 1.0, 0.0), seed);
  let n110 = perlin_at(base + vec3<f32>(1.0, 1.0, 0.0), f - vec3<f32>(1.0, 1.0, 0.0), seed);
  let n001 = perlin_at(base + vec3<f32>(0.0, 0.0, 1.0), f - vec3<f32>(0.0, 0.0, 1.0), seed);
  let n101 = perlin_at(base + vec3<f32>(1.0, 0.0, 1.0), f - vec3<f32>(1.0, 0.0, 1.0), seed);
  let n011 = perlin_at(base + vec3<f32>(0.0, 1.0, 1.0), f - vec3<f32>(0.0, 1.0, 1.0), seed);
  let n111 = perlin_at(base + vec3<f32>(1.0, 1.0, 1.0), f - vec3<f32>(1.0, 1.0, 1.0), seed);

  let x00 = mix(n000, n100, w.x);
  let x10 = mix(n010, n110, w.x);
  let x01 = mix(n001, n101, w.x);
  let x11 = mix(n011, n111, w.x);
  let signed_value = mix(mix(x00, x10, w.y), mix(x01, x11, w.y), w.z) * PERLIN_SCALE;
  return clamp(signed_value * 0.5 + 0.5, 0.0, 1.0);
}

// --- simplex noise -------------------------------------------------------
//
// The same idea as Perlin on a skewed lattice whose cells are tetrahedra, so a
// sample has four neighbours instead of eight. Cheaper per octave than Perlin
// in 3D, and — the reason it is here rather than as an optimisation — it has no
// axis-aligned lattice, so it does not carry the faint square grain that gives
// a Perlin field away when it is stretched or fed to a dither.

const SIMPLEX_F3 : f32 = 0.3333333333333333;
const SIMPLEX_G3 : f32 = 0.16666666666666666;

fn simplex_corner(cell : vec3<f32>, d : vec3<f32>, seed : u32) -> f32 {
  // The support radius. Outside it the corner contributes nothing, which is
  // what keeps the sum to four terms rather than to the whole lattice.
  let t = 0.6 - dot(d, d);
  if (t < 0.0) {
    return 0.0;
  }
  let k = lattice_key(cell);
  let t2 = t * t;
  return t2 * t2 * perlin_grad(hash4(k.x, k.y, k.z, seed), d);
}

/** [0, 1] after the fold at the end. */
fn simplex_noise(p : vec3<f32>, seed : u32) -> f32 {
  // Skew into the lattice where the simplices are regular.
  let s = (p.x + p.y + p.z) * SIMPLEX_F3;
  let cell = floor(p + vec3<f32>(s));
  let t = (cell.x + cell.y + cell.z) * SIMPLEX_G3;
  // Unskew the cell origin and take the offset to it.
  let d0 = p - (cell - vec3<f32>(t));

  // Which of the six tetrahedra in this cell the point is in, decided by the
  // ordering of the three components. Written as nested conditionals rather
  // than as a table because the six orderings are what the conditionals *are*.
  var o1 : vec3<f32>;
  var o2 : vec3<f32>;
  if (d0.x >= d0.y) {
    if (d0.y >= d0.z) {
      o1 = vec3<f32>(1.0, 0.0, 0.0);
      o2 = vec3<f32>(1.0, 1.0, 0.0);
    } else if (d0.x >= d0.z) {
      o1 = vec3<f32>(1.0, 0.0, 0.0);
      o2 = vec3<f32>(1.0, 0.0, 1.0);
    } else {
      o1 = vec3<f32>(0.0, 0.0, 1.0);
      o2 = vec3<f32>(1.0, 0.0, 1.0);
    }
  } else {
    if (d0.y < d0.z) {
      o1 = vec3<f32>(0.0, 0.0, 1.0);
      o2 = vec3<f32>(0.0, 1.0, 1.0);
    } else if (d0.x < d0.z) {
      o1 = vec3<f32>(0.0, 1.0, 0.0);
      o2 = vec3<f32>(0.0, 1.0, 1.0);
    } else {
      o1 = vec3<f32>(0.0, 1.0, 0.0);
      o2 = vec3<f32>(1.0, 1.0, 0.0);
    }
  }

  let d1 = d0 - o1 + vec3<f32>(SIMPLEX_G3);
  let d2 = d0 - o2 + vec3<f32>(2.0 * SIMPLEX_G3);
  let d3 = d0 - vec3<f32>(1.0) + vec3<f32>(3.0 * SIMPLEX_G3);

  let n = simplex_corner(cell, d0, seed)
        + simplex_corner(cell + o1, d1, seed)
        + simplex_corner(cell + o2, d2, seed)
        + simplex_corner(cell + vec3<f32>(1.0), d3, seed);

  return clamp(n * SIMPLEX_SCALE * 0.5 + 0.5, 0.0, 1.0);
}

// --- Worley (cellular) noise ---------------------------------------------
//
// One jittered feature point per unit cell; the value is the distance to the
// nearest of them. This is the field most generative work is built on, because
// its two readings are completely different pictures from the same 27 cells:
// F1 alone gives the rounded cell interiors that read as scales, cracked mud or
// crumpled foil, and F2-F1 gives the *walls* — a network of thin bright lines
// where two cells meet, which is the Voronoi look.
//
// 27 cells rather than 9 because the field is three-dimensional; that is the
// price of `evolve`, and it is why this kind is the expensive one.

struct WorleyResult {
  f1 : f32,
  f2 : f32,
};

fn worley(p : vec3<f32>, seed : u32) -> WorleyResult {
  let base = floor(p);
  let f = p - base;

  var f1 = 1e9;
  var f2 = 1e9;

  for (var dz = -1; dz <= 1; dz = dz + 1) {
    for (var dy = -1; dy <= 1; dy = dy + 1) {
      for (var dx = -1; dx <= 1; dx = dx + 1) {
        let neighbour = vec3<f32>(f32(dx), f32(dy), f32(dz));
        let k = lattice_key(base + neighbour);
        // Three independent unit values for the feature point's position
        // inside its own cell. Salted apart so the three coordinates cannot
        // move together, which would put every feature point on the cell
        // diagonal.
        let h = hash4(k.x, k.y, k.z, seed);
        let jitter = vec3<f32>(
          random_unit(pcg_hash(h)),
          random_unit(pcg_hash(h ^ 0x9e3779b9u)),
          random_unit(pcg_hash(h ^ 0x85ebca6bu)),
        );
        let diff = neighbour + jitter - f;
        let d = length(diff);
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
  }

  return WorleyResult(f1, f2);
}

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

// --- the field, and the octave sum ---------------------------------------

/** One octave of the selected kind, always in [0, 1]. */
fn field(p : vec3<f32>, seed : u32) -> f32 {
  switch (params.kind) {
    case KIND_VALUE: {
      return value_noise(p, seed);
    }
    case KIND_PERLIN: {
      return perlin_noise(p, seed);
    }
    case KIND_SIMPLEX: {
      return simplex_noise(p, seed);
    }
    case KIND_WORLEY: {
      return clamp(worley(p, seed).f1 / WORLEY_SCALE, 0.0, 1.0);
    }
    // WGSL requires a default arm. Written as the last real case rather than as
    // a catch-all: the packer refuses anything that is not a declared enum
    // value, so no other ordinal can arrive.
    default: {
      let w = worley(p, seed);
      // The gap between the nearest two feature points: zero exactly on a cell
      // wall and growing inward, so this is the walls drawn dark. Scaled by the
      // same constant as F1 so the two Worley readings have one exposure.
      return clamp((w.f2 - w.f1) / WORLEY_SCALE, 0.0, 1.0);
    }
  }
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));

  // Pixel centres, and the offset applied in pixels before the division, so
  // that `offsetX` means "move the field N pixels" at every scale rather than
  // N features.
  let pixel = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5)
            + vec2<f32>(params.offset_x, params.offset_y);
  let p0 = vec3<f32>(pixel / max(params.scale, MIN_SCALE), params.evolve);

  var sum = 0.0;
  var norm = 0.0;
  var amplitude = 1.0;
  var frequency = 1.0;

  // fBm. The loop bound is a uniform, which WGSL allows and which is what lets
  // one pipeline serve every octave count instead of one per count.
  for (var octave = 0u; octave < params.octaves; octave = octave + 1u) {
    var n = field(p0 * frequency, params.seed ^ (octave * OCTAVE_SALT));
    if (params.ridged != 0u) {
      // Fold about the middle: what was a smooth zero crossing becomes a sharp
      // crease. Applied per octave rather than to the sum, which is what makes
      // ridged multifractal look like eroded terrain rather than like a
      // solarised photograph of noise.
      n = 1.0 - abs(n * 2.0 - 1.0);
    }
    sum = sum + n * amplitude;
    norm = norm + amplitude;
    amplitude = amplitude * params.gain;
    frequency = frequency * params.lacunarity;
  }

  // Normalising by the amplitude sum rather than by a closed form keeps the
  // exposure fixed as `gain` and `octaves` move, so those two controls change
  // the texture without also changing the brightness. `norm` cannot be zero:
  // the legal octave range starts at 1 and the first amplitude is 1.
  let tone = clamp(sum / norm, 0.0, 1.0);

  // Display-referred to linear light, once, on the way out — the same argument
  // gen-shape.wgsl and gen-gradient.wgsl make. Opaque: a generator makes a
  // picture, not a matte.
  textureStore(dst, coord, vec4<f32>(srgb_to_linear(vec3<f32>(tone)), 1.0));
}
