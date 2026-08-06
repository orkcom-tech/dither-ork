/**
 * Pixel sort (F-GL-01).
 *
 * The one effect in the glitch family that is not a per-pixel function of its
 * input. A span is a run of consecutive pixels whose sort key clears a
 * threshold, and the run has to be *walked* to be found — capping it at the
 * span limit makes where it ends depend on where it started, so no pixel can
 * work out which span it belongs to from its neighbourhood. That is why this
 * effect is three compute passes and two storage buffers rather than one
 * dispatch, and the shape is described at the top of `pixel-sort.wgsl`.
 *
 * Two of the three passes are the same program over a different axis. The
 * direction is a parameter and a dispatch shape is fixed when the pass is
 * compiled, so the horizontal scan (`per-row`) and the vertical scan
 * (`per-column`) are both declared and each returns immediately when the other
 * axis is selected. The alternative — one `per-pixel` dispatch that keeps only
 * its line leaders — launches a million invocations to do a thousand
 * invocations' work.
 *
 * **Cost is `spanLimit` per pixel.** Pass 3 counts the pixels of its own span
 * that sort below it, so the work is `width * height * spanLimit` comparisons.
 * The legal maximum is 512 for that reason and the surprise range stops far
 * short of it; the span limit is a look control that also happens to be the
 * budget.
 *
 * **No index map.** Sorting moves pixels, so any index map upstream of this
 * node no longer describes the image after it. The descriptor declares neither
 * `producesIndexMap` nor `requiresIndexMap`: claiming to require one would make
 * the node illegal before a quantizer, and claiming to produce one would mean
 * emitting indices this pass does not compute.
 */

import type { EffectDescriptor, ParamDescriptor } from "../types/registry";
import type { ComputePass, GpuEffect, PassBinding, UniformLayout } from "../types/gpu";

import wgsl from "../shaders/pixel-sort.wgsl?raw";

/** Canonical binding numbers, restated from CONVENTIONS.md. */
export const PIXEL_SORT_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
  /** `(first, last + 1)` along the active axis, per pixel. */
  spans: 6,
  /** The sort key, per pixel, computed once by the line pass. */
  keys: 7,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const PIXEL_SORT_PARAM = {
  sortKey: "sortKey",
  direction: "direction",
  threshold: "threshold",
  spanLimit: "spanLimit",
  jitter: "jitter",
  seed: "seed",
} as const;

/**
 * `struct Params` in `pixel-sort.wgsl`, byte for byte.
 *
 * Eight 4-byte scalars in a run: nothing needs padding in front of it and the
 * block is exactly 32 bytes, so the size is visible here rather than left to
 * WGSL's round-up rule.
 */
export const PIXEL_SORT_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: PIXEL_SORT_PARAM.seed }, type: "u32", offset: 8 },
    { source: { kind: "param", key: PIXEL_SORT_PARAM.direction }, type: "u32", offset: 12 },
    { source: { kind: "param", key: PIXEL_SORT_PARAM.sortKey }, type: "u32", offset: 16 },
    { source: { kind: "param", key: PIXEL_SORT_PARAM.spanLimit }, type: "u32", offset: 20 },
    { source: { kind: "param", key: PIXEL_SORT_PARAM.threshold }, type: "f32", offset: 24 },
    { source: { kind: "param", key: PIXEL_SORT_PARAM.jitter }, type: "f32", offset: 28 },
  ],
};

const PARAMS: readonly ParamDescriptor[] = [
  {
    key: PIXEL_SORT_PARAM.sortKey,
    label: "Sort key",
    type: "enum",
    // All three are measured in OKLab and normalised to [0, 1], so the
    // threshold below means the same thing whichever is chosen. Luminance in
    // linear light would put a threshold of 0.5 well into the highlights.
    hint: "What the pixels are ordered by, and what the threshold measures.",
    animatable: false,
    values: [
      { value: "luma", label: "Lightness" },
      { value: "hue", label: "Hue" },
      { value: "saturation", label: "Saturation" },
    ],
    default: "luma",
    surprise: {
      // Lightness is the sort everyone means by pixel sort; hue and saturation
      // are the ones you reach for on purpose (F-SM-03).
      values: [
        { value: "luma", weight: 1 },
        { value: "hue", weight: 0.35 },
        { value: "saturation", weight: 0.35 },
      ],
      weight: 0.7,
    },
  },
  {
    key: PIXEL_SORT_PARAM.direction,
    label: "Direction",
    type: "enum",
    hint: "Which axis the spans run along, and which end the low keys collect at.",
    animatable: false,
    // Order is load-bearing: the shader reads the ordinal and uses bit 1 for
    // the axis and bit 0 for the sort order. Inserting a value in the middle
    // renumbers every document already saved.
    values: [
      { value: "right", label: "Rows →" },
      { value: "left", label: "Rows ←" },
      { value: "down", label: "Columns ↓" },
      { value: "up", label: "Columns ↑" },
    ],
    default: "right",
    surprise: {
      values: [
        { value: "right", weight: 1 },
        { value: "left", weight: 0.5 },
        { value: "down", weight: 0.7 },
        { value: "up", weight: 0.4 },
      ],
      weight: 0.9,
    },
  },
  {
    key: PIXEL_SORT_PARAM.threshold,
    label: "Threshold",
    type: "float",
    hint: "Pixels at or above this on the sort key form spans. 0 sorts everything, 1 sorts nothing.",
    animatable: true,
    legal: [0, 1],
    default: 0.55,
    step: 0.01,
    surprise: {
      // Outside roughly this band the effect is either the whole image in
      // uniform blocks or nothing at all, which is the noise-versus-result
      // distinction of F-SM-04.
      range: [0.25, 0.8],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: PIXEL_SORT_PARAM.spanLimit,
    label: "Span limit",
    type: "int",
    // Also the budget: pass 3 compares each pixel against every pixel of its
    // own span, so this multiplies the pixel count directly.
    hint: "Longest run that sorts as one block, in pixels. Longer runs are chopped into blocks of this length.",
    animatable: true,
    legal: [2, 512],
    default: 64,
    surprise: {
      // Log, because it is measured in octaves: uniform sampling of 8..128
      // spends most of its draws above 64, where every result looks the same.
      range: [8, 128],
      distribution: { kind: "log" },
      weight: 1,
    },
  },
  {
    key: PIXEL_SORT_PARAM.jitter,
    label: "Threshold jitter",
    type: "float",
    // This is what the seed drives. At 0 the sort is exactly the published
    // algorithm and the seed does nothing — stated rather than hidden, because
    // a seed control that never moves anything is worse than no seed at all.
    hint: "Seeded per-line variation of the threshold. 0 is off, and then the seed has no effect.",
    animatable: true,
    legal: [0, 1],
    default: 0,
    step: 0.01,
    surprise: {
      range: [0, 0.35],
      distribution: { kind: "uniform" },
      weight: 0.6,
    },
  },
  {
    key: PIXEL_SORT_PARAM.seed,
    label: "Seed",
    type: "seed",
    hint: "Reroll the per-line threshold jitter.",
    animatable: false,
    default: 0,
    surprise: { weight: 1 },
  },
];

const descriptor: EffectDescriptor = {
  id: "pixel-sort",
  name: "Pixel sort",
  requirement: "F-GL-01",
  slot: "postprocess",
  family: "glitch",
  execution: "gpu",
  params: PARAMS,
  // Below 1: unmistakable, expensive, and it overwhelms whatever it is stacked
  // on, so it should turn up less often than the effects that combine.
  surpriseWeight: 0.8,
  producesIndexMap: false,
  requiresIndexMap: false,
};

export default descriptor;

/**
 * The two storage buffers, declared identically in every pass.
 *
 * They are keyed by slot, so all three passes of one node share one allocation
 * (`BufferCache.scratch`). Twelve bytes per pixel is the price of computing the
 * sort key once instead of `spanLimit` times per pixel; at 1920x1080 that is
 * 25 MB, and above roughly 4000x4000 the spans buffer runs into
 * `maxStorageBufferBindingSize` and is refused by name rather than truncated.
 *
 * Both are `read-write` everywhere, including in the pass that only reads them:
 * one WGSL file declares a binding once, and a bind group layout has to match
 * the access the shader declared.
 */
const SCRATCH: readonly PassBinding[] = [
  {
    role: "scratch",
    binding: PIXEL_SORT_BINDING.spans,
    slot: "spans",
    access: "read-write",
    size: { kind: "per-pixel", bytesPerPixel: 8 },
  },
  {
    role: "scratch",
    binding: PIXEL_SORT_BINDING.keys,
    slot: "keys",
    access: "read-write",
    size: { kind: "per-pixel", bytesPerPixel: 4 },
  },
];

const LINE_BINDINGS: readonly PassBinding[] = [
  { role: "input-color", binding: PIXEL_SORT_BINDING.inputColor },
  { role: "uniforms", binding: PIXEL_SORT_BINDING.uniforms },
  ...SCRATCH,
];

/**
 * Span identification along rows.
 *
 * `per-row` gives one invocation per row, which is the parallelism this half of
 * the algorithm actually has: lines are independent, pixels within a line are
 * not.
 */
const SPANS_ROWS: ComputePass = {
  id: "pixel-sort/spans-rows",
  label: "Pixel sort row spans",
  wgsl,
  entryPoint: "spans_rows",
  workgroupSize: [64, 1, 1],
  dispatch: { kind: "per-row" },
  // Walks a whole line and writes a storage buffer; it cannot be reordered
  // against anything.
  access: "global",
  bindings: LINE_BINDINGS,
  uniforms: PIXEL_SORT_UNIFORMS,
};

/** The same program down columns. Exactly one of the two does any work. */
const SPANS_COLUMNS: ComputePass = {
  id: "pixel-sort/spans-columns",
  label: "Pixel sort column spans",
  wgsl,
  entryPoint: "spans_columns",
  workgroupSize: [64, 1, 1],
  dispatch: { kind: "per-column" },
  access: "global",
  bindings: LINE_BINDINGS,
  uniforms: PIXEL_SORT_UNIFORMS,
};

/** Rank within the span, then scatter. Covers every output texel exactly once. */
const SCATTER: ComputePass = {
  id: "pixel-sort/scatter",
  label: "Pixel sort scatter",
  wgsl,
  entryPoint: "sort_scatter",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  access: "global",
  bindings: [
    { role: "input-color", binding: PIXEL_SORT_BINDING.inputColor },
    { role: "output-color", binding: PIXEL_SORT_BINDING.outputColor },
    { role: "uniforms", binding: PIXEL_SORT_BINDING.uniforms },
    ...SCRATCH,
  ],
  uniforms: PIXEL_SORT_UNIFORMS,
};

/**
 * Pass order is the algorithm. WebGPU orders dispatches inside one compute pass
 * and makes their writes visible to what follows, so the scatter reads spans
 * and keys the line pass wrote without an explicit barrier.
 */
export const pixelSortGpuEffect: GpuEffect = {
  effect: descriptor.id,
  passes: [SPANS_ROWS, SPANS_COLUMNS, SCATTER],
};

/** Parameter descriptors keyed for `packUniforms`, which needs them for enums. */
export const PIXEL_SORT_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  PARAMS.map((param) => [param.key, param]),
);
