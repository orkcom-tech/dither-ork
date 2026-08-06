/**
 * F-PT-03 — Line screen.
 *
 * A rotated grating whose line width carries the tone. The geometry and the
 * reasoning behind it live in `../shaders/line-screen.wgsl`; what is here is the
 * registry descriptor and the uniform block whose byte offsets the shader
 * restates.
 *
 * Descriptor, layout and pass sit together because the parameter keys appear
 * three times — here, in {@link LINE_SCREEN_UNIFORMS}, and as `struct Params` in
 * the shader — and a rename that misses one of them is a wrong image with no
 * error anywhere.
 */

import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";
import { defineEffect, type ParamDescriptor } from "../types/registry";
import wgsl from "../shaders/line-screen.wgsl?raw";

/**
 * Canonical binding numbers, restated from CONVENTIONS.md.
 *
 * Binding 2 (`input-index`) is absent: a line screen is the node that *creates*
 * the index map, so it has none to read.
 */
export const LINE_SCREEN_BINDING = {
  inputColor: 0,
  outputColor: 1,
  outputIndex: 3,
  palette: 4,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const LINE_SCREEN_PARAM = {
  pitch: "pitch",
  angle: "angle",
  duty: "duty",
  phase: "phase",
  spread: "spread",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/line-screen.wgsl`. Seven 4-byte scalars and one word of tail
 * padding.
 */
export const LINE_SCREEN_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: LINE_SCREEN_PARAM.pitch }, type: "f32", offset: 8 },
    { source: { kind: "param", key: LINE_SCREEN_PARAM.angle }, type: "f32", offset: 12 },
    { source: { kind: "param", key: LINE_SCREEN_PARAM.duty }, type: "f32", offset: 16 },
    { source: { kind: "param", key: LINE_SCREEN_PARAM.phase }, type: "f32", offset: 20 },
    { source: { kind: "param", key: LINE_SCREEN_PARAM.spread }, type: "f32", offset: 24 },
  ],
};

const descriptor = defineEffect({
  id: "line-screen",
  name: "Line screen",
  requirement: "F-PT-03",
  slot: "dither",
  family: "pattern",
  execution: "gpu",
  params: [
    {
      key: LINE_SCREEN_PARAM.pitch,
      label: "Pitch",
      type: "float",
      hint: "Pixels between line centres.",
      animatable: true,
      legal: [1, 256],
      default: 6,
      // Log, because pitch is measured in octaves: uniform sampling of 1..256
      // spends most of its draws above 100, where the screen is two bars.
      surprise: { range: [2, 24], distribution: { kind: "log" }, weight: 1.2 },
    },
    {
      key: LINE_SCREEN_PARAM.angle,
      label: "Angle",
      type: "float",
      hint: "Direction of the lines, in degrees. 0 is horizontal.",
      animatable: true,
      legal: [-180, 180],
      default: 45,
      surprise: { range: [-90, 90], distribution: { kind: "uniform" }, weight: 1 },
    },
    {
      key: LINE_SCREEN_PARAM.duty,
      label: "Duty cycle",
      type: "float",
      // Scales the ink demand rather than offsetting it, so paper white stays
      // paper white at every setting and only the mid and shadow tones move.
      hint: "Line width as a fraction of the pitch at 50% tone. 0.5 reproduces tone exactly.",
      animatable: true,
      legal: [0.05, 0.95],
      default: 0.5,
      surprise: { range: [0.3, 0.7], distribution: { kind: "uniform" }, weight: 0.7 },
    },
    {
      key: LINE_SCREEN_PARAM.phase,
      label: "Phase",
      type: "float",
      // In pitches, so a modulator ramping 0 -> 1 slides the grating by exactly
      // one line and lands back where it started: the loop closes by
      // construction rather than by the UI knowing that some number is special.
      hint: "Shifts the grating across the lines, in pitches.",
      animatable: true,
      legal: [-1024, 1024],
      default: 0,
      surprise: { range: [-1, 1], distribution: { kind: "uniform" }, weight: 0.5 },
    },
    {
      key: LINE_SCREEN_PARAM.spread,
      label: "Spread",
      type: "float",
      hint: "Screen strength. 0 is plain quantization, 1 reproduces tone exactly.",
      animatable: true,
      legal: [0, 2],
      default: 1,
      surprise: { range: [0.6, 1.2], distribution: { kind: "uniform" }, weight: 0.8 },
    },
  ],
  surpriseWeight: 0.9,
  // Quantizing is the point: the index map it emits is what makes outline,
  // dilate/erode, hue-targeted recolour and the tracer lossless downstream.
  producesIndexMap: true,
  requiresIndexMap: false,
});

export default descriptor;

/**
 * Parameter descriptors keyed for `packUniforms`.
 *
 * Every line-screen control is a float, so this map is only ever consulted to
 * confirm that — but the packer takes it for every effect.
 */
export const LINE_SCREEN_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  descriptor.params.map((param) => [param.key, param]),
);

/** The compute pass. One dispatch: the grating is a function of the coordinate. */
export function lineScreenEffect(): GpuEffect {
  const bindings: readonly PassBinding[] = [
    { role: "input-color", binding: LINE_SCREEN_BINDING.inputColor },
    { role: "output-color", binding: LINE_SCREEN_BINDING.outputColor },
    { role: "output-index", binding: LINE_SCREEN_BINDING.outputIndex },
    { role: "palette", binding: LINE_SCREEN_BINDING.palette },
    { role: "uniforms", binding: LINE_SCREEN_BINDING.uniforms },
  ];

  const pass: ComputePass = {
    id: `${descriptor.id}/screen`,
    label: `${descriptor.name} screen`,
    wgsl,
    entryPoint: "main",
    // 64 invocations, well under the 256 guaranteed everywhere.
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    // Reads only its own pixel: the grating comes from the coordinate, not from
    // a neighbour.
    access: "pointwise",
    bindings,
    uniforms: LINE_SCREEN_UNIFORMS,
  };

  return { effect: descriptor.id, passes: [pass] };
}
