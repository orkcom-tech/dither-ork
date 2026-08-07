// Per-node opacity and blend — F-ST-03.
//
// Not an effect, which is why the file name is prefixed: no registry
// descriptor, no `?raw` import from an effect module, no entry in the
// catalogue. It is one program owned by the GPU layer
// (`web/src/gpu/composite.ts`) and run after any node whose composite is not
// the identity.
//
// What it composites is a node's output against **that node's own input**. A
// stack node is a filter, not a layer, so 50% of a blur is half-blurred — not
// blurred over whatever happened to precede it in the panel.
//
// --- LINEAR LIGHT --------------------------------------------------------
//
// Both operands arrive linear-light `rgba16float` and every formula below is
// evaluated there, because the whole pipeline is (docs/ARCHITECTURE.md,
// "Colour"). That is a deliberate choice and it is visible in the result.
//
// `multiply`, `screen`, `difference`, `exclusion`, `darken`, `lighten`, `add`
// and `subtract` are light being multiplied, added or compared, and linear
// light is where that arithmetic is correct.
//
// `overlay`, `hard-light` and `soft-light` are **pivoted at 0.5**, and 0.5 is
// the middle of the code range rather than the middle of perceived brightness.
// Perceptual mid-grey is about 0.216 in linear light, so the pivot sits higher
// up the tone scale than it does in a gamma-space compositor: more of the frame
// lands on the multiply side and these three come out darker, with their
// contrast hinge on a brighter tone. Correcting it would mean encoding to sRGB,
// pivoting there and decoding back — a gamma-space island inside a linear
// pipeline, per node. Not taken.
//
// Values are NOT clipped to [0, 1]; `rgba16float` carries more and several
// effects produce more. `subtract` floors at zero because negative light has no
// meaning downstream.
//
// The arithmetic is transcribed from `web/src/graph/blend.ts`, which is the
// definition both execution kinds share. `blend.test.ts` checks this file
// declares an ordinal for every mode and that the numbers agree; the formulas
// themselves must be diffed by eye, so keep the two in the same order.

struct Params {
  width    : u32,
  height   : u32,
  mode     : u32,
  opacity  : f32,
};

// Ordinals, in the order of BLEND_MODES in `web/src/graph/blend.ts`.
// APPEND-ONLY: a mode inserted in the middle renumbers every saved document
// that names one of the modes after it.
const BLEND_NORMAL     : u32 = 0u;
const BLEND_MULTIPLY   : u32 = 1u;
const BLEND_SCREEN     : u32 = 2u;
const BLEND_OVERLAY    : u32 = 3u;
const BLEND_HARD_LIGHT : u32 = 4u;
const BLEND_SOFT_LIGHT : u32 = 5u;
const BLEND_DARKEN     : u32 = 6u;
const BLEND_LIGHTEN    : u32 = 7u;
const BLEND_DIFFERENCE : u32 = 8u;
const BLEND_EXCLUSION  : u32 = 9u;
const BLEND_ADD        : u32 = 10u;
const BLEND_SUBTRACT   : u32 = 11u;

// Binding numbers follow `web/src/shaders/CONVENTIONS.md` where the roles
// exist there: 0 is the colour input, 1 the colour output, 5 the uniforms. The
// second colour input has no conventional role — no effect pass has two — so it
// takes 6, the first effect-specific slot.
@group(0) @binding(0) var base_tex : texture_2d<f32>;
@group(0) @binding(1) var dst      : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;
@group(0) @binding(6) var top_tex  : texture_2d<f32>;

// --- shared: soft light (keep identical with graph/blend.ts) --------------
//
// The W3C compositing definition, which is also Photoshop's. The piecewise
// `d(base)` term is what keeps the function continuous at the pivot; the
// "raise base to a power of top" shortcut is not, and its discontinuity shows
// as a band across a gradient.
fn soft_light(base : f32, top : f32) -> f32 {
  if (top <= 0.5) {
    return base - (1.0 - 2.0 * top) * base * (1.0 - base);
  }
  var d : f32;
  if (base <= 0.25) {
    d = ((16.0 * base - 12.0) * base + 4.0) * base;
  } else {
    d = sqrt(max(0.0, base));
  }
  return base + (2.0 * top - 1.0) * (d - base);
}
// --- end shared -----------------------------------------------------------

fn blend_channel(mode : u32, base : f32, top : f32) -> f32 {
  switch (mode) {
    case 0u: { return top; }
    case 1u: { return base * top; }
    case 2u: { return base + top - base * top; }
    case 3u: {
      // The pivot is on the base, which is the whole difference between
      // overlay and hard-light: the same function with the operands swapped.
      if (base <= 0.5) {
        return 2.0 * base * top;
      }
      return 1.0 - 2.0 * (1.0 - base) * (1.0 - top);
    }
    case 4u: {
      if (top <= 0.5) {
        return 2.0 * base * top;
      }
      return 1.0 - 2.0 * (1.0 - base) * (1.0 - top);
    }
    case 5u: { return soft_light(base, top); }
    case 6u: { return min(base, top); }
    case 7u: { return max(base, top); }
    case 8u: { return abs(base - top); }
    case 9u: { return base + top - 2.0 * base * top; }
    case 10u: { return base + top; }
    // WGSL requires a default arm. Written as the last real case rather than as
    // a catch-all: the packer only ever sends an ordinal from BLEND_MODES, so
    // no other value can arrive, and a neutral default would be a fallback
    // branch for a condition that cannot occur.
    default: { return max(0.0, base - top); }
  }
}

@compute @workgroup_size(8, 8, 1)
fn composite(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let at = vec2<i32>(i32(gid.x), i32(gid.y));

  let base = textureLoad(base_tex, at, 0);
  let top = textureLoad(top_tex, at, 0);

  let blended = vec3<f32>(
    blend_channel(params.mode, base.r, top.r),
    blend_channel(params.mode, base.g, top.g),
    blend_channel(params.mode, base.b, top.b),
  );

  // Opacity is applied after the blend, as a lerp back towards the base. That
  // order is what makes opacity 0 the identity for every mode.
  let rgb = base.rgb + (blended - base.rgb) * params.opacity;

  // Alpha is unassociated throughout the pipeline (F-IN-03) and is interpolated
  // by opacity alone rather than blended: multiplying an alpha channel would
  // silently erode coverage every time a node's opacity left 100%.
  let a = base.a + (top.a - base.a) * params.opacity;

  textureStore(dst, at, vec4<f32>(rgb, a));
}
