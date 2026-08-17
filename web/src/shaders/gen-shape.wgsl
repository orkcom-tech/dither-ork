// F-GN-03 — Shape source.
//
// A generator: it binds no `input-color` and produces its picture from its
// parameters alone. See `web/src/types/document.ts` on the `source` slot for
// why that is a slot rather than a flag, and `web/src/gpu/compiler.ts`'s
// `validateSourceDeclaration` for the check that keeps this file and the
// descriptor from drifting apart.
//
// ## It is a distance field with a transfer on top
//
// The shape is evaluated as a signed distance (F-INF-01, `web/src/gpu/sdf.ts`)
// and the tone is a smoothstep across that distance. That is not decoration:
// it is what makes one `softness` control cover both looks people want from a
// shape source. At 1.5 texels the band is one pixel wide and the result is a
// crisp antialiased figure; at 300 texels the same expression is a soft glow in
// the shape of a star, because the tone is now ramping over 300 texels of real
// distance. A mask built from a boolean inside/outside test would need a second
// mechanism for the second look, and the two would disagree at the corners.
//
// The consequence worth knowing: the tone is 0.5 exactly on the boundary at
// every softness, so the shape's nominal size does not move as it is softened.
//
// ## Why the tone is display-referred and converted on the way out
//
// Everything between nodes is linear light. A generator is where a number
// becomes light, so it has to say which encoding its number is in, and the
// answer is the display-referred one: "half grey" from a shape source has to
// look like the half grey a user would pick in any other tool, and a ramp that
// is linear in the buffer reads as a ramp crushed into the shadows. So the
// field is computed as an encoded tone in [0, 1] and `srgb_to_linear` is
// applied once, immediately before the store. Same argument grain.wgsl makes
// for going the other way.
//
// ## Determinism
//
// Nothing here is stochastic — the picture is a closed-form function of the
// pixel coordinate and the parameters. There is no seed, no clock and no
// `normalized-time` in this file (F-AN-05).
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// Offsets must match GEN_SHAPE_UNIFORMS in web/src/effects/gen-shape.effect.ts.
struct Params {
  width      : u32,   //  0
  height     : u32,   //  4
  shape      : u32,   //  8
  sides      : u32,   // 12
  center_x   : f32,   // 16
  center_y   : f32,   // 20
  size       : f32,   // 24
  aspect     : f32,   // 28
  rotation   : f32,   // 32
  inner      : f32,   // 36
  softness   : f32,   // 40
  invert     : u32,   // 44
};

@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

// --- shared: analytic signed distance fields (keep identical across shaders) ---
// A signed distance is in texels and negative inside the shape. Every function
// below returns exactly that, so they are interchangeable at the call site and
// a shape can be added without touching anything that consumes one.

// Rotate a point by -turns, so a shape drawn in its own frame appears rotated
// by +turns on screen. Turns rather than radians: CONVENTIONS.md, and a
// parameter ramping 0 -> 1 lands where it started, which is what lets an
// animated spin close its loop.
fn sdf_unrotate(p : vec2<f32>, turns : f32) -> vec2<f32> {
  let a = -turns * 6.28318530717958647692;
  let c = cos(a);
  let s = sin(a);
  return vec2<f32>(p.x * c - p.y * s, p.x * s + p.y * c);
}

// Exact everywhere, inside and out.
fn sdf_circle(p : vec2<f32>, radius : f32) -> f32 {
  return length(p) - radius;
}

// Exact outside; inside it is the distance to the nearest edge, which is what
// erode wants and what a rounded corner needs. `half_size` is half the width
// and half the height, so a square is `vec2(r, r)`.
fn sdf_rectangle(p : vec2<f32>, half_size : vec2<f32>) -> f32 {
  let d = abs(p) - half_size;
  return length(max(d, vec2<f32>(0.0))) + min(max(d.x, d.y), 0.0);
}

// Regular n-gon of `sides` sides, `radius` measured to the *vertices* so that
// a polygon and a circle of the same radius touch.
//
// Folding the plane into one wedge and measuring the distance to that wedge's
// single edge is exact for a convex regular polygon and costs one `atan2`
// rather than a loop over the edges — which matters because this runs per
// pixel and `sides` is a parameter, so a loop would be a dynamically bounded
// one in a compute shader.
fn sdf_polygon(p : vec2<f32>, radius : f32, sides : f32) -> f32 {
  let n = max(sides, 3.0);
  let segment = 6.28318530717958647692 / n;
  // The apothem: the distance from the centre to the middle of an edge.
  let apothem = radius * cos(segment * 0.5);

  // atan2 is undefined at the origin, and the origin is inside every polygon
  // with a positive radius, so the answer there is the apothem outright.
  let r = length(p);
  if (r < 1e-6) {
    return -apothem;
  }

  // Fold into the wedge `[-segment/2, +segment/2]`, then measure along the
  // edge's normal.
  let angle = atan2(p.y, p.x);
  let folded = angle - segment * round(angle / segment);
  return r * cos(folded) - apothem;
}

// An `points`-pointed star. `radius` is to the outer points; `inner` is the
// fraction of it the inner vertices sit at, so 0.382 is the classic
// five-pointed star and 1 degenerates to the polygon.
//
// The same fold as `sdf_polygon`, but into a *half* wedge, mirrored — a star's
// wedge is not symmetric about its own bisector, it is symmetric about the line
// through one outer point. What is left is the distance to a single line
// segment from the outer vertex to the inner one, which is exact outside and a
// bound inside; the bound is conservative in the concave corners, and it is
// still the right sign everywhere, which is what a threshold on it needs.
fn sdf_star(p : vec2<f32>, radius : f32, points : f32, inner : f32) -> f32 {
  let n = max(points, 2.0);
  let segment = 6.28318530717958647692 / n;
  let r = length(p);
  if (r < 1e-6) {
    return -radius * clamp(inner, 0.0, 1.0);
  }

  let angle = atan2(p.y, p.x);
  // Fold to one wedge, then mirror to a half wedge: |folded| in [0, segment/2].
  let folded = abs(angle - segment * round(angle / segment));
  let q = vec2<f32>(r * cos(folded), r * sin(folded));

  // The segment from the outer vertex (on the +x axis) to the inner vertex at
  // half the wedge angle.
  let outer_v = vec2<f32>(radius, 0.0);
  let inner_r = radius * clamp(inner, 0.001, 1.0);
  let inner_v = vec2<f32>(inner_r * cos(segment * 0.5), inner_r * sin(segment * 0.5));

  let edge = inner_v - outer_v;
  let rel = q - outer_v;
  let t = clamp(dot(rel, edge) / max(dot(edge, edge), 1e-12), 0.0, 1.0);
  let distance_to_edge = length(rel - edge * t);

  // Sign from which side of the edge the point is on. The edge runs outward-to-
  // inward, so a point to its left is inside the star.
  let side = edge.x * rel.y - edge.y * rel.x;
  return select(distance_to_edge, -distance_to_edge, side > 0.0);
}

// One entry point over the ordinals, so a consumer switches once. The ordinals
// restate SDF_SHAPES in web/src/gpu/sdf.ts and are append-only.
const SDF_SHAPE_CIRCLE    : u32 = 0u;
const SDF_SHAPE_RECTANGLE : u32 = 1u;
const SDF_SHAPE_POLYGON   : u32 = 2u;
const SDF_SHAPE_STAR      : u32 = 3u;

fn sdf_shape(
  p          : vec2<f32>,
  shape      : u32,
  half_size  : vec2<f32>,
  sides      : f32,
  inner      : f32,
) -> f32 {
  switch (shape) {
    case SDF_SHAPE_CIRCLE: {
      return sdf_circle(p, half_size.x);
    }
    case SDF_SHAPE_RECTANGLE: {
      return sdf_rectangle(p, half_size);
    }
    case SDF_SHAPE_POLYGON: {
      return sdf_polygon(p, half_size.x, sides);
    }
    // WGSL requires a default arm. Written as the last real case rather than as
    // a catch-all: the packer refuses anything that is not a declared enum
    // value, so no other ordinal can arrive.
    default: {
      return sdf_star(p, half_size.x, sides, inner);
    }
  }
}

// The gradient of the field: a unit vector pointing away from the nearest
// boundary, which for an analytic field is just the normalised gradient of the
// distance. Central differences at one texel, because the closed forms above
// are cheap enough that four extra evaluations cost less than carrying an
// analytic derivative per shape — and because this is then identical to what a
// transform-produced field would have to do.
fn sdf_normal(
  p          : vec2<f32>,
  shape      : u32,
  half_size  : vec2<f32>,
  sides      : f32,
  inner      : f32,
) -> vec2<f32> {
  let e = vec2<f32>(1.0, 0.0);
  let dx = sdf_shape(p + e.xy, shape, half_size, sides, inner)
         - sdf_shape(p - e.xy, shape, half_size, sides, inner);
  let dy = sdf_shape(p + e.yx, shape, half_size, sides, inner)
         - sdf_shape(p - e.yx, shape, half_size, sides, inner);
  let g = vec2<f32>(dx, dy);
  let l = length(g);
  // At an exact local extremum the gradient vanishes and there is no nearest
  // boundary direction. Zero is the honest answer and is what a consumer must
  // check for; inventing a direction would put a wavefront somewhere arbitrary.
  return select(vec2<f32>(0.0), g / l, l > 1e-9);
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

// A zero-width smoothstep band is indeterminate in WGSL, and a zero softness is
// a legal parameter value meaning "as hard as the grid allows". A twentieth of
// a texel is below what any display can resolve and keeps the expression
// defined.
const MIN_SOFTNESS : f32 = 0.05;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));

  // The short side, so `size` means the same fraction of the picture whatever
  // the aspect ratio is: a circle at size 1 touches both short edges in a
  // portrait frame and in a landscape one. Measuring against the long side or
  // against the diagonal would make the same document a different picture on a
  // crop.
  let short_side = f32(min(params.width, params.height));
  let radius = params.size * short_side * 0.5;

  // Pixel centres, so the field is symmetric about the frame: with corner
  // coordinates a shape centred at 0.5 would sit half a texel off.
  let pixel = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);
  let centre = vec2<f32>(
    params.center_x * f32(params.width),
    params.center_y * f32(params.height),
  );

  // Un-rotated into the shape's own frame. The circle is invariant under this
  // and pays for it anyway; branching to skip two multiplies would cost more in
  // divergence than it saves.
  let p = sdf_unrotate(pixel - centre, params.rotation);

  // Aspect stretches the rectangle only, and that is a real limitation rather
  // than an oversight: scaling the coordinate for the radial shapes would turn
  // an exact distance into a scaled one, and every consumer of this field
  // measures in texels. The descriptor says so on the parameter.
  let half_size = vec2<f32>(radius * params.aspect, radius / params.aspect);

  let d = sdf_shape(p, params.shape, half_size, f32(params.sides), params.inner);

  // The transfer. 0.5 exactly on the boundary at every softness, so softening a
  // shape does not move it.
  let s = max(params.softness, MIN_SOFTNESS);
  var tone = 1.0 - smoothstep(-s * 0.5, s * 0.5, d);
  if (params.invert != 0u) {
    tone = 1.0 - tone;
  }

  // Display-referred to linear light, once, on the way out. Opaque: a generator
  // makes a picture, not a matte — a shape that wrote alpha would composite
  // against whatever the pool held rather than against the stack.
  textureStore(dst, coord, vec4<f32>(srgb_to_linear(vec3<f32>(tone)), 1.0));
}
