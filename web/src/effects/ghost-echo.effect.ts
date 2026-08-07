/**
 * Ghost / echo (F-GL-15).
 *
 * "Offset copies with decay": the pixel plus `copies` delayed images of itself,
 * each one step further along the offset vector and each `decay` times weaker
 * than the last. The shader gathers rather than scatters — see
 * `../shaders/ghost-echo.wgsl` for why that makes it one dispatch with no
 * atomics.
 *
 * The two combination modes are both the requirement, not a control and its
 * fallback. `average` normalises the weights and reads as a smear; `add` does
 * not and blooms where copies overlap, which is the analogue-broadcast ghost
 * the effect is named after. Neither is derivable from the other by a slider.
 *
 * **No seed.** Nothing here is stochastic — the copies are at fixed multiples
 * of one offset — and a control that moves nothing is worse than a missing one
 * (`./error-diffusion` makes the same call for the same reason). The spec's GL
 * preamble asks for a seed on every glitch effect; it is left out here rather
 * than declared inert, and that departure is reported rather than hidden.
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

import wgsl from "../shaders/ghost-echo.wgsl?raw";

/** Canonical binding numbers, restated from CONVENTIONS.md. */
export const GHOST_ECHO_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const GHOST_ECHO_PARAM = {
  copies: "copies",
  mode: "mode",
  offsetX: "offsetX",
  offsetY: "offsetY",
  decay: "decay",
} as const;

/**
 * Largest number of echoes offered.
 *
 * Each copy is one extra `textureLoad` per pixel, and past about a dozen the
 * later copies are below the quantizer's step for any decay that is not
 * effectively 1 — so this is where the control stops doing anything, not an
 * arbitrary cap.
 */
const MAX_COPIES = 16;

/**
 * Largest single-step offset offered, in pixels.
 *
 * At the maximum copy count that puts the last ghost 4096px away, which is off
 * the frame for any working resolution this application renders at — i.e. the
 * far end of the range is already "gone", and going further adds nothing.
 */
const MAX_OFFSET = 256;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/ghost-echo.wgsl`.
 *
 * Scalars in a run — four `u32` then three `f32` — so no field needs padding in
 * front of it and the only padding is the tail that rounds 28 up to 32.
 */
export const GHOST_ECHO_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: GHOST_ECHO_PARAM.copies }, type: "u32", offset: 8 },
    { source: { kind: "param", key: GHOST_ECHO_PARAM.mode }, type: "u32", offset: 12 },
    { source: { kind: "param", key: GHOST_ECHO_PARAM.offsetX }, type: "f32", offset: 16 },
    { source: { kind: "param", key: GHOST_ECHO_PARAM.offsetY }, type: "f32", offset: 20 },
    { source: { kind: "param", key: GHOST_ECHO_PARAM.decay }, type: "f32", offset: 24 },
  ],
};

const GHOST_ECHO_PARAMS: readonly ParamDescriptor[] = [
  {
    key: GHOST_ECHO_PARAM.copies,
    label: "Copies",
    type: "int",
    // Not animatable: a copy appearing or vanishing is a step change in the
    // image, and every frame either side of it is a different picture rather
    // than a stage of one movement. Offset and decay are the animation axes.
    animatable: false,
    description: "How many delayed images follow the original.",
    legal: [1, MAX_COPIES],
    default: 3,
    surprise: {
      // Legal reaches 16, but past 8 the copies overlap into a smear whatever
      // the offset — the count has stopped being visible as a count (F-SM-04).
      range: [1, 8],
      distribution: { kind: "normal", mean: 3, sigma: 2 },
      weight: 0.9,
    },
  },
  {
    key: GHOST_ECHO_PARAM.offsetX,
    label: "Offset X",
    type: "float",
    animatable: true,
    description: "Horizontal step between copies, in pixels. Positive puts the ghosts to the right.",
    legal: [-MAX_OFFSET, MAX_OFFSET],
    default: 8,
    surprise: {
      // Wide enough to separate the copies, narrow enough that the last one is
      // still on the frame at a typical working resolution.
      range: [-24, 24],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: GHOST_ECHO_PARAM.offsetY,
    label: "Offset Y",
    type: "float",
    animatable: true,
    description: "Vertical step between copies, in pixels. Positive puts the ghosts below.",
    legal: [-MAX_OFFSET, MAX_OFFSET],
    // Zero by default: the horizontal ghost is the one the effect is named
    // after, and a purely horizontal default makes the offset pair read as
    // "how far" rather than "which way".
    default: 0,
    surprise: {
      range: [-12, 12],
      distribution: { kind: "uniform" },
      // Below offsetX: a vertical-only echo reads as a print misregistration
      // rather than as a ghost.
      weight: 0.7,
    },
  },
  {
    key: GHOST_ECHO_PARAM.decay,
    label: "Decay",
    type: "float",
    animatable: true,
    description: "Weight of each copy relative to the one before it. 1 makes every copy as strong as the original.",
    // 0 is legal and is the identity — every echo weighted to nothing. It is
    // the honest bottom of the range rather than a value to hide.
    legal: [0, 1],
    default: 0.6,
    step: 0.01,
    surprise: {
      // Below ~0.3 only the first copy survives and the count stops mattering;
      // above ~0.85 in add mode the frame blows out.
      range: [0.3, 0.85],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: GHOST_ECHO_PARAM.mode,
    label: "Combine",
    type: "enum",
    // A choice, not a quantity: binding a modulator to it would turn a sine
    // into a stutter of hard cuts.
    animatable: false,
    description: "Average keeps the image's own brightness; add lets the copies pile up and bloom.",
    values: [
      { value: "average", label: "Average" },
      { value: "add", label: "Add" },
    ],
    default: "average",
    surprise: {
      // Add is the louder of the two and clips a bright source, so it is the
      // deviation rather than the norm.
      values: [
        { value: "average", weight: 3 },
        { value: "add", weight: 1 },
      ],
      weight: 0.5,
    },
  },
];

export default defineEffect({
  id: "ghost-echo",
  name: "Ghost / echo",
  summary:
    "Offset copies of the picture trailing behind it, each one weaker than the last.",
  description:
    "The pixel plus a number of delayed images of itself, each one step further along the offset vector and each decayed relative to the one before — the analogue broadcast ghost the effect is named after. Average normalises the weights, so the picture keeps its own brightness and the result reads as a smear; add does not normalise, so the copies pile up and bloom where they overlap. Neither is derivable from the other by a slider, which is why both are here. No seed: the copies sit at fixed multiples of one offset and there is nothing to reroll.",
  keywords: ["ghost", "echo", "trail", "copies", "double", "multiple exposure", "broadcast", "antenna", "reflection", "smear", "motion blur", "after image"],
  concept: "glitch",
  requirement: "F-GL-15",
  slot: "postprocess",
  family: "glitch",
  execution: "gpu",
  params: GHOST_ECHO_PARAMS,
  // Near ordinary: an echo survives being combined with almost anything else,
  // which is not true of the more destructive glitches.
  surpriseWeight: 0.9,
  producesIndexMap: false,
  requiresIndexMap: false,
});

/** Parameter descriptors keyed for `packUniforms`, which needs them for enums. */
export const GHOST_ECHO_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  GHOST_ECHO_PARAMS.map((param) => [param.key, param]),
);

/** Defaults, for a node created without an explicit parameter set. */
export function ghostEchoDefaults(): Record<string, number | string> {
  return {
    [GHOST_ECHO_PARAM.copies]: 3,
    [GHOST_ECHO_PARAM.offsetX]: 8,
    [GHOST_ECHO_PARAM.offsetY]: 0,
    [GHOST_ECHO_PARAM.decay]: 0.6,
    [GHOST_ECHO_PARAM.mode]: "average",
  };
}

/** The compute pass. */
export function ghostEchoEffect(): GpuEffect {
  const bindings: readonly PassBinding[] = [
    { role: "input-color", binding: GHOST_ECHO_BINDING.inputColor },
    { role: "output-color", binding: GHOST_ECHO_BINDING.outputColor },
    { role: "uniforms", binding: GHOST_ECHO_BINDING.uniforms },
  ];

  const pass: ComputePass = {
    id: "ghost-echo/gather",
    label: "Ghost / echo gather",
    wgsl,
    entryPoint: "main",
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    // Reads a window bounded by copies * offset — up to 4096px, but bounded by
    // the parameters and never dependent on a value read from another pixel. It
    // must not alias its input, which is what this declaration tells the
    // scheduler.
    access: "neighbourhood",
    bindings,
    uniforms: GHOST_ECHO_UNIFORMS,
  };

  return { effect: "ghost-echo", passes: [pass] };
}

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("ghost-echo", () => ghostEchoEffect());
