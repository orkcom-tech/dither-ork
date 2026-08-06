// F-GL-08 — Scanlines.
//
// A CRT does not illuminate the gaps between its scan lines, so the picture is
// a series of lit bands separated by darker ones. The effect is a per-line
// attenuation and nothing more: no blur, no bloom, no colour shift. Those are
// other requirements (F-SP-01, F-GL-09) and folding them in here would make
// three effects that cannot be used apart.
//
// **The attenuation is a multiply in linear light**, which is what a dimmer
// physically is. Doing it on encoded values instead would darken the midtones
// far more than the highlights and the lines would read as grey haze rather
// than as absent light.
//
// **The pattern is sampled at the line index, not at the pixel centre.**
// Scanlines are a property of the raster: line n is lit or it is not. Sampling
// a continuous field at y + 0.5 looks more principled and is worse — at the
// canonical pitch of 2 the two phases land at 0.25 and 0.75, which are
// equidistant from any band centre, so every line gets the same attenuation and
// the whole effect collapses to a flat multiply. Indexing by the line makes
// pitch 2 alternate, which is the entire point of pitch 2.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// A pitch below one line cannot be represented on a raster; the registry's
// legal range starts at 1, so this clamp only catches a malformed document.
// Zero would divide the whole frame to NaN, and NaN in a linear-light buffer
// survives every node after it.
const MIN_PITCH : f32 = 1.0;

// Minimum half-width of the smoothstep transition, in cycles. `softness` = 0
// means a hard edge, but smoothstep with equal bounds is undefined, so the
// hard edge is a transition one thousandth of a cycle wide instead.
const MIN_EDGE : f32 = 0.0009765625;

// Offsets must match SCANLINES_UNIFORMS in web/src/effects/scanlines.effect.ts.
// pad0 makes the 32-byte size visible here rather than leaving it to WGSL's
// round-up rule.
struct Params {
  width     : u32,   //  0
  height    : u32,   //  4
  pitch     : f32,   //  8
  phase     : f32,   // 12
  strength  : f32,   // 16
  thickness : f32,   // 20
  softness  : f32,   // 24
  pad0      : f32,   // 28
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

// Coverage of the dark band at raster line `line`, in [0, 1].
//
// The band is centred on the half-cycle so that `phase` = 0 leaves line 0 fully
// lit — a pattern whose zero phase starts dark makes every offset read one line
// off from what the number says.
//
// `thickness` is the band's share of one cycle and `softness` is the width of
// its edge as a fraction of its own half-width: at 0 the band is a hard bar, at
// 1 the transition spans the band and the profile is a smooth hump. Both
// endpoints are usable looks, which is why the control is not a boolean.
fn line_mask(line : f32) -> f32 {
  let cycle = line / max(params.pitch, MIN_PITCH) + params.phase;
  // fract is x - floor(x), so a negative phase wraps rather than reflecting.
  let f = fract(cycle);
  let centred = abs(f - 0.5);

  let half_band = clamp(params.thickness, 0.0, 1.0) * 0.5;
  let edge = max(clamp(params.softness, 0.0, 1.0) * half_band, MIN_EDGE);

  return 1.0 - smoothstep(half_band - edge, half_band + edge, centred);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);

  let mask = line_mask(f32(gid.y));
  let attenuation = 1.0 - clamp(params.strength, 0.0, 1.0) * mask;

  // Alpha is carried through untouched. A scanline removes light, not coverage,
  // and nothing in the stack composites onto white (F-IN-03).
  textureStore(dst, coord, vec4<f32>(texel.rgb * attenuation, texel.a));
}
