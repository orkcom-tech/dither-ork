/**
 * F-GL-11 — Slice repeat: seeded band duplication.
 *
 * The image is cut into bands of seeded thickness; a seeded subset of them is
 * filled with a thin strip of the picture repeated down the band, taken from a
 * seeded offset. That is the distinction from row and column displacement
 * (F-GL-02, F-GL-03), which move a band without repeating anything: the repeat
 * count is what makes this effect itself, which is why the count is a parameter
 * rather than something the shader picks.
 *
 * Every draw comes from `seed` and the band index, so the whole thing is
 * reproducible from the document and periodic in nothing — there is no clock
 * anywhere in the shader (F-AN-05).
 *
 * Both the descriptor and the compute pass live in this file; see the note in
 * `wave-warp.effect.ts` for why an effect with a uniform layout of its own
 * keeps the two halves adjacent.
 */

import type { ParameterValue } from "../types/document";
import type { ComputePass, GpuEffect, PassBinding, UniformLayout } from "../types/gpu";
import { defineEffect } from "../types/registry";
import type { EffectDescriptor, ParamDescriptor } from "../types/registry";

import wgsl from "../shaders/slice-repeat.wgsl?raw";

const EFFECT_ID = "slice-repeat";

/**
 * Canonical binding numbers, restated from CONVENTIONS.md.
 *
 * Bindings 2, 3 and 4 are absent: the effect moves pixels without deciding what
 * they are, so it neither reads nor writes an index map and never consults the
 * palette.
 */
export const SLICE_REPEAT_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const SLICE_REPEAT_PARAM = {
  axis: "axis",
  sliceSize: "sliceSize",
  sizeJitter: "sizeJitter",
  probability: "probability",
  repeats: "repeats",
  offsetRange: "offsetRange",
  seed: "seed",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `web/src/shaders/slice-repeat.wgsl`.
 *
 * Nine 4-byte scalars in a run, so nothing needs padding in front of it and the
 * only padding is the tail that rounds 36 up to 48.
 *
 * The seed is a parameter rather than the `seed` builtin. `StackNode.seed`
 * would work equally well arithmetically, but the glitch family exposes its
 * seed as a control in its own right — F-GL says so for all seventeen — and a
 * seed the user can type is a seed they can keep when they like an accident.
 */
export const SLICE_REPEAT_UNIFORMS: UniformLayout = {
  sizeBytes: 48,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: SLICE_REPEAT_PARAM.sliceSize }, type: "f32", offset: 8 },
    { source: { kind: "param", key: SLICE_REPEAT_PARAM.sizeJitter }, type: "f32", offset: 12 },
    { source: { kind: "param", key: SLICE_REPEAT_PARAM.probability }, type: "f32", offset: 16 },
    { source: { kind: "param", key: SLICE_REPEAT_PARAM.offsetRange }, type: "f32", offset: 20 },
    { source: { kind: "param", key: SLICE_REPEAT_PARAM.repeats }, type: "u32", offset: 24 },
    { source: { kind: "param", key: SLICE_REPEAT_PARAM.axis }, type: "u32", offset: 28 },
    { source: { kind: "param", key: SLICE_REPEAT_PARAM.seed }, type: "u32", offset: 32 },
  ],
};

const PARAMS = [
  {
    key: SLICE_REPEAT_PARAM.axis,
    label: "Axis",
    type: "enum",
    hint: "Horizontal cuts the image into rows; vertical into columns.",
    animatable: false,
    values: [
      { value: "horizontal", label: "Horizontal" },
      { value: "vertical", label: "Vertical" },
    ],
    default: "horizontal",
    surprise: {
      // Horizontal is what a broken scanline looks like, and it is what the
      // effect is reached for. Vertical is legible but reads as a different
      // kind of damage.
      values: [
        { value: "horizontal", weight: 4 },
        { value: "vertical", weight: 1 },
      ],
      weight: 0.6,
    },
  },
  {
    key: SLICE_REPEAT_PARAM.sliceSize,
    label: "Band thickness",
    type: "float",
    hint: "Mean thickness of a band, in pixels.",
    animatable: true,
    legal: [1, 512],
    default: 24,
    step: 1,
    surprise: {
      // Below about six the bands stop being separable from noise; above a
      // hundred there are only a handful of them and the picture is either
      // untouched or destroyed with nothing in between.
      range: [6, 96],
      // Thickness is read in octaves, so uniform sampling would spend most
      // draws in the top one and every surprise would look the same.
      distribution: { kind: "log" },
      weight: 1,
    },
  },
  {
    key: SLICE_REPEAT_PARAM.sizeJitter,
    label: "Thickness jitter",
    type: "float",
    // The shader moves each boundary by at most half a slot, which is what
    // keeps the boundaries monotone and the band lookup a three-step walk
    // rather than a search over the image.
    hint: "How much band thickness varies. 0 gives an even grid.",
    animatable: true,
    legal: [0, 1],
    default: 0.5,
    step: 0.01,
    surprise: {
      // 0 is a real look — an even grid reads as a deliberate screen — but it
      // is the one setting where the seed stops mattering, so it is not where
      // random documents should mostly land.
      range: [0.2, 0.9],
      distribution: { kind: "uniform" },
      weight: 0.6,
    },
  },
  {
    key: SLICE_REPEAT_PARAM.probability,
    label: "Band probability",
    type: "float",
    hint: "Fraction of bands that are duplicated. The rest pass through.",
    animatable: true,
    legal: [0, 1],
    default: 0.35,
    step: 0.01,
    surprise: {
      // Past about two thirds nothing of the original survives to be glitched
      // against, and the result stops reading as damage to a photograph.
      range: [0.1, 0.6],
      distribution: { kind: "uniform" },
      weight: 1.2,
    },
  },
  {
    key: SLICE_REPEAT_PARAM.repeats,
    label: "Max repeats",
    type: "int",
    // The per-band count is drawn from 1..max, so 1 is meaningful: that band is
    // displaced without being repeated, which is the row-displacement look
    // appearing inside this effect rather than a degenerate case.
    hint: "Upper bound on how many times the strip repeats inside a band.",
    animatable: true,
    legal: [1, 16],
    default: 4,
    surprise: {
      range: [2, 8],
      distribution: { kind: "uniform" },
      weight: 0.8,
    },
  },
  {
    key: SLICE_REPEAT_PARAM.offsetRange,
    label: "Reach",
    type: "float",
    hint: "How far from its own position a band may take its strip, in pixels.",
    animatable: true,
    legal: [0, 2048],
    default: 96,
    step: 1,
    surprise: {
      // Small reaches read as a smear of local content; large ones drag
      // unrelated parts of the picture into the band. Both are wanted, and the
      // difference between them is octaves rather than pixels.
      range: [16, 320],
      distribution: { kind: "log" },
      weight: 0.9,
    },
  },
  {
    key: SLICE_REPEAT_PARAM.seed,
    label: "Seed",
    type: "seed",
    hint: "Fixes the band thicknesses, which bands repeat, and how far they reach.",
    animatable: false,
    default: 0,
    surprise: {
      // Rerolling the seed is the single most useful thing to do to this
      // effect: every other control keeps its character while the arrangement
      // changes completely.
      weight: 1.5,
    },
  },
] as const satisfies readonly ParamDescriptor[];

const DESCRIPTOR = defineEffect({
  id: EFFECT_ID,
  name: "Slice repeat",
  requirement: "F-GL-11",
  // Glitch effects sit after the primary dither in the stack grammar (F-SM-03).
  slot: "postprocess",
  family: "glitch",
  execution: "gpu",
  params: PARAMS,
  surpriseWeight: 0.7,
  producesIndexMap: false,
  requiresIndexMap: false,
});

/** What the registry glob collects (`registry/discovery.ts`). */
export default DESCRIPTOR;

/** The same object under a name, for the GPU side. */
export const SLICE_REPEAT_DESCRIPTOR: EffectDescriptor = DESCRIPTOR;

const BINDINGS: readonly PassBinding[] = [
  { role: "input-color", binding: SLICE_REPEAT_BINDING.inputColor },
  { role: "output-color", binding: SLICE_REPEAT_BINDING.outputColor },
  { role: "uniforms", binding: SLICE_REPEAT_BINDING.uniforms },
];

const PASS: ComputePass = {
  id: `${EFFECT_ID}/gather`,
  label: "Slice repeat",
  wgsl,
  entryPoint: "main",
  // 64 invocations, well under the 256 guaranteed everywhere.
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  // A band's strip may be taken from anywhere in the image, so the read is not
  // confined to a window around the pixel.
  access: "global",
  bindings: BINDINGS,
  uniforms: SLICE_REPEAT_UNIFORMS,
};

export const SLICE_REPEAT_GPU: GpuEffect = { effect: EFFECT_ID, passes: [PASS] };

/** Parameter descriptors keyed for `packUniforms`, which resolves enum ordinals. */
export const SLICE_REPEAT_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  PARAMS.map((param) => [param.key, param]),
);

/** Defaults, for a node created without an explicit parameter set. */
export function sliceRepeatDefaults(): Record<string, ParameterValue> {
  const defaults: Record<string, ParameterValue> = {};
  for (const param of PARAMS) {
    switch (param.type) {
      case "float":
      case "int":
      case "seed":
      case "enum":
        defaults[param.key] = param.default;
        break;
    }
  }
  return defaults;
}

/** Descriptor and compute pass together, which is what the compiler takes. */
export function createSliceRepeat(): {
  readonly descriptor: EffectDescriptor;
  readonly gpu: GpuEffect;
} {
  return { descriptor: DESCRIPTOR, gpu: SLICE_REPEAT_GPU };
}
