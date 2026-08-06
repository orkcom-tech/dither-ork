/**
 * Invert (F-SP-08).
 *
 * One compute pass, read-your-own-pixel.
 *
 * The one decision worth making here is *which space the complement is taken
 * in*: linear light and sRGB give different pictures, and this effect commits
 * to sRGB. The argument is in `../shaders/invert.wgsl`, above the code that
 * does it, in full — short version: complementing linear light sends visual
 * mid-grey to 90% bright and produces a negative with no shadows, so it is not
 * what the word means.
 *
 * The descriptor and the compute pass are both in this file; see
 * `./posterize.effect.ts` for why.
 */

import { staticGpuEffect, defineEffect, type ParamDescriptor } from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/invert.wgsl?raw";

/** Canonical binding numbers, restated from `shaders/CONVENTIONS.md`. */
export const INVERT_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const INVERT_PARAM = {
  amount: "amount",
  mode: "mode",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/invert.wgsl`. Four 4-byte scalars fill 16 bytes exactly.
 */
export const INVERT_UNIFORMS: UniformLayout = {
  sizeBytes: 16,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: INVERT_PARAM.amount }, type: "f32", offset: 8 },
    { source: { kind: "param", key: INVERT_PARAM.mode }, type: "u32", offset: 12 },
  ],
};

export const INVERT_PARAMS: readonly ParamDescriptor[] = [
  {
    key: INVERT_PARAM.amount,
    label: "Amount",
    type: "float",
    hint: "How far towards the negative. Half way is flat grey; the approach to it is the solarized look.",
    animatable: true,
    legal: [0, 1],
    // Full. An invert node that does not invert is a node that does nothing,
    // and a partial amount is the deviation rather than the norm.
    default: 1,
    step: 0.01,
    surprise: {
      // Below about half the picture is closer to grey than to either the
      // original or the negative, and one flat grey looks like any other.
      range: [0.5, 1],
      distribution: { kind: "uniform" },
      weight: 0.6,
    },
  },
  {
    key: INVERT_PARAM.mode,
    label: "Mode",
    type: "enum",
    hint: "Complement every channel, or flip only the OKLab lightness and keep hue and chroma.",
    animatable: false,
    values: [
      { value: "rgb", label: "Per channel" },
      { value: "lightness", label: "Lightness only" },
    ],
    default: "rgb",
    surprise: {
      // Per-channel is the negative everybody means; lightness-only is the
      // quieter one that keeps the palette recognisable, so it appears less.
      values: [
        { value: "rgb", weight: 1 },
        { value: "lightness", weight: 0.5 },
      ],
      weight: 0.7,
    },
  },
];

/**
 * Parameter descriptors keyed for `packUniforms`. `mode` is an enum, whose
 * document value is a string and whose numeric form is its position in
 * `values`, so the packer cannot resolve it without this.
 */
export const INVERT_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  INVERT_PARAMS.map((param) => [param.key, param]),
);

const bindings: readonly PassBinding[] = [
  { role: "input-color", binding: INVERT_BINDING.inputColor },
  { role: "output-color", binding: INVERT_BINDING.outputColor },
  { role: "uniforms", binding: INVERT_BINDING.uniforms },
];

const pass: ComputePass = {
  id: "invert/main",
  label: "Invert",
  wgsl,
  entryPoint: "main",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  access: "pointwise",
  bindings,
  uniforms: INVERT_UNIFORMS,
};

/** The compute pass, for the pass compiler. */
export const INVERT_GPU: GpuEffect = {
  effect: "invert",
  passes: [pass],
};

export default defineEffect({
  id: "invert",
  name: "Invert",
  requirement: "F-SP-08",
  // Inverting after a quantizer is a tempting place to put this — and it is
  // exactly where it would rewrite every pixel's colour while the index map
  // beside it still names the old palette entries. Preprocess keeps the two
  // halves of the buffer telling the same story.
  slot: "preprocess",
  family: "special",
  execution: "gpu",
  params: INVERT_PARAMS,
  surpriseWeight: 0.6,
  producesIndexMap: false,
  requiresIndexMap: false,
});

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("invert", () => INVERT_GPU);
