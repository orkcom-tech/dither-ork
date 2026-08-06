// F-SP-13 — Barrel / pincushion distortion.
//
// The first radial term of the Brown-Conrady lens model, run as an inverse map:
// for each output pixel, find where in the source it came from and fetch that.
//
//   r_src = r_dst * (1 + k * r_dst^2)
//
// with r measured in units of the half-diagonal, so r = 1 at the corners.
//
// ## Sign convention
//
// k is `amount` and its sign follows the model rather than the vocabulary:
//
// - **k > 0** samples further out the further out you are, so features move
//   inward and the edges pinch — **pincushion**.
// - **k < 0** samples nearer the centre, so the middle of the frame expands and
//   the edges bulge — **barrel**.
//
// That is the same sign as k1 in every published distortion table, and the
// descriptor's label says which is which so nobody has to derive it from here.
//
// ## Why the radius is normalised by the half-diagonal
//
// A lens does not know the sensor's aspect ratio; distortion is isotropic in the
// image plane and depends only on field angle. Normalising per axis — which is
// right for the vignette, where the falloff should follow the frame — would make
// a circle in the source come out as an ellipse, which is not a lens.
//
// ## Why the filtering is written out by hand
//
// The pass layer binds no samplers at all (`web/src/gpu/compiler.ts` has no
// sampler entry), and the convention is that colour is read with `textureLoad`
// at integer coordinates. So bilinear here is four `textureLoad`s and two mixes,
// which is exactly what a sampler would have done and is visible rather than
// delegated.
//
// Both filters are offered because the right one depends on what is upstream,
// and that is a real choice rather than a quality setting: bilinear is correct
// for continuous tone and invents colours between palette entries when it is not
// there, and nearest keeps whatever palette the buffer already has at the cost
// of stair-stepping the geometry.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const EDGE_CLAMP       : u32 = 0u;
const EDGE_BLACK       : u32 = 1u;
const EDGE_TRANSPARENT : u32 = 2u;

const SAMPLING_NEAREST  : u32 = 0u;
const SAMPLING_BILINEAR : u32 = 1u;

// `scale` divides the sampled radius. The registry's legal range starts well
// above zero, so this only catches a malformed document — but a zero here paints
// the frame with infinities, and an infinity in a linear-light buffer survives
// every node after it.
const MIN_SCALE : f32 = 0.0009765625;

// Offsets must match LENS_DISTORTION_UNIFORMS in
// web/src/effects/lens-distortion.effect.ts. The two pad members make the
// 32-byte size visible here rather than leaving it to WGSL's round-up rule.
struct Params {
  width    : u32,   //  0
  height   : u32,   //  4
  amount   : f32,   //  8
  scale    : f32,   // 12
  edge     : u32,   // 16
  sampling : u32,   // 20
  pad0     : u32,   // 24
  pad1     : u32,   // 28
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

// One texel, clamped to the frame. Clamping rather than returning zero for an
// out-of-range tap: `textureLoad` outside a texture already returns zero, and a
// bilinear kernel straddling the border would then fade every edge of every
// distorted frame to transparent black. Whether an out-of-frame *sample* is
// legal at all is decided once, on the unclamped coordinate, in `main`.
fn fetch(x : i32, y : i32) -> vec4<f32> {
  let cx = clamp(x, 0, i32(params.width) - 1);
  let cy = clamp(y, 0, i32(params.height) - 1);
  return textureLoad(src, vec2<i32>(cx, cy), 0);
}

// `p` is in pixel-centre coordinates: the centre of texel (i, j) is (i+0.5, j+0.5).
fn sample_bilinear(p : vec2<f32>) -> vec4<f32> {
  // Shift to lattice space, where the integer points are the texel centres.
  let t = p - vec2<f32>(0.5);
  let base = floor(t);
  let f = t - base;
  let x0 = i32(base.x);
  let y0 = i32(base.y);

  let c00 = fetch(x0,     y0);
  let c10 = fetch(x0 + 1, y0);
  let c01 = fetch(x0,     y0 + 1);
  let c11 = fetch(x0 + 1, y0 + 1);

  // Interpolated in linear light, which is where averaging is physical. The
  // buffer is already linear, so this is the cheap correctness rather than a
  // choice: mixing sRGB-encoded values would darken every edge in the frame.
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));

  let size = vec2<f32>(f32(params.width), f32(params.height));
  let centre = size * 0.5;
  let pixel = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);

  // Half the diagonal in pixels: the unit that makes r = 1 at the corners.
  let half_diagonal = length(centre);
  let v = (pixel - centre) / half_diagonal;

  let factor = 1.0 + params.amount * dot(v, v);
  let source = centre + v * (factor / max(params.scale, MIN_SCALE)) * half_diagonal;

  // Decided on the unclamped coordinate, before any fetch clamping happens.
  let outside =
    source.x < 0.0 || source.x >= size.x || source.y < 0.0 || source.y >= size.y;

  var texel : vec4<f32>;
  if (outside && params.edge != EDGE_CLAMP) {
    // Black keeps the frame opaque; transparent writes coverage 0 and leaves the
    // decision about what sits behind it to whatever composites later. Alpha is
    // never composited onto white inside the stack (F-IN-03), so the difference
    // survives to export.
    let alpha = select(1.0, 0.0, params.edge == EDGE_TRANSPARENT);
    texel = vec4<f32>(0.0, 0.0, 0.0, alpha);
  } else if (params.sampling == SAMPLING_BILINEAR) {
    texel = sample_bilinear(source);
  } else {
    texel = fetch(i32(floor(source.x)), i32(floor(source.y)));
  }

  textureStore(dst, coord, texel);
}
