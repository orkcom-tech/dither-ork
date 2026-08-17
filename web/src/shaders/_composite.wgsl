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

// --- MASKING (F-PP-08) ---------------------------------------------------
//
// A mask is spatially-varying opacity and nothing else, so it rides on this
// program rather than being a pass of its own: coverage multiplies `opacity`
// per pixel, and a masked node therefore costs the same one dispatch an
// ordinary composited node costs.
//
// Two entry points, not one:
//
//   composite         — no mask, or a mask read from the node's own input.
//   composite_masked  — a mask read from a second picture, bound at 7.
//
// Two rather than one-with-a-dummy-texture because WebGPU requires every
// declared binding to be provided: a single entry point would have to be handed
// *some* texture on binding 7 for the 99% of composites that have no mask
// picture, and binding the base texture to a slot the shader is told to ignore
// is precisely the sort of thing that renders fine until the day the flag is
// wrong. `web/src/gpu/composite.ts` picks the pipeline from the mask kind.
//
// The arithmetic is transcribed from `web/src/graph/mask.ts`, which is the
// definition both execution kinds share, exactly as `blend.ts` is for the
// blend modes. `mask.test.ts` checks this file declares every kind and channel
// and agrees on the ordinals.

struct Params {
  width      : u32,
  height     : u32,
  mode       : u32,
  opacity    : f32,
  // MASK_NONE, or a MASK_* ordinal from graph/mask.ts.
  mask_kind  : u32,
  // 1 when coverage is inverted.
  mask_invert: u32,
  // luminance: low, high, feather. colour: OKLab L, a, b then tolerance,
  // feather. image: channel ordinal in `mask_channel`. One struct rather than
  // three because a uniform buffer's layout is fixed at pipeline creation and
  // three layouts would be three pipelines for one program.
  mask_a     : f32,
  mask_b     : f32,
  mask_c     : f32,
  mask_d     : f32,
  mask_e     : f32,
  mask_channel : u32,
};

// Ordinals, in the order of MASK_KINDS in `web/src/graph/mask.ts`.
// APPEND-ONLY, same rule as the blend modes.
const MASK_NONE      : u32 = 0xffffffffu;
const MASK_LUMINANCE : u32 = 0u;
const MASK_COLOR     : u32 = 1u;
const MASK_IMAGE     : u32 = 2u;

// Ordinals, in the order of MASK_CHANNELS in `web/src/graph/mask.ts`.
const MASK_CH_LUMINANCE : u32 = 0u;
const MASK_CH_ALPHA     : u32 = 1u;
const MASK_CH_RED       : u32 = 2u;
const MASK_CH_GREEN     : u32 = 3u;
const MASK_CH_BLUE      : u32 = 4u;

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
// Present only in the masked pipeline's layout. See the MASKING note above.
@group(0) @binding(7) var mask_tex : texture_2d<f32>;

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

// --- shared: masking (keep identical with graph/mask.ts) ------------------

// Rec. 709 luminance in linear light, the same weights the rest of the
// pipeline turns colour into tone with.
fn mask_luminance(c : vec3<f32>) -> f32 {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

// Linear-light sRGB primaries to OKLab. Ottosson's matrices, the same numbers
// `linearToOklab` in `gpu/resources.ts` carries — the target colour is
// converted on the CPU once per node, so only the pixel is converted here.
fn mask_oklab(c : vec3<f32>) -> vec3<f32> {
  let l = 0.41222146 * c.r + 0.53633255 * c.g + 0.051445995 * c.b;
  let m = 0.2119035 * c.r + 0.6806995 * c.g + 0.10739696 * c.b;
  let s = 0.08830246 * c.r + 0.28171884 * c.g + 0.6299785 * c.b;
  // `sign(x) * pow(abs(x), 1/3)`: a linear-light sample can be slightly
  // negative after a wide-gamut conversion, and `pow` of a negative is NaN,
  // which would spread through the whole tile.
  let l_ = sign(l) * pow(abs(l), 1.0 / 3.0);
  let m_ = sign(m) * pow(abs(m), 1.0 / 3.0);
  let s_ = sign(s) * pow(abs(s), 1.0 / 3.0);
  return vec3<f32>(
    0.21045426 * l_ + 0.7936178 * m_ - 0.004072047 * s_,
    1.9779985 * l_ - 2.4285922 * m_ + 0.4505937 * s_,
    0.025904037 * l_ + 0.78277177 * m_ - 0.80867577 * s_,
  );
}

fn mask_channel_value(channel : u32, c : vec4<f32>) -> f32 {
  switch (channel) {
    case 1u: { return c.a; }
    case 2u: { return c.r; }
    case 3u: { return c.g; }
    case 4u: { return c.b; }
    default: { return mask_luminance(c.rgb); }
  }
}

// `image` is only meaningful in the masked entry point; the unmasked one passes
// zeroes and never reaches the MASK_IMAGE arm.
fn mask_coverage(base : vec4<f32>, image : vec4<f32>) -> f32 {
  if (params.mask_kind == MASK_NONE) {
    return 1.0;
  }
  var raw : f32;
  if (params.mask_kind == MASK_LUMINANCE) {
    let l = mask_luminance(base.rgb);
    // Two edges of one band. `smoothstep` with equal edges is a step, which is
    // why a feather of zero needs no branch here or in graph/mask.ts.
    let rise = smoothstep(params.mask_a - params.mask_c, params.mask_a, l);
    let fall = 1.0 - smoothstep(params.mask_b, params.mask_b + params.mask_c, l);
    raw = min(rise, fall);
  } else if (params.mask_kind == MASK_COLOR) {
    let lab = mask_oklab(base.rgb);
    // Not `target`: that is a reserved keyword in WGSL, and the shader will not
    // compile with it. Same for `sample`, `filter` and `binding` — see
    // shaders/CONVENTIONS.md.
    let aim = vec3<f32>(params.mask_a, params.mask_b, params.mask_c);
    let reach = length(lab - aim);
    raw = 1.0 - smoothstep(params.mask_d, params.mask_d + params.mask_e, reach);
  } else {
    raw = mask_channel_value(params.mask_channel, image);
  }
  let clamped = clamp(raw, 0.0, 1.0);
  if (params.mask_invert == 1u) {
    return 1.0 - clamped;
  }
  return clamped;
}
// --- end shared -----------------------------------------------------------

fn composite_at(at : vec2<i32>, image : vec4<f32>) {
  let base = textureLoad(base_tex, at, 0);
  let top = textureLoad(top_tex, at, 0);

  let blended = vec3<f32>(
    blend_channel(params.mode, base.r, top.r),
    blend_channel(params.mode, base.g, top.g),
    blend_channel(params.mode, base.b, top.b),
  );

  // Coverage multiplies opacity, per pixel. The two answer different questions
  // — how much of this node overall, and where — so one does not override the
  // other; see the note in `graph/mask.ts`.
  let amount = params.opacity * mask_coverage(base, image);

  // Opacity is applied after the blend, as a lerp back towards the base. That
  // order is what makes opacity 0 the identity for every mode.
  let rgb = base.rgb + (blended - base.rgb) * amount;

  // Alpha is unassociated throughout the pipeline (F-IN-03) and is interpolated
  // by opacity alone rather than blended: multiplying an alpha channel would
  // silently erode coverage every time a node's opacity left 100%.
  let a = base.a + (top.a - base.a) * amount;

  textureStore(dst, at, vec4<f32>(rgb, a));
}

@compute @workgroup_size(8, 8, 1)
fn composite(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  composite_at(vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(0.0, 0.0, 0.0, 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn composite_masked(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let at = vec2<i32>(i32(gid.x), i32(gid.y));
  composite_at(at, textureLoad(mask_tex, at, 0));
}
