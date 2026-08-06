/**
 * Noise burst (F-GL-17).
 *
 * "Seeded regional corruption, density and size." The frame is tiled into
 * cells; each cell draws one number from a hash of its grid coordinate and the
 * seed, and bursts if that number falls under `density`. Inside a bursting cell
 * every pixel is replaced — `intensity` of the way — with seeded noise.
 *
 * The regions are a grid rather than free-floating rectangles because a grid is
 * addressable: a pixel can decide whether it is inside a burst from its own
 * coordinate alone, which keeps the whole effect one pointwise dispatch. Random
 * rectangles would need either a list of them in a storage buffer, built by a
 * pass that has no natural dispatch shape, or a per-pixel search over every
 * candidate region. `aspect` recovers the part of that freedom that carries the
 * look — wide streaks instead of square blocks — for the price of one slider.
 *
 * **This effect has a seed and it is a real one.** Cell selection and pixel
 * noise are drawn through different domain constants from the same seed, so
 * turning the density up does not reshuffle the noise inside cells that were
 * already bursting. The noise itself is uniform in the *encoded* domain and
 * converted to linear light before it lands in the buffer; the shader explains
 * why, and it is the difference between noise and a white block.
 */

import {
  defineEffect,
  type ParamDescriptor,
  staticGpuEffect,
} from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/noise-burst.wgsl?raw";

/** Canonical binding numbers, restated from CONVENTIONS.md. */
export const NOISE_BURST_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const NOISE_BURST_PARAM = {
  seed: "seed",
  mode: "mode",
  cellSize: "cellSize",
  aspect: "aspect",
  density: "density",
  intensity: "intensity",
} as const;

/**
 * Largest cell offered, in pixels.
 *
 * At the working resolutions this application renders at, a 512px cell is
 * already a substantial fraction of the frame, so the control has run out of
 * picture rather than out of range.
 */
const MAX_CELL_SIZE = 512;

/**
 * Bounds on the cell aspect ratio.
 *
 * Symmetric in the multiplicative sense — 1/20 and 20 — so the control reaches
 * a tall sliver and a wide streak equally far. Both ends are strictly positive,
 * which is also what lets the surprise range sample in log space.
 */
const MIN_ASPECT = 0.05;
const MAX_ASPECT = 20;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/noise-burst.wgsl`.
 *
 * Eight 4-byte scalars fill 32 bytes exactly, so there is no tail padding to
 * declare — which is why that shader's struct is the one of the four with no
 * `pad` members.
 */
export const NOISE_BURST_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: NOISE_BURST_PARAM.seed }, type: "u32", offset: 8 },
    { source: { kind: "param", key: NOISE_BURST_PARAM.mode }, type: "u32", offset: 12 },
    { source: { kind: "param", key: NOISE_BURST_PARAM.cellSize }, type: "f32", offset: 16 },
    { source: { kind: "param", key: NOISE_BURST_PARAM.aspect }, type: "f32", offset: 20 },
    { source: { kind: "param", key: NOISE_BURST_PARAM.density }, type: "f32", offset: 24 },
    { source: { kind: "param", key: NOISE_BURST_PARAM.intensity }, type: "f32", offset: 28 },
  ],
};

const NOISE_BURST_PARAMS: readonly ParamDescriptor[] = [
  {
    key: NOISE_BURST_PARAM.seed,
    label: "Seed",
    type: "seed",
    // Not animatable. A modulator produces a continuous number and a seed is a
    // label, not a quantity — interpolating between two seeds is meaningless,
    // and per-frame variation is the temporal-variation system's job, where it
    // can be made periodic in the loop length rather than merely different.
    animatable: false,
    hint: "Which corruption. Every seed is as good as every other; the same seed always gives the same bursts.",
    default: 0,
    surprise: { weight: 1 },
  },
  {
    key: NOISE_BURST_PARAM.density,
    label: "Density",
    type: "float",
    animatable: true,
    hint: "Fraction of cells that burst.",
    legal: [0, 1],
    default: 0.15,
    step: 0.01,
    surprise: {
      // 1 is legal and destroys the image entirely; the musical range stops
      // where the source is still recognisable under the corruption (F-SM-04).
      range: [0.05, 0.5],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: NOISE_BURST_PARAM.cellSize,
    label: "Burst size",
    type: "float",
    animatable: true,
    hint: "Height of one cell in pixels, and its width before the aspect ratio is applied.",
    legal: [1, MAX_CELL_SIZE],
    default: 24,
    surprise: {
      // Log: size is measured in octaves, and uniform sampling of 4..96 spends
      // most of its draws above 48, where every result is the same few blocks.
      range: [4, 96],
      distribution: { kind: "log" },
      weight: 1,
    },
  },
  {
    key: NOISE_BURST_PARAM.aspect,
    label: "Burst aspect",
    type: "float",
    animatable: true,
    hint: "Cell width relative to its height. Above 1 gives horizontal streaks, below 1 vertical slivers.",
    legal: [MIN_ASPECT, MAX_ASPECT],
    // Square. The aspect is a departure from the plain reading of "size", so
    // the default is the value at which it is not doing anything.
    default: 1,
    surprise: {
      // Weighted towards wide, because horizontal streaks are what a corrupt
      // scan looks like and vertical slivers are the rarer accident.
      range: [0.5, 8],
      distribution: { kind: "log" },
      weight: 0.8,
    },
  },
  {
    key: NOISE_BURST_PARAM.intensity,
    label: "Intensity",
    type: "float",
    animatable: true,
    hint: "How completely the noise replaces the image inside a bursting cell.",
    legal: [0, 1],
    // Full replacement: a burst is data that was lost, not data that was
    // dimmed. Partial intensity is the deliberate softening.
    default: 1,
    step: 0.01,
    surprise: {
      // Below ~0.6 the burst reads as grain over the picture rather than as a
      // hole in it, which is F-SP-16's job.
      range: [0.6, 1],
      distribution: { kind: "uniform" },
      weight: 0.6,
    },
  },
  {
    key: NOISE_BURST_PARAM.mode,
    label: "Noise colour",
    type: "enum",
    animatable: false,
    hint: "Per channel gives coloured static; monochrome gives one grey level per pixel.",
    values: [
      { value: "rgb", label: "Per channel" },
      { value: "mono", label: "Monochrome" },
    ],
    default: "rgb",
    surprise: {
      // Per-channel is what corrupt samples actually look like. Monochrome is
      // the tidier deviation, and it survives a small palette better, so it is
      // drawn but not often.
      values: [
        { value: "rgb", weight: 3 },
        { value: "mono", weight: 1 },
      ],
      weight: 0.5,
    },
  },
];

export default defineEffect({
  id: "noise-burst",
  name: "Noise burst",
  requirement: "F-GL-17",
  slot: "postprocess",
  family: "glitch",
  execution: "gpu",
  params: NOISE_BURST_PARAMS,
  surpriseWeight: 0.8,
  producesIndexMap: false,
  requiresIndexMap: false,
});

/** Parameter descriptors keyed for `packUniforms`, which needs them for enums. */
export const NOISE_BURST_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  NOISE_BURST_PARAMS.map((param) => [param.key, param]),
);

/** Defaults, for a node created without an explicit parameter set. */
export function noiseBurstDefaults(): Record<string, number | string> {
  return {
    [NOISE_BURST_PARAM.seed]: 0,
    [NOISE_BURST_PARAM.density]: 0.15,
    [NOISE_BURST_PARAM.cellSize]: 24,
    [NOISE_BURST_PARAM.aspect]: 1,
    [NOISE_BURST_PARAM.intensity]: 1,
    [NOISE_BURST_PARAM.mode]: "rgb",
  };
}

/** The compute pass. */
export function noiseBurstEffect(): GpuEffect {
  const bindings: readonly PassBinding[] = [
    { role: "input-color", binding: NOISE_BURST_BINDING.inputColor },
    { role: "output-color", binding: NOISE_BURST_BINDING.outputColor },
    { role: "uniforms", binding: NOISE_BURST_BINDING.uniforms },
  ];

  const pass: ComputePass = {
    id: "noise-burst/corrupt",
    label: "Noise burst corrupt",
    wgsl,
    entryPoint: "main",
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    // Reads only its own pixel; which cell it belongs to comes from its
    // coordinate, and the noise from a hash of that coordinate and the seed.
    access: "pointwise",
    bindings,
    uniforms: NOISE_BURST_UNIFORMS,
  };

  return { effect: "noise-burst", passes: [pass] };
}

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("noise-burst", () => noiseBurstEffect());
