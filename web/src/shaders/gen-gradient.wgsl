// F-GN-02 — Gradient source.
//
// A generator: it binds no `input-color` and produces its picture from its
// parameters alone. See `web/src/types/document.ts` on the `source` slot.
//
// ## Three geometries, one ramp
//
// Linear, radial and conical differ only in how a pixel is turned into a
// position `t` along the ramp. Everything after that — the repeat, the mirror,
// the transfer curve, the encoding — is shared, which is why the three read as
// one effect with a mode rather than as three effects.
//
// ## The curve is the shaping control, and it is the existing one
//
// A gradient's interesting parameter is not its endpoints, it is what happens
// between them: a linear ramp, an ease, a hard step, a bounce. That is exactly
// what F-PP-05's transfer curve already is, and it already has an editor, a
// serialisation and a set of surprise archetypes. So the ramp is a `curve`
// parameter sampled into the same 256-entry LUT `curves.wgsl` reads, and the
// diagonal — the curve editor's default — is the plain linear ramp.
//
// ## Why the tone is display-referred and converted on the way out
//
// The same argument gen-shape.wgsl makes: a generator is where a number becomes
// light, and "a linear gradient" means one that *looks* linear. The ramp is
// computed as an encoded tone and `srgb_to_linear` is applied once, immediately
// before the store. A ramp written straight into the linear buffer would spend
// three quarters of its width in what reads as shadow.
//
// ## Determinism
//
// Closed form in the pixel coordinate. No seed, no clock, no `normalized-time`
// (F-AN-05).
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// Ordinals restate the `kind` enum's `values` list in
// web/src/effects/gen-gradient.effect.ts. Append-only: inserting one in the
// middle renumbers every saved document naming a later value.
const KIND_LINEAR  : u32 = 0u;
const KIND_RADIAL  : u32 = 1u;
const KIND_CONICAL : u32 = 2u;

const TAU : f32 = 6.28318530717958647692;

// The LUT's last index. Its length is CURVE_LUT_SIZE in
// web/src/effects/curves.effect.ts, which this effect reuses rather than
// declaring a second table format.
const LUT_LAST : u32 = 255u;
const LUT_LAST_F : f32 = 255.0;

// `extent` scales a divisor. The legal range starts above zero, so this only
// catches a malformed document — but a zero divisor paints the frame NaN, and
// NaN in a linear-light buffer survives every node after it.
const MIN_EXTENT : f32 = 1e-4;

// Offsets must match GEN_GRADIENT_UNIFORMS in
// web/src/effects/gen-gradient.effect.ts. The two pad members make the 48-byte
// size visible here rather than leaving it to WGSL's round-up rule.
struct Params {
  width      : u32,   //  0
  height     : u32,   //  4
  kind       : u32,   //  8
  repeats    : u32,   // 12
  center_x   : f32,   // 16
  center_y   : f32,   // 20
  angle      : f32,   // 24
  extent     : f32,   // 28
  mirror     : u32,   // 32
  invert     : u32,   // 36
  pad0       : u32,   // 40
  pad1       : u32,   // 44
};

@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;
// This node's own ramp, built from its `ramp` curve parameter. Read-only and
// rebuilt only when the control points move — see `InstanceDataBinding`.
@group(0) @binding(6) var<storage, read> lut : array<f32>;

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

// Linear interpolation between LUT entries, so a 256-entry table does not band
// across a gradient that may be two thousand pixels wide. This is the same
// lookup `curves.wgsl` performs, and deliberately so: the table format is
// shared, so the sampling of it has to be.
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

  // Pixel centres and the short side, for the reasons gen-shape.wgsl gives:
  // symmetry about the frame, and an `extent` that means the same fraction of
  // the picture whatever the aspect ratio.
  let pixel = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);
  let centre = vec2<f32>(
    params.center_x * f32(params.width),
    params.center_y * f32(params.height),
  );
  let p = pixel - centre;
  let span = max(params.extent, MIN_EXTENT) * f32(min(params.width, params.height));

  // `t` is the raw position along the ramp, before repeating. 0 is the start of
  // the ramp and 1 its end; outside that range is what the repeat rule below
  // decides about.
  var t : f32;
  switch (params.kind) {
    case KIND_LINEAR: {
      // Angle is in turns and 0 points right, so 0.25 runs the ramp downward,
      // matching the y-down texture space every other effect here works in.
      let a = params.angle * TAU;
      let dir = vec2<f32>(cos(a), sin(a));
      // Centred: the ramp's midpoint is at the centre, so moving the centre
      // slides the gradient rather than stretching it.
      t = 0.5 + dot(p, dir) / span;
    }
    case KIND_RADIAL: {
      // Distance from the centre. `span` is the radius at which the ramp
      // reaches its end, so extent 1 means the ramp completes at the short
      // edge.
      t = length(p) / span;
    }
    // WGSL requires a default arm. Written as the last real case rather than as
    // a catch-all: the packer refuses anything that is not a declared enum
    // value, so no other ordinal can arrive.
    default: {
      // Angle around the centre, one full sweep per turn. `atan2` is undefined
      // at the origin; a single pixel there takes the sweep's start, which is
      // the limit from every direction the ramp is continuous in.
      let a = select(atan2(p.y, p.x), 0.0, dot(p, p) < 1e-12);
      t = fract(a / TAU - params.angle + 1.0);
    }
  }

  // The repeat rule, stated rather than inherited from `fract`:
  //
  // - one repeat clamps at both ends, which is what an ordinary gradient does
  //   and what stops a linear ramp from wrapping into a hard seam at the frame
  //   edge;
  // - more than one tiles, and `mirror` makes the tiling ping-pong so the tiles
  //   join continuously instead of cutting from white back to black.
  let n = f32(max(params.repeats, 1u));
  var u : f32;
  if (params.repeats <= 1u) {
    u = clamp(t, 0.0, 1.0);
  } else if (params.mirror != 0u) {
    // Triangle wave in [0, 1] with period 2 in `t * n`.
    u = abs(fract(t * n * 0.5) * 2.0 - 1.0);
  } else {
    u = fract(t * n);
  }

  var tone = transfer(u);
  if (params.invert != 0u) {
    tone = 1.0 - tone;
  }

  // Display-referred to linear light, once, on the way out. Opaque for the same
  // reason gen-shape is: a generator makes a picture, not a matte.
  textureStore(dst, coord, vec4<f32>(srgb_to_linear(vec3<f32>(tone)), 1.0));
}
