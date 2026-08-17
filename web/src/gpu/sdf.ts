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
 * ## Two producers, and both are built
 *
 * A field can come from two places, and they are genuinely different problems:
 *
 * The transform's own two-line summary, because it is the part a reader has to
 * trust: **smooth the mask, seed its boundary, flood, read.** The smoothing is
 * what makes "the subject" a shape rather than a threshold, and it is stated
 * first because leaving it out is the difference between a wave field and
 * confetti — measured, not assumed.
 *
 * 1. **Analytic** — the shape is described by parameters, so the distance is a
 *    closed-form function of the pixel coordinate. Exact at every pixel, free
 *    of resolution artefacts, no extra passes. This is what `gen-shape` uses:
 *    {@link SDF_WGSL} below.
 * 2. **From the picture** — the shape is wherever a *subject mask* changes
 *    value, so the distance has to be **transformed** out of a raster. That is
 *    {@link SDF_TRANSFORM_WGSL} and {@link sdfTransformPasses}: a jump flood,
 *    which is what F-INF-01 names, over two ping-ponged scratch **buffers**.
 *
 * The earlier note here said the transform "needs a scratch surface the pass
 * vocabulary does not have a role for — `ScratchSize` is a buffer, and this
 * wants a texture". **That was wrong, and it is what kept the half unbuilt.** A
 * jump flood carries one packed seed *coordinate* per texel, not a colour; a
 * `u32` per texel in a storage buffer holds it exactly, with no format, no
 * filtering and no ping-pong of textures the scheduler would have to know
 * about. The role that was missing was never a texture — it was writing down
 * that the seed is an integer.
 *
 * The two producers agree on the value and on its gradient, so a consumer
 * written against one reads the other correctly. That agreement is checked in
 * `sdf.test.ts` at the level a text diff can reach, and stated at
 * `sdf_field` — the sign convention is the part that is easy to get backwards
 * and impossible to notice.
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
 * - **How a shader gets one.** By copying {@link SDF_WGSL} (analytic) or
 *   {@link SDF_TRANSFORM_WGSL} (from the picture) verbatim. WGSL here is
 *   complete and constant — no includes, no runtime assembly, see
 *   `shaders/CONVENTIONS.md` — so "shared" means *one canonical text that
 *   copies are mechanically diffed against*, which is what `sdf.test.ts` does
 *   for every shader carrying either fence. That is the same arrangement the
 *   OKLab block and the seeded-hash block already have, with the diff automated
 *   instead of left to a reader.
 *
 * A node that *renders* a field as a picture — the debug view, or a field fed
 * to a dither — has to map texels onto a tone, and that is the consumer's
 * decision rather than the field's: `gen-shape` does it with an explicit
 * softness in texels, which is the same number an outline width would be.
 *
 * {@link SDF_CHANNEL_LAYOUT} still describes carrying a field *between nodes*
 * and nothing in the catalogue does that yet: `gen-shape` renders a tone, and
 * the transform's consumer (`wave-field`) reads the field inside its own pass
 * chain, where it is a scratch buffer rather than a colour surface. The layout
 * is what a future field-producing node would write, and it is the reason the
 * transform's gradient is defined the way it is rather than the other way up.
 */

import type {
  ComputePass,
  PassBinding,
  UniformField,
  UniformLayout,
} from "../types/gpu";

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

// --- the transform half: a field out of the picture ----------------------
//
// Everything above describes a shape somebody typed the parameters of.
// Everything below describes one that is *in the photograph*, which is the half
// F-PT-10 needs and the half that was recorded as unbuilt. The two halves meet
// at exactly one place — the value and its gradient, defined identically — and
// nothing else about them is alike.

/**
 * Where the subject mask comes from.
 *
 * **The source is a parameter, not an assumption**, which is F-INF-01's own
 * wording and the thing that stops "the subject" from silently meaning
 * "whatever is bright". A consumer builds its `EnumParam` from this list, so
 * the descriptor and the shader's `const` block cannot number them differently.
 *
 * **Append-only**, like every enum that crosses into a shader.
 *
 * ## The index map is named by the requirement and is not here
 *
 * F-INF-01 names a third source — "a selection over the index map", which would
 * make *the subject is palette entries 2 and 5* exact and free, since the
 * pipeline already carries the map after any quantizing node. It is not
 * implemented and the reason is structural rather than effort:
 *
 * A pass may bind `input-index` only if its effect declares
 * `requiresIndexMap` (`gpu/compiler.ts`), and that declaration is not
 * per-parameter — it is a property of the whole effect, and `registry/stack.ts`
 * uses it to refuse the node anywhere no quantizer precedes it. So offering the
 * index source would make **every** consumer of this transform illegal in front
 * of a dither, including a wave field over an unquantized photograph, which is
 * the case the requirement was asked for. Two descriptors differing only in
 * that flag would be the alternative, and that is a catalogue decision rather
 * than a shader one.
 *
 * What that costs is real and is worth naming: with a luminance threshold, a
 * subject the same brightness as its background cannot be separated. Nothing
 * here guesses at one.
 */
export const SDF_MASK_SOURCES = ["luminance", "alpha"] as const;

export type SdfMaskSource = (typeof SDF_MASK_SOURCES)[number];

/** Ordinal of a mask source, as the shader reads it. */
export function sdfMaskSourceOrdinal(source: SdfMaskSource): number {
  return SDF_MASK_SOURCES.indexOf(source);
}

/**
 * How many jump-flood passes the transform runs.
 *
 * A jump flood needs its step to start at about half the longest side and halve
 * to 1, so the pass count is log₂(extent) — and a pass list is **static**
 * (`GpuEffectSource.build` is handed a threshold matrix or nothing, never an
 * extent), so the count has to cover the largest extent this build can reach
 * rather than the one in front of it.
 *
 * The step is therefore **not baked into the pass**. Each pass knows only its
 * level `L` and computes `max(longest_side >> (L + 1), 1)` from the uniform
 * extent, which has two consequences worth having:
 *
 * - **No pass is ever wasted.** Baking `2048, 1024, …` in would make the first
 *   four passes no-ops on a 1600px preview — a full-frame read and write each,
 *   copying a buffer to say nothing.
 * - **Levels past log₂(extent) are step-1 passes**, which is *JFA+1*: extra
 *   refinement rounds that only reduce the algorithm's error.
 *
 * 15 covers 32768 texels, comfortably past `MAX_SOURCE_DIMENSION` (8192) and
 * past what `nn-upscale` can multiply it to before `maxTextureDimension2D`
 * refuses the surface outright.
 *
 * **It must stay odd.** Pass `i` reads buffer A and writes B when `i` is even,
 * so an odd count always leaves the answer in B — which is the buffer
 * `sdf_field` reads. {@link sdfTransformPasses} asserts it rather than trusting
 * this comment.
 */
export const SDF_JFA_LEVELS = 15;

/**
 * What the transform is, and what it costs — stated because it is approximate
 * and the approximation must not be discovered in a picture.
 *
 * A jump flood is **not exact**. Its error is a small number of texels taking a
 * seed that is not quite their nearest, always by a distance far below the
 * texel spacing that produced it; on a real photograph's mask it is invisible
 * and it is what every GPU distance field in production use does. The exact
 * alternative is a Felzenszwalb envelope scan per axis — two passes instead of
 * fifteen, exact everywhere — and it is not what F-INF-01 names, so it is not
 * what is built. If the error ever shows, that is the swap to make, and the
 * consumers do not change: they read `sdf_field`.
 *
 * The error is **deterministic**. Every pass reads one buffer and writes the
 * other, so no invocation observes another's write and the result is a pure
 * function of the input at every extent (F-AN-05, and the two-worker
 * determinism test).
 */
export const SDF_TRANSFORM_IS_APPROXIMATE = true;

/**
 * Binding numbers the shared transform block declares.
 *
 * `shaders/CONVENTIONS.md` fixes 0–5 by role and leaves "6…" to the effect. The
 * transform claims **6 and 7** in every carrier, so a shader that also needs
 * scratch of its own starts at 8. Stated as data because the block's WGSL
 * hard-codes them and a carrier that numbered its own buffers 6 and 7 would
 * collide silently — the bind group layout would be built from the descriptor
 * and the shader would read the wrong buffer.
 */
export const SDF_TRANSFORM_BINDING = {
  /**
   * Ping-pong buffer A. Seeded by `sdf_seed`, read by even levels — and used
   * before any of that as the smoothing pass's row scratch, which is why the
   * smoothing costs one buffer rather than two.
   */
  seedA: 6,
  /** Ping-pong buffer B. Holds the answer, which is why `sdf_field` reads it. */
  seedB: 7,
  /** The smoothed mask value, one f32 per texel. Read by `sdf_subject`. */
  mask: 8,
} as const;

/** Scratch slot names, so a carrier cannot collide with them. */
export const SDF_TRANSFORM_SLOT = {
  seedA: "sdf-seed-a",
  seedB: "sdf-seed-b",
  mask: "sdf-mask",
} as const;

/**
 * Bytes per texel in one seed buffer.
 *
 * One `u32`, holding the seed's x in the low 16 bits and its y in the high 16.
 * Sixteen bits per axis is exact to 65535, which is eight times
 * `MAX_SOURCE_DIMENSION` and past `maxTextureDimension2D` on every adapter this
 * build runs on — so the pack never has to be checked at runtime, and the
 * ping-pong costs 4 bytes a texel rather than the 8 a `vec2<u32>` would.
 */
export const SDF_SEED_BYTES_PER_PIXEL = 4;

/**
 * Fence name for the transform block, as it appears in a shader.
 *
 * Distinct from {@link SDF_FENCE_OPEN}: a shader may carry either block, both,
 * or neither, and `sdf.test.ts` diffs each against its own canonical text.
 */
export const SDF_TRANSFORM_FENCE_OPEN =
  "// --- shared: signed distance transform of the picture (keep identical across shaders) ---";
export const SDF_TRANSFORM_FENCE_CLOSE =
  "// --- end shared ---------------------------------------------------------";

/**
 * Uniform fields the transform block reads out of the carrier's `Params`.
 *
 * The block is pasted into a shader that has its own uniform struct, and it
 * refers to `params.sdf_source`, `params.sdf_threshold`, `params.sdf_invert` and
 * `params.sdf_smooth` by name. Those four offsets are produced here rather than
 * written out in each carrier so that the block and the layout cannot disagree
 * about where the threshold is — which is a wrong-looking picture and no error
 * anywhere (`shaders/CONVENTIONS.md`, "Uniforms").
 *
 * Four 4-byte scalars in a run, so the caller needs only a 4-byte-aligned
 * offset and gets no implicit padding.
 *
 * `params.width` and `params.height` are read too, and are not listed: every
 * shader in the catalogue already declares them at offsets 0 and 4.
 */
export function sdfTransformUniformFields(
  baseOffset: number,
  keys: {
    readonly source: string;
    readonly threshold: string;
    readonly invert: string;
    readonly smooth: string;
  },
): readonly UniformField[] {
  if (!Number.isInteger(baseOffset) || baseOffset < 0 || baseOffset % 4 !== 0) {
    throw new Error(
      `sdfTransformUniformFields: baseOffset ${baseOffset} must be a non-negative multiple of 4`,
    );
  }
  return [
    { source: { kind: "param", key: keys.source }, type: "u32", offset: baseOffset },
    { source: { kind: "param", key: keys.threshold }, type: "f32", offset: baseOffset + 4 },
    { source: { kind: "param", key: keys.invert }, type: "u32", offset: baseOffset + 8 },
    { source: { kind: "param", key: keys.smooth }, type: "f32", offset: baseOffset + 12 },
  ];
}

/** Bytes {@link sdfTransformUniformFields} occupies. */
export const SDF_TRANSFORM_UNIFORM_BYTES = 16;

/**
 * The ceiling on the mask's smoothing radius, in texels.
 *
 * **A correctness bound, not a taste one.** The smoothing passes carry a running
 * sum over a window of `2r + 1` samples in `f32`; capping the window at 65 keeps
 * that sum small enough that the add-and-subtract walk along a 4096-texel line
 * stays exact to well under one part in a thousand, which is far below anything
 * a threshold can see.
 */
export const SDF_MASK_SMOOTH_MAX = 32;

/**
 * The two ping-pong bindings, for a carrier's binding list.
 *
 * Both are `read-write` in every pass even though each pass only writes one of
 * them: one WGSL file per effect means one declaration of each variable, and a
 * shader's access mode has to match the bind group layout's buffer type in
 * every pass that uses it. Same reason `epsilon-glow`'s stash is.
 */
export const SDF_TRANSFORM_BINDINGS: readonly PassBinding[] = [
  {
    role: "scratch",
    binding: SDF_TRANSFORM_BINDING.seedA,
    slot: SDF_TRANSFORM_SLOT.seedA,
    access: "read-write",
    size: { kind: "per-pixel", bytesPerPixel: SDF_SEED_BYTES_PER_PIXEL },
  },
  {
    role: "scratch",
    binding: SDF_TRANSFORM_BINDING.seedB,
    slot: SDF_TRANSFORM_SLOT.seedB,
    access: "read-write",
    size: { kind: "per-pixel", bytesPerPixel: SDF_SEED_BYTES_PER_PIXEL },
  },
  {
    role: "scratch",
    binding: SDF_TRANSFORM_BINDING.mask,
    slot: SDF_TRANSFORM_SLOT.mask,
    access: "read-write",
    size: { kind: "per-pixel", bytesPerPixel: 4 },
  },
];

/** Entry points the smoothing pair declares. */
export const SDF_SMOOTH_ENTRY_POINTS = ["sdf_smooth_h", "sdf_smooth_v"] as const;

/** Entry point name for one jump-flood level, as the shared block declares it. */
export function sdfJfaEntryPoint(level: number): string {
  return `sdf_jfa_${String(level).padStart(2, "0")}`;
}

/** Entry point that seeds the boundary. */
export const SDF_SEED_ENTRY_POINT = "sdf_seed";

/**
 * The passes that build the field, for a consumer to put in front of its own.
 *
 * The consumer supplies its own WGSL (carrying the fenced block) and its own
 * uniform layout, because both belong to the effect: `shaders/CONVENTIONS.md`
 * keeps one file per effect and one uniform struct per file. What this builds
 * is the *schedule* — a seed pass and {@link SDF_JFA_LEVELS} flood passes, in
 * the order and with the buffer parity that leave the answer where `sdf_field`
 * looks for it.
 *
 * The ids are prefixed with the effect, because `ComputePass.id` keys the
 * shader module cache across the whole GPU layer. Two consumers therefore
 * compile the same block twice; that is the cost of "no runtime assembly" and
 * it is paid once per effect at startup, not per frame.
 *
 * **Exactly one pass reads the picture**: the first smoothing pass, which turns
 * the colour surface into a mask value per texel. Everything after it reads
 * buffers. None of them writes `output-color`, so the node's colour surface is
 * untouched and the consumer's own draw pass still reads the node's input —
 * which is how `gpu/compiler.ts`'s `validateSourceDeclaration` reads it too.
 *
 * ## Why smoothing is here and not left to a blur node in front
 *
 * A per-texel threshold on a photograph is not a subject; it is a few hundred
 * islands. Measured on a lit figure: the wave field's interior came out as
 * fragments that followed the jacket seams, because every seam was its own
 * closed boundary with its own field around it. **A subject mask has to be a
 * shape, and a shape has a scale.**
 *
 * Putting a `blur` node in front does not substitute. It changes the picture the
 * consumer *draws from* as well as the mask it *measures*, and for a consumer
 * that keeps its input — an outline, a glow — that is a different output rather
 * than the same output with a better mask. Radius 0 is the identity, so nothing
 * pays for it that does not ask.
 */
export function sdfTransformPasses(options: {
  /** Effect id, used to namespace the pass ids. */
  readonly effect: string;
  /** The carrier shader's full source. */
  readonly wgsl: string;
  /** The carrier's uniform layout — the same one every pass of it declares. */
  readonly uniforms: UniformLayout;
}): readonly ComputePass[] {
  // Odd, or the flood's last write lands in A and `sdf_field` reads a buffer
  // that is one round out of date — a field that is subtly wrong everywhere and
  // right nowhere, which is the worst kind.
  if (SDF_JFA_LEVELS % 2 === 0) {
    throw new Error(
      `SDF_JFA_LEVELS is ${SDF_JFA_LEVELS}, which is even; the flood would leave its answer in buffer A and sdf_field reads B`,
    );
  }

  const withPicture: readonly PassBinding[] = [
    { role: "input-color", binding: 0 },
    { role: "uniforms", binding: 5 },
    ...SDF_TRANSFORM_BINDINGS,
  ];
  const bufferOnly: readonly PassBinding[] = [
    { role: "uniforms", binding: 5 },
    ...SDF_TRANSFORM_BINDINGS,
  ];

  const passes: ComputePass[] = [
    {
      id: `${options.effect}/sdf-smooth-h`,
      label: `${options.effect} subject-mask smoothing, rows`,
      wgsl: options.wgsl,
      entryPoint: SDF_SMOOTH_ENTRY_POINTS[0],
      // One invocation per row, because a box average is a running sum along a
      // line: O(1) per texel at any radius, where a gather would be O(r).
      workgroupSize: [64, 1, 1],
      dispatch: { kind: "per-row" },
      access: "global",
      bindings: withPicture,
      uniforms: options.uniforms,
    },
    {
      id: `${options.effect}/sdf-smooth-v`,
      label: `${options.effect} subject-mask smoothing, columns`,
      wgsl: options.wgsl,
      entryPoint: SDF_SMOOTH_ENTRY_POINTS[1],
      workgroupSize: [64, 1, 1],
      dispatch: { kind: "per-column" },
      access: "global",
      bindings: bufferOnly,
      uniforms: options.uniforms,
    },
    {
      id: `${options.effect}/sdf-seed`,
      label: `${options.effect} subject-mask boundary seed`,
      wgsl: options.wgsl,
      entryPoint: SDF_SEED_ENTRY_POINT,
      workgroupSize: [8, 8, 1],
      dispatch: { kind: "per-pixel" },
      // Four neighbours of the smoothed mask, clamped: a bounded window, which
      // is what `neighbourhood` means and what stops it aliasing its input.
      access: "neighbourhood",
      bindings: bufferOnly,
      uniforms: options.uniforms,
    },
  ];

  for (let level = 0; level < SDF_JFA_LEVELS; level += 1) {
    passes.push({
      id: `${options.effect}/sdf-jfa-${String(level).padStart(2, "0")}`,
      label: `${options.effect} jump flood level ${level}`,
      wgsl: options.wgsl,
      entryPoint: sdfJfaEntryPoint(level),
      workgroupSize: [8, 8, 1],
      dispatch: { kind: "per-pixel" },
      // A flood step reads eight texels a whole step away, which is not a
      // bounded neighbourhood by any radius the scheduler could reason about.
      access: "global",
      // No `input-color`: a flood step reads the seed buffer and nothing else,
      // so binding 0 is absent from its layout and the entry point does not
      // statically use `src`. That is what keeps the node's colour surface
      // untouched across all fifteen of them.
      bindings: bufferOnly,
      uniforms: options.uniforms,
    });
  }

  return passes;
}

/**
 * The canonical text of the transform block.
 *
 * Pasted verbatim between {@link SDF_TRANSFORM_FENCE_OPEN} and
 * {@link SDF_TRANSFORM_FENCE_CLOSE} in every shader that needs a field out of
 * the picture, and diffed against by `sdf.test.ts`.
 *
 * **What a carrier owes it**, all four checked by that test:
 *
 * - `src` at binding 0 (`texture_2d<f32>`), because the mask is read from the
 *   picture.
 * - `params.width`, `params.height`, which every shader has, plus
 *   `params.sdf_source`, `params.sdf_threshold`, `params.sdf_invert` and
 *   `params.sdf_smooth` at the offsets {@link sdfTransformUniformFields}
 *   produces.
 * - The two seed buffers and the mask buffer at {@link SDF_TRANSFORM_BINDING}.
 * - The same uniform layout on **every** pass of the effect. A flood pass reads
 *   only `width`/`height`, but WebGPU sizes the bound uniform buffer against
 *   the whole `Params` struct, so a pass declaring a shorter layout fails
 *   validation rather than reading a short buffer.
 *
 * Function names are all `sdf_`-prefixed and deliberately do **not** reuse
 * `rec709_luminance` or `perceptual_lightness` from the `perceptual lightness`
 * block: a carrier may need both blocks, and two definitions of one name is a
 * compile error rather than a diff.
 */
export const SDF_TRANSFORM_WGSL = `
// A field transformed out of the picture (F-INF-01, the second producer).
//
// Four stages, and the third is fifteen passes:
//
//   1. sdf_smooth_*  — box-average the mask value along each axis, so that what
//                      is thresholded is a SHAPE and not one texel's brightness.
//                      Radius 0 is the identity.
//   2. sdf_seed      — mark the texels that sit ON the subject's boundary, and
//                      only those. One jump flood over the boundary gives the
//                      distance to it in both directions at once; flooding the
//                      subject and its complement separately would be two.
//   3. sdf_jfa_NN    — jump flood: each texel takes the best seed among the
//                      eight neighbours a step away, the step halving each
//                      pass. log2(extent) passes instead of a search per texel.
//   4. sdf_field     — read the answer: signed distance in texels, negative
//                      inside, plus the gradient of that signed distance.

// The seed of a texel that has not been reached. 0xFFFFFFFF rather than a
// sentinel coordinate, because every coordinate in range is a legal seed.
const SDF_NO_SEED : u32 = 0xFFFFFFFFu;

// What sdf_field returns where the picture has no boundary at all — a mask that
// is empty, or one that covers the frame. Finite and far past any real texel
// distance, so a consumer that forgets to check gets a wave it can see is wrong
// rather than a NaN that survives every node after it.
const SDF_FAR : f32 = 1.0e9;

// Ordinals restate SDF_MASK_SOURCES in web/src/gpu/sdf.ts. Append-only.
const SDF_MASK_LUMINANCE : u32 = 0u;
const SDF_MASK_ALPHA     : u32 = 1u;

fn sdf_pack_seed(p : vec2<i32>) -> u32 {
  return (u32(p.x) & 0xFFFFu) | ((u32(p.y) & 0xFFFFu) << 16u);
}

fn sdf_unpack_seed(s : u32) -> vec2<i32> {
  return vec2<i32>(i32(s & 0xFFFFu), i32((s >> 16u) & 0xFFFFu));
}

fn sdf_offset(p : vec2<i32>) -> u32 {
  return u32(p.y) * params.width + u32(p.x);
}

// Perceptual lightness, so the threshold slider means what the eye sees it
// mean: 0.5 in linear light is already a light grey, and a subject picked at
// "half brightness" would come out as the highlights alone. The cube root is
// the same curve web/src/gpu/resources.ts uses; it is spelled out here under an
// sdf_ name so a carrier may also hold the perceptual-lightness block.
fn sdf_lightness(c : vec3<f32>) -> f32 {
  let y = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return pow(max(y, 0.0), 1.0 / 3.0);
}

// The raw mask value at a texel, before smoothing and before the threshold.
// The whole of "what is the subject made of" is this function, and the source is
// a parameter rather than an assumption.
fn sdf_mask_value(p : vec2<i32>) -> f32 {
  let texel = textureLoad(src, p, 0);
  if (params.sdf_source == SDF_MASK_ALPHA) {
    return texel.a;
  }
  return sdf_lightness(texel.rgb);
}

// The smoothing radius in whole texels. 0 makes the pair below the identity, so
// a consumer that wants the raw threshold pays two buffer copies and nothing
// else.
fn sdf_smooth_radius() -> i32 {
  return i32(round(clamp(params.sdf_smooth, 0.0, 32.0)));
}

// Box average along the rows, into the seed buffer.
//
// **The mask is smoothed before it is thresholded, and that is what makes it a
// subject rather than a texture.** A per-texel threshold on a photograph is a
// few hundred islands — every seam, every highlight, its own closed boundary
// with its own field around it — and a wave field over that comes out as
// fragments. Averaging first says how big a thing has to be to count.
//
// A running sum along the line rather than a gather per texel: O(1) per texel at
// any radius, which is why this is a \`per-row\` dispatch with one invocation per
// line instead of a per-pixel pass with a loop in it. Edges are clamped, so a
// flat field stays flat.
//
// \`sdf_seed_a\` is the scratch here, bit for bit as an f32. It holds nothing yet
// — the flood does not start until \`sdf_seed\` — so the smoothing costs one
// buffer rather than two.
@compute @workgroup_size(64, 1, 1)
fn sdf_smooth_h(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.height) {
    return;
  }
  let y = i32(gid.x);
  let w = i32(params.width);
  let r = sdf_smooth_radius();
  let n = f32(2 * r + 1);

  var sum : f32 = 0.0;
  for (var k : i32 = -r; k <= r; k = k + 1) {
    sum = sum + sdf_mask_value(vec2<i32>(clamp(k, 0, w - 1), y));
  }
  sdf_seed_a[sdf_offset(vec2<i32>(0, y))] = bitcast<u32>(sum / n);

  for (var x : i32 = 1; x < w; x = x + 1) {
    sum = sum
        + sdf_mask_value(vec2<i32>(clamp(x + r, 0, w - 1), y))
        - sdf_mask_value(vec2<i32>(clamp(x - r - 1, 0, w - 1), y));
    sdf_seed_a[sdf_offset(vec2<i32>(x, y))] = bitcast<u32>(sum / n);
  }
}

// The other axis, out of the row scratch and into the mask buffer that survives
// the flood. Separable, so a radius of 32 costs two linear scans rather than a
// 65x65 gather.
@compute @workgroup_size(64, 1, 1)
fn sdf_smooth_v(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width) {
    return;
  }
  let x = i32(gid.x);
  let h = i32(params.height);
  let r = sdf_smooth_radius();
  let n = f32(2 * r + 1);

  var sum : f32 = 0.0;
  for (var k : i32 = -r; k <= r; k = k + 1) {
    sum = sum + bitcast<f32>(sdf_seed_a[sdf_offset(vec2<i32>(x, clamp(k, 0, h - 1)))]);
  }
  sdf_mask[sdf_offset(vec2<i32>(x, 0))] = sum / n;

  for (var y : i32 = 1; y < h; y = y + 1) {
    sum = sum
        + bitcast<f32>(sdf_seed_a[sdf_offset(vec2<i32>(x, clamp(y + r, 0, h - 1)))])
        - bitcast<f32>(sdf_seed_a[sdf_offset(vec2<i32>(x, clamp(y - r - 1, 0, h - 1)))]);
    sdf_mask[sdf_offset(vec2<i32>(x, y))] = sum / n;
  }
}

// Whether a texel belongs to the subject. Reads the SMOOTHED mask, so this is a
// question about a shape rather than about one texel's brightness.
fn sdf_subject(p : vec2<i32>) -> bool {
  let inside = sdf_mask[sdf_offset(p)] >= params.sdf_threshold;
  return select(inside, !inside, params.sdf_invert != 0u);
}

// Seed the boundary, and nothing else.
//
// A texel is a seed when it is in the subject and touches something that is
// not, or the reverse. Flooding from the boundary rather than from the subject
// is what makes ONE flood produce a SIGNED field: the distance is to the
// boundary from either side, and the sign is a local question sdf_subject
// answers at the reading texel.
//
// Neighbours are clamped to the frame rather than treated as background. A
// subject running off the edge of the picture has no boundary there — it
// continues past what was photographed — and seeding one would draw a
// wavefront along the frame's edge that nothing in the picture put there.
@compute @workgroup_size(8, 8, 1)
fn sdf_seed(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let p = vec2<i32>(i32(gid.x), i32(gid.y));
  let w = i32(params.width);
  let h = i32(params.height);

  let here = sdf_subject(p);
  let west  = sdf_subject(vec2<i32>(max(p.x - 1, 0), p.y));
  let east  = sdf_subject(vec2<i32>(min(p.x + 1, w - 1), p.y));
  let north = sdf_subject(vec2<i32>(p.x, max(p.y - 1, 0)));
  let south = sdf_subject(vec2<i32>(p.x, min(p.y + 1, h - 1)));

  var seed : u32 = SDF_NO_SEED;
  if (here != west || here != east || here != north || here != south) {
    seed = sdf_pack_seed(p);
  }
  sdf_seed_a[sdf_offset(p)] = seed;
}

// The step this level jumps, computed from the extent rather than baked in.
//
// Level 0 jumps half the longest side, and each level halves it. Deriving it
// here is what makes every pass do work at every resolution: a baked 2048 would
// be four full-frame copies before anything happened on a 1600px preview.
// Levels past log2(extent) clamp to 1, which is JFA+1 — extra refinement, never
// a no-op.
fn sdf_jfa_step(level : u32) -> i32 {
  let longest = max(i32(params.width), i32(params.height));
  return max(longest >> (level + 1u), 1);
}

// One flood step. \`from_a\` says which buffer holds the previous round; the
// caller alternates, and the two never alias.
fn sdf_jfa(p : vec2<i32>, level : u32, from_a : bool) {
  let w = i32(params.width);
  let h = i32(params.height);
  let step = sdf_jfa_step(level);

  var best : u32 = SDF_NO_SEED;
  var best_d : f32 = 3.0e38;

  for (var dy : i32 = -1; dy <= 1; dy = dy + 1) {
    for (var dx : i32 = -1; dx <= 1; dx = dx + 1) {
      let q = p + vec2<i32>(dx * step, dy * step);
      if (q.x < 0 || q.y < 0 || q.x >= w || q.y >= h) {
        continue;
      }
      var candidate : u32;
      if (from_a) {
        candidate = sdf_seed_a[sdf_offset(q)];
      } else {
        candidate = sdf_seed_b[sdf_offset(q)];
      }
      if (candidate == SDF_NO_SEED) {
        continue;
      }
      let delta = vec2<f32>(sdf_unpack_seed(candidate) - p);
      let d = dot(delta, delta);
      // Ties broken on the packed coordinate, so the answer does not depend on
      // the order the nine taps happen to be written in. Two texels equidistant
      // from one point is common on an axis-aligned mask edge.
      if (d < best_d || (d == best_d && candidate < best)) {
        best_d = d;
        best = candidate;
      }
    }
  }

  if (from_a) {
    sdf_seed_b[sdf_offset(p)] = best;
  } else {
    sdf_seed_a[sdf_offset(p)] = best;
  }
}

// The field at a texel, as F-INF-01 fixes it.
//
//   .x  signed distance to the nearest boundary, in working-resolution texels,
//       NEGATIVE INSIDE the subject.
//   .yz the gradient of that signed distance: a unit vector.
//
// **The gradient's sign is the part that is easy to get backwards.** Outside,
// distance grows as you move away from the boundary, so the gradient points
// away from the nearest boundary texel. Inside, the distance is negative and
// grows *towards* the boundary, so it is the same vector negated — and the
// result is that the gradient points out of the subject on both sides, exactly
// as sdf_normal's central difference does for an analytic shape. Consumers are
// written against one convention; two producers disagreeing about it is a
// wavefront that bends the wrong way and no error anywhere.
//
// Zero gradient is returned at a boundary texel itself and where the picture
// has no boundary at all. It is the honest answer — there is no direction to a
// boundary you are standing on, and none to one that does not exist — and it is
// the same answer, checked the same way, that sdf_normal returns at a local
// extremum.
fn sdf_field(p : vec2<i32>) -> vec3<f32> {
  let packed = sdf_seed_b[sdf_offset(p)];
  let sign_out = select(1.0, -1.0, sdf_subject(p));

  if (packed == SDF_NO_SEED) {
    return vec3<f32>(sign_out * SDF_FAR, 0.0, 0.0);
  }

  let delta = vec2<f32>(sdf_unpack_seed(packed) - p);
  let d = length(delta);
  if (d < 1e-6) {
    return vec3<f32>(0.0, 0.0, 0.0);
  }
  let gradient = delta * (-sign_out / d);
  return vec3<f32>(sign_out * d, gradient.x, gradient.y);
}

// Whether the field says anything at all here. A mask that caught everything or
// nothing has no boundary, and a consumer must take its no-obstacle branch
// rather than dividing by a distance of 1e9.
fn sdf_has_boundary(field : vec3<f32>) -> bool {
  return abs(field.x) < SDF_FAR;
}

// The fifteen flood levels. One entry point each, because the level and the
// buffer parity are the only things that differ and WGSL has no way to pass a
// constant into an entry point. Even levels read A and write B, so an odd
// count leaves the answer in B — which is what sdf_field reads and what
// sdfTransformPasses asserts.
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_00(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 0u, true);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_01(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 1u, false);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_02(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 2u, true);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_03(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 3u, false);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_04(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 4u, true);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_05(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 5u, false);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_06(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 6u, true);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_07(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 7u, false);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_08(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 8u, true);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_09(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 9u, false);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_10(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 10u, true);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_11(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 11u, false);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_12(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 12u, true);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_13(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 13u, false);
}
@compute @workgroup_size(8, 8, 1)
fn sdf_jfa_14(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  sdf_jfa(vec2<i32>(i32(gid.x), i32(gid.y)), 14u, true);
}
`.trim();
