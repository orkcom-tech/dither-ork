// F-SP-04 — Edge detect: Sobel and Laplacian, with mix-back.
//
// Both operators are 3x3 convolutions over LIGHTNESS, so one dispatch covers
// the pair and the choice is a uniform rather than a second pass. The response
// is turned into a neutral grey and mixed back over the source, which is what
// makes the effect a control rather than a replacement.
//
// The two are normalised to agree with each other: a full-contrast step edge
// reads 1.0 from either. Sobel's gradient over a 0-to-1 step is 4, hence the
// division; the four-neighbour Laplacian's response over the same step is 1 on
// each side of it, hence none. Without that they would be different effects
// wearing one `strength` slider.
//
//   Sobel      Gx = [-1 0 1; -2 0 2; -1 0 1]   Gy = Gx transposed
//   Laplacian       [ 0 1 0;  1 -4 1;  0 1 0]
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const OPERATOR_SOBEL     : u32 = 0u;
const OPERATOR_LAPLACIAN : u32 = 1u;

// Gradient magnitude of a full-contrast step edge under the Sobel kernel. The
// operators are normalised to each other so `strength` means one thing.
const SOBEL_STEP_RESPONSE : f32 = 4.0;

// Offsets must match EDGE_DETECT_UNIFORMS in
// web/src/effects/edge-detect.effect.ts. The three pad members make the
// 32-byte size visible here rather than leaving it to WGSL's round-up rule.
//
// `operator_` is an enum ordinal, and the ordinals above are the descriptor's
// declaration order. Enum values are append-only for exactly this reason:
// inserting one in the middle renumbers every document already saved.
//
// `operator` is a WGSL reserved word and `mix` is a builtin; the trailing
// underscore and the `_back` suffix are not decoration, in the same way
// `PaletteEntry.match_` is not.
struct Params {
  width     : u32,   //  0
  height    : u32,   //  4
  strength  : f32,   //  8
  mix_back  : f32,   // 12
  operator_ : u32,   // 16
  pad0      : u32,   // 20
  pad1      : u32,   // 24
  pad2      : u32,   // 28
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

// --- shared: clamped texel fetch (keep identical across shaders) ----------
//
// Every neighbourhood effect needs this and none of them may use a sampler:
// the working surface is linear-light rgba16float read at integer coordinates.
// Out-of-bounds `textureLoad` returns zero, so an unclamped kernel paints a
// dark frame one radius wide around the image. Clamp-to-edge is the standard
// answer and the only one that leaves a flat field flat.
fn load_clamped(coord : vec2<i32>) -> vec4<f32> {
  let last = vec2<i32>(i32(params.width) - 1, i32(params.height) - 1);
  return textureLoad(src, clamp(coord, vec2<i32>(0, 0), last), 0);
}
// --- end shared ----------------------------------------------------------

// --- shared: perceptual lightness (keep identical across shaders) ---------
//
// The cube root of Rec.709 luminance. This is the classical lightness curve —
// CIE L* and OKLab's L are both this shape — and for a neutral colour it is
// exactly OKLab's L, because each row of OKLab's LMS matrix sums to one, so a
// grey of linear value v has l = m = s = v and L = v^(1/3).
//
// Used rather than the full OKLab transform because these effects evaluate
// lightness per TAP, not per pixel: a glow's bright-pass at radius 24 asks for
// it 49 times per invocation, and the full transform is three `pow` calls to
// this one's one. The two agree exactly where it matters — on the neutral axis
// — and the quantity being measured here is relief and edge contrast, not
// colour difference, so no palette decision depends on the difference.
fn rec709_luminance(linear_rgb : vec3<f32>) -> f32 {
  return 0.2126 * linear_rgb.r + 0.7152 * linear_rgb.g + 0.0722 * linear_rgb.b;
}

fn perceptual_lightness(linear_rgb : vec3<f32>) -> f32 {
  // `pow` of a negative base is undefined in WGSL, and a previous node with
  // headroom can leave a channel slightly below zero.
  return pow(max(rec709_luminance(linear_rgb), 0.0), 1.0 / 3.0);
}
// --- end shared ----------------------------------------------------------

// --- shared: neutral grey from lightness (keep identical across shaders) --
//
// Exact inverse of `perceptual_lightness` on the neutral axis: a grey of
// lightness l is linear l^3. That is what lets an effect compute in lightness
// and write linear light without an approximation sitting between the two.
fn lightness_to_linear_grey(lightness : f32) -> vec3<f32> {
  let l = clamp(lightness, 0.0, 1.0);
  return vec3<f32>(l * l * l);
}
// --- end shared ----------------------------------------------------------

@compute @workgroup_size(8, 8, 1)
fn detect(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));

  // Lightness of the 3x3 window, row-major from the top-left corner:
  //
  //   0 1 2
  //   3 4 5      +y is down, as everywhere else in the pipeline.
  //   6 7 8
  var w : array<f32, 9>;
  for (var j = -1; j <= 1; j = j + 1) {
    for (var i = -1; i <= 1; i = i + 1) {
      w[(j + 1) * 3 + (i + 1)] = perceptual_lightness(load_clamped(coord + vec2<i32>(i, j)).rgb);
    }
  }

  var response : f32;
  if (params.operator_ == OPERATOR_LAPLACIAN) {
    // The four-neighbour discrete Laplacian. Its sign says which side of the
    // edge the pixel is on, which an edge map does not care about.
    response = abs(w[1] + w[3] + w[5] + w[7] - 4.0 * w[4]);
  } else {
    let gx = (w[2] + 2.0 * w[5] + w[8]) - (w[0] + 2.0 * w[3] + w[6]);
    let gy = (w[6] + 2.0 * w[7] + w[8]) - (w[0] + 2.0 * w[1] + w[2]);
    response = sqrt(gx * gx + gy * gy) / SOBEL_STEP_RESPONSE;
  }

  // `strength` is a gain and not a decoration: an edge response is a difference
  // between neighbouring pixels, so on anything but a hard graphic edge it
  // arrives in the low hundredths and the unscaled map is black.
  let edge = clamp(response * params.strength, 0.0, 1.0);

  let texel = textureLoad(src, coord, 0);

  // Mix-back in linear light, between the source colour and a neutral grey of
  // the edge's lightness. 1 is the plain edge map; below that the edges sit
  // over the picture, which is the usual way to feed one to a dither.
  let out_rgb = mix(texel.rgb, lightness_to_linear_grey(edge), clamp(params.mix_back, 0.0, 1.0));

  // Alpha is carried through untouched (F-IN-03).
  textureStore(dst, coord, vec4<f32>(out_rgb, texel.a));
}
