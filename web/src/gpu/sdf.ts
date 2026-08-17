/**
 * Signed distance fields (F-INF-01) — the shared half.
 *
 * The spec files F-INF-01 as *infrastructure* rather than as an effect, because
 * four separate requirements want the same thing and each of them would
 * otherwise grow its own private copy: outline (F-SP-10) wants the distance to
 * a region boundary so a stroke can have a width in pixels; epsilon glow
 * (F-SP-01) wants it so the falloff is a function of distance rather than of a
 * blur radius; dilate/erode (F-SP-11) is a threshold on it by definition; and
 * wave field (F-PT-10) wants the distance *and its gradient* so a wavefront can
 * bend around the subject.
 *
 * ## What a signed distance field is here, exactly
 *
 * **A single f32 per pixel: the distance from that pixel's centre to the
 * nearest boundary of the shape, in working-resolution texels, negative inside
 * the shape and positive outside it.** Three parts of that sentence are load
 * bearing and each of them is a decision:
 *
 * - **In texels, not normalised.** A stroke is 2px wide, a glow reaches 30px. A
 *   field normalised to the frame would make every one of those numbers depend
 *   on the resolution, and F-UI-03 changes the resolution while the user drags
 *   — so a normalised field would make an outline thicken as the preview
 *   degraded. Texels are the unit the extent already carries.
 * - **Negative inside.** The sign convention every SDF paper and every shader
 *   library uses. Stated because the opposite convention is equally coherent
 *   and silently inverts every effect that reads it.
 * - **Distance to the *nearest* boundary, in both directions.** Not the
 *   unsigned distance to the shape, which loses the interior and makes erode
 *   inexpressible.
 *
 * ## Two producers, and only one of them is built
 *
 * A field can come from two places, and they are genuinely different problems:
 *
 * 1. **Analytic** — the shape is described by parameters, so the distance is a
 *    closed-form function of the pixel coordinate. Exact at every pixel, free
 *    of resolution artefacts, no extra passes. This is what `gen-shape` uses
 *    and it is what this module builds: {@link SDF_WGSL} below.
 * 2. **From the picture** — the shape is wherever the index map changes value,
 *    so the distance has to be *transformed* out of a raster. That is a jump
 *    flood (log₂ n ping-ponged passes over a two-channel seed buffer) or an
 *    exact Felzenszwalb pass per axis, and it needs a scratch surface the pass
 *    vocabulary does not have a role for yet — `ScratchSize` is a buffer, and
 *    this wants a texture.
 *
 * **The second is not built, and this file does not pretend otherwise.**
 * Outline and dilate/erode ship today reading the index map directly, which is
 * exact for a one-texel neighbourhood and is why they never needed a field;
 * what they would gain from one is a width in pixels rather than in taps, and
 * what F-PT-10 needs is the transform and nothing less. The interface below is
 * written so that when the transform is built, the consumers do not change:
 * they read a field, and where it came from is not their business.
 *
 * ## The interface, stated
 *
 * A consumer of a distance field needs three things and this module fixes all
 * three, so that an analytic producer and a transform producer are
 * interchangeable:
 *
 * - **The value.** One f32 in texels, sign as above.
 * - **How it is carried between nodes.** Not by a new surface kind. The
 *   pipeline already carries exactly two things between nodes — linear-light
 *   RGBA and the index map — and adding a third would touch the cache, the
 *   boundary crossings, the WASM surfaces and `.dork`. A field is carried in
 *   the ordinary colour buffer under {@link SDF_CHANNEL_LAYOUT}: R holds the
 *   signed distance, G and B hold the unit vector *away from* the nearest
 *   boundary (which is the gradient F-PT-10 needs and which an analytic
 *   producer gets for free), A holds 1. `rgba16float` carries ±65504 exactly
 *   enough for texel distances at any working extent this build allows.
 * - **How a shader gets one.** By copying {@link SDF_WGSL} verbatim. WGSL here
 *   is complete and constant — no includes, no runtime assembly, see
 *   `shaders/CONVENTIONS.md` — so "shared" means *one canonical text that
 *   copies are mechanically diffed against*, which is what `sdf.test.ts` does
 *   for every shader carrying the fence. That is the same arrangement the OKLab
 *   block and the seeded-hash block already have, with the diff automated
 *   instead of left to a reader.
 *
 * A node that *renders* a field as a picture — the debug view, or a field fed
 * to a dither — has to map texels onto a tone, and that is the consumer's
 * decision rather than the field's: `gen-shape` does it with an explicit
 * softness in texels, which is the same number an outline width would be.
 */

/**
 * Which channel of the colour buffer carries what, when the buffer holds a
 * distance field rather than a picture.
 *
 * Written down as data rather than as prose so a test can assert a shader's
 * `textureStore` order against it, and so a future transform pass and the
 * analytic pass here cannot disagree about which channel is which.
 */
export const SDF_CHANNEL_LAYOUT = {
  /** Signed distance in working-resolution texels. Negative inside. */
  distance: "r",
  /** x of the unit vector pointing away from the nearest boundary. */
  normalX: "g",
  /** y of the same vector, in texture space: +y is down. */
  normalY: "b",
  /** Always 1. A field is opaque; alpha is not a spare channel. */
  alpha: "a",
} as const;

/**
 * The analytic primitives, and their ordinals.
 *
 * **Append-only**, like every enum that crosses into a shader: the ordinal is
 * the position in this list, so inserting one in the middle renumbers every
 * saved document that names a later shape. `gen-shape.effect.ts` builds its
 * `EnumParam` from this list, so the descriptor and the shader's `const` block
 * cannot number them differently.
 */
export const SDF_SHAPES = ["circle", "rectangle", "polygon", "star"] as const;

export type SdfShape = (typeof SDF_SHAPES)[number];

/** Ordinal of a shape, as the shader reads it. */
export function sdfShapeOrdinal(shape: SdfShape): number {
  return SDF_SHAPES.indexOf(shape);
}

/**
 * Fence name for the shared block, as it appears in a shader.
 *
 * `sdf.test.ts` finds the block by these two lines and diffs what is between
 * them against {@link SDF_WGSL}.
 */
export const SDF_FENCE_OPEN =
  "// --- shared: analytic signed distance fields (keep identical across shaders) ---";
export const SDF_FENCE_CLOSE =
  "// --- end shared ---------------------------------------------------------";

/**
 * The canonical text of the shared block.
 *
 * **This string is not concatenated into a shader at runtime.** It is the
 * reference copy: every shader that needs these functions pastes the text
 * between the two fence lines, and the test diffs them. That keeps
 * `CONVENTIONS.md`'s two guarantees — a module compiled once and cached by
 * pass id, and a compilation error naming a line in a real file — while making
 * "keep identical across shaders" a check instead of a request.
 *
 * Every function takes and returns texels. `p` is the pixel centre relative to
 * the shape's centre, already un-rotated by the caller, so none of them knows
 * about rotation and all of them are even functions of the frame.
 */
export const SDF_WGSL = `
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
// erode wants and what a rounded corner needs. \`half_size\` is half the width
// and half the height, so a square is \`vec2(r, r)\`.
fn sdf_rectangle(p : vec2<f32>, half_size : vec2<f32>) -> f32 {
  let d = abs(p) - half_size;
  return length(max(d, vec2<f32>(0.0))) + min(max(d.x, d.y), 0.0);
}

// Regular n-gon of \`sides\` sides, \`radius\` measured to the *vertices* so that
// a polygon and a circle of the same radius touch.
//
// Folding the plane into one wedge and measuring the distance to that wedge's
// single edge is exact for a convex regular polygon and costs one \`atan2\`
// rather than a loop over the edges — which matters because this runs per
// pixel and \`sides\` is a parameter, so a loop would be a dynamically bounded
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

  // Fold into the wedge \`[-segment/2, +segment/2]\`, then measure along the
  // edge's normal.
  let angle = atan2(p.y, p.x);
  let folded = angle - segment * round(angle / segment);
  return r * cos(folded) - apothem;
}

// An \`points\`-pointed star. \`radius\` is to the outer points; \`inner\` is the
// fraction of it the inner vertices sit at, so 0.382 is the classic
// five-pointed star and 1 degenerates to the polygon.
//
// The same fold as \`sdf_polygon\`, but into a *half* wedge, mirrored — a star's
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
`.trim();
