// F-SP-12 — Vignette.
//
// A radial falloff that attenuates the frame towards its edges. Three controls,
// exactly as the requirement states them: where the falloff starts (radius), how
// long it takes (softness), and how dark it gets (strength).
//
// ## Why it multiplies linear light
//
// A lens vignette is lost light — the corners of the frame receive fewer photons
// than the centre, by roughly cos^4 of the field angle — so the operation that
// reproduces it is a multiplication of radiance, and radiance is what the
// working buffer holds. Doing the same multiply on an sRGB-encoded value would
// darken the midtones far more than the shadows and produce the muddy grey ring
// that gives cheap vignettes away.
//
// ## Why the falloff is an ellipse and not a circle
//
// The radius is measured in units of the half-frame *per axis*, so the contour
// at a given radius is an ellipse with the frame's own aspect ratio: the
// darkening reaches the middle of the left edge and the middle of the top edge
// at the same setting. A circular contour measured in pixels would put a
// panorama's entire short axis inside the falloff before the long axis had
// started, which reads as a horizontal gradient rather than as a vignette.
//
// At radius 1 the contour touches the edge midpoints; the corners sit at
// sqrt(2), which is why the legal range goes past 1.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// The registry's legal range starts above zero, so this clamp only catches a
// malformed document — but `smoothstep` with edge0 >= edge1 is indeterminate in
// WGSL, and an indeterminate result here is a frame of driver-dependent garbage
// rather than an error anywhere.
const MIN_SOFTNESS : f32 = 0.001;

// Offsets must match VIGNETTE_UNIFORMS in web/src/effects/vignette.effect.ts.
// The three pad members make the 32-byte size visible here rather than leaving
// it to WGSL's round-up rule.
struct Params {
  width    : u32,   //  0
  height   : u32,   //  4
  radius   : f32,   //  8
  softness : f32,   // 12
  strength : f32,   // 16
  pad0     : f32,   // 20
  pad1     : f32,   // 24
  pad2     : f32,   // 28
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
  let texel = textureLoad(src, coord, 0);

  let half_extent = vec2<f32>(f32(params.width), f32(params.height)) * 0.5;
  let pixel = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);
  // -1 to 1 across each axis, so `r` is 0 at the centre, 1 at an edge midpoint
  // and sqrt(2) in the corners regardless of the frame's aspect ratio.
  let offset = (pixel - half_extent) / half_extent;
  let r = length(offset);

  let softness = max(params.softness, MIN_SOFTNESS);
  // 1 inside the radius, falling to 0 by radius + softness. Hermite rather than
  // linear so there is no visible crease at the point the falloff begins —
  // which on a flat sky is the one artefact a vignette cannot hide.
  let mask = 1.0 - smoothstep(params.radius, params.radius + softness, r);

  // strength 0 leaves the frame alone; 1 takes the far edge to black. Written as
  // a mix rather than as `1 - strength * (1 - mask)` so the identity at 0 is
  // exact rather than a subtraction that happens to cancel.
  let attenuation = mix(1.0, mask, params.strength);

  // Alpha is carried through untouched — a vignette is lost light, not lost
  // coverage, and alpha is never composited anywhere in the stack (F-IN-03).
  textureStore(dst, coord, vec4<f32>(texel.rgb * attenuation, texel.a));
}
