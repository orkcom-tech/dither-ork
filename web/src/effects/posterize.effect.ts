/**
 * Posterize (F-SP-06) — N levels, per channel or on luma.
 *
 * One compute pass, read-your-own-pixel. Everything the effect needs is a
 * transfer, a rounding and a multiply, so there is nothing here that wants a
 * second dispatch.
 *
 * The descriptor and the compute pass are both in this file. The ordered
 * dithers keep theirs in `../gpu/effects/ordered` because five effects share
 * one uniform layout and one parameter set there, and a rename has to break in
 * one place. Nothing is shared here — this is one effect with its own layout —
 * so splitting it across two modules would only put the parameter keys and the
 * offsets that read them in different files, which is the mismatch
 * `web/src/types/gpu.ts` exists to prevent.
 *
 * The shader is `../shaders/posterize.wgsl` and the reasoning about *which
 * space the levels are even in* lives there, next to the code that decides it.
 */

import { staticGpuEffect, defineEffect, type ParamDescriptor } from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/posterize.wgsl?raw";

/** Canonical binding numbers, restated from `shaders/CONVENTIONS.md`. */
export const POSTERIZE_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const POSTERIZE_PARAM = {
  levels: "levels",
  mode: "mode",
  space: "space",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/posterize.wgsl`.
 *
 * Five 4-byte scalars: 20 bytes of data in a block WGSL rounds up to 32. Enum
 * parameters arrive as `u32` ordinals, which is why the shader's `MODE_*` and
 * `SPACE_*` constants are positions in the descriptor's `values` list and why
 * that list is append-only.
 */
export const POSTERIZE_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: POSTERIZE_PARAM.levels }, type: "u32", offset: 8 },
    { source: { kind: "param", key: POSTERIZE_PARAM.mode }, type: "u32", offset: 12 },
    { source: { kind: "param", key: POSTERIZE_PARAM.space }, type: "u32", offset: 16 },
  ],
};

/**
 * Ceiling offered for the level count.
 *
 * Past about 64 levels per channel the banding stops being visible against
 * 16-bit float working precision, so the control has quietly stopped doing
 * anything. A legal maximum that still does something is worth more than a
 * large one that does not.
 */
const MAX_LEVELS = 64;

export const POSTERIZE_PARAMS: readonly ParamDescriptor[] = [
  {
    key: POSTERIZE_PARAM.levels,
    label: "Levels",
    type: "int",
    description: "How many tones each channel is allowed. 2 is pure black and white.",
    animatable: true,
    legal: [2, MAX_LEVELS],
    default: 4,
    surprise: {
      // Legal goes to 64, but above about 10 the bands stop reading as bands
      // and the result is indistinguishable from the input — a random draw that
      // looks like nothing happened (F-SM-04).
      range: [2, 10],
      // Levels are octaves: the difference between 2 and 3 is the whole
      // picture, the difference between 40 and 41 is nothing. Uniform sampling
      // would spend most draws in the range where the effect is invisible.
      distribution: { kind: "log" },
      weight: 1,
    },
  },
  {
    key: POSTERIZE_PARAM.mode,
    label: "Mode",
    type: "enum",
    description: "Band each channel separately, or band the tone and keep the colour.",
    animatable: false,
    values: [
      { value: "rgb", label: "Per channel" },
      { value: "luma", label: "Luma" },
    ],
    default: "rgb",
    surprise: {
      // Per-channel is the canonical posterize and produces the hue shifts
      // people recognise; luma is the quieter one, so it appears less often.
      values: [
        { value: "rgb", weight: 1 },
        { value: "luma", weight: 0.6 },
      ],
      weight: 0.8,
    },
  },
  {
    key: POSTERIZE_PARAM.space,
    label: "Level spacing",
    type: "enum",
    description: "Even in the encoded value, as an image editor's posterize is, or even in physical light.",
    animatable: false,
    values: [
      { value: "srgb", label: "sRGB (perceptual)" },
      { value: "linear", label: "Linear light" },
    ],
    default: "srgb",
    surprise: {
      // Linear spacing throws nearly every level into the highlights, which is
      // a real look but a narrow one; it stays rare rather than absent.
      values: [
        { value: "srgb", weight: 1 },
        { value: "linear", weight: 0.25 },
      ],
      weight: 0.5,
    },
  },
];

/**
 * Parameter descriptors keyed for `packUniforms`.
 *
 * Required, not optional: two of the three parameters are enums, and an enum's
 * document value is a string whose numeric form is its position in `values`.
 * The packer refuses to guess that without the descriptor.
 */
export const POSTERIZE_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  POSTERIZE_PARAMS.map((param) => [param.key, param]),
);

const bindings: readonly PassBinding[] = [
  { role: "input-color", binding: POSTERIZE_BINDING.inputColor },
  { role: "output-color", binding: POSTERIZE_BINDING.outputColor },
  { role: "uniforms", binding: POSTERIZE_BINDING.uniforms },
];

const pass: ComputePass = {
  id: "posterize/main",
  label: "Posterize",
  wgsl,
  entryPoint: "main",
  // 64 invocations, well under the 256 guaranteed everywhere.
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  access: "pointwise",
  bindings,
  uniforms: POSTERIZE_UNIFORMS,
};

/** The compute pass, for the pass compiler. */
export const POSTERIZE_GPU: GpuEffect = {
  effect: "posterize",
  passes: [pass],
};

export default defineEffect({
  id: "posterize",
  name: "Posterize",
  summary:
    "Reduces the picture to a fixed number of tones per channel, with hard steps and no dithering at all.",
  description:
    "The straight quantization a dither exists to avoid: every value is snapped to the nearest of N evenly spaced levels, so gradients become visible bands. Two levels per channel is pure black and white. RGB bands each channel separately, which can shift hues at the step boundaries; luma bands the tone and keeps the colour. Level spacing decides whether the steps are even in the encoded value, as an image editor's posterize is, or even in physical light, which puts more of them in the shadows.",
  keywords: ["posterize", "levels", "banding", "bands", "quantize", "flat", "steps", "reduce colours", "reduce colors", "cel shading", "poster"],
  concept: "tone-and-colour",
  requirement: "F-SP-06",
  // Before the dither, not after. Crushing the input to a handful of levels and
  // then dithering it is the reason to reach for this; running it after a
  // quantizer would rewrite colours the index map still claims to describe, and
  // the map would then be a lie about the buffer beside it.
  slot: "preprocess",
  family: "special",
  execution: "gpu",
  params: POSTERIZE_PARAMS,
  surpriseWeight: 0.9,
  producesIndexMap: false,
  requiresIndexMap: false,
});

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("posterize", () => POSTERIZE_GPU);
