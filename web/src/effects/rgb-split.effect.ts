/**
 * RGB split (F-GL-04).
 *
 * Three independent per-channel translations. One pointwise compute pass: each
 * pixel works out where its own red, green and blue came from and reads them.
 *
 * **Offsets are fractions of the image, not pixels.** Preview and export are
 * the same graph at two resolutions, so a pixel-valued translation would export
 * a different picture than the one on screen. A fractional offset is almost
 * never a whole texel, so the shader interpolates — four `textureLoad`s and a
 * `mix`, in linear light, with the node's own edge rule. Without it the first
 * half-texel of every slider would do nothing at all, which is a dead control
 * rather than a subtle one.
 *
 * **The seed drives `jitter`.** A split described by six numbers is fully
 * determined, so the family's seed requirement needs a stochastic axis to act
 * on: `jitter` gives each scanline its own extra horizontal displacement per
 * channel. At 0 it is off and the seed does nothing, which is stated on the
 * control rather than left to be discovered.
 */

import type { EffectDescriptor, ParamDescriptor } from "../types/registry";
import type { ComputePass, GpuEffect, UniformLayout } from "../types/gpu";

import wgsl from "../shaders/rgb-split.wgsl?raw";

/** Canonical binding numbers, restated from CONVENTIONS.md. */
export const RGB_SPLIT_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const RGB_SPLIT_PARAM = {
  redX: "redX",
  redY: "redY",
  greenX: "greenX",
  greenY: "greenY",
  blueX: "blueX",
  blueY: "blueY",
  jitter: "jitter",
  edge: "edge",
  seed: "seed",
} as const;

/**
 * `struct Params` in `rgb-split.wgsl`, byte for byte.
 *
 * Twelve 4-byte scalars, so nothing needs padding in front of it and the only
 * padding is the tail that rounds 44 up to 48. Keeping the block to scalars is
 * not laziness — a `vec2f` per channel would align to 8 and put holes in the
 * middle that both sides then have to agree about.
 */
export const RGB_SPLIT_UNIFORMS: UniformLayout = {
  sizeBytes: 48,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: RGB_SPLIT_PARAM.seed }, type: "u32", offset: 8 },
    { source: { kind: "param", key: RGB_SPLIT_PARAM.edge }, type: "u32", offset: 12 },
    { source: { kind: "param", key: RGB_SPLIT_PARAM.redX }, type: "f32", offset: 16 },
    { source: { kind: "param", key: RGB_SPLIT_PARAM.redY }, type: "f32", offset: 20 },
    { source: { kind: "param", key: RGB_SPLIT_PARAM.greenX }, type: "f32", offset: 24 },
    { source: { kind: "param", key: RGB_SPLIT_PARAM.greenY }, type: "f32", offset: 28 },
    { source: { kind: "param", key: RGB_SPLIT_PARAM.blueX }, type: "f32", offset: 32 },
    { source: { kind: "param", key: RGB_SPLIT_PARAM.blueY }, type: "f32", offset: 36 },
    { source: { kind: "param", key: RGB_SPLIT_PARAM.jitter }, type: "f32", offset: 40 },
  ],
};

/**
 * The edge rule.
 *
 * Restated here rather than imported from a neighbouring effect: one effect is
 * one file, and an effect file that imports from another makes deleting either
 * of them a two-file edit. The order is load-bearing — it is the shader's
 * `EDGE_*` constants, and the packer sends the ordinal, so inserting a value in
 * the middle renumbers every document already saved.
 */
const EDGE_VALUES = [
  { value: "clamp", label: "Hold edge" },
  { value: "wrap", label: "Wrap" },
  { value: "mirror", label: "Mirror" },
] as const;

/** Legal travel for one channel, as a fraction of the image. */
const TRAVEL: readonly [number, number] = [-0.25, 0.25];

/**
 * Surprise ranges for the six offsets.
 *
 * Far narrower than legal, and narrower on Y than on X: a quarter of the image
 * is a channel in a different part of the picture, and vertical separation
 * reads as a broken render where horizontal separation reads as a mistracked
 * channel (F-SM-04).
 */
const SURPRISE_X: readonly [number, number] = [-0.04, 0.04];
const SURPRISE_Y: readonly [number, number] = [-0.02, 0.02];

const PARAMS: readonly ParamDescriptor[] = [
  {
    key: RGB_SPLIT_PARAM.redX,
    label: "Red X",
    type: "float",
    hint: "Horizontal travel of the red channel, as a fraction of image width.",
    animatable: true,
    legal: TRAVEL,
    // A visible split at the default: an effect that does nothing until a
    // slider is touched looks broken when it is added to a stack.
    default: 0.006,
    surprise: { range: SURPRISE_X, distribution: { kind: "uniform" }, weight: 1 },
  },
  {
    key: RGB_SPLIT_PARAM.redY,
    label: "Red Y",
    type: "float",
    hint: "Vertical travel of the red channel, as a fraction of image height.",
    animatable: true,
    legal: TRAVEL,
    default: 0,
    surprise: { range: SURPRISE_Y, distribution: { kind: "uniform" }, weight: 0.6 },
  },
  {
    key: RGB_SPLIT_PARAM.greenX,
    label: "Green X",
    type: "float",
    hint: "Horizontal travel of the green channel, as a fraction of image width.",
    animatable: true,
    legal: TRAVEL,
    // Green is the channel the eye reads detail from, so it stays put by
    // default and the split reads as colour fringing rather than as blur.
    default: 0,
    surprise: { range: SURPRISE_Y, distribution: { kind: "uniform" }, weight: 0.6 },
  },
  {
    key: RGB_SPLIT_PARAM.greenY,
    label: "Green Y",
    type: "float",
    hint: "Vertical travel of the green channel, as a fraction of image height.",
    animatable: true,
    legal: TRAVEL,
    default: 0,
    surprise: { range: SURPRISE_Y, distribution: { kind: "uniform" }, weight: 0.5 },
  },
  {
    key: RGB_SPLIT_PARAM.blueX,
    label: "Blue X",
    type: "float",
    hint: "Horizontal travel of the blue channel, as a fraction of image width.",
    animatable: true,
    legal: TRAVEL,
    // Opposite the red default, which is what makes the untouched effect read
    // as a split rather than as a shifted picture.
    default: -0.006,
    surprise: { range: SURPRISE_X, distribution: { kind: "uniform" }, weight: 1 },
  },
  {
    key: RGB_SPLIT_PARAM.blueY,
    label: "Blue Y",
    type: "float",
    hint: "Vertical travel of the blue channel, as a fraction of image height.",
    animatable: true,
    legal: TRAVEL,
    default: 0,
    surprise: { range: SURPRISE_Y, distribution: { kind: "uniform" }, weight: 0.6 },
  },
  {
    key: RGB_SPLIT_PARAM.jitter,
    label: "Line wobble",
    type: "float",
    // This is what the seed drives; without it the effect is fully determined
    // by the six offsets and a seed control would move nothing.
    hint: "Seeded per-scanline horizontal wobble, independent per channel, as a fraction of width. 0 is off, and then the seed has no effect.",
    animatable: true,
    legal: [0, 0.25],
    default: 0,
    step: 0.001,
    surprise: {
      // Two percent of the width is already a channel torn line by line;
      // beyond that the picture stops being readable.
      range: [0, 0.02],
      distribution: { kind: "uniform" },
      weight: 0.7,
    },
  },
  {
    key: RGB_SPLIT_PARAM.edge,
    label: "Edge",
    type: "enum",
    hint: "What a channel shows where it has been shifted off the frame.",
    animatable: false,
    values: [...EDGE_VALUES],
    // Holding the edge is the only one of the three that does not invent
    // structure at the border out of the far side of the image.
    default: "clamp",
    surprise: {
      values: [
        { value: "clamp", weight: 1 },
        { value: "wrap", weight: 0.4 },
        { value: "mirror", weight: 0.4 },
      ],
      weight: 0.4,
    },
  },
  {
    key: RGB_SPLIT_PARAM.seed,
    label: "Seed",
    type: "seed",
    hint: "Reroll the line wobble. No effect while wobble is 0.",
    animatable: false,
    default: 0,
    surprise: { weight: 0.8 },
  },
];

const descriptor: EffectDescriptor = {
  id: "rgb-split",
  name: "RGB split",
  requirement: "F-GL-04",
  slot: "postprocess",
  family: "glitch",
  execution: "gpu",
  params: PARAMS,
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: false,
};

export default descriptor;

const SPLIT: ComputePass = {
  id: "rgb-split/split",
  label: "RGB split",
  wgsl,
  entryPoint: "main",
  // 64 invocations, well under the 256 guaranteed everywhere.
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  // Reads three arbitrary points, so it is not pointwise in the scheduler's
  // sense even though it is one dispatch: it must not alias its input.
  access: "global",
  bindings: [
    { role: "input-color", binding: RGB_SPLIT_BINDING.inputColor },
    { role: "output-color", binding: RGB_SPLIT_BINDING.outputColor },
    { role: "uniforms", binding: RGB_SPLIT_BINDING.uniforms },
  ],
  uniforms: RGB_SPLIT_UNIFORMS,
};

export const rgbSplitGpuEffect: GpuEffect = {
  effect: descriptor.id,
  passes: [SPLIT],
};

/** Parameter descriptors keyed for `packUniforms`, which needs them for enums. */
export const RGB_SPLIT_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  PARAMS.map((param) => [param.key, param]),
);
