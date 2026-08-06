/**
 * Threshold (F-SP-07) — level and softness.
 *
 * One compute pass, read-your-own-pixel.
 *
 * The descriptor and the compute pass are both in this file; see
 * `./posterize.effect.ts` for why these five do not follow the ordered dithers'
 * split-module shape.
 *
 * Why the level is measured on the display-referred tone rather than on linear
 * luminance is argued in `../shaders/threshold.wgsl`, next to the line that
 * does it.
 */

import { defineEffect, type ParamDescriptor } from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/threshold.wgsl?raw";

/** Canonical binding numbers, restated from `shaders/CONVENTIONS.md`. */
export const THRESHOLD_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const THRESHOLD_PARAM = {
  level: "level",
  softness: "softness",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/threshold.wgsl`. Four 4-byte scalars fill 16 bytes exactly, so
 * nothing is padded.
 */
export const THRESHOLD_UNIFORMS: UniformLayout = {
  sizeBytes: 16,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: THRESHOLD_PARAM.level }, type: "f32", offset: 8 },
    { source: { kind: "param", key: THRESHOLD_PARAM.softness }, type: "f32", offset: 12 },
  ],
};

export const THRESHOLD_PARAMS: readonly ParamDescriptor[] = [
  {
    key: THRESHOLD_PARAM.level,
    label: "Level",
    type: "float",
    hint: "The tone the cut is made at, measured as it looks on screen. 0.5 is visual mid-grey.",
    animatable: true,
    legal: [0, 1],
    default: 0.5,
    step: 0.01,
    surprise: {
      // Legal runs to both ends because a document may want an all-black or
      // all-white frame deliberately. A random draw must not: outside roughly a
      // quarter either side of the middle, most images have almost no pixels on
      // one side of the cut and the result is a solid rectangle.
      range: [0.25, 0.75],
      distribution: { kind: "normal", mean: 0.5, sigma: 0.15 },
      weight: 1,
    },
  },
  {
    key: THRESHOLD_PARAM.softness,
    label: "Softness",
    type: "float",
    hint: "Width of the ramp across the cut, centred on the level. 0 is a hard edge.",
    animatable: true,
    legal: [0, 1],
    // Hard. A threshold is a hard cut unless asked otherwise, and 0 is the case
    // any golden image would be taken against.
    default: 0,
    step: 0.01,
    surprise: {
      // Past about a third the ramp swallows the whole tonal range and the node
      // is a contrast curve rather than a threshold — a different effect
      // wearing this one's name.
      range: [0, 0.35],
      distribution: { kind: "uniform" },
      weight: 0.7,
    },
  },
];

/**
 * Parameter descriptors keyed for `packUniforms`.
 *
 * Both parameters are floats, so this map is only ever consulted to confirm
 * that — but the packer takes one for every effect and refusing to supply it
 * would make adding an enum here a runtime failure rather than an edit.
 */
export const THRESHOLD_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  THRESHOLD_PARAMS.map((param) => [param.key, param]),
);

const bindings: readonly PassBinding[] = [
  { role: "input-color", binding: THRESHOLD_BINDING.inputColor },
  { role: "output-color", binding: THRESHOLD_BINDING.outputColor },
  { role: "uniforms", binding: THRESHOLD_BINDING.uniforms },
];

const pass: ComputePass = {
  id: "threshold/main",
  label: "Threshold",
  wgsl,
  entryPoint: "main",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  access: "pointwise",
  bindings,
  uniforms: THRESHOLD_UNIFORMS,
};

/** The compute pass, for the pass compiler. */
export const THRESHOLD_GPU: GpuEffect = {
  effect: "threshold",
  passes: [pass],
};

export default defineEffect({
  id: "threshold",
  name: "Threshold",
  requirement: "F-SP-07",
  // Preprocess for the same reason as posterize: it rewrites colours, so
  // downstream of a quantizer it would leave the index map describing an image
  // that no longer exists.
  slot: "preprocess",
  family: "special",
  execution: "gpu",
  params: THRESHOLD_PARAMS,
  // Low. A hard threshold in front of a dither hands the dither a two-tone
  // image and there is nothing left for it to do, so this is an effect to reach
  // for on purpose rather than one to meet by accident (F-SM-03).
  surpriseWeight: 0.45,
  producesIndexMap: false,
  requiresIndexMap: false,
});
