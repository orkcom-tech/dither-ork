// F-GL-13 — Bit crush: per-channel bit-depth reduction and bit-plane
// corruption.
//
// **The crush happens in sRGB, not in linear light, and that is the whole
// effect.** Everywhere else in this application the answer is "linear light,
// always" — see docs/ARCHITECTURE.md — because averaging, blending and error
// diffusion are physical operations on light. Bit-depth reduction is not one of
// those. It is a statement about a *storage encoding*, and the encodings this
// effect imitates — a VGA DAC, an RGB565 framebuffer, an 8-bit PNG, an Amiga
// register — all store gamma-encoded values. A crush is meaningless without
// naming the encoding it crushes, so this one names sRGB.
//
// Crushing the linear values instead is the failure mode worth spelling out,
// because it looks plausible and is wrong: linear 1/8 is sRGB 0.38, so at three
// bits per channel the first step already covers everything from black to
// mid-grey. The entire shadow range collapses onto two levels, highlights get
// steps nobody can see, and the result looks nothing like any hardware that
// ever shipped.
//
// So: decode-free input (the working surface is already linear), encode to
// sRGB, quantize, corrupt bit planes of the quantized code, decode back. The
// buffer that leaves is linear light again, exactly as every node expects.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// Offsets must match BIT_CRUSH_UNIFORMS in
// web/src/effects/bit-crush.effect.ts. Every slot is a 4-byte scalar, so the
// block is exactly 32 bytes with nothing implicit in it.
struct Params {
  width          : u32,   //  0
  height         : u32,   //  4
  red_bits       : u32,   //  8
  green_bits     : u32,   // 12
  blue_bits      : u32,   // 16
  corrupt_chance : f32,   // 20
  corrupt_plane  : u32,   // 24
  seed           : u32,   // 28
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

// --- shared: integer hash (keep identical across shaders) ----------------
//
// PCG hash, from Jarzynski & Olano, "Hash Functions for GPU Rendering". A pure
// function of its argument: no clock, no frame counter, no state. That is what
// F-AN-05 requires and what makes the loop-seam test possible at all.

fn pcg_hash(input : u32) -> u32 {
  let state = input * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

// Nested rather than added, so hash2(a, b) and hash2(b, a) differ. An additive
// combiner collides on every pair with the same sum, which on a pixel grid is
// every anti-diagonal.
fn hash2(a : u32, b : u32) -> u32 {
  return pcg_hash(a ^ pcg_hash(b));
}

fn hash3(a : u32, b : u32, c : u32) -> u32 {
  return pcg_hash(a ^ pcg_hash(b ^ pcg_hash(c)));
}

// [0, 1). Twenty-four bits is exactly what an f32 mantissa carries, so no draw
// is quietly rounded onto its neighbour.
fn unit_float(h : u32) -> f32 {
  return f32(h >> 8u) * (1.0 / 16777216.0);
}

// --- end shared ----------------------------------------------------------

// --- shared: linear <-> sRGB transfer (keep identical across shaders) ----
//
// The same constants as `srgb_to_linear` / `linear_to_srgb` in
// core/crates/dither-core/src/color.rs and web/src/gpu/resources.ts. They have
// to be the same numbers, or a crush applied on the GPU and a value written by
// the CPU half of the same stack disagree at every code boundary.

fn linear_to_srgb(c : vec3<f32>) -> vec3<f32> {
  let clamped = max(c, vec3<f32>(0.0));
  let lo = clamped * 12.92;
  let hi = 1.055 * pow(clamped, vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(hi, lo, clamped <= vec3<f32>(0.0031308));
}

fn srgb_to_linear(c : vec3<f32>) -> vec3<f32> {
  let clamped = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
  let lo = clamped / 12.92;
  let hi = pow((clamped + 0.055) / 1.055, vec3<f32>(2.4));
  return select(hi, lo, clamped <= vec3<f32>(0.040448237));
}

// --- end shared ----------------------------------------------------------

// The plane is counted from the channel's most significant bit, so plane 0 is
// always the largest jump that channel can make and the control means the same
// thing whether the channel carries eight bits or two. Counting from the least
// significant bit instead would make the slider inert on a shallow channel,
// which is worse than making it coarse.
fn corrupt(code : u32, bits : u32, h : u32) -> u32 {
  if (unit_float(h) >= params.corrupt_chance) {
    return code;
  }
  let plane = min(params.corrupt_plane, bits - 1u);
  return code ^ (1u << ((bits - 1u) - plane));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);

  // The registry's legal range is 1..8; these guard a malformed document, where
  // a zero would underflow `bits - 1` into a shift of 4294967295.
  let bits = vec3<u32>(
    clamp(params.red_bits, 1u, 8u),
    clamp(params.green_bits, 1u, 8u),
    clamp(params.blue_bits, 1u, 8u),
  );
  let levels = vec3<f32>(
    f32((1u << bits.x) - 1u),
    f32((1u << bits.y) - 1u),
    f32((1u << bits.z) - 1u),
  );

  // Clamped to the encodable range on the way in. A working buffer may hold
  // values above 1 — rgba16float has the headroom and an earlier node may have
  // used it — and a code space has no room for them, exactly as the framebuffer
  // this imitates has none.
  let encoded = clamp(linear_to_srgb(texel.rgb), vec3<f32>(0.0), vec3<f32>(1.0));
  var code = vec3<u32>(
    u32(round(encoded.x * levels.x)),
    u32(round(encoded.y * levels.y)),
    u32(round(encoded.z * levels.z)),
  );

  // One draw per pixel per channel. Corrupting all three together would produce
  // grey speckle; corrupting them independently produces the coloured confetti
  // that bit-plane damage actually looks like.
  let h = hash3(gid.x, gid.y, params.seed);
  code = vec3<u32>(
    corrupt(code.x, bits.x, pcg_hash(h ^ 0u)),
    corrupt(code.y, bits.y, pcg_hash(h ^ 1u)),
    corrupt(code.z, bits.z, pcg_hash(h ^ 2u)),
  );

  let restored = vec3<f32>(
    f32(code.x) / levels.x,
    f32(code.y) / levels.y,
    f32(code.z) / levels.z,
  );

  // Alpha is carried through untouched: it is not a colour channel and it is
  // never composited onto white anywhere in the stack (F-IN-03).
  textureStore(dst, coord, vec4<f32>(srgb_to_linear(restored), texel.a));
}
