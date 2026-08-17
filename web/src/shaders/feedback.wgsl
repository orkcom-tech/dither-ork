// Feedback — frame N reads frame N-1 (F-FB-01).
//
// The only shader in the catalogue that reads something other than the picture
// arriving on its input: binding 6 is **this node's own output from the
// previous frame**, supplied by the frame store in `web/src/gpu/feedback.ts`.
// Everything trails, decays, grows, smears or zooms because of that one
// binding.
//
// --- WHAT IT COMPUTES ----------------------------------------------------
//
//   history = fetch(previous frame, inverse_transform(p)) * decay
//   out.rgb = input.rgb + (blend(mode, input.rgb, history.rgb) - input.rgb) * opacity
//   out.a   = input.a
//
// Three things in that are decisions rather than arithmetic.
//
// **The transform is inverted.** `offset`, `scale` and `rotate` describe where
// the previous frame *goes*, which is what a person setting them means; a
// gather shader has to read from where it *came from*, so the inverse is
// applied here and the controls read forwards. Scale above 1 pushes the history
// outward every frame, which is the endless zoom; rotate spins it, which is the
// spiral.
//
// **Outside the frame is zero, not the edge texel.** This buffer means "what
// this node produced last frame", and outside the frame it produced nothing.
// Clamping to the edge would invent pixels and would smear a one-texel column
// into the whole overscan of a zooming feedback — a very visible artefact that
// is nobody's intent. So the fetch below returns transparent black off the
// edge, and a trail that leaves the frame is gone.
//
// **Alpha is the input's, untouched.** Alpha is unassociated throughout the
// pipeline (F-IN-03) and none of the blend modes is defined for coverage.
// Feeding a decayed alpha back would erode the picture's own opacity a little
// on every frame, and at frame 0 — where the history is transparent black by
// construction — it would make an opaque image transparent in one step. What
// feeds back is light.
//
// At frame 0 the history is zero everywhere, so for `screen`, `add`, `lighten`,
// `difference` and `exclusion` this pass is the identity and frame 0 is the
// input exactly. That is the property the cleared buffer buys, and it is what
// makes a feedback document's first frame something a reader can predict.

struct Params {
  width    : u32,
  height   : u32,
  mode     : u32,
  decay    : f32,
  opacity  : f32,
  offset_x : f32,
  offset_y : f32,
  scale    : f32,
  rotate   : f32,
  pad0     : u32,
  pad1     : u32,
  pad2     : u32,
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

const TAU : f32 = 6.2831853071795864;

// Bindings follow `web/src/shaders/CONVENTIONS.md`: 0 input colour, 1 output
// colour, 5 uniforms. The previous frame takes 6, the first effect-specific
// slot, which is the same number `_composite.wgsl` gives its second colour
// input for the same reason — there is one conventional colour input and this
// is not it.
@group(0) @binding(0) var src  : texture_2d<f32>;
@group(0) @binding(1) var dst  : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;
@group(0) @binding(6) var prev : texture_2d<f32>;

// --- shared: soft light (keep identical with graph/blend.ts) --------------
//
// The W3C compositing definition, which is also Photoshop's. The piecewise
// `d(base)` term is what keeps the function continuous at the pivot.
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

// --- shared: blend channel (keep identical with _composite.wgsl) ----------
//
// Transcribed from `web/src/graph/blend.ts`, the definition both execution
// kinds share, and identical to the copy in `_composite.wgsl`. Duplicated
// because the WGSL contract has no includes (CONVENTIONS.md); keep the two in
// the same order so they can be diffed by eye, and `blend.test.ts` checks both
// files declare the same ordinals.
fn blend_channel(mode : u32, base : f32, top : f32) -> f32 {
  switch (mode) {
    case 0u: { return top; }
    case 1u: { return base * top; }
    case 2u: { return base + top - base * top; }
    case 3u: {
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
    // a catch-all: the packer only ever sends an ordinal from BLEND_MODES.
    default: { return max(0.0, base - top); }
  }
}
// --- end shared -----------------------------------------------------------

/**
 * One texel of the previous frame, or transparent black outside it.
 *
 * A variant of the fenced `bilinear fetch` block in `chromatic-aberration.wgsl`
 * and `rgb-split.wgsl`, and deliberately not identical to them: those clamp to
 * the edge, and this returns zero. See the header for why. `p` is in
 * texel-centre coordinates — pixel (x, y) has its centre at (x + 0.5, y + 0.5)
 * — so an untransformed fetch has weights 0 and 1 and is bit-identical to a
 * plain `textureLoad`.
 */
fn fetch_prev(p : vec2<f32>) -> vec4<f32> {
  let w = i32(params.width);
  let h = i32(params.height);

  let q = p - vec2<f32>(0.5, 0.5);
  let base = floor(q);
  let f = q - base;

  let x0 = i32(base.x);
  let y0 = i32(base.y);

  var acc = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  for (var dy = 0; dy < 2; dy = dy + 1) {
    for (var dx = 0; dx < 2; dx = dx + 1) {
      let x = x0 + dx;
      let y = y0 + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) {
        continue;
      }
      let wx = select(1.0 - f.x, f.x, dx == 1);
      let wy = select(1.0 - f.y, f.y, dy == 1);
      acc = acc + textureLoad(prev, vec2<i32>(x, y), 0) * wx * wy;
    }
  }
  return acc;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let at = vec2<i32>(i32(gid.x), i32(gid.y));
  let input = textureLoad(src, at, 0);

  // Texel centre of this pixel, and the centre of the frame the transform
  // pivots about. Pivoting about the centre rather than the origin is what
  // makes scale read as a zoom and rotate as a spin instead of as a shear away
  // from the top-left corner.
  let p = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);
  let centre = vec2<f32>(f32(params.width), f32(params.height)) * 0.5;

  // The inverse of "offset, then scale, then rotate about the centre". Guarded
  // against a zero scale, which the parameter's legal range already forbids;
  // the guard is here because a division by zero would write NaN into the
  // frame store and NaN never leaves once it is in a feedback loop.
  let scale = max(params.scale, 1.0e-4);
  let theta = -params.rotate * TAU;
  let c = cos(theta);
  let s = sin(theta);
  let d = (p - centre - vec2<f32>(params.offset_x, params.offset_y)) / scale;
  let rotated = vec2<f32>(d.x * c - d.y * s, d.x * s + d.y * c);
  let source = rotated + centre;

  let history = fetch_prev(source) * params.decay;

  let blended = vec3<f32>(
    blend_channel(params.mode, input.r, history.r),
    blend_channel(params.mode, input.g, history.g),
    blend_channel(params.mode, input.b, history.b),
  );

  // Opacity applied after the blend, as a lerp back towards the input — the
  // same order `_composite.wgsl` uses, and for the same reason: it makes
  // opacity 0 the identity for every mode.
  let rgb = input.rgb + (blended - input.rgb) * params.opacity;

  textureStore(dst, at, vec4<f32>(rgb, input.a));
}
