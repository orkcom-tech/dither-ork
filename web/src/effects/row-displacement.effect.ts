/**
 * Row displacement (F-GL-02).
 *
 * Horizontal slices of seeded height, each shifted sideways by a seeded amount.
 *
 * Two passes, and the first is a single invocation. Slice heights are drawn one
 * after another, so which slice a row belongs to depends on every slice above
 * it — the walk is sequential by construction. Running it once into a per-row
 * buffer costs one iteration per row; the alternatives are to make every pixel
 * repeat the walk, or to give up control of the slice heights by jittering a
 * fixed grid, and the requirement asks for seeded slice heights.
 *
 * **Everything is a fraction of the image, never a pixel count.** Preview and
 * export are the same graph at two resolutions, so a displacement measured in
 * pixels would produce a different picture on export. That is also why the
 * effect reads its own `width`/`height` builtins rather than assuming one.
 */

import type { EffectDescriptor, ParamDescriptor } from "../types/registry";
import type { ComputePass, GpuEffect, PassBinding, UniformLayout } from "../types/gpu";

import wgsl from "../shaders/row-displacement.wgsl?raw";

/** Canonical binding numbers, restated from CONVENTIONS.md. */
export const ROW_DISPLACEMENT_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
  /** One signed pixel offset per row. */
  offsets: 6,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const ROW_DISPLACEMENT_PARAM = {
  minSliceHeight: "minSliceHeight",
  maxSliceHeight: "maxSliceHeight",
  offsetRange: "offsetRange",
  probability: "probability",
  edge: "edge",
  seed: "seed",
} as const;

/**
 * `struct Params` in `row-displacement.wgsl`, byte for byte. Eight 4-byte
 * scalars in a run, so the block is exactly 32 bytes with no implicit padding.
 */
export const ROW_DISPLACEMENT_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: ROW_DISPLACEMENT_PARAM.seed }, type: "u32", offset: 8 },
    { source: { kind: "param", key: ROW_DISPLACEMENT_PARAM.edge }, type: "u32", offset: 12 },
    {
      source: { kind: "param", key: ROW_DISPLACEMENT_PARAM.minSliceHeight },
      type: "f32",
      offset: 16,
    },
    {
      source: { kind: "param", key: ROW_DISPLACEMENT_PARAM.maxSliceHeight },
      type: "f32",
      offset: 20,
    },
    {
      source: { kind: "param", key: ROW_DISPLACEMENT_PARAM.offsetRange },
      type: "f32",
      offset: 24,
    },
    {
      source: { kind: "param", key: ROW_DISPLACEMENT_PARAM.probability },
      type: "f32",
      offset: 28,
    },
  ],
};

/**
 * The edge rule.
 *
 * Restated in each glitch effect that reads outside the frame rather than
 * imported from a neighbour: one effect is one file, and an effect file that
 * imports from another effect file makes deleting either of them a two-file
 * edit. The order is load-bearing — it is the shader's `EDGE_*` constants, and
 * the packer sends the ordinal, so inserting a value in the middle renumbers
 * every document already saved.
 */
const EDGE_VALUES = [
  { value: "clamp", label: "Hold edge" },
  { value: "wrap", label: "Wrap" },
  { value: "mirror", label: "Mirror" },
] as const;

const PARAMS: readonly ParamDescriptor[] = [
  {
    key: ROW_DISPLACEMENT_PARAM.minSliceHeight,
    label: "Min slice height",
    type: "float",
    hint: "Shortest slice, as a fraction of image height. Resolution-independent, so preview and export match.",
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
    key: ROW_DISPLACEMENT_PARAM.maxSliceHeight,
    label: "Max slice height",
    type: "float",
    // The two bounds are read as a range, so a max below the min is the same
    // range described backwards rather than an error.
    hint: "Tallest slice, as a fraction of image height.",
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
    key: ROW_DISPLACEMENT_PARAM.offsetRange,
    label: "Offset range",
    type: "float",
    hint: "Largest sideways shift, as a fraction of image width. Each slice draws within ±this.",
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
    key: ROW_DISPLACEMENT_PARAM.probability,
    label: "Slice density",
    type: "float",
    // At 1 every slice moves and the image turns to mush; the look depends on
    // most of the picture staying put.
    hint: "Chance that any given slice is displaced at all.",
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
    key: ROW_DISPLACEMENT_PARAM.edge,
    label: "Edge",
    type: "enum",
    hint: "What a slice shows where it has been shifted off the frame.",
    animatable: false,
    values: [...EDGE_VALUES],
    default: "wrap",
    surprise: {
      // Wrap is the tape-glitch look this effect is for; holding the edge
      // smears and mirror reads as a reflection rather than a tear.
      values: [
        { value: "wrap", weight: 1 },
        { value: "clamp", weight: 0.5 },
        { value: "mirror", weight: 0.4 },
      ],
      weight: 0.5,
    },
  },
  {
    key: ROW_DISPLACEMENT_PARAM.seed,
    label: "Seed",
    type: "seed",
    hint: "Reroll the slice heights and their offsets.",
    animatable: false,
    default: 0,
    surprise: { weight: 1 },
  },
];

const descriptor: EffectDescriptor = {
  id: "row-displacement",
  name: "Row displacement",
  requirement: "F-GL-02",
  slot: "postprocess",
  family: "glitch",
  execution: "gpu",
  params: PARAMS,
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: false,
};

export default descriptor;

/**
 * One offset per row, shared between the two passes by slot name.
 *
 * `read-write` in both, including the pass that only reads it: one WGSL file
 * declares a binding once and the bind group layout has to match the access the
 * shader declared.
 */
const OFFSETS: PassBinding = {
  role: "scratch",
  binding: ROW_DISPLACEMENT_BINDING.offsets,
  slot: "offsets",
  access: "read-write",
  size: { kind: "per-row", bytesPerRow: 4 },
};

/**
 * The sequential half: one invocation walks the image top to bottom.
 *
 * `fixed` at one workgroup because the walk cannot be split — a slice's
 * position depends on the height of every slice above it.
 */
const BUILD_SLICES: ComputePass = {
  id: "row-displacement/slices",
  label: "Row displacement slices",
  wgsl,
  entryPoint: "build_slices",
  workgroupSize: [1, 1, 1],
  dispatch: { kind: "fixed", workgroups: [1, 1, 1] },
  access: "global",
  bindings: [{ role: "uniforms", binding: ROW_DISPLACEMENT_BINDING.uniforms }, OFFSETS],
  uniforms: ROW_DISPLACEMENT_UNIFORMS,
};

/** The parallel half: a lookup and a fetch. */
const APPLY: ComputePass = {
  id: "row-displacement/apply",
  label: "Row displacement apply",
  wgsl,
  entryPoint: "apply",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  // Reads an arbitrary column of its own row, so it is not pointwise and must
  // not alias its input.
  access: "global",
  bindings: [
    { role: "input-color", binding: ROW_DISPLACEMENT_BINDING.inputColor },
    { role: "output-color", binding: ROW_DISPLACEMENT_BINDING.outputColor },
    { role: "uniforms", binding: ROW_DISPLACEMENT_BINDING.uniforms },
    OFFSETS,
  ],
  uniforms: ROW_DISPLACEMENT_UNIFORMS,
};

export const rowDisplacementGpuEffect: GpuEffect = {
  effect: descriptor.id,
  passes: [BUILD_SLICES, APPLY],
};

/** Parameter descriptors keyed for `packUniforms`, which needs them for enums. */
export const ROW_DISPLACEMENT_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  PARAMS.map((param) => [param.key, param]),
);
