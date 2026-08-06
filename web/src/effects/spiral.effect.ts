/**
 * F-PT-06 — Spiral pattern dither.
 *
 * An Archimedean spiral screen: the ring screen of F-PT-05 with an angular
 * shear added, so `pitch` sets the radial spacing between arms and `twist` sets
 * how many arms there are and which way they wind.
 *
 * **`twist` is an `int`, and the reason is correctness rather than taste.** The
 * angular term crosses a seam at theta = pi where the turn count jumps by one;
 * only an integral twist leaves the screen continuous across it. A fractional
 * twist puts a hard radial cut through the image, which reads as a rendering
 * fault rather than as a control. `rotation` is the continuous control that
 * replaces it — rotating the whole field is continuous everywhere — and it is
 * the one to animate.
 *
 * Everything this effect is lives in this file and in
 * `../shaders/spiral.wgsl`; see `registry/discovery.ts` for why the catalogue
 * is discovered from one module per effect rather than listed centrally.
 */

import { defineEffect, type ParamDescriptor } from "../types/registry";
import type { ParameterValue } from "../types/document";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/spiral.wgsl?raw";

export const SPIRAL_ID = "spiral";

/** Canonical binding numbers, restated from `shaders/CONVENTIONS.md`. */
const BINDING = {
  inputColor: 0,
  outputColor: 1,
  outputIndex: 3,
  palette: 4,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const SPIRAL_PARAM = {
  centreX: "centreX",
  centreY: "centreY",
  pitch: "pitch",
  twist: "twist",
  rotation: "rotation",
  contrast: "contrast",
  spread: "spread",
  thresholdOffset: "thresholdOffset",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/spiral.wgsl`.
 *
 * Every slot is a 4-byte scalar, so no field needs padding in front of it and
 * the only padding is the tail that rounds 40 up to 48. `twist` is `i32`
 * because it is legally negative — a negative twist winds the arms the other
 * way — and because the packer refuses a non-integer for an `i32` field, which
 * is the check that keeps a fractional twist from ever reaching the seam
 * discontinuity described in the shader.
 */
export const SPIRAL_UNIFORMS: UniformLayout = {
  sizeBytes: 48,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: SPIRAL_PARAM.centreX }, type: "f32", offset: 8 },
    { source: { kind: "param", key: SPIRAL_PARAM.centreY }, type: "f32", offset: 12 },
    { source: { kind: "param", key: SPIRAL_PARAM.pitch }, type: "f32", offset: 16 },
    { source: { kind: "param", key: SPIRAL_PARAM.twist }, type: "i32", offset: 20 },
    { source: { kind: "param", key: SPIRAL_PARAM.rotation }, type: "f32", offset: 24 },
    { source: { kind: "param", key: SPIRAL_PARAM.contrast }, type: "f32", offset: 28 },
    { source: { kind: "param", key: SPIRAL_PARAM.spread }, type: "f32", offset: 32 },
    {
      source: { kind: "param", key: SPIRAL_PARAM.thresholdOffset },
      type: "f32",
      offset: 36,
    },
  ],
};

const PARAMS: readonly ParamDescriptor[] = [
  {
    key: SPIRAL_PARAM.centreX,
    label: "Centre X",
    type: "float",
    // Normalized rather than in pixels so a document keeps pointing at the same
    // feature when the working resolution changes between preview and export.
    hint: "Spiral centre, as a fraction of image width. Values outside 0..1 put it off-frame.",
    animatable: true,
    legal: [-1, 2],
    default: 0.5,
    surprise: { range: [0.15, 0.85], distribution: { kind: "uniform" }, weight: 1 },
  },
  {
    key: SPIRAL_PARAM.centreY,
    label: "Centre Y",
    type: "float",
    hint: "Spiral centre, as a fraction of image height.",
    animatable: true,
    legal: [-1, 2],
    default: 0.5,
    surprise: { range: [0.15, 0.85], distribution: { kind: "uniform" }, weight: 1 },
  },
  {
    key: SPIRAL_PARAM.pitch,
    label: "Pitch",
    type: "float",
    hint: "Radial distance between successive arms, in pixels.",
    animatable: true,
    legal: [0.5, 512],
    default: 8,
    // Measured in octaves: uniform sampling of 0.5..512 spends nearly every
    // draw above 128, where one arm is wider than most images.
    surprise: { range: [2, 48], distribution: { kind: "log" }, weight: 1.2 },
  },
  {
    key: SPIRAL_PARAM.twist,
    label: "Twist",
    type: "int",
    hint: "Arms, and their handedness. Whole turns per revolution; a fraction would cut the screen at one angle.",
    // Not animatable: the value reaches the shader as an i32 and the uniform
    // packer refuses a non-integer for one, so a modulator bound here would
    // fail the pack rather than round. It is also a discrete look — arms appear
    // and disappear — so interpolating it would pop rather than move.
    animatable: false,
    legal: [-12, 12],
    default: 1,
    // Zero is a legal value and it is exactly the concentric-ring screen, which
    // is a separate effect; the surprise range skips it so a spiral drawn at
    // random is recognisably a spiral.
    surprise: { range: [1, 5], distribution: { kind: "uniform" }, weight: 1.2 },
  },
  {
    key: SPIRAL_PARAM.rotation,
    label: "Rotation",
    type: "float",
    // Turns, not degrees: a modulator ramping 0 -> 1 lands back where it
    // started, so an animated rotation loops without the UI having to know that
    // 360 is special.
    hint: "Rotation of the whole spiral about its centre, in turns. The primary animation target.",
    animatable: true,
    legal: [-1, 1],
    default: 0,
    surprise: { range: [-0.5, 0.5], distribution: { kind: "uniform" }, weight: 0.6 },
  },
  {
    key: SPIRAL_PARAM.contrast,
    label: "Screen contrast",
    type: "float",
    hint: "Steepens the arm profile around its midpoint. Above 1 hardens the arms into bands.",
    animatable: true,
    legal: [0.05, 4],
    default: 1,
    surprise: { range: [0.6, 1.8], distribution: { kind: "log" }, weight: 0.8 },
  },
  {
    key: SPIRAL_PARAM.spread,
    label: "Spread",
    type: "float",
    hint: "Dither strength. 0 is plain quantization, 1 reproduces tone exactly.",
    animatable: true,
    legal: [0, 2],
    default: 1,
    surprise: { range: [0.4, 1.2], distribution: { kind: "uniform" }, weight: 1 },
  },
  {
    key: SPIRAL_PARAM.thresholdOffset,
    label: "Threshold offset",
    type: "float",
    hint: "Slides the cut between the two candidate colours. ±0.5 forces one.",
    animatable: true,
    legal: [-0.5, 0.5],
    default: 0,
    surprise: { range: [-0.15, 0.15], distribution: { kind: "uniform" }, weight: 0.6 },
  },
];

/** Parameter descriptors keyed for `packUniforms`. */
export const SPIRAL_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  PARAMS.map((param) => [param.key, param]),
);

/** Defaults, for a node created without an explicit parameter set. */
export function spiralDefaults(): Record<string, ParameterValue> {
  const defaults: Record<string, ParameterValue> = {};
  for (const param of PARAMS) {
    if (param.type === "float" || param.type === "int") {
      defaults[param.key] = param.default;
    }
  }
  return defaults;
}

/**
 * The compute pass.
 *
 * One dispatch, pointwise: the threshold comes from the pixel's own coordinate
 * and nothing is read from a neighbour.
 */
export function spiralGpuEffect(): GpuEffect {
  const bindings: readonly PassBinding[] = [
    { role: "input-color", binding: BINDING.inputColor },
    { role: "output-color", binding: BINDING.outputColor },
    { role: "output-index", binding: BINDING.outputIndex },
    { role: "palette", binding: BINDING.palette },
    { role: "uniforms", binding: BINDING.uniforms },
  ];

  const pass: ComputePass = {
    id: `${SPIRAL_ID}/screen`,
    label: "Spiral screen",
    wgsl,
    entryPoint: "main",
    // 64 invocations, well under the 256 guaranteed everywhere.
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    access: "pointwise",
    bindings,
    uniforms: SPIRAL_UNIFORMS,
  };

  return { effect: SPIRAL_ID, passes: [pass] };
}

export default defineEffect({
  id: SPIRAL_ID,
  name: "Spiral",
  requirement: "F-PT-06",
  slot: "dither",
  family: "pattern",
  execution: "gpu",
  params: PARAMS,
  // The most specific look in the pattern family: it puts a single focal point
  // in the frame whether or not the image has one (F-SM-03).
  surpriseWeight: 0.6,
  // Quantizing is the point: the index map it emits is what makes outline,
  // dilate/erode, hue-targeted recolour and the tracer lossless downstream.
  producesIndexMap: true,
  requiresIndexMap: false,
});
