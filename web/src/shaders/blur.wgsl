// F-SP-02 — Gaussian blur.
//
// A true gaussian, separated into a horizontal and a vertical pass. A 2D
// gaussian is the outer product of two 1D gaussians, so the separated form is
// exact rather than an approximation, and it turns (2r+1)^2 taps per pixel into
// 2(2r+1) — at r = 24 that is 2401 loads against 98.
//
// The two passes are two entry points in this one file, which is the convention
// for a multi-pass effect (CONVENTIONS.md). The scheduler ping-pongs the colour
// surface between them, so `blur_v` reads exactly what `blur_h` wrote.
//
// Alpha: the intermediate is PREMULTIPLIED and the vertical pass undoes it.
// Blurring unassociated alpha and colour independently drags colour out of
// pixels that are not there — a fully transparent pixel still carries some RGB
// value, and an unweighted average gives it a vote. Premultiplying is the fix
// that keeps F-IN-03 honest: alpha is preserved and never composited onto
// anything.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// Offsets must match BLUR_UNIFORMS in web/src/effects/blur.effect.ts. pad0
// makes the 16-byte size visible here rather than leaving it to WGSL's
// round-up rule.
struct Params {
  width  : u32,   //  0
  height : u32,   //  4
  radius : f32,   //  8
  pad0   : f32,   // 12
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

// --- shared: gaussian kernel geometry (keep identical across shaders) -----
//
// `radius` is the truncation half-width in pixels and sigma is a third of it,
// so the outermost tap carries exp(-4.5) = 1.1% of the peak. The tail past
// that is discarded and the weights are renormalised, which makes the
// truncation exact rather than merely small: the kernel still sums to one, so
// a flat field comes out at its own value at any radius.
//
// The ceiling exists because the loop bound has to be finite on a GPU. It is
// the same number as the legal maximum in the descriptor, so a document can
// never ask for a radius this silently refuses to honour.
const MAX_BLUR_RADIUS : i32 = 64;

// A radius of zero is legal and means "do nothing". Sigma would then be zero
// and the single i = 0 tap would evaluate 0/0 — NaN, which survives every node
// downstream of it. Flooring the input keeps that arithmetic finite; the tap
// count is still zero, so the pass is still an exact identity.
const MIN_BLUR_RADIUS : f32 = 0.001;

fn blur_taps(radius : f32) -> i32 {
  return clamp(i32(ceil(radius)), 0, MAX_BLUR_RADIUS);
}

fn blur_sigma(radius : f32) -> f32 {
  return max(radius, MIN_BLUR_RADIUS) / 3.0;
}

fn blur_weight(tap : i32, sigma : f32) -> f32 {
  let x = f32(tap);
  return exp(-0.5 * x * x / (sigma * sigma));
}
// --- end shared ----------------------------------------------------------

// Below this the colour carried by a pixel is not a colour — it is whatever
// happened to be in a fully transparent texel — so unpremultiplying it
// amplifies noise by 1/alpha. Returning transparent black instead is the
// defined result, not a fallback.
const MIN_ALPHA : f32 = 1.0e-5;

@compute @workgroup_size(8, 8, 1)
fn blur_h(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));

  let taps = blur_taps(params.radius);
  let sigma = blur_sigma(params.radius);

  var acc = vec4<f32>(0.0);
  var weight_sum = 0.0;
  for (var i = -taps; i <= taps; i = i + 1) {
    let w = blur_weight(i, sigma);
    let texel = load_clamped(coord + vec2<i32>(i, 0));
    acc = acc + w * vec4<f32>(texel.rgb * texel.a, texel.a);
    weight_sum = weight_sum + w;
  }

  // weight_sum is at least 1: the centre tap's weight is exp(0) exactly.
  //
  // Written PREMULTIPLIED. The vertical pass is the only reader of this
  // surface and it undoes the premultiplication, so the convention never
  // escapes this effect — but round-tripping through unassociated alpha
  // between the two passes would divide and re-multiply by the same small
  // number for nothing.
  textureStore(dst, coord, acc / weight_sum);
}

@compute @workgroup_size(8, 8, 1)
fn blur_v(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));

  let taps = blur_taps(params.radius);
  let sigma = blur_sigma(params.radius);

  var acc = vec4<f32>(0.0);
  var weight_sum = 0.0;
  for (var i = -taps; i <= taps; i = i + 1) {
    let w = blur_weight(i, sigma);
    acc = acc + w * load_clamped(coord + vec2<i32>(0, i));
    weight_sum = weight_sum + w;
  }

  let premultiplied = acc / weight_sum;
  let alpha = premultiplied.a;

  var rgb = vec3<f32>(0.0);
  if (alpha > MIN_ALPHA) {
    rgb = premultiplied.rgb / alpha;
  }

  // Back to unassociated alpha, which is what the rest of the stack carries.
  textureStore(dst, coord, vec4<f32>(rgb, alpha));
}
