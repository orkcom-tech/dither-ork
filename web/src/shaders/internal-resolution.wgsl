// F-PP-01 — internal resolution factor: nearest / box / Lanczos downscale.
//
// The detail-crush node and the main performance lever, and it is one node
// because those are the same operation: everything after this point in the
// stack runs on a buffer `factor` times smaller on each axis, so the dither
// grid, the halftone cell and the pixel-sort run are all measured against the
// reduced grid rather than against the source. Pair it with Nearest upscale
// (F-SP-14) at the same factor to bring the frame back to output size — that
// pair is what "resolution-independent detail crush" means, and neither half
// can do it alone.
//
// **Two passes, one per axis.** Separable resampling is 2·k taps per output
// texel instead of k²; at factor 8 the Lanczos window is 48 source texels wide,
// so the 2D form would be 2304 taps per pixel and the separable form is 96. The
// contract's `ExtentAxes` exists for exactly this — pass one scales x and
// leaves y alone, pass two scales y and reads what pass one wrote (see
// `web/src/gpu/prepare.ts`, which threads the extent from each pass to the
// next). Both are the same program; only the axis flag differs.
//
// **The intermediate is a normal straight-alpha linear buffer.** Each pass
// premultiplies on the way in and unpremultiplies on the way out rather than
// leaving the middle texture premultiplied. That costs one divide per texel and
// buys the invariant every other shader in the catalogue relies on: a colour
// surface is linear light with straight alpha, always, whichever pass wrote it.
//
// **Filtering happens on premultiplied alpha.** Averaging straight-alpha texels
// pulls the colour of transparent texels into opaque neighbours — the classic
// dark halo — and F-IN-03 forbids repairing that by compositing onto anything.
// Weighting colour by coverage is the repair that composites onto nothing.
//
// **Rounding is `ceil`, decided in `web/src/gpu/extent.ts` and not here.** The
// last output texel of a box or Lanczos window legitimately covers a partial
// source window; rounding down would drop that column of the image entirely.
// This shader therefore has to expect a final texel whose window runs off the
// end of the source, and it clamps the window rather than the coordinate — a
// clamped coordinate would count the edge texel `factor` times and brighten the
// last column towards it.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// Ordinals are positions in the descriptor's `values` list, which is
// append-only: inserting a value in the middle renumbers every saved document.
const FILTER_NEAREST : u32 = 0u;
const FILTER_BOX     : u32 = 1u;
const FILTER_LANCZOS : u32 = 2u;

const PI : f32 = 3.141592653589793;

// Lanczos-3. Two lobes either side of the centre: a=2 is softer than a box at
// these factors and a=4 rings visibly on the hard edges a dither is about to
// quantize anyway.
const LANCZOS_A : f32 = 3.0;

// Below this the sinc quotient is 0/0 and the limit is 1.
const LANCZOS_EPSILON : f32 = 1.0e-6;

// The window always contains its centre tap, so the weight sum is never near
// zero — even at the frame edge, where half the Lanczos window is cut, it is
// about 0.5. The floor is here because the alternative to a guarded divide is a
// NaN, and a NaN in a linear-light buffer survives every node after it.
const MIN_WEIGHT_SUM : f32 = 1.0e-6;

// Coverage below this leaves the colour underdetermined: the premultiplied
// accumulator carries no colour to divide out, so the texel is written as fully
// transparent black rather than as whatever the division produced.
const MIN_ALPHA : f32 = 1.0e-6;

// Offsets must match INTERNAL_RESOLUTION_UNIFORMS in
// web/src/effects/internal-resolution.effect.ts. Six 4-byte scalars plus two
// pad words make the 32-byte size visible here rather than leaving it to WGSL's
// round-up rule.
//
// `filter` is a WGSL reserved keyword, so the field is `filter_` — the same
// trailing underscore `match_` carries in the palette struct, and no more
// decorative here than it is there. The *parameter* key stays `filter`: it is a
// document value, and renaming it to suit a shading language would put the
// language in every saved file.
struct Params {
  width         : u32,   //  0  extent this pass READS
  height        : u32,   //  4
  output_width  : u32,   //  8  extent this pass WRITES
  output_height : u32,   // 12
  factor        : u32,   // 16
  filter_       : u32,   // 20
  pad0          : u32,   // 24
  pad1          : u32,   // 28
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

fn lanczos(x : f32) -> f32 {
  let ax = abs(x);
  if (ax < LANCZOS_EPSILON) {
    return 1.0;
  }
  if (ax >= LANCZOS_A) {
    return 0.0;
  }
  let px = PI * ax;
  return (LANCZOS_A * sin(px) * sin(px / LANCZOS_A)) / (px * px);
}

// One texel, addressed along the axis being scaled. `horizontal` is uniform
// across the dispatch — it is which entry point is running, not per-pixel data
// — so this costs a select and no divergence.
fn fetch(axis_index : i32, other : i32, horizontal : bool) -> vec4<f32> {
  let coord = select(
    vec2<i32>(other, axis_index),
    vec2<i32>(axis_index, other),
    horizontal,
  );
  return textureLoad(src, coord, 0);
}

// The whole resampler, for one output texel along one axis.
//
// `n` is the source length on that axis; the window is clamped to `[0, n-1]`
// and the weights are renormalised by whatever survived, which is what keeps a
// flat field flat at the frame edge as well as in the middle.
fn resample(out_index : i32, other : i32, n : i32, horizontal : bool) -> vec4<f32> {
  let factor_i = i32(params.factor);
  let f = f32(params.factor);
  // Centre of this output texel expressed in source texels, on the same
  // half-texel convention the rest of the catalogue samples with.
  let centre = (f32(out_index) + 0.5) * f;

  var lo : i32 = 0;
  var hi : i32 = 0;   // inclusive
  switch (params.filter_) {
    case FILTER_NEAREST: {
      // The source texel the output centre lands in. Crunchy and aliased on
      // purpose: it is the only filter that keeps a source pixel's exact colour,
      // which is what makes it the right one under a hard-edged source.
      lo = clamp(i32(floor(centre)), 0, n - 1);
      hi = lo;
    }
    case FILTER_BOX: {
      // Exactly the `factor` source texels this output texel covers, and no
      // more — an area average, which is the correct reconstruction for an
      // integer downscale and the reason it is the default.
      lo = out_index * factor_i;
      hi = min(lo + factor_i - 1, n - 1);
    }
    default: {
      // FILTER_LANCZOS. The kernel is widened by the factor so it low-passes at
      // the *output* Nyquist rather than the source's: a kernel of fixed source
      // width would leave everything it was meant to remove.
      //
      // The loop is bounded by construction — the descriptor's legal factor
      // stops at INTERNAL_RESOLUTION_MAX_FACTOR (16), so the widest window is
      // 6·16 + 1 = 97 taps.
      lo = max(i32(ceil(centre - LANCZOS_A * f - 0.5)), 0);
      hi = min(i32(floor(centre + LANCZOS_A * f - 0.5)), n - 1);
    }
  }

  var acc = vec4<f32>(0.0);
  var weight_sum = 0.0;
  for (var s = lo; s <= hi; s = s + 1) {
    var w = 1.0;
    if (params.filter_ == FILTER_LANCZOS) {
      w = lanczos((f32(s) + 0.5 - centre) / f);
    }
    let texel = fetch(s, other, horizontal);
    // Premultiplied: colour weighted by its own coverage as well as by the
    // filter, so a transparent texel contributes no colour.
    acc = acc + vec4<f32>(texel.rgb * texel.a, texel.a) * w;
    weight_sum = weight_sum + w;
  }

  let alpha = clamp(acc.a / max(weight_sum, MIN_WEIGHT_SUM), 0.0, 1.0);
  var rgb = vec3<f32>(0.0);
  if (acc.a > MIN_ALPHA) {
    // Unpremultiply. `max` against zero because Lanczos has negative lobes and
    // ringing can undershoot: negative linear light is not a colour, and it
    // would come back as a bright fringe the moment anything downstream took a
    // square root of it. Overshoot *above* 1 is left alone — the working
    // surface is rgba16float and headroom is carried through the stack.
    rgb = max(acc.rgb / acc.a, vec3<f32>(0.0));
  }
  return vec4<f32>(rgb, alpha);
}

@compute @workgroup_size(8, 8, 1)
fn reduce_x(@builtin(global_invocation_id) gid : vec3<u32>) {
  // Against the extent this pass WRITES: the dispatch is sized to cover the
  // output, and on this pass the output is narrower than the input.
  if (gid.x >= params.output_width || gid.y >= params.output_height) {
    return;
  }
  let value = resample(i32(gid.x), i32(gid.y), i32(params.width), true);
  textureStore(dst, vec2<i32>(i32(gid.x), i32(gid.y)), value);
}

@compute @workgroup_size(8, 8, 1)
fn reduce_y(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.output_width || gid.y >= params.output_height) {
    return;
  }
  let value = resample(i32(gid.y), i32(gid.x), i32(params.height), false);
  textureStore(dst, vec2<i32>(i32(gid.x), i32(gid.y)), value);
}
