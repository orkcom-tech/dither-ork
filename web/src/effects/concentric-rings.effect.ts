/**
 * F-PT-05 — Concentric rings pattern dither.
 *
 * A radial screen. The threshold is a periodic function of distance from a
 * centre point, so the texture reads as rings expanding out of that point;
 * centre and pitch are the two controls the requirement names.
 *
 * Everything this effect is lives in this file and in
 * `../shaders/concentric-rings.wgsl`. That is the convention for the
 * catalogue's 63 effects (see `registry/discovery.ts`): adding one is adding
 * one module, so two effects written in parallel cannot conflict. The uniform
 * layout is here rather than in a shared table because it is the half of the
 * contract the shader's `struct Params` has to agree with byte for byte, and
 * the two must be diffable side by side.
 *
 * The ordered-dither family shares its controls through `gpu/effects/ordered`
 * because F-OD-CTL says they are shared *by requirement*. The pattern dithers
 * have no such requirement — each names its own geometry — so `contrast`,
 * `spread` and `thresholdOffset` are restated here rather than pulled from a
 * neighbouring effect module, which would make deleting that effect break this
 * one.
 */

import { staticGpuEffect, defineEffect, type ParamDescriptor } from "../types/registry";
import type { ParameterValue } from "../types/document";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/concentric-rings.wgsl?raw";

export const CONCENTRIC_RINGS_ID = "concentric-rings";

/** Canonical binding numbers, restated from `shaders/CONVENTIONS.md`. */
const BINDING = {
  inputColor: 0,
  outputColor: 1,
  outputIndex: 3,
  palette: 4,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const CONCENTRIC_RINGS_PARAM = {
  centreX: "centreX",
  centreY: "centreY",
  pitch: "pitch",
  phase: "phase",
  contrast: "contrast",
  spread: "spread",
  thresholdOffset: "thresholdOffset",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/concentric-rings.wgsl`.
 *
 * Every slot is a 4-byte scalar, so no field needs padding in front of it and
 * the only padding is the tail that rounds 36 up to 48. Keeping the block to
 * scalars is deliberate: a `vec2f` for the centre pair would align to 8 and put
 * a hole after `height` that both sides would have to agree about.
 */
export const CONCENTRIC_RINGS_UNIFORMS: UniformLayout = {
  sizeBytes: 48,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: CONCENTRIC_RINGS_PARAM.centreX }, type: "f32", offset: 8 },
    { source: { kind: "param", key: CONCENTRIC_RINGS_PARAM.centreY }, type: "f32", offset: 12 },
    { source: { kind: "param", key: CONCENTRIC_RINGS_PARAM.pitch }, type: "f32", offset: 16 },
    { source: { kind: "param", key: CONCENTRIC_RINGS_PARAM.phase }, type: "f32", offset: 20 },
    { source: { kind: "param", key: CONCENTRIC_RINGS_PARAM.contrast }, type: "f32", offset: 24 },
    { source: { kind: "param", key: CONCENTRIC_RINGS_PARAM.spread }, type: "f32", offset: 28 },
    {
      source: { kind: "param", key: CONCENTRIC_RINGS_PARAM.thresholdOffset },
      type: "f32",
      offset: 32,
    },
  ],
};

const PARAMS: readonly ParamDescriptor[] = [
  {
    key: CONCENTRIC_RINGS_PARAM.centreX,
    label: "Centre X",
    type: "float",
    // Normalized rather than in pixels so a document keeps pointing at the same
    // feature when the working resolution changes between preview and export.
    hint: "Ring centre, as a fraction of image width. Values outside 0..1 put it off-frame.",
    animatable: true,
    legal: [-1, 2],
    default: 0.5,
    surprise: { range: [0.15, 0.85], distribution: { kind: "uniform" }, weight: 1 },
  },
  {
    key: CONCENTRIC_RINGS_PARAM.centreY,
    label: "Centre Y",
    type: "float",
    hint: "Ring centre, as a fraction of image height.",
    animatable: true,
    legal: [-1, 2],
    default: 0.5,
    surprise: { range: [0.15, 0.85], distribution: { kind: "uniform" }, weight: 1 },
  },
  {
    key: CONCENTRIC_RINGS_PARAM.pitch,
    label: "Pitch",
    type: "float",
    hint: "Distance between rings, in pixels.",
    animatable: true,
    legal: [0.5, 512],
    default: 8,
    // Measured in octaves: uniform sampling of 0.5..512 spends nearly every
    // draw above 128, where the rings are wider than most images.
    surprise: { range: [2, 48], distribution: { kind: "log" }, weight: 1.2 },
  },
  {
    key: CONCENTRIC_RINGS_PARAM.phase,
    label: "Phase",
    type: "float",
    // Cycles, not pixels: a modulator ramping 0 -> 1 advances the rings by
    // exactly one pitch and lands back on frame 0, so the loop closes without
    // the UI having to know what the pitch is.
    hint: "Shifts the rings outward, in whole ring cycles. The primary animation target.",
    animatable: true,
    legal: [-1, 1],
    default: 0,
    surprise: { range: [-0.5, 0.5], distribution: { kind: "uniform" }, weight: 0.5 },
  },
  {
    key: CONCENTRIC_RINGS_PARAM.contrast,
    label: "Screen contrast",
    type: "float",
    hint: "Steepens the ring profile around its midpoint. Above 1 hardens the rings into bands.",
    animatable: true,
    legal: [0.05, 4],
    default: 1,
    surprise: { range: [0.6, 1.8], distribution: { kind: "log" }, weight: 0.8 },
  },
  {
    key: CONCENTRIC_RINGS_PARAM.spread,
    label: "Spread",
    type: "float",
    hint: "Dither strength. 0 is plain quantization, 1 reproduces tone exactly.",
    animatable: true,
    legal: [0, 2],
    default: 1,
    surprise: { range: [0.4, 1.2], distribution: { kind: "uniform" }, weight: 1 },
  },
  {
    key: CONCENTRIC_RINGS_PARAM.thresholdOffset,
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
export const CONCENTRIC_RINGS_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  PARAMS.map((param) => [param.key, param]),
);

/** Defaults, for a node created without an explicit parameter set. */
export function concentricRingsDefaults(): Record<string, ParameterValue> {
  const defaults: Record<string, ParameterValue> = {};
  for (const param of PARAMS) {
    if (param.type === "float") defaults[param.key] = param.default;
  }
  return defaults;
}

/**
 * The compute pass.
 *
 * One dispatch, pointwise: the threshold comes from the pixel's own coordinate
 * and nothing is read from a neighbour.
 */
export function concentricRingsGpuEffect(): GpuEffect {
  const bindings: readonly PassBinding[] = [
    { role: "input-color", binding: BINDING.inputColor },
    { role: "output-color", binding: BINDING.outputColor },
    { role: "output-index", binding: BINDING.outputIndex },
    { role: "palette", binding: BINDING.palette },
    { role: "uniforms", binding: BINDING.uniforms },
  ];

  const pass: ComputePass = {
    id: `${CONCENTRIC_RINGS_ID}/screen`,
    label: "Concentric rings screen",
    wgsl,
    entryPoint: "main",
    // 64 invocations, well under the 256 guaranteed everywhere.
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    access: "pointwise",
    bindings,
    uniforms: CONCENTRIC_RINGS_UNIFORMS,
  };

  return { effect: CONCENTRIC_RINGS_ID, passes: [pass] };
}

export default defineEffect({
  id: CONCENTRIC_RINGS_ID,
  name: "Concentric rings",
  requirement: "F-PT-05",
  slot: "dither",
  family: "pattern",
  execution: "gpu",
  params: PARAMS,
  // Below the Bayer tiles: a radial screen is a strong, specific look rather
  // than something that flatters an arbitrary image (F-SM-03).
  surpriseWeight: 0.7,
  // Quantizing is the point: the index map it emits is what makes outline,
  // dilate/erode, hue-targeted recolour and the tracer lossless downstream.
  producesIndexMap: true,
  requiresIndexMap: false,
});

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("concentric-rings", () => concentricRingsGpuEffect());
