/**
 * Levels (F-PP-03).
 *
 * One pointwise compute pass: input black/white, gamma, output black/white,
 * per channel or on luma.
 *
 * Two decisions are argued in full at the top of `../shaders/levels.wgsl` and
 * only summarised here. The transfer is **defined on the sRGB-encoded value**,
 * because that is what a black point of 0.25 and a gamma of 1.2 mean — the same
 * domain brightness/contrast (F-PP-02) uses, which is what lets the two stack
 * into the single curve a user is picturing. And **gamma follows Photoshop's
 * midtone convention**, `pow(n, 1/gamma)`, so above 1 brightens; the opposite
 * convention is equally common and renders a perfectly plausible wrong picture.
 *
 * One consequence worth knowing before reaching for this node: unlike
 * brightness/contrast and HSL, it **clips headroom at its default settings**,
 * because an input white of 1 is a statement about where white is and the
 * working surface can legitimately carry values above it.
 *
 * The descriptor, the uniform layout and the compute pass are all in this file;
 * see `./invert.effect.ts` for why they may not be separated.
 */

import { staticGpuEffect, defineEffect, type ParamDescriptor } from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/levels.wgsl?raw";

/** Canonical binding numbers, restated from `shaders/CONVENTIONS.md`. */
export const LEVELS_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const LEVELS_PARAM = {
  inputBlack: "inputBlack",
  inputWhite: "inputWhite",
  gamma: "gamma",
  outputBlack: "outputBlack",
  outputWhite: "outputWhite",
  mode: "mode",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/levels.wgsl`. Eight 4-byte scalars fill 32 bytes exactly, so
 * there is no padding on either side.
 */
export const LEVELS_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: LEVELS_PARAM.inputBlack }, type: "f32", offset: 8 },
    { source: { kind: "param", key: LEVELS_PARAM.inputWhite }, type: "f32", offset: 12 },
    { source: { kind: "param", key: LEVELS_PARAM.gamma }, type: "f32", offset: 16 },
    { source: { kind: "param", key: LEVELS_PARAM.outputBlack }, type: "f32", offset: 20 },
    { source: { kind: "param", key: LEVELS_PARAM.outputWhite }, type: "f32", offset: 24 },
    { source: { kind: "param", key: LEVELS_PARAM.mode }, type: "u32", offset: 28 },
  ],
};

export const LEVELS_PARAMS: readonly ParamDescriptor[] = [
  {
    key: LEVELS_PARAM.inputBlack,
    label: "Input black",
    type: "float",
    hint: "Everything at or below this encoded value becomes the output black.",
    animatable: true,
    legal: [0, 1],
    default: 0,
    step: 0.005,
    surprise: {
      // Held below the input-white range so the two can never be drawn crossed.
      // The shader defines what a crossed pair does, but a generator that
      // produced one would be relying on that definition rather than on the
      // control, and a quarter of the shadows is already a hard clip.
      range: [0, 0.25],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: LEVELS_PARAM.inputWhite,
    label: "Input white",
    type: "float",
    hint: "Everything at or above this encoded value becomes the output white.",
    animatable: true,
    legal: [0, 1],
    default: 1,
    step: 0.005,
    surprise: {
      range: [0.75, 1],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: LEVELS_PARAM.gamma,
    label: "Gamma",
    type: "float",
    hint: "Midtone bend. Above 1 brightens, below 1 darkens; the exponent applied is 1/gamma.",
    animatable: true,
    // Photoshop's own bounds, and they are the useful ones: at 0.1 the midtones
    // are already crushed onto black and at 9.99 onto white, so nothing beyond
    // either end is a different picture.
    legal: [0.1, 9.99],
    default: 1,
    step: 0.01,
    surprise: {
      // Half to double is the band where the midtones move and the ends stay
      // put. Outside it the frame is one tone before any dither sees it.
      range: [0.5, 2],
      // A gamma is multiplicative about 1: 0.5 and 2 are the same size of step
      // in opposite directions, which uniform sampling would not respect.
      distribution: { kind: "log" },
      weight: 1,
    },
  },
  {
    key: LEVELS_PARAM.outputBlack,
    label: "Output black",
    type: "float",
    hint: "Encoded value the input black maps to. Above output white, the tone scale inverts.",
    animatable: true,
    legal: [0, 1],
    default: 0,
    step: 0.005,
    surprise: {
      // Lifting the black is the faded-print look and it survives a dither,
      // because it leaves the darkest tone inside the palette rather than
      // pinned to its darkest entry. Kept small: past 0.2 there is no black
      // left anywhere in the frame.
      range: [0, 0.2],
      distribution: { kind: "uniform" },
      weight: 0.5,
    },
  },
  {
    key: LEVELS_PARAM.outputWhite,
    label: "Output white",
    type: "float",
    hint: "Encoded value the input white maps to. Below output black, the tone scale inverts.",
    animatable: true,
    legal: [0, 1],
    default: 1,
    step: 0.005,
    surprise: {
      range: [0.8, 1],
      distribution: { kind: "uniform" },
      weight: 0.5,
    },
  },
  {
    key: LEVELS_PARAM.mode,
    label: "Mode",
    type: "enum",
    hint: "Run the transfer on each channel, or on luminance alone and scale the colour by the ratio.",
    animatable: false,
    // Append-only: the shader reads the ordinal, so inserting a value in the
    // middle renumbers every document already saved.
    values: [
      { value: "per-channel", label: "Per channel" },
      { value: "luma", label: "Luma" },
    ],
    // Per channel, because that is what the composite channel of every levels
    // dialog does and therefore what the numbers are calibrated against.
    default: "per-channel",
    surprise: {
      // Per-channel clips the three channels at different places and shifts hue
      // on saturated colours, which is most of what makes a levels move look
      // like one. Luma is the quieter half and appears less often.
      values: [
        { value: "per-channel", weight: 1 },
        { value: "luma", weight: 0.7 },
      ],
      weight: 0.6,
    },
  },
];

/**
 * Parameter descriptors keyed for `packUniforms`. `mode` is an enum, whose
 * document value is a string and whose numeric form is its position in
 * `values`, so the packer cannot resolve it without this.
 */
export const LEVELS_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  LEVELS_PARAMS.map((param) => [param.key, param]),
);

const bindings: readonly PassBinding[] = [
  { role: "input-color", binding: LEVELS_BINDING.inputColor },
  { role: "output-color", binding: LEVELS_BINDING.outputColor },
  { role: "uniforms", binding: LEVELS_BINDING.uniforms },
];

const pass: ComputePass = {
  id: "levels/main",
  label: "Levels",
  wgsl,
  entryPoint: "main",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  access: "pointwise",
  bindings,
  uniforms: LEVELS_UNIFORMS,
};

/** The compute pass, for the pass compiler. */
export const LEVELS_GPU: GpuEffect = {
  effect: "levels",
  passes: [pass],
};

export default defineEffect({
  id: "levels",
  name: "Levels",
  requirement: "F-PP-03",
  // Preprocess: levels decides how much of the tone scale the kernel downstream
  // has to work with, which is the whole reason to reach for it here. After a
  // quantizer it would rewrite every pixel's colour while the index map beside
  // it still named the old palette entries.
  slot: "preprocess",
  family: "preprocess",
  execution: "gpu",
  params: LEVELS_PARAMS,
  // Just below brightness/contrast. It does everything that node does and more,
  // but five interacting numbers land on a usable picture less often than three
  // independent ones, and Surprise Me is drawing rather than adjusting.
  surpriseWeight: 0.9,
  producesIndexMap: false,
  requiresIndexMap: false,
});

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("levels", () => LEVELS_GPU);
