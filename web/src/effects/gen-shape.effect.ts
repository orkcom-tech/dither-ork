/**
 * Shape source (F-GN-03).
 *
 * A circle, rectangle, regular polygon or star, drawn from a signed distance
 * field. **It takes no image**: it sits in the `source` slot and its pass binds
 * no `input-color`, so a document containing one needs no photograph. See
 * `types/document.ts` on `NodeSlot` for why a generator is a slot rather than a
 * flag, and `registry/stack.ts`'s `analyseSources` for what happens to nodes
 * placed in front of one.
 *
 * ## One softness control, two looks
 *
 * The tone is a smoothstep across the distance rather than an inside/outside
 * test, which is what lets `softness` cover both things people want here: 1.5
 * texels is a crisp antialiased figure, 300 texels is a soft glow in the shape
 * of a star. That is argued where the expression is, in
 * `../shaders/gen-shape.wgsl`.
 *
 * ## Everything is animatable, and everything closes its loop
 *
 * Position, size, rotation and softness are all bound-modulator targets, so a
 * shape can travel, breathe, spin and bloom. None of them can break loop
 * closure: `cyclesPerLoop` is an integer by construction (F-AN-03), rotation is
 * measured in turns so a full ramp lands where it started, and nothing in the
 * shader reads a clock. Unlike feedback, a generator has no reason to be the
 * thing that stops a document looping, and it is not.
 *
 * ## No seed
 *
 * The picture is a closed-form function of the pixel coordinate. There is
 * nothing stochastic to reroll, which is the same argument `vignette` and
 * `concentric-rings` make.
 */

import {
  defineEffect,
  staticGpuEffect,
  type ParamDescriptor,
} from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";
import { SDF_SHAPES } from "../gpu/sdf";

import wgsl from "../shaders/gen-shape.wgsl?raw";

/**
 * Canonical binding numbers, restated from `shaders/CONVENTIONS.md`.
 *
 * **There is no `inputColor`, and that is the declaration.** A generator reads
 * no picture; `gpu/compiler.ts` refuses a `source` effect whose first pass
 * binds one, and refuses a non-source effect whose first pass binds none.
 */
export const GEN_SHAPE_BINDING = {
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const GEN_SHAPE_PARAM = {
  shape: "shape",
  sides: "sides",
  centerX: "centerX",
  centerY: "centerY",
  size: "size",
  aspect: "aspect",
  rotation: "rotation",
  inner: "inner",
  softness: "softness",
  invert: "invert",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/gen-shape.wgsl`.
 *
 * Four `u32` then seven `f32` then one `u32`, all scalars in one run, so
 * nothing needs padding anywhere: 48 bytes exactly, which is already a multiple
 * of the 16-byte round-up.
 */
export const GEN_SHAPE_UNIFORMS: UniformLayout = {
  sizeBytes: 48,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: GEN_SHAPE_PARAM.shape }, type: "u32", offset: 8 },
    { source: { kind: "param", key: GEN_SHAPE_PARAM.sides }, type: "u32", offset: 12 },
    { source: { kind: "param", key: GEN_SHAPE_PARAM.centerX }, type: "f32", offset: 16 },
    { source: { kind: "param", key: GEN_SHAPE_PARAM.centerY }, type: "f32", offset: 20 },
    { source: { kind: "param", key: GEN_SHAPE_PARAM.size }, type: "f32", offset: 24 },
    { source: { kind: "param", key: GEN_SHAPE_PARAM.aspect }, type: "f32", offset: 28 },
    { source: { kind: "param", key: GEN_SHAPE_PARAM.rotation }, type: "f32", offset: 32 },
    { source: { kind: "param", key: GEN_SHAPE_PARAM.inner }, type: "f32", offset: 36 },
    { source: { kind: "param", key: GEN_SHAPE_PARAM.softness }, type: "f32", offset: 40 },
    { source: { kind: "param", key: GEN_SHAPE_PARAM.invert }, type: "u32", offset: 44 },
  ],
};

/**
 * The shape enum's values, generated from `SDF_SHAPES`.
 *
 * Generated rather than written out for the same reason `feedback` generates
 * its blend list: the ordinal that crosses to the shader is the **position in
 * that list**, and the shader's `const` block restates the same numbering. Two
 * hand-written lists would agree until somebody added a shape to one of them,
 * and the symptom would be a saved document drawing a different figure.
 */
const SHAPE_LABELS: Readonly<Record<(typeof SDF_SHAPES)[number], string>> = {
  circle: "Circle",
  rectangle: "Rectangle",
  polygon: "Polygon",
  star: "Star",
};

const GEN_SHAPE_PARAMS: readonly ParamDescriptor[] = [
  {
    key: GEN_SHAPE_PARAM.shape,
    label: "Figure",
    type: "enum",
    // A choice, not a quantity. A modulator bound to it would cut between four
    // unrelated figures rather than animate one.
    animatable: false,
    description:
      "Which figure is drawn. Polygon and star also read the point count; the rectangle is the only one that reads the aspect.",
    values: SDF_SHAPES.map((shape) => ({ value: shape, label: SHAPE_LABELS[shape] })),
    default: "circle",
    surprise: {
      values: [
        { value: "circle", weight: 2 },
        { value: "rectangle", weight: 1.5 },
        { value: "polygon", weight: 1.5 },
        { value: "star", weight: 1 },
      ],
      weight: 1,
    },
  },
  {
    key: GEN_SHAPE_PARAM.sides,
    label: "Points",
    type: "int",
    // Integral and discrete: ramping it produces a jump per integer rather than
    // a morph, which is a stutter rather than an animation.
    animatable: false,
    description:
      "How many sides a polygon has, or how many points a star has. Ignored by the circle and the rectangle.",
    // Two is a degenerate star (a two-pointed sliver) and is the lower end of
    // what the star's fold is defined for; the polygon clamps itself to 3.
    legal: [2, 24],
    default: 5,
    surprise: {
      // Above about twelve a polygon is a circle and a star is a sunburst that
      // a dither cannot resolve (F-SM-04).
      range: [3, 12],
      distribution: { kind: "uniform" },
      weight: 0.9,
    },
  },
  {
    key: GEN_SHAPE_PARAM.centerX,
    label: "Centre X",
    type: "float",
    animatable: true,
    description:
      "Where the figure sits across the frame, as a fraction of its width. 0.5 is the middle; values outside 0..1 put it off the edge.",
    // Past the edge on purpose: a shape travelling on a bound modulator has to
    // be able to leave the frame and come back.
    legal: [-1, 2],
    default: 0.5,
    step: 0.001,
    surprise: {
      // Kept near the middle: a random shape mostly off-screen is a blank
      // picture with an edge in it, which is not a result (F-SM-04).
      range: [0.25, 0.75],
      distribution: { kind: "normal", mean: 0.5, sigma: 0.15 },
      weight: 0.8,
    },
  },
  {
    key: GEN_SHAPE_PARAM.centerY,
    label: "Centre Y",
    type: "float",
    animatable: true,
    description:
      "Where the figure sits down the frame, as a fraction of its height. 0 is the top edge.",
    legal: [-1, 2],
    default: 0.5,
    step: 0.001,
    surprise: {
      range: [0.25, 0.75],
      distribution: { kind: "normal", mean: 0.5, sigma: 0.15 },
      weight: 0.8,
    },
  },
  {
    key: GEN_SHAPE_PARAM.size,
    label: "Size",
    type: "float",
    animatable: true,
    description:
      "How big the figure is, as a fraction of the frame's short side. At 1 a circle touches both short edges, whatever the aspect ratio.",
    // Zero is a legal document value meaning "nothing"; the top end lets a
    // shape fill a wide frame completely.
    legal: [0, 3],
    default: 0.6,
    step: 0.001,
    surprise: {
      // Log, because this is a size: uniform sampling of 0.1..1.2 spends most
      // of its draws in the top octave, where every result fills the frame.
      range: [0.15, 1.2],
      distribution: { kind: "log" },
      weight: 1,
    },
  },
  {
    key: GEN_SHAPE_PARAM.aspect,
    label: "Aspect",
    type: "float",
    animatable: true,
    description:
      "How much wider than tall the rectangle is. 1 is a square, 2 is twice as wide. The circle, polygon and star are radial and ignore it.",
    // Strictly positive: the shader divides by it, and a rectangle of zero
    // height is not a shape.
    legal: [0.05, 20],
    default: 1,
    step: 0.01,
    surprise: {
      range: [0.4, 2.5],
      distribution: { kind: "log" },
      weight: 0.6,
    },
  },
  {
    key: GEN_SHAPE_PARAM.rotation,
    label: "Rotation",
    type: "float",
    animatable: true,
    // Turns, not degrees — CONVENTIONS.md. A parameter ramping 0 -> 1 lands
    // where it started, so an animated spin closes its own loop.
    description:
      "How far the figure is turned, in turns. A whole turn is 1, so a modulator ramping across the loop spins it exactly once.",
    legal: [-1, 1],
    default: 0,
    step: 0.001,
    surprise: {
      range: [0, 1],
      distribution: { kind: "uniform" },
      weight: 0.7,
    },
  },
  {
    key: GEN_SHAPE_PARAM.inner,
    label: "Point depth",
    type: "float",
    animatable: true,
    description:
      "How far a star's inner vertices sit in, as a fraction of its outer radius. 0.382 is the classic five-pointed star; at 1 the star becomes its polygon.",
    // Strictly positive: at zero the inner vertices collide at the centre and
    // the star's edge segment has no length.
    legal: [0.02, 1],
    default: 0.382,
    step: 0.001,
    surprise: {
      // Above about 0.7 the points are too shallow to read as a star at all.
      range: [0.15, 0.65],
      distribution: { kind: "uniform" },
      weight: 0.7,
    },
  },
  {
    key: GEN_SHAPE_PARAM.softness,
    label: "Softness",
    type: "float",
    animatable: true,
    description:
      "How many pixels the edge takes to fade from solid to nothing. Around 1 gives a clean antialiased edge; in the hundreds the figure becomes a soft haze of that shape.",
    legal: [0, 2048],
    // Slightly over one texel: the smallest value that antialiases rather than
    // leaving the diagonal edges of a polygon visibly stepped.
    default: 1.5,
    step: 0.1,
    surprise: {
      // Log across four octaves, because this is a width and the two looks it
      // spans — crisp figure, broad glow — are octaves apart. Uniform sampling
      // would put nearly every draw in the glow.
      range: [1, 400],
      distribution: { kind: "log" },
      weight: 1,
    },
  },
  {
    key: GEN_SHAPE_PARAM.invert,
    label: "Cut out",
    type: "bool",
    // A choice. Ramping it is a hard cut between a figure and its complement.
    animatable: false,
    description:
      "Swap the figure and its surroundings, so the shape is the hole rather than the mark.",
    default: false,
    surprise: {
      trueProbability: 0.35,
      weight: 0.5,
    },
  },
];

export default defineEffect({
  id: "gen-shape",
  name: "Shape",
  summary:
    "Draws a circle, rectangle, polygon or star from nothing — a source node, so it needs no image.",
  description:
    "A generator: it takes no picture and makes one from its parameters, so a document can start here instead of with a photograph. The figure is evaluated as a signed distance field and the tone is a fade across that distance, which is why one softness control covers both looks — around a pixel it is a crisp antialiased figure, in the hundreds it is a soft haze in the shape of a star. Position, size, rotation and softness are all modulator targets, so the figure can travel, breathe and spin, and rotation is measured in turns so a full ramp closes the loop exactly. Placed at the top of a stack it is the image everything else works on; placed lower at less than full opacity, or in any blend but normal, it is composited over what came before, which is how it becomes a mask or a hard-edged frame over a photograph. At full opacity in normal blend it replaces the picture outright and the stack panel marks the rows it discards.",
  keywords: [
    "shape",
    "circle",
    "ellipse",
    "disc",
    "dot",
    "rectangle",
    "square",
    "box",
    "polygon",
    "hexagon",
    "triangle",
    "star",
    "generator",
    "source",
    "sdf",
    "signed distance field",
    "distance field",
    "mask",
    "matte",
    "stencil",
    "no image",
    "from scratch",
    "primitive",
    "geometry",
    "touchdesigner",
  ],
  concept: "halftone-screen",
  requirement: "F-GN-03",
  slot: "source",
  family: "pattern",
  execution: "gpu",
  params: GEN_SHAPE_PARAMS,
  surpriseWeight: 0.6,
  producesIndexMap: false,
  requiresIndexMap: false,
});

/** Parameter descriptors keyed for `packUniforms`, which needs them for enums. */
export const GEN_SHAPE_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  GEN_SHAPE_PARAMS.map((param) => [param.key, param]),
);

const bindings: readonly PassBinding[] = [
  // No `input-color`. That absence is the whole of what makes this a source.
  { role: "output-color", binding: GEN_SHAPE_BINDING.outputColor },
  { role: "uniforms", binding: GEN_SHAPE_BINDING.uniforms },
];

const pass: ComputePass = {
  id: "gen-shape/main",
  label: "Shape source",
  wgsl,
  entryPoint: "main",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  // Every pixel is a closed-form function of its own coordinate. It reads no
  // neighbour because it reads no texture at all.
  access: "pointwise",
  bindings,
  uniforms: GEN_SHAPE_UNIFORMS,
};

/** The compute pass, for the pass compiler. */
export const GEN_SHAPE_GPU: GpuEffect = {
  effect: "gen-shape",
  passes: [pass],
};

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("gen-shape", () => GEN_SHAPE_GPU);
