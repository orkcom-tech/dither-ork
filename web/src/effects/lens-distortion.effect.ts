/**
 * Barrel / pincushion distortion (F-SP-13).
 *
 * One compute pass. The first radial term of the Brown-Conrady lens model, run
 * as an inverse map — each output pixel computes where in the source it came
 * from — which is the only direction that fills every output pixel exactly once.
 *
 * The model, the sign convention and the argument for normalising the radius by
 * the half-diagonal are in `../shaders/lens-distortion.wgsl`, next to the code
 * that implements them.
 *
 * The descriptor and the compute pass are both in this file; see
 * `./invert.effect.ts` for why.
 */

import { defineEffect, type ParamDescriptor } from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/lens-distortion.wgsl?raw";

/** Canonical binding numbers, restated from `shaders/CONVENTIONS.md`. */
export const LENS_DISTORTION_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const LENS_DISTORTION_PARAM = {
  amount: "amount",
  scale: "scale",
  edge: "edge",
  sampling: "sampling",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/lens-distortion.wgsl`. Six 4-byte scalars — 24 bytes in a block
 * WGSL rounds up to 32.
 */
export const LENS_DISTORTION_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: LENS_DISTORTION_PARAM.amount }, type: "f32", offset: 8 },
    { source: { kind: "param", key: LENS_DISTORTION_PARAM.scale }, type: "f32", offset: 12 },
    { source: { kind: "param", key: LENS_DISTORTION_PARAM.edge }, type: "u32", offset: 16 },
    { source: { kind: "param", key: LENS_DISTORTION_PARAM.sampling }, type: "u32", offset: 20 },
  ],
};

export const LENS_DISTORTION_PARAMS: readonly ParamDescriptor[] = [
  {
    key: LENS_DISTORTION_PARAM.amount,
    label: "Distortion",
    type: "float",
    hint: "Negative barrels the frame outward; positive pinches it into a pincushion.",
    animatable: true,
    // Stops short of ±1. At k = -1 the corner term cancels the radius exactly
    // and all four corners sample the single centre texel — a degenerate map
    // rather than a strong one, and nothing above about 0.6 is a lens any more.
    legal: [-0.9, 0.9],
    // Not 0: a distortion node set to no distortion is a node that costs a full
    // resample to produce its own input.
    default: -0.3,
    surprise: {
      // Weighted towards barrel by being asymmetric about zero: barrel is the
      // cheap-lens look this catalogue is for, pincushion is the one you reach
      // for deliberately. Draws near zero are still legal and read as a subtle
      // lens rather than as a failed reroll.
      range: [-0.55, 0.3],
      distribution: { kind: "uniform" },
      weight: 1,
    },
    step: 0.01,
  },
  {
    key: LENS_DISTORTION_PARAM.scale,
    label: "Zoom",
    type: "float",
    hint: "Scales the frame after the distortion. Raise it to crop away the corners a pincushion empties.",
    animatable: true,
    legal: [0.25, 4],
    default: 1,
    surprise: {
      // Log, because it is a magnification: uniform sampling of 0.8..1.4 is fine
      // but the same range in log space keeps a draw of 0.9 as far from 1 as a
      // draw of 1.11, which is what "one stop out" means for a zoom.
      range: [0.85, 1.35],
      distribution: { kind: "log" },
      weight: 0.6,
    },
    step: 0.01,
  },
  {
    key: LENS_DISTORTION_PARAM.edge,
    label: "Outside the frame",
    type: "enum",
    hint: "What fills the pixels whose source lies off the image.",
    animatable: false,
    values: [
      { value: "clamp", label: "Stretch edge" },
      { value: "black", label: "Black" },
      { value: "transparent", label: "Transparent" },
    ],
    // Stretch: it is the only one of the three that introduces no colour the
    // frame did not already contain, which matters when a palette is about to
    // be matched against it.
    default: "clamp",
    surprise: {
      values: [
        { value: "clamp", weight: 1 },
        { value: "black", weight: 0.7 },
        // Lowest: on an opaque source the difference from black only shows once
        // something composites the result, which most exports do not.
        { value: "transparent", weight: 0.3 },
      ],
      weight: 0.5,
    },
  },
  {
    key: LENS_DISTORTION_PARAM.sampling,
    label: "Filtering",
    type: "enum",
    // Not a quality setting. Bilinear invents colours between palette entries,
    // which is right on continuous tone and wrong on an already-indexed buffer;
    // nearest keeps the palette and stair-steps the geometry instead.
    hint: "Bilinear is right for continuous tone; nearest keeps an already-quantized image on its palette.",
    animatable: false,
    values: [
      { value: "bilinear", label: "Bilinear" },
      { value: "nearest", label: "Nearest" },
    ],
    // This node sits in the preprocess slot, so its input is continuous tone.
    default: "bilinear",
    surprise: {
      values: [
        { value: "bilinear", weight: 1 },
        // Nearest before a dither shows up as aliasing that the dither then
        // amplifies, so it is the deliberate choice rather than the common one.
        { value: "nearest", weight: 0.4 },
      ],
      weight: 0.4,
    },
  },
];

/**
 * Parameter descriptors keyed for `packUniforms`. Two of the four are enums,
 * whose document value is a string and whose numeric form is its position in
 * `values`, so the packer cannot resolve them without this.
 */
export const LENS_DISTORTION_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  LENS_DISTORTION_PARAMS.map((param) => [param.key, param]),
);

const bindings: readonly PassBinding[] = [
  { role: "input-color", binding: LENS_DISTORTION_BINDING.inputColor },
  { role: "output-color", binding: LENS_DISTORTION_BINDING.outputColor },
  { role: "uniforms", binding: LENS_DISTORTION_BINDING.uniforms },
];

const pass: ComputePass = {
  id: "lens-distortion/main",
  label: "Lens distortion",
  wgsl,
  entryPoint: "main",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  // `global`, not `neighbourhood`: the read offset grows with the radius and is
  // bounded only by the frame, so this pass can reach anywhere in its input and
  // cannot be reordered against anything that writes it. Same call as
  // chromatic-aberration, and for the same reason.
  access: "global",
  bindings,
  uniforms: LENS_DISTORTION_UNIFORMS,
};

/** The compute pass, for the pass compiler. */
export const LENS_DISTORTION_GPU: GpuEffect = {
  effect: "lens-distortion",
  passes: [pass],
};

export default defineEffect({
  id: "lens-distortion",
  name: "Lens distortion",
  requirement: "F-SP-13",
  // Preprocess, because this moves pixels. Downstream of a quantizer it would
  // resample the colour buffer while the index map beside it kept describing
  // where those pixels used to be, and it cannot resample the map itself: an
  // effect that binds the index map has to declare `requiresIndexMap`, and a
  // bilinear average of two palette *indices* is not a palette index.
  slot: "preprocess",
  family: "special",
  execution: "gpu",
  params: LENS_DISTORTION_PARAMS,
  surpriseWeight: 0.7,
  producesIndexMap: false,
  requiresIndexMap: false,
});
