/**
 * Channel swap (F-GL-14).
 *
 * "Arbitrary RGBA permutation", expressed as four independent choices — one per
 * output channel, naming the input channel it reads. That covers all 24
 * permutations and, as a superset, the non-bijective maps that duplicate a
 * channel (`r -> r, r -> g, r -> b` collapses the image onto its red record).
 * The alternative, a single enum over the 24 permutations, would be legal too
 * and would put a list of twenty-four four-letter strings in the properties
 * panel; four dropdowns say the same thing in a form somebody can read.
 *
 * Everything the shader does is in `../shaders/channel-swap.wgsl`. This file is
 * the description the UI, the scheduler and Surprise Me read, plus the uniform
 * layout that maps these parameter keys onto that shader's `struct Params` —
 * the two have to agree byte for byte, so they sit in one file.
 *
 * **No seed.** The GL preamble in the spec says every glitch effect exposes its
 * own sliders and a seed; this one has nothing stochastic in it, and the house
 * rule that a control which moves nothing is worse than a missing one wins (see
 * `./error-diffusion`, which refuses inert controls for the same reason). If a
 * seeded variant is wanted it is a different effect — seeded per-region channel
 * corruption is F-GL-17, and it is implemented.
 */

import {
  defineEffect,
  type ParamDescriptor,
  staticGpuEffect,
} from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/channel-swap.wgsl?raw";

/**
 * Canonical binding numbers, restated from CONVENTIONS.md.
 *
 * No palette and no index map: the swap is a per-pixel rearrangement of
 * channels that are already in the buffer, and it neither quantizes nor reads a
 * quantization.
 */
export const CHANNEL_SWAP_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const CHANNEL_SWAP_PARAM = {
  sourceR: "sourceR",
  sourceG: "sourceG",
  sourceB: "sourceB",
  sourceA: "sourceA",
} as const;

/**
 * The channels an output may be read from, in the order the shader's
 * `SOURCE_*` constants number them.
 *
 * The packer resolves an enum to its **position in this list**, so the order is
 * append-only: inserting a value in the middle renumbers every document already
 * saved and every one of them renders a different picture.
 */
const SOURCE_VALUES = [
  { value: "r", label: "Red" },
  { value: "g", label: "Green" },
  { value: "b", label: "Blue" },
  { value: "a", label: "Alpha" },
] as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/channel-swap.wgsl`.
 *
 * Six 4-byte scalars in a run, so nothing needs padding in front of it and the
 * only padding is the tail that rounds 24 up to 32.
 */
export const CHANNEL_SWAP_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: CHANNEL_SWAP_PARAM.sourceR }, type: "u32", offset: 8 },
    { source: { kind: "param", key: CHANNEL_SWAP_PARAM.sourceG }, type: "u32", offset: 12 },
    { source: { kind: "param", key: CHANNEL_SWAP_PARAM.sourceB }, type: "u32", offset: 16 },
    { source: { kind: "param", key: CHANNEL_SWAP_PARAM.sourceA }, type: "u32", offset: 20 },
  ],
};

/**
 * The four selectors.
 *
 * Not animatable. A modulator produces a continuous number and these are
 * choices, so a binding would either quantize a sine into a stutter of hard
 * cuts or do nothing at all; the same call `./error-diffusion` makes for its
 * channel-mode enum.
 *
 * The surprise sets weight the *identity* choice low on the three colour
 * outputs, because a reroll that leaves red reading from red on all three has
 * spent a node and changed nothing (F-SM-04). Alpha is the opposite case: it is
 * left alone nearly always, since routing a colour channel into coverage is a
 * real look but a rare one, and routing coverage into a colour channel usually
 * produces a flat field, because most sources are opaque everywhere.
 */
const CHANNEL_SWAP_PARAMS: readonly ParamDescriptor[] = [
  {
    key: CHANNEL_SWAP_PARAM.sourceR,
    label: "Red from",
    type: "enum",
    animatable: false,
    hint: "Input channel the red output is read from.",
    values: SOURCE_VALUES,
    default: "r",
    surprise: {
      values: [
        { value: "r", weight: 1 },
        { value: "g", weight: 3 },
        { value: "b", weight: 3 },
        { value: "a", weight: 0.5 },
      ],
      weight: 1,
    },
  },
  {
    key: CHANNEL_SWAP_PARAM.sourceG,
    label: "Green from",
    type: "enum",
    animatable: false,
    hint: "Input channel the green output is read from.",
    values: SOURCE_VALUES,
    default: "g",
    surprise: {
      values: [
        { value: "r", weight: 3 },
        { value: "g", weight: 1 },
        { value: "b", weight: 3 },
        { value: "a", weight: 0.5 },
      ],
      weight: 1,
    },
  },
  {
    key: CHANNEL_SWAP_PARAM.sourceB,
    label: "Blue from",
    type: "enum",
    animatable: false,
    hint: "Input channel the blue output is read from.",
    values: SOURCE_VALUES,
    default: "b",
    surprise: {
      values: [
        { value: "r", weight: 3 },
        { value: "g", weight: 3 },
        { value: "b", weight: 1 },
        { value: "a", weight: 0.5 },
      ],
      weight: 1,
    },
  },
  {
    key: CHANNEL_SWAP_PARAM.sourceA,
    label: "Alpha from",
    type: "enum",
    animatable: false,
    hint: "Input channel the alpha output is read from. Leave on Alpha to keep coverage intact.",
    values: SOURCE_VALUES,
    default: "a",
    surprise: {
      values: [
        { value: "r", weight: 1 },
        { value: "g", weight: 1 },
        { value: "b", weight: 1 },
        { value: "a", weight: 8 },
      ],
      // Low, so the chaos slider spends its budget on the three outputs that
      // are visible rather than on the one that can make the image vanish.
      weight: 0.25,
    },
  },
];

export default defineEffect({
  id: "channel-swap",
  name: "Channel swap",
  requirement: "F-GL-14",
  // Glitch is applied to the picture, so it sits after the dither. Nothing here
  // forbids it earlier in principle, but a channel swap upstream of a quantizer
  // is a colour-correction move, and the stack grammar has one slot per effect.
  slot: "postprocess",
  family: "glitch",
  execution: "gpu",
  params: CHANNEL_SWAP_PARAMS,
  // Below 1: the look is unmistakable and destructive, so it should turn up
  // less often than the effects that flatter an image (F-SM-03).
  surpriseWeight: 0.7,
  producesIndexMap: false,
  requiresIndexMap: false,
});

/** Parameter descriptors keyed for `packUniforms`, which needs them for enums. */
export const CHANNEL_SWAP_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  CHANNEL_SWAP_PARAMS.map((param) => [param.key, param]),
);

/** Defaults, for a node created without an explicit parameter set. */
export function channelSwapDefaults(): Record<string, string> {
  return {
    [CHANNEL_SWAP_PARAM.sourceR]: "r",
    [CHANNEL_SWAP_PARAM.sourceG]: "g",
    [CHANNEL_SWAP_PARAM.sourceB]: "b",
    [CHANNEL_SWAP_PARAM.sourceA]: "a",
  };
}

/** The compute pass. One dispatch; there is nothing here that needs two. */
export function channelSwapEffect(): GpuEffect {
  const bindings: readonly PassBinding[] = [
    { role: "input-color", binding: CHANNEL_SWAP_BINDING.inputColor },
    { role: "output-color", binding: CHANNEL_SWAP_BINDING.outputColor },
    { role: "uniforms", binding: CHANNEL_SWAP_BINDING.uniforms },
  ];

  const pass: ComputePass = {
    id: "channel-swap/swap",
    label: "Channel swap",
    wgsl,
    entryPoint: "main",
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    // Reads its own pixel and nothing else.
    access: "pointwise",
    bindings,
    uniforms: CHANNEL_SWAP_UNIFORMS,
  };

  return { effect: "channel-swap", passes: [pass] };
}

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("channel-swap", () => channelSwapEffect());
