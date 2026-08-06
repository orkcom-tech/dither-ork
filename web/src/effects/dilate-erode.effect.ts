/**
 * Dilate / erode on the index map (F-SP-11).
 *
 * One compute pass, `neighbourhood` access. Binary morphology over one palette
 * region: dilation grows the region named by `targetIndex` by the structuring
 * element, erosion shrinks it. The index map is the set membership function, so
 * both operations are exact integer comparisons with no threshold anywhere —
 * which is the whole reason the pipeline carries an index map
 * (docs/ARCHITECTURE.md, "Data layout").
 *
 * It writes the index map as well as the colour buffer, for the same reason
 * outline (F-SP-10) does: a node that moved a region boundary in colour while
 * leaving the map behind would hand the next index-map consumer a segmentation
 * that no longer describes the pixels.
 *
 * The two arguments that are really about the algorithm — why the operation
 * names one region instead of running greyscale morphology over the index as an
 * ordinate, and where erosion puts the pixels it takes out of the region — are
 * in `../shaders/dilate-erode.wgsl`, next to the code they govern.
 */

import { staticGpuEffect, defineEffect, type ParamDescriptor } from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/dilate-erode.wgsl?raw";

/** Canonical binding numbers, restated from `shaders/CONVENTIONS.md`. */
export const DILATE_ERODE_BINDING = {
  inputColor: 0,
  outputColor: 1,
  inputIndex: 2,
  outputIndex: 3,
  palette: 4,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const DILATE_ERODE_PARAM = {
  operation: "operation",
  targetIndex: "targetIndex",
  radius: "radius",
  shape: "shape",
} as const;

/**
 * Largest structuring element offered.
 *
 * The search is a square of side `2r + 1` per pixel, so cost is O(r²): 8 is 289
 * index taps, which puts it alongside outline as the most expensive per-pixel
 * pass in the catalogue. A wider element wants a different algorithm — separable
 * morphology, two passes, O(r) — not a bigger number here. Stated as a constant
 * because `MAX_RADIUS` in the shader restates it, and the shader floors the
 * value so a hand-edited document cannot hang a frame.
 */
const MAX_RADIUS = 8;

/**
 * Highest palette index a parameter may name.
 *
 * Same bound and same reasoning as outline's: the index map is written by
 * quantizers whose palettes are hardware colour specifications or extractions
 * with a selectable K, and 256 covers both with room. A target above the
 * palette's actual count matches nothing, which the shader handles by doing
 * nothing rather than by clamping onto a region the user did not name.
 */
const MAX_PALETTE_INDEX = 255;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/dilate-erode.wgsl`. Six 4-byte scalars — 24 bytes in a block WGSL
 * rounds up to 32.
 */
export const DILATE_ERODE_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: DILATE_ERODE_PARAM.operation }, type: "u32", offset: 8 },
    { source: { kind: "param", key: DILATE_ERODE_PARAM.targetIndex }, type: "u32", offset: 12 },
    { source: { kind: "param", key: DILATE_ERODE_PARAM.radius }, type: "u32", offset: 16 },
    { source: { kind: "param", key: DILATE_ERODE_PARAM.shape }, type: "u32", offset: 20 },
  ],
};

export const DILATE_ERODE_PARAMS: readonly ParamDescriptor[] = [
  {
    key: DILATE_ERODE_PARAM.operation,
    label: "Operation",
    type: "enum",
    hint: "Grow the region into its neighbours, or shrink it back into them.",
    // Not animatable: this is a choice between two operations, and a modulator
    // ramping across the boundary between them would produce a hard cut rather
    // than a transition. Radius is the animatable axis.
    animatable: false,
    values: [
      { value: "dilate", label: "Dilate" },
      { value: "erode", label: "Erode" },
    ],
    default: "dilate",
    surprise: {
      // Even weights. Neither is the special case: on a two-entry palette
      // dilating entry 0 and eroding entry 1 are the same picture, and on a
      // larger one they are genuinely different looks.
      values: [
        { value: "dilate", weight: 1 },
        { value: "erode", weight: 1 },
      ],
      weight: 1,
    },
  },
  {
    key: DILATE_ERODE_PARAM.targetIndex,
    label: "Region",
    type: "int",
    hint: "Which palette entry's regions grow or shrink.",
    animatable: false,
    legal: [0, MAX_PALETTE_INDEX],
    default: 0,
    surprise: {
      // Most palettes here are small — hardware specifications and extractions
      // with a low K — so a draw above about 8 usually names an entry that does
      // not exist, and morphology on nothing is a reroll that looks broken.
      range: [0, 7],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: DILATE_ERODE_PARAM.radius,
    label: "Radius",
    type: "int",
    hint: "How far the region moves, in pixels.",
    animatable: true,
    legal: [1, MAX_RADIUS],
    default: 1,
    surprise: {
      // Past about 3 a dilate swallows the regions it was meant to thicken, and
      // it is also where the O(r²) search starts to cost something on a preview
      // drag.
      range: [1, 3],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: DILATE_ERODE_PARAM.shape,
    label: "Element shape",
    type: "enum",
    hint: "Disc or square structuring element. Only visible above a radius of about 2.",
    animatable: false,
    values: [
      { value: "round", label: "Round" },
      { value: "square", label: "Square" },
    ],
    default: "round",
    surprise: {
      values: [
        { value: "round", weight: 1 },
        { value: "square", weight: 0.6 },
      ],
      // Low: at the radii a reroll draws, this changes four pixels per corner.
      weight: 0.4,
    },
  },
];

/**
 * Parameter descriptors keyed for `packUniforms`. Two of the four are enums,
 * whose document value is a string and whose numeric form is its position in
 * `values`, so the packer cannot resolve them without this.
 */
export const DILATE_ERODE_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  DILATE_ERODE_PARAMS.map((param) => [param.key, param]),
);

const bindings: readonly PassBinding[] = [
  { role: "input-color", binding: DILATE_ERODE_BINDING.inputColor },
  { role: "output-color", binding: DILATE_ERODE_BINDING.outputColor },
  { role: "input-index", binding: DILATE_ERODE_BINDING.inputIndex },
  { role: "output-index", binding: DILATE_ERODE_BINDING.outputIndex },
  { role: "palette", binding: DILATE_ERODE_BINDING.palette },
  { role: "uniforms", binding: DILATE_ERODE_BINDING.uniforms },
];

const pass: ComputePass = {
  id: "dilate-erode/main",
  label: "Dilate / erode",
  wgsl,
  entryPoint: "main",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  // Reads a bounded window around its pixel, so it must not alias its input and
  // must not start before the pass before it has finished writing.
  access: "neighbourhood",
  bindings,
  uniforms: DILATE_ERODE_UNIFORMS,
};

/** The compute pass, for the pass compiler. */
export const DILATE_ERODE_GPU: GpuEffect = {
  effect: "dilate-erode",
  passes: [pass],
};

export default defineEffect({
  id: "dilate-erode",
  name: "Dilate / erode",
  requirement: "F-SP-11",
  // Postprocess by necessity, not by taste: it reads the index map, and
  // `validateEffect` rejects an index-map consumer in the preprocess slot
  // because nothing has quantized yet at that point.
  slot: "postprocess",
  family: "special",
  execution: "gpu",
  params: DILATE_ERODE_PARAMS,
  // Below 1: it is a retouching tool for an already-dithered image — thickening
  // a stroke, closing speckle — rather than a look in its own right.
  surpriseWeight: 0.6,
  // Writes both halves of the buffer, so the index map still describes the
  // pixels beside it after this node has run.
  producesIndexMap: true,
  requiresIndexMap: true,
});

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("dilate-erode", () => DILATE_ERODE_GPU);
