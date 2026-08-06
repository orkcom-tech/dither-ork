// F-SP-01 — Epsilon glow.
//
// Light bleeding out of the bright parts of the picture: take what is above a
// lightness threshold, spread it with a gaussian, add it back. Three stages,
// each of which the requirement names a control for — threshold, radius,
// intensity — plus the choice of how it comes back, additive or screen.
//
// Two passes, and the shape is forced by two facts. The blur is separable, so
// it wants two dispatches anyway; and the composite needs the ORIGINAL pixel,
// which the colour surface no longer holds by then because it ping-pongs
// between passes. Pass 0 therefore stashes the untouched source on its way
// past and blurs the bright-pass horizontally; pass 1 finishes the blur
// vertically and composites against the stash:
//
//   pass 0  stash src -> scratch, horizontal gaussian of bright(src) -> colour
//   pass 1  vertical gaussian over colour, blend with stash -> colour
//
// The bright-pass is evaluated per TAP rather than once per pixel, which is
// what lets it live inside pass 0 instead of needing a pass of its own.
// Thresholding is pointwise, so blurring the thresholded image and thresholding
// each tap before summing are the same arithmetic; the second costs one `pow`
// per tap and saves a full-frame dispatch and a second scratch buffer.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const BLEND_ADDITIVE : u32 = 0u;
const BLEND_SCREEN   : u32 = 1u;

// Offsets must match EPSILON_GLOW_UNIFORMS in
// web/src/effects/epsilon-glow.effect.ts. The two pad members make the 32-byte
// size visible here rather than leaving it to WGSL's round-up rule.
//
// `blend` is an enum ordinal, and the ordinals above are the descriptor's
// declaration order. Enum values are append-only for exactly this reason:
// inserting one in the middle renumbers every document already saved.
struct Params {
  width     : u32,   //  0
  height    : u32,   //  4
  threshold : f32,   //  8
  radius    : f32,   // 12
  intensity : f32,   // 16
  blend     : u32,   // 20
  pad0      : u32,   // 24
  pad1      : u32,   // 28
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

// Declared read_write although pass 1 only reads it. There is one WGSL file per
// effect and therefore one declaration, and a shader's access mode has to match
// the bind group layout's buffer type in every pass that uses it — so both
// passes declare the slot read-write and pass 1 simply does not store.
@group(0) @binding(6) var<storage, read_write> stash : array<vec2<u32>>;

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

// --- shared: source stash (keep identical across shaders) -----------------
//
// Four halves in two u32, which is bit-for-bit what the rgba16float surface
// holds. An effect whose last pass needs the untouched input has to keep it
// somewhere, because the colour surface it arrived on has been overwritten by
// then; this is that somewhere, and it costs 8 bytes per pixel for the life of
// the node.
fn stash_index(gid : vec3<u32>) -> u32 {
  return gid.y * params.width + gid.x;
}

fn stash_pack(texel : vec4<f32>) -> vec2<u32> {
  return vec2<u32>(pack2x16float(texel.rg), pack2x16float(texel.ba));
}

fn stash_unpack(packed : vec2<u32>) -> vec4<f32> {
  let rg = unpack2x16float(packed.x);
  let ba = unpack2x16float(packed.y);
  return vec4<f32>(rg.x, rg.y, ba.x, ba.y);
}
// --- end shared ----------------------------------------------------------

// Guards the knee's denominator. The legal range for `threshold` stops short of
// 1, so this only catches a malformed document — but a zero denominator paints
// the frame NaN, and NaN in a linear-light buffer survives every node after it.
const MIN_KNEE_WIDTH : f32 = 1.0e-4;

// What a pixel contributes to the glow.
//
// The mask is measured on LIGHTNESS and applied to the colour, rather than
// subtracted per channel. Subtracting the threshold from each channel pulls
// saturated highlights towards whichever channel is largest, so a warm
// highlight glows orange and a cool one glows blue-white — a hue shift nobody
// asked for. Scaling by a lightness mask keeps the glow the colour of the thing
// that is glowing.
//
// The ramp reaches full at white rather than cutting hard at the threshold,
// because a hard cut draws a contour line through every gradient it crosses,
// and that contour survives the blur as a visible ring.
//
// Weighted by alpha, so a transparent region cannot emit light (F-IN-03).
fn bright_pass(texel : vec4<f32>) -> vec3<f32> {
  let lightness = perceptual_lightness(texel.rgb);
  let knee = clamp(
    (lightness - params.threshold) / max(1.0 - params.threshold, MIN_KNEE_WIDTH),
    0.0,
    1.0,
  );
  return texel.rgb * texel.a * knee;
}

@compute @workgroup_size(8, 8, 1)
fn bright_blur_h(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));

  // In bounds by the check above, so this needs no clamping.
  stash[stash_index(gid)] = stash_pack(textureLoad(src, coord, 0));

  let taps = blur_taps(params.radius);
  let sigma = blur_sigma(params.radius);

  var acc = vec3<f32>(0.0);
  var weight_sum = 0.0;
  for (var i = -taps; i <= taps; i = i + 1) {
    let w = blur_weight(i, sigma);
    acc = acc + w * bright_pass(load_clamped(coord + vec2<i32>(i, 0)));
    weight_sum = weight_sum + w;
  }

  // weight_sum is at least 1: the centre tap's weight is exp(0) exactly.
  //
  // The alpha channel of this intermediate carries nothing — the glow is
  // emitted light, already weighted by the source alpha, and the alpha that
  // reaches the output comes from the stash. Written as 1 rather than left to
  // whatever was in the surface.
  textureStore(dst, coord, vec4<f32>(acc / weight_sum, 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn glow_composite(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));

  let taps = blur_taps(params.radius);
  let sigma = blur_sigma(params.radius);

  var acc = vec3<f32>(0.0);
  var weight_sum = 0.0;
  for (var i = -taps; i <= taps; i = i + 1) {
    let w = blur_weight(i, sigma);
    acc = acc + w * load_clamped(coord + vec2<i32>(0, i)).rgb;
    weight_sum = weight_sum + w;
  }

  let glow = max((acc / weight_sum) * params.intensity, vec3<f32>(0.0));
  let original = stash_unpack(stash[stash_index(gid)]);
  let base = clamp(original.rgb, vec3<f32>(0.0), vec3<f32>(1.0));

  // Both blends happen in LINEAR LIGHT, which for the additive one is the
  // physics: two light sources reaching the same pixel add. Screen is the
  // softer of the two — it approaches white asymptotically instead of arriving
  // there, so a highlight keeps its internal structure at intensities where
  // additive has flattened it to a solid patch, which in a stack that ends in a
  // dither is the difference between a textured highlight and a blank one.
  var lit : vec3<f32>;
  if (params.blend == BLEND_SCREEN) {
    let s = clamp(glow, vec3<f32>(0.0), vec3<f32>(1.0));
    lit = 1.0 - (1.0 - base) * (1.0 - s);
  } else {
    lit = base + glow;
  }

  // Clamped back into [0, 1]. The surface has float headroom, but the source
  // decodes to [0, 1] linear (F-IN-02) and every node downstream measures
  // against a palette that lives in that range; letting a glow push past it
  // would silently change what all of them see.
  let out_rgb = clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0));

  // Alpha is the original's, untouched. A glow adds light, not coverage.
  textureStore(dst, coord, vec4<f32>(out_rgb, original.a));
}
