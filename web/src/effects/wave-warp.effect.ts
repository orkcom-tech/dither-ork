/**
 * F-GL-10 — Wave warp.
 *
 * Sine or triangle displacement with amplitude, frequency and axis, as the
 * requirement names them, plus the two decisions the requirement leaves open
 * and a shader cannot: what happens off the edge, and whether the resampling is
 * smooth or nearest. Both are exposed rather than fixed, because both are looks
 * people ask for by name and neither has a defensible default that makes the
 * other unreachable.
 *
 * Unlike the rest of the glitch family this effect declares **no seed**. It is
 * pure geometry — a wave is a shape, not a draw — and a seed parameter that
 * nothing reads is a control in the properties panel that moves nothing.
 *
 * Both the descriptor and the compute pass live in this file. The ordered
 * dithers keep theirs in `web/src/gpu/effects/ordered.ts` because five effects
 * share one uniform layout there and a rename has to break in one place; a
 * single effect with a layout of its own has no second place to drift to, and
 * keeping the two halves adjacent is what makes the parameter keys and the
 * shader's `struct Params` checkable side by side.
 */

import type { ParameterValue } from "../types/document";
import type { ComputePass, GpuEffect, PassBinding, UniformLayout } from "../types/gpu";
import { staticGpuEffect, defineEffect } from "../types/registry";
import type { EffectDescriptor, ParamDescriptor } from "../types/registry";

import wgsl from "../shaders/wave-warp.wgsl?raw";

const EFFECT_ID = "wave-warp";

/**
 * Canonical binding numbers, restated from CONVENTIONS.md.
 *
 * Bindings 2, 3 and 4 are absent: the warp moves pixels without looking at what
 * they mean, so it neither reads nor writes an index map and never consults the
 * palette.
 */
export const WAVE_WARP_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const WAVE_WARP_PARAM = {
  amplitude: "amplitude",
  frequency: "frequency",
  phase: "phase",
  waveform: "waveform",
  axis: "axis",
  edges: "edges",
  smoothing: "smoothing",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `web/src/shaders/wave-warp.wgsl`.
 *
 * Nine 4-byte scalars in a run, so nothing needs padding in front of it and the
 * only padding is the tail that rounds 36 up to 48. The two enums and the bool
 * arrive as `u32`: `packUniforms` resolves an enum to its ordinal and a bool to
 * 0 or 1, and the shader compares against the `WAVE_*`, `AXIS_*` and `EDGE_*`
 * constants that restate the declaration order below.
 */
export const WAVE_WARP_UNIFORMS: UniformLayout = {
  sizeBytes: 48,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: WAVE_WARP_PARAM.amplitude }, type: "f32", offset: 8 },
    { source: { kind: "param", key: WAVE_WARP_PARAM.frequency }, type: "f32", offset: 12 },
    { source: { kind: "param", key: WAVE_WARP_PARAM.phase }, type: "f32", offset: 16 },
    { source: { kind: "param", key: WAVE_WARP_PARAM.waveform }, type: "u32", offset: 20 },
    { source: { kind: "param", key: WAVE_WARP_PARAM.axis }, type: "u32", offset: 24 },
    { source: { kind: "param", key: WAVE_WARP_PARAM.edges }, type: "u32", offset: 28 },
    { source: { kind: "param", key: WAVE_WARP_PARAM.smoothing }, type: "u32", offset: 32 },
  ],
};

const PARAMS = [
  {
    key: WAVE_WARP_PARAM.amplitude,
    label: "Amplitude",
    type: "float",
    hint: "How far the wave pushes the image, in pixels.",
    animatable: true,
    legal: [0, 512],
    default: 12,
    step: 0.5,
    surprise: {
      // Legal goes to half a thousand pixels because a deliberate full-frame
      // smear is a real request; past about fifty the picture stops being
      // recognisable, which is not what a random document should mostly be.
      range: [2, 48],
      // Amplitude is read in octaves — the step from 2 to 4 is the same visual
      // change as 24 to 48 — so uniform sampling would spend most draws in the
      // top octave and every surprise would look the same.
      distribution: { kind: "log" },
      weight: 1.2,
    },
  },
  {
    key: WAVE_WARP_PARAM.frequency,
    label: "Frequency",
    type: "float",
    // Cycles across the image rather than pixels per cycle, so the shape of the
    // warp survives the resolution change between preview and export.
    hint: "Wave cycles across the image. 0 holds the image still.",
    animatable: true,
    legal: [0, 64],
    default: 3,
    step: 0.1,
    surprise: {
      range: [0.5, 12],
      distribution: { kind: "log" },
      weight: 1,
    },
  },
  {
    key: WAVE_WARP_PARAM.phase,
    label: "Phase",
    type: "float",
    // Turns, not degrees or radians: a modulator ramping 0 -> 1 lands back
    // where it started, so an animated wave closes the loop without the UI
    // having to know that some number is special (F-AN-03).
    hint: "Position along the wave, in turns. A 0 → 1 ramp scrolls it once.",
    animatable: true,
    legal: [-1, 1],
    default: 0,
    step: 0.01,
    surprise: {
      range: [0, 1],
      distribution: { kind: "uniform" },
      weight: 0.8,
    },
  },
  {
    key: WAVE_WARP_PARAM.waveform,
    label: "Waveform",
    type: "enum",
    hint: "Sine bends; triangle creases.",
    animatable: false,
    values: [
      { value: "sine", label: "Sine" },
      { value: "triangle", label: "Triangle" },
    ],
    default: "sine",
    surprise: {
      // Sine is the shape the effect is usually reached for. Triangle is the
      // deliberate deviation — it puts a hard crease at every peak — so it is
      // drawn, but less often.
      values: [
        { value: "sine", weight: 3 },
        { value: "triangle", weight: 1 },
      ],
      weight: 0.5,
    },
  },
  {
    key: WAVE_WARP_PARAM.axis,
    label: "Axis",
    type: "enum",
    hint: "Which way the image is pushed. Both gives a ripple.",
    animatable: false,
    values: [
      { value: "horizontal", label: "Horizontal" },
      { value: "vertical", label: "Vertical" },
      { value: "both", label: "Both" },
    ],
    default: "horizontal",
    surprise: {
      // Horizontal is the classic: rows sliding against each other reads as a
      // signal problem, which is what the glitch family is about. Both is a
      // ripple, which reads as water and pulls the result somewhere else.
      values: [
        { value: "horizontal", weight: 3 },
        { value: "vertical", weight: 2 },
        { value: "both", weight: 1 },
      ],
      weight: 0.9,
    },
  },
  {
    key: WAVE_WARP_PARAM.edges,
    label: "Edges",
    type: "enum",
    // Not an implementation detail left to a sampler's address mode: at any
    // useful amplitude the border band is a visible part of the result.
    hint: "What the wave finds past the border once it pushes off the image.",
    animatable: false,
    values: [
      { value: "mirror", label: "Mirror" },
      { value: "wrap", label: "Wrap" },
      { value: "clamp", label: "Clamp" },
    ],
    default: "mirror",
    surprise: {
      values: [
        { value: "mirror", weight: 3 },
        { value: "wrap", weight: 2 },
        // Clamp smears the border row across the whole excursion. It is a look,
        // and it is the one that reads as a mistake most often.
        { value: "clamp", weight: 1 },
      ],
      weight: 0.3,
    },
  },
  {
    key: WAVE_WARP_PARAM.smoothing,
    label: "Smooth resampling",
    type: "bool",
    hint: "Interpolate between texels. Off snaps the warp to whole pixels.",
    animatable: false,
    default: true,
    surprise: {
      // Off is a genuine look — it keeps the pixel grid intact, which matters
      // when the warp sits after a dither — but smooth is what the control is
      // usually wanted for.
      trueProbability: 0.75,
      weight: 0.4,
    },
  },
] as const satisfies readonly ParamDescriptor[];

const DESCRIPTOR = defineEffect({
  id: EFFECT_ID,
  name: "Wave warp",
  requirement: "F-GL-10",
  // Glitch effects sit after the primary dither in the stack grammar
  // (F-SM-03). A warp before one would be dithered over and disappear.
  slot: "postprocess",
  family: "glitch",
  execution: "gpu",
  params: PARAMS,
  surpriseWeight: 0.8,
  // It moves pixels without deciding what they are: nothing is quantized here,
  // and no index map is read.
  producesIndexMap: false,
  requiresIndexMap: false,
});

/** What the registry glob collects (`registry/discovery.ts`). */
export default DESCRIPTOR;

/** The same object under a name, for the GPU side. */
export const WAVE_WARP_DESCRIPTOR: EffectDescriptor = DESCRIPTOR;

const BINDINGS: readonly PassBinding[] = [
  { role: "input-color", binding: WAVE_WARP_BINDING.inputColor },
  { role: "output-color", binding: WAVE_WARP_BINDING.outputColor },
  { role: "uniforms", binding: WAVE_WARP_BINDING.uniforms },
];

const PASS: ComputePass = {
  id: `${EFFECT_ID}/warp`,
  label: "Wave warp",
  wgsl,
  entryPoint: "main",
  // 64 invocations, well under the 256 guaranteed everywhere.
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  // Every read sits within `amplitude` pixels of the pixel being written — a
  // window, taken modulo the image at the border — so it is not `pointwise` and
  // must not alias its input, but it is bounded and does not need `global`.
  access: "neighbourhood",
  bindings: BINDINGS,
  uniforms: WAVE_WARP_UNIFORMS,
};

export const WAVE_WARP_GPU: GpuEffect = { effect: EFFECT_ID, passes: [PASS] };

/** Parameter descriptors keyed for `packUniforms`, which resolves enum ordinals. */
export const WAVE_WARP_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  PARAMS.map((param) => [param.key, param]),
);

/** Defaults, for a node created without an explicit parameter set. */
export function waveWarpDefaults(): Record<string, ParameterValue> {
  const defaults: Record<string, ParameterValue> = {};
  for (const param of PARAMS) {
    switch (param.type) {
      case "float":
      case "enum":
      case "bool":
        defaults[param.key] = param.default;
        break;
    }
  }
  return defaults;
}

/** Descriptor and compute pass together, which is what the compiler takes. */
export function createWaveWarp(): {
  readonly descriptor: EffectDescriptor;
  readonly gpu: GpuEffect;
} {
  return { descriptor: DESCRIPTOR, gpu: WAVE_WARP_GPU };
}

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("wave-warp", () => WAVE_WARP_GPU);
