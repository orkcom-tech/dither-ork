/**
 * Outline / stroke around palette regions (F-SP-10).
 *
 * One compute pass, `neighbourhood` access. This is the first effect in the
 * catalogue that reads the index map, which is the whole reason the pipeline
 * carries one (docs/ARCHITECTURE.md, "Data layout"): a region boundary is an
 * integer inequality between two palette indices, exact and free, where the
 * same job on the colour buffer would be an edge detector that finds nothing
 * between two similar palette entries and finds edges everywhere in dither
 * noise.
 *
 * It writes the index map as well as the colour buffer. A stroke that changed
 * only the colours would leave every painted pixel indexed as the region
 * underneath it, and the next index-map consumer — dilate/erode, hue-targeted
 * recolour, the SVG tracer — would run the region boundary straight through the
 * middle of the stroke. That is also why the stroke colour is a palette entry
 * and not a free colour: there is no index for a colour the palette does not
 * contain.
 *
 * The two design arguments that are really about the algorithm — why the target
 * is one index rather than every boundary, and why out-of-frame neighbours are
 * clamped rather than skipped — are in `../shaders/outline.wgsl`, next to the
 * code they govern.
 */

import { staticGpuEffect, defineEffect, type ParamDescriptor } from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/outline.wgsl?raw";

/** Canonical binding numbers, restated from `shaders/CONVENTIONS.md`. */
export const OUTLINE_BINDING = {
  inputColor: 0,
  outputColor: 1,
  inputIndex: 2,
  outputIndex: 3,
  palette: 4,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const OUTLINE_PARAM = {
  strokeWidth: "strokeWidth",
  targetIndex: "targetIndex",
  colorIndex: "colorIndex",
  placement: "placement",
  shape: "shape",
} as const;

/**
 * Widest stroke offered.
 *
 * The search is a square of side `2w + 1` per pixel, so cost is O(w²): 8 is
 * 289 index taps per pixel, which is already the most expensive per-pixel pass
 * in the catalogue. A wider stroke wants a different algorithm — a separable
 * morphological dilation, two passes, O(w) — not a bigger number here. Stated
 * as a constant because `MAX_STROKE_WIDTH` in the shader restates it, and the
 * shader floors the value so a hand-edited document cannot hang a frame.
 */
const MAX_STROKE_WIDTH = 8;

/**
 * Highest palette index a parameter may name.
 *
 * The document palette has no declared ceiling, but the index map is written by
 * quantizers whose palettes are hardware colour specifications and extractions
 * with a selectable K, and 256 covers both with room. A target above the
 * palette's actual count matches nothing and a colour above it is floored to
 * the last entry — both in the shader, where the count is known.
 */
const MAX_PALETTE_INDEX = 255;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/outline.wgsl`. Seven 4-byte scalars — 28 bytes in a block WGSL
 * rounds up to 32.
 */
export const OUTLINE_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: OUTLINE_PARAM.strokeWidth }, type: "u32", offset: 8 },
    { source: { kind: "param", key: OUTLINE_PARAM.targetIndex }, type: "u32", offset: 12 },
    { source: { kind: "param", key: OUTLINE_PARAM.colorIndex }, type: "u32", offset: 16 },
    { source: { kind: "param", key: OUTLINE_PARAM.placement }, type: "u32", offset: 20 },
    { source: { kind: "param", key: OUTLINE_PARAM.shape }, type: "u32", offset: 24 },
  ],
};

export const OUTLINE_PARAMS: readonly ParamDescriptor[] = [
  {
    key: OUTLINE_PARAM.strokeWidth,
    label: "Stroke width",
    type: "int",
    description: "Thickness in pixels. Both sides places this much on each side of the boundary.",
    animatable: true,
    legal: [1, MAX_STROKE_WIDTH],
    default: 1,
    surprise: {
      // Past about 3 the stroke stops being a stroke and starts eating the
      // regions it is meant to describe — and it is also where the O(w²) search
      // starts to cost something on a preview drag.
      range: [1, 3],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: OUTLINE_PARAM.targetIndex,
    label: "Region",
    type: "int",
    description: "Which palette entry's regions get stroked.",
    animatable: false,
    legal: [0, MAX_PALETTE_INDEX],
    default: 0,
    surprise: {
      // Most palettes in this application are small — hardware specifications
      // and extractions with a low K — so a draw above about 8 usually names an
      // entry that does not exist, and an outline of nothing is a reroll that
      // looks broken.
      range: [0, 7],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: OUTLINE_PARAM.colorIndex,
    label: "Stroke colour",
    type: "int",
    description: "Palette entry the stroke is drawn in. Floored to the last entry if the palette is shorter.",
    animatable: false,
    legal: [0, MAX_PALETTE_INDEX],
    // Not 0: the default target is region 0, and stroking region 0 in its own
    // colour is an invisible node.
    default: 1,
    surprise: {
      range: [0, 7],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: OUTLINE_PARAM.placement,
    label: "Placement",
    type: "enum",
    description: "Which side of the region boundary the stroke sits on.",
    animatable: false,
    values: [
      { value: "inside", label: "Inside" },
      { value: "outside", label: "Outside" },
      { value: "both", label: "Both sides" },
    ],
    // Inside. On a two-entry palette an outside stroke drawn in the only other
    // colour is invisible — it paints region 1 in region 1's own colour — so
    // the default has to be the one that shows something on the smallest
    // palette anyone will use.
    default: "inside",
    surprise: {
      values: [
        { value: "inside", weight: 1 },
        { value: "outside", weight: 0.8 },
        // Both sides is twice the width for the same setting, so it reads as a
        // heavier stroke rather than as a different one.
        { value: "both", weight: 0.4 },
      ],
      weight: 0.8,
    },
  },
  {
    key: OUTLINE_PARAM.shape,
    label: "Corner shape",
    type: "enum",
    description: "Disc or square neighbourhood. Only visible above a width of about 2.",
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
      // Low: at the widths a reroll draws, this changes four pixels per corner.
      weight: 0.4,
    },
  },
];

/**
 * Parameter descriptors keyed for `packUniforms`. Two of the five are enums,
 * whose document value is a string and whose numeric form is its position in
 * `values`, so the packer cannot resolve them without this.
 */
export const OUTLINE_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  OUTLINE_PARAMS.map((param) => [param.key, param]),
);

const bindings: readonly PassBinding[] = [
  { role: "input-color", binding: OUTLINE_BINDING.inputColor },
  { role: "output-color", binding: OUTLINE_BINDING.outputColor },
  { role: "input-index", binding: OUTLINE_BINDING.inputIndex },
  { role: "output-index", binding: OUTLINE_BINDING.outputIndex },
  { role: "palette", binding: OUTLINE_BINDING.palette },
  { role: "uniforms", binding: OUTLINE_BINDING.uniforms },
];

const pass: ComputePass = {
  id: "outline/main",
  label: "Outline",
  wgsl,
  entryPoint: "main",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  // Reads a bounded window around its pixel, so it must not alias its input and
  // must not start before the pass before it has finished writing.
  access: "neighbourhood",
  bindings,
  uniforms: OUTLINE_UNIFORMS,
};

/** The compute pass, for the pass compiler. */
export const OUTLINE_GPU: GpuEffect = {
  effect: "outline",
  passes: [pass],
};

export default defineEffect({
  id: "outline",
  name: "Outline",
  summary:
    "Draws a stroke along the boundary of one palette region, in another palette colour.",
  description:
    "It reads the index map rather than the colours, so a boundary is an integer inequality between two palette indices — exact, and correct even where the two colours are nearly identical or where dither noise would defeat an edge detector. That is why it is only legal downstream of a node that quantized. The stroke colour is a palette entry rather than a free colour, because there is no index for a colour the palette does not contain, and the node rewrites the index map as well as the pixels so the next reader still sees a segmentation that describes them. Edge detect is the version that works on brightness and finds detail everywhere; this one finds region borders and nothing else.",
  keywords: ["outline", "stroke", "border", "edge", "contour", "region", "palette", "keyline", "key line", "comic", "sticker", "trace"],
  concept: "index-map",
  requirement: "F-SP-10",
  // Postprocess by necessity, not by taste: it reads the index map, and
  // `validateEffect` rejects an index-map consumer in the preprocess slot
  // because nothing has quantized yet at that point.
  slot: "postprocess",
  family: "special",
  execution: "gpu",
  params: OUTLINE_PARAMS,
  surpriseWeight: 0.7,
  // Writes both halves of the buffer, so the index map still describes the
  // pixels beside it after this node has run.
  producesIndexMap: true,
  requiresIndexMap: true,
});

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("outline", () => OUTLINE_GPU);
