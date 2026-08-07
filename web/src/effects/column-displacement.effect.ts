/**
 * Column displacement (F-GL-03).
 *
 * Row displacement turned ninety degrees: vertical slices of seeded width, each
 * shifted up or down by a seeded amount. Same two-pass shape, same reason — the
 * slice a column belongs to depends on every slice to its left, so the walk is
 * sequential and is run once into a per-column buffer.
 *
 * **Scratch is sized per-pixel although only `width` entries are used.**
 * `ScratchSize` offers `fixed`, `per-pixel` and `per-row`; there is no
 * per-column rule, and the two candidates are both wrong in one direction. A
 * `fixed` size is a constant that a wide enough image outgrows — and a storage
 * buffer read past its end returns zeroes rather than failing, so the symptom
 * would be a band of undisplaced columns on exactly the large exports where
 * nobody is watching. `per-row` scales with height, which is the wrong
 * dimension entirely. `per-pixel` at four bytes is `4 * width * height` where
 * `4 * width` is needed: always large enough, and wasteful in proportion to the
 * height. That is the trade taken deliberately; the fix belongs in
 * `web/src/types/gpu.ts` as a `per-column` rule and is reported rather than
 * worked around here.
 */

import type { EffectDescriptor, ParamDescriptor } from "../types/registry";
import { staticGpuEffect } from "../types/registry";
import type { ComputePass, GpuEffect, PassBinding, UniformLayout } from "../types/gpu";

import wgsl from "../shaders/column-displacement.wgsl?raw";

/** Canonical binding numbers, restated from CONVENTIONS.md. */
export const COLUMN_DISPLACEMENT_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
  /** One signed pixel offset per column. */
  offsets: 6,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const COLUMN_DISPLACEMENT_PARAM = {
  minSliceWidth: "minSliceWidth",
  maxSliceWidth: "maxSliceWidth",
  offsetRange: "offsetRange",
  probability: "probability",
  edge: "edge",
  seed: "seed",
} as const;

/**
 * `struct Params` in `column-displacement.wgsl`, byte for byte. Eight 4-byte
 * scalars in a run, so the block is exactly 32 bytes with no implicit padding.
 */
export const COLUMN_DISPLACEMENT_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: COLUMN_DISPLACEMENT_PARAM.seed }, type: "u32", offset: 8 },
    { source: { kind: "param", key: COLUMN_DISPLACEMENT_PARAM.edge }, type: "u32", offset: 12 },
    {
      source: { kind: "param", key: COLUMN_DISPLACEMENT_PARAM.minSliceWidth },
      type: "f32",
      offset: 16,
    },
    {
      source: { kind: "param", key: COLUMN_DISPLACEMENT_PARAM.maxSliceWidth },
      type: "f32",
      offset: 20,
    },
    {
      source: { kind: "param", key: COLUMN_DISPLACEMENT_PARAM.offsetRange },
      type: "f32",
      offset: 24,
    },
    {
      source: { kind: "param", key: COLUMN_DISPLACEMENT_PARAM.probability },
      type: "f32",
      offset: 28,
    },
  ],
};

/**
 * The edge rule.
 *
 * Restated here rather than imported from a neighbouring effect: one effect is
 * one file, and an effect file that imports from another makes deleting either
 * of them a two-file edit. The order is load-bearing — it is the shader's
 * `EDGE_*` constants, and the packer sends the ordinal, so inserting a value in
 * the middle renumbers every document already saved.
 */
const EDGE_VALUES = [
  { value: "clamp", label: "Hold edge" },
  { value: "wrap", label: "Wrap" },
  { value: "mirror", label: "Mirror" },
] as const;

const PARAMS: readonly ParamDescriptor[] = [
  {
    key: COLUMN_DISPLACEMENT_PARAM.minSliceWidth,
    label: "Min slice width",
    type: "float",
    description: "Narrowest slice, as a fraction of image width. Resolution-independent, so preview and export match.",
    animatable: true,
    legal: [0.002, 0.5],
    default: 0.008,
    surprise: {
      // Log: measured in octaves. Uniform sampling of 0.003..0.03 spends most
      // of its draws in the top octave, where every result looks the same.
      range: [0.003, 0.03],
      distribution: { kind: "log" },
      weight: 0.8,
    },
  },
  {
    key: COLUMN_DISPLACEMENT_PARAM.maxSliceWidth,
    label: "Max slice width",
    type: "float",
    // The two bounds are read as a range, so a max below the min is the same
    // range described backwards rather than an error.
    description: "Widest slice, as a fraction of image width.",
    animatable: true,
    legal: [0.002, 0.5],
    default: 0.05,
    surprise: {
      range: [0.02, 0.18],
      distribution: { kind: "log" },
      weight: 1,
    },
  },
  {
    key: COLUMN_DISPLACEMENT_PARAM.offsetRange,
    label: "Offset range",
    type: "float",
    description: "Largest vertical shift, as a fraction of image height. Each slice draws within ±this.",
    animatable: true,
    legal: [0, 1],
    default: 0.06,
    surprise: {
      // Stops well short of the legal 1: past about a third the slices no
      // longer read as displaced, they read as unrelated strips (F-SM-04).
      range: [0.01, 0.3],
      distribution: { kind: "log" },
      weight: 1,
    },
  },
  {
    key: COLUMN_DISPLACEMENT_PARAM.probability,
    label: "Slice density",
    type: "float",
    // At 1 every slice moves and the image turns to mush; the look depends on
    // most of the picture staying put.
    description: "Chance that any given slice is displaced at all.",
    animatable: true,
    legal: [0, 1],
    default: 0.35,
    step: 0.01,
    surprise: {
      range: [0.15, 0.7],
      distribution: { kind: "uniform" },
      weight: 0.9,
    },
  },
  {
    key: COLUMN_DISPLACEMENT_PARAM.edge,
    label: "Edge",
    type: "enum",
    description: "What a slice shows where it has been shifted off the frame.",
    animatable: false,
    values: [...EDGE_VALUES],
    default: "wrap",
    surprise: {
      values: [
        { value: "wrap", weight: 1 },
        { value: "clamp", weight: 0.5 },
        { value: "mirror", weight: 0.4 },
      ],
      weight: 0.5,
    },
  },
  {
    key: COLUMN_DISPLACEMENT_PARAM.seed,
    label: "Seed",
    type: "seed",
    description: "Reroll the slice widths and their offsets.",
    animatable: false,
    default: 0,
    surprise: { weight: 1 },
  },
];

const descriptor: EffectDescriptor = {
  id: "column-displacement",
  name: "Column displacement",
  summary:
    "Row displacement turned ninety degrees — vertical slices of random width, each shifted up or down.",
  description:
    "Slice widths and vertical offsets are drawn from the seed exactly as the row version draws heights and horizontal offsets, so the two are the same effect on the other axis and are commonly stacked together for a shattered result. Like its sibling it displaces by a seed rather than by a geometric function or by the picture. Sizes are fractions of the image, so preview and export agree.",
  keywords: ["column", "columns", "vertical", "displace", "displacement", "slice", "slices", "tear", "shift", "shatter", "broken"],
  concept: "glitch",
  requirement: "F-GL-03",
  slot: "postprocess",
  family: "glitch",
  execution: "gpu",
  params: PARAMS,
  // Slightly under row displacement: vertical tearing reads as a rendering
  // fault more often than horizontal tearing reads as a tape fault.
  surpriseWeight: 0.8,
  producesIndexMap: false,
  requiresIndexMap: false,
};

export default descriptor;

/**
 * One offset per column, shared between the two passes by slot name.
 *
 * `read-write` in both, including the pass that only reads it: one WGSL file
 * declares a binding once and the bind group layout has to match the access the
 * shader declared. See the module header for why the size rule is per-pixel.
 */
const OFFSETS: PassBinding = {
  role: "scratch",
  binding: COLUMN_DISPLACEMENT_BINDING.offsets,
  slot: "offsets",
  access: "read-write",
  size: { kind: "per-pixel", bytesPerPixel: 4 },
};

/**
 * The sequential half: one invocation walks the image left to right.
 *
 * `fixed` at one workgroup because the walk cannot be split — a slice's
 * position depends on the width of every slice before it.
 */
const BUILD_SLICES: ComputePass = {
  id: "column-displacement/slices",
  label: "Column displacement slices",
  wgsl,
  entryPoint: "build_slices",
  workgroupSize: [1, 1, 1],
  dispatch: { kind: "fixed", workgroups: [1, 1, 1] },
  access: "global",
  bindings: [{ role: "uniforms", binding: COLUMN_DISPLACEMENT_BINDING.uniforms }, OFFSETS],
  uniforms: COLUMN_DISPLACEMENT_UNIFORMS,
};

/** The parallel half: a lookup and a fetch. */
const APPLY: ComputePass = {
  id: "column-displacement/apply",
  label: "Column displacement apply",
  wgsl,
  entryPoint: "apply",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  // Reads an arbitrary row of its own column, so it is not pointwise and must
  // not alias its input.
  access: "global",
  bindings: [
    { role: "input-color", binding: COLUMN_DISPLACEMENT_BINDING.inputColor },
    { role: "output-color", binding: COLUMN_DISPLACEMENT_BINDING.outputColor },
    { role: "uniforms", binding: COLUMN_DISPLACEMENT_BINDING.uniforms },
    OFFSETS,
  ],
  uniforms: COLUMN_DISPLACEMENT_UNIFORMS,
};

export const columnDisplacementGpuEffect: GpuEffect = {
  effect: descriptor.id,
  passes: [BUILD_SLICES, APPLY],
};

/** Parameter descriptors keyed for `packUniforms`, which needs them for enums. */
export const COLUMN_DISPLACEMENT_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  PARAMS.map((param) => [param.key, param]),
);

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("column-displacement", () => columnDisplacementGpuEffect);
