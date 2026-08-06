// F-GL-15 — Ghost / echo.
//
// The pixel plus N delayed copies of itself, each one step further along the
// offset vector and each `decay` times weaker than the one before. Written as a
// gather rather than a scatter: copy k of the image, displaced by k*offset,
// contributes to this pixel the texel at `p - k*offset`, so one invocation owns
// one output pixel and nothing needs atomics.
//
// Two combination modes, and they are genuinely different pictures rather than
// a control and its fallback:
//
//   average — weights are normalised, so a flat field keeps its own value and
//             the result reads as a smear or a multipath ghost.
//   add     — weights are not normalised, so the copies pile up and the image
//             blooms where they overlap. This is the analogue-broadcast ghost,
//             and it is the reason the working surface is float rather than
//             unorm: the sum is allowed past 1 and the quantizer downstream is
//             where it comes back.
//
// Samples that fall outside the frame contribute nothing and are also left out
// of the normalising total, so a ghost thins out at the edge it walks off
// instead of fading into a dark border that no copy ever wrote.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// Ordinals of the `mode` enum in ghost-echo.effect.ts.
const MODE_AVERAGE : u32 = 0u;
const MODE_ADD     : u32 = 1u;

// Offsets must match GHOST_ECHO_UNIFORMS in ghost-echo.effect.ts.
struct Params {
  width    : u32,   //  0
  height   : u32,   //  4
  copies   : u32,   //  8
  mode     : u32,   // 12
  offset_x : f32,   // 16
  offset_y : f32,   // 20
  decay    : f32,   // 24
  pad0     : f32,   // 28
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let w = i32(params.width);
  let h = i32(params.height);

  // The original always carries weight 1, so `decay` is purely the ratio
  // between successive copies and does not also dim the picture it started
  // from. That is what lets decay reach 1 and mean "every copy equally strong"
  // rather than "no image".
  var accum : vec4<f32> = textureLoad(src, coord, 0);
  var total : f32 = 1.0;
  var weight : f32 = 1.0;

  for (var k : u32 = 1u; k <= params.copies; k = k + 1u) {
    weight = weight * params.decay;
    let step = f32(k);

    // Rounded to whole texels. The alternative — a bilinear tap at the
    // fractional position — would soften every copy, and a ghost that is
    // blurrier than its original is a motion blur wearing the wrong name. The
    // cost is that an animated offset advances in 1px steps, which is what a
    // scan-line delay does anyway.
    //
    // Sampling *backwards* along the offset is what places copy k forwards: a
    // positive offset_x puts the ghosts to the right of the subject.
    let sx = coord.x - i32(round(params.offset_x * step));
    let sy = coord.y - i32(round(params.offset_y * step));

    if (sx >= 0 && sy >= 0 && sx < w && sy < h) {
      accum = accum + textureLoad(src, vec2<i32>(sx, sy), 0) * weight;
      total = total + weight;
    }
  }

  // `total` starts at 1 and only grows, so this division is never by zero
  // regardless of what decay or copies hold.
  let combined = select(accum, accum / total, params.mode == MODE_AVERAGE);

  // Colour is left where the sum put it; alpha is not. Unassociated coverage
  // above 1 is meaningless, and in add mode the accumulation would produce it
  // for every opaque pixel with an echo behind it.
  textureStore(
    dst,
    coord,
    vec4<f32>(combined.rgb, clamp(combined.a, 0.0, 1.0)),
  );
}
