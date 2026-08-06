// F-SP-03 — Sharpen, as an unsharp mask.
//
//     out = src + amount * gate * (src - blur(src))
//
// which is the definition: subtract a blurred copy to isolate what the blur
// removed, then add that detail back with gain. `radius` is the blur's radius,
// `amount` the gain, `threshold` the floor below which a difference is left
// alone so film grain and sensor noise are not amplified along with the edges.
//
// Two passes, because the blur inside it is a separable gaussian and the
// composite needs the ORIGINAL pixel that the blur has by then overwritten.
// The colour surface ping-pongs, so pass 0 stashes the untouched source in a
// scratch buffer on its way past and pass 1 reads it back:
//
//   pass 0  stash src -> scratch, horizontal gaussian -> colour
//   pass 1  vertical gaussian over colour, unsharp against scratch -> colour
//
// The stash is two u32 per pixel holding four halves — exactly the precision
// of the rgba16float surface it copies, so nothing is lost and nothing is
// spent on headroom the source cannot reach.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// Offsets must match SHARPEN_UNIFORMS in web/src/effects/sharpen.effect.ts.
// The three pad members make the 32-byte size visible here rather than leaving
// it to WGSL's round-up rule.
struct Params {
  width     : u32,   //  0
  height    : u32,   //  4
  amount    : f32,   //  8
  radius    : f32,   // 12
  threshold : f32,   // 16
  pad0      : f32,   // 20
  pad1      : f32,   // 24
  pad2      : f32,   // 28
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

// Below this the colour carried by a pixel is not a colour — it is whatever
// happened to be in a fully transparent texel — so unpremultiplying it
// amplifies noise by 1/alpha. Returning transparent black instead is the
// defined result, not a fallback.
const MIN_ALPHA : f32 = 1.0e-5;

// Width of the ramp at threshold = 0. The gate below reaches full strength at
// twice the threshold; at zero that would be a division by zero, so the
// denominator is floored here instead. The consequence is exactly what the
// default wants: at threshold = 0 any difference at all is sharpened in full,
// i.e. the plain unsharp mask.
const MIN_GATE_WIDTH : f32 = 1.0e-6;

@compute @workgroup_size(8, 8, 1)
fn blur_h_stash(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));

  // In bounds by the check above, so this needs no clamping.
  stash[stash_index(gid)] = stash_pack(textureLoad(src, coord, 0));

  let taps = blur_taps(params.radius);
  let sigma = blur_sigma(params.radius);

  var acc = vec4<f32>(0.0);
  var weight_sum = 0.0;
  for (var i = -taps; i <= taps; i = i + 1) {
    let w = blur_weight(i, sigma);
    let texel = load_clamped(coord + vec2<i32>(i, 0));
    // Premultiplied: an unweighted average lets a fully transparent pixel vote
    // with whatever RGB it happens to carry (F-IN-03).
    acc = acc + w * vec4<f32>(texel.rgb * texel.a, texel.a);
    weight_sum = weight_sum + w;
  }

  // weight_sum is at least 1: the centre tap's weight is exp(0) exactly.
  textureStore(dst, coord, acc / weight_sum);
}

@compute @workgroup_size(8, 8, 1)
fn blur_v_sharpen(@builtin(global_invocation_id) gid : vec3<u32>) {
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
  var blurred = vec3<f32>(0.0);
  if (premultiplied.a > MIN_ALPHA) {
    blurred = premultiplied.rgb / premultiplied.a;
  }

  let original = stash_unpack(stash[stash_index(gid)]);
  let detail = original.rgb - blurred;

  // The threshold is measured on LIGHTNESS, not on a channel difference, so
  // one number means the same thing on a red edge as on a grey one and reads
  // the way the eye does. The detail added back is still per-channel: an
  // unsharp mask that only moved lightness would leave colour edges soft.
  let contrast = abs(perceptual_lightness(original.rgb) - perceptual_lightness(blurred));

  // A soft gate reaching full strength at twice the threshold. The textbook
  // unsharp mask cuts hard at the threshold, which quantizes the sharpening
  // into visible patches wherever it crosses a gradient — in an application
  // whose whole subject is controlled texture, that is a pattern nobody asked
  // for. At threshold = 0 the two are identical, which is the case the default
  // and any golden image pin.
  let gate = clamp(
    (contrast - params.threshold) / max(params.threshold, MIN_GATE_WIDTH),
    0.0,
    1.0,
  );

  // Clamped back into [0, 1]. The surface has float headroom, but the source
  // decodes to [0, 1] linear (F-IN-02) and every node downstream measures
  // against a palette that lives in that range; letting a sharpen push past it
  // would silently change what all of them see.
  let sharpened = clamp(
    original.rgb + params.amount * gate * detail,
    vec3<f32>(0.0),
    vec3<f32>(1.0),
  );

  // Alpha is the original's, untouched. The blur inside an unsharp mask is
  // scaffolding, not output.
  textureStore(dst, coord, vec4<f32>(sharpened, original.a));
}
