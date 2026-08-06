// F-GL-14 — Channel swap.
//
// Each output channel names the input channel it is read from, so any of the
// 24 RGBA permutations is expressible, and so are the non-bijective maps that
// duplicate one channel across several outputs (r->r, r->g, r->b is a
// desaturate-to-red). Four independent choices is the smallest description that
// covers "arbitrary permutation" without a permutation table the UI would have
// to render as 24 opaque options.
//
// The swap happens in LINEAR LIGHT, because that is the only thing in the
// buffer. It is worth stating that this is a different picture from swapping
// sRGB bytes: linear R and B carry the same numbers a display would show only
// after the transfer function is reapplied, so a linear swap of a mid-grey is
// still grey but a linear swap of a saturated colour lands somewhere a byte
// swap would not. Converting to sRGB, swapping, and converting back would be a
// second colour model in a pipeline that has one.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// Ordinals of the `source` enum in channel-swap.effect.ts. The packer resolves
// an enum parameter to its position in the descriptor's `values` list, so these
// four numbers and that list are the same fact written twice.
const SOURCE_R : u32 = 0u;
const SOURCE_G : u32 = 1u;
const SOURCE_B : u32 = 2u;
const SOURCE_A : u32 = 3u;

// Offsets must match CHANNEL_SWAP_UNIFORMS in channel-swap.effect.ts. The two
// pad members make the 32-byte size visible here rather than leaving it to
// WGSL's round-up rule.
struct Params {
  width    : u32,   //  0
  height   : u32,   //  4
  source_r : u32,   //  8
  source_g : u32,   // 12
  source_b : u32,   // 16
  source_a : u32,   // 20
  pad0     : u32,   // 24
  pad1     : u32,   // 28
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

// The `default` arm is SOURCE_A rather than a catch-all: the enum declares
// exactly four values and the packer refuses anything that is not one of them,
// so 3 is the only ordinal that can reach it. WGSL requires the clause to
// exist; it is not a fallback for a value that could actually occur.
fn pick(texel : vec4<f32>, source : u32) -> f32 {
  switch (source) {
    case SOURCE_R: {
      return texel.r;
    }
    case SOURCE_G: {
      return texel.g;
    }
    case SOURCE_B: {
      return texel.b;
    }
    default: {
      return texel.a;
    }
  }
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);

  let out_rgb = vec3<f32>(
    pick(texel, params.source_r),
    pick(texel, params.source_g),
    pick(texel, params.source_b),
  );

  // Alpha is the one channel that is clamped. Colour may legitimately leave
  // [0, 1] — the working surface is rgba16float and additive effects put it
  // there on purpose — but coverage outside the unit interval has no meaning,
  // and routing a bright linear channel into alpha would otherwise hand every
  // node downstream a number no compositor can use.
  let out_a = clamp(pick(texel, params.source_a), 0.0, 1.0);

  textureStore(dst, coord, vec4<f32>(out_rgb, out_a));
}
