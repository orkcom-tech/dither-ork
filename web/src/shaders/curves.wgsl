// F-PP-05 — Curves: an editable spline, per channel or luma.
//
// The spline is not evaluated here. The node's control points are turned into a
// 256-entry transfer LUT on the CPU (`web/src/effects/curves.effect.ts`) and
// arrive as this node's own bulk data — an `instance-data` binding, which is
// the channel `web/src/types/gpu.ts` describes for exactly this. Two reasons,
// and the second is the one that decided it:
//
// - a uniform block whose size depended on how many points the user had dragged
//   would be a different `UniformLayout` per document, and the layout is what
//   the pipeline is compiled against;
// - a monotone cubic evaluated per pixel is a search plus a Hermite basis per
//   channel per texel, against one linear interpolation into a table. The table
//   is rebuilt only when the curve moves, and the digest on it means a slider
//   drag elsewhere on the node costs no upload at all.
//
// **The transfer is defined on the sRGB-encoded value**, the same domain as
// levels (F-PP-03) and brightness/contrast (F-PP-02). That is what a curve
// dialog's diagonal means: the point at (0.5, 0.5) is the middle of the
// histogram, which is encoded 0.5 and linear 0.21. Running the same control
// points on the linear buffer would move a midtone lift three times as far as
// the curve drawn on screen says it does. The buffer is linear light in and
// linear light out; only the transfer is defined in gamma space. See
// `levels.wgsl` for the same argument at length.
//
// **This node clips headroom**, like levels and unlike brightness/contrast: a
// transfer curve is a function on [0, 1], so an upstream exposure that left
// values above 1 has them mapped to whatever the curve says about 1. That is
// what a transfer curve is, not an oversight.
//
// **Two modes.** Per-channel runs the same curve on R, G and B independently,
// which shifts hue on saturated colours because the three channels bend at
// different places — that is most of what a curves move looks like. Luma runs
// it on the pixel's Rec.709 luminance and scales the linear triple by the
// ratio, a pure scale that leaves chromaticity exactly where it was.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// Ordinals are positions in the descriptor's `values` list, which is
// append-only: inserting a value in the middle renumbers every saved document.
const MODE_PER_CHANNEL : u32 = 0u;
const MODE_LUMA        : u32 = 1u;

// The LUT's last index. Its length is CURVE_LUT_SIZE in
// web/src/effects/curves.effect.ts and the builder there emits exactly that
// many entries — one per 8-bit code, so a curve drawn against a histogram lands
// on the codes the histogram is drawn from.
const LUT_LAST : u32 = 255u;
const LUT_LAST_F : f32 = 255.0;

// Below this a pixel carries no luminance to take a ratio against, so in luma
// mode the mapped grey is the answer rather than `linear_rgb * (0/0)`.
const MIN_LUMINANCE : f32 = 1.0e-5;

// Offsets must match CURVES_UNIFORMS in web/src/effects/curves.effect.ts. Three
// 4-byte scalars plus one pad word make the 16-byte size visible here rather
// than leaving it to WGSL's round-up rule.
struct Params {
  width  : u32,   //  0
  height : u32,   //  4
  mode   : u32,   //  8
  pad0   : u32,   // 12
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;
// This node's own transfer LUT, built from its `curve` parameter. Read-only:
// the CPU builds these bytes and the shader samples them.
@group(0) @binding(6) var<storage, read> lut : array<f32>;

// --- shared: linear -> sRGB transfer (keep identical across shaders) -----

fn linear_to_srgb(c : vec3<f32>) -> vec3<f32> {
  let clamped = max(c, vec3<f32>(0.0));
  let lo = clamped * 12.92;
  let hi = 1.055 * pow(clamped, vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(hi, lo, clamped <= vec3<f32>(0.0031308));
}

// --- end shared ---------------------------------------------------------

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

// --- shared: Rec.709 luminance on linear light (keep identical) ----------

fn luminance(c : vec3<f32>) -> f32 {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

// --- end shared ---------------------------------------------------------

// One encoded value through the transfer.
//
// Linear interpolation between the two neighbouring table entries, because the
// table samples a curve that is already smooth: at 256 entries the largest gap
// a monotone cubic can leave between two codes is far below one 8-bit step, so
// interpolating linearly costs nothing visible and interpolating cubically
// would re-derive a curve the CPU already resolved.
fn transfer(value : f32) -> f32 {
  let p = clamp(value, 0.0, 1.0) * LUT_LAST_F;
  let base = floor(p);
  let i0 = u32(base);
  let i1 = min(i0 + 1u, LUT_LAST);
  return mix(lut[i0], lut[i1], p - base);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);
  let linear_rgb = texel.rgb;

  let y = luminance(linear_rgb);

  // One encode, one transfer, one decode whichever mode is on: luma mode sends
  // the grey carrying the pixel's own luminance through instead of the pixel,
  // so the two modes differ in what goes in and what comes out rather than in
  // how much arithmetic runs.
  let subject = select(linear_rgb, vec3<f32>(y), params.mode == MODE_LUMA);
  let encoded = linear_to_srgb(subject);
  let mapped = srgb_to_linear(vec3<f32>(
    transfer(encoded.r),
    transfer(encoded.g),
    transfer(encoded.b),
  ));

  var out_rgb = mapped;
  if (params.mode == MODE_LUMA && y > MIN_LUMINANCE) {
    // A scale on the linear triple, which moves tone and leaves chromaticity
    // exactly where it was. Re-mixing towards the mapped grey would desaturate
    // as well, which is what the per-channel mode already does for free.
    out_rgb = linear_rgb * (mapped.x / y);
  }

  // Alpha is carried through untouched: a transfer curve is a tone control, and
  // remapping alpha would be a compositing change under its name (F-IN-03).
  textureStore(dst, coord, vec4<f32>(out_rgb, texel.a));
}
