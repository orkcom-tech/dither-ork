/**
 * F-OD-01..05 — the five ordered dithers, and F-OD-CTL, their shared controls.
 *
 * All five are the same program with a different threshold tile: sample a
 * matrix at a transformed coordinate, perturb the pixel by the threshold, take
 * the nearest palette entry. That is why they share one uniform layout and one
 * parameter set, and why the tile is a table binding rather than something
 * baked into each shader.
 *
 * The tiles themselves are generated in Rust and validated in
 * `../matrices.ts`. Nothing here invents one.
 *
 * The registry's convention is one file per effect under `web/src/effects/`,
 * collected by glob. The descriptors are built here rather than there because
 * they live next to the uniform layout that reads their parameter keys, so a
 * rename breaks in one place; `web/src/effects/<id>.effect.ts` is a one-line
 * re-export of {@link orderedDitherDescriptor} and holds nothing of its own.
 */

import type { EffectDescriptor, ParamDescriptor } from "../../types/registry";
import type { ComputePass, GpuEffect, PassBinding, UniformLayout } from "../../types/gpu";
import { thresholdMatrixBytes, type ThresholdMatrix } from "../matrices";

import bayer2Wgsl from "../../shaders/bayer-2.wgsl?raw";
import bayer4Wgsl from "../../shaders/bayer-4.wgsl?raw";
import bayer8Wgsl from "../../shaders/bayer-8.wgsl?raw";
import bayer16Wgsl from "../../shaders/bayer-16.wgsl?raw";
import blueNoiseWgsl from "../../shaders/blue-noise.wgsl?raw";

/**
 * Canonical binding numbers, restated from CONVENTIONS.md.
 *
 * Binding 2 (`input-index`) is deliberately absent: an ordered dither is the
 * node that *creates* the index map, so it has none to read.
 */
export const ORDERED_BINDING = {
  inputColor: 0,
  outputColor: 1,
  outputIndex: 3,
  palette: 4,
  uniforms: 5,
  matrix: 6,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const ORDERED_PARAM = {
  thresholdOffset: "thresholdOffset",
  contrast: "contrast",
  spread: "spread",
  tileScale: "tileScale",
  tileRotation: "tileRotation",
  offsetX: "offsetX",
  offsetY: "offsetY",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in every
 * ordered-dither shader.
 *
 * All twelve slots are 4-byte scalars, so no field needs padding in front of
 * it and the only padding is the tail that rounds 36 up to 48. Keeping the
 * block to scalars is not laziness — a `vec2f` for the offset pair would align
 * to 8 and put a hole after `spread` that both sides have to agree about.
 */
export const ORDERED_DITHER_UNIFORMS: UniformLayout = {
  sizeBytes: 48,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: ORDERED_PARAM.thresholdOffset }, type: "f32", offset: 8 },
    { source: { kind: "param", key: ORDERED_PARAM.contrast }, type: "f32", offset: 12 },
    { source: { kind: "param", key: ORDERED_PARAM.spread }, type: "f32", offset: 16 },
    { source: { kind: "param", key: ORDERED_PARAM.tileScale }, type: "f32", offset: 20 },
    { source: { kind: "param", key: ORDERED_PARAM.tileRotation }, type: "f32", offset: 24 },
    { source: { kind: "param", key: ORDERED_PARAM.offsetX }, type: "f32", offset: 28 },
    { source: { kind: "param", key: ORDERED_PARAM.offsetY }, type: "f32", offset: 32 },
  ],
};

/**
 * F-OD-CTL — the controls every ordered dither exposes.
 *
 * Shared as one array rather than copied into five descriptors: they are the
 * same controls by requirement, and five copies is five places for one of them
 * to drift.
 *
 * The surprise ranges are all narrower than the legal ones, which is the
 * difference between a usable random result and noise (F-SM-04). `tileScale`
 * samples in log space because it is measured in octaves — uniform sampling of
 * 0.25..64 spends most of its draws above 32, where every result looks the same.
 */
export const ORDERED_CONTROL_PARAMS: readonly ParamDescriptor[] = [
  {
    key: ORDERED_PARAM.thresholdOffset,
    label: "Threshold offset",
    type: "float",
    // The candidate pair is ordered darker-first in the shader, so positive is
    // always towards the lighter of the two — the control does not reverse
    // direction as the image crosses a palette midpoint.
    description: "Slides the cut between the two candidate colours. ±0.5 forces one.",
    animatable: true,
    legal: [-0.5, 0.5],
    default: 0,
    surprise: { range: [-0.15, 0.15], distribution: { kind: "uniform" }, weight: 0.6 },
  },
  {
    key: ORDERED_PARAM.contrast,
    label: "Matrix contrast",
    type: "float",
    description: "Steepens the matrix around its midpoint. Above 1 hardens the pattern.",
    animatable: true,
    legal: [0.05, 4],
    default: 1,
    surprise: { range: [0.6, 1.8], distribution: { kind: "log" }, weight: 0.8 },
  },
  {
    key: ORDERED_PARAM.spread,
    label: "Spread",
    type: "float",
    // The threshold is compared against the pixel's *fraction* of the way
    // between its two candidate palette entries, so 1 reproduces tone exactly
    // for any palette, even or uneven — there is nothing to tune per palette.
    description: "Dither strength. 0 is plain quantization, 1 reproduces tone exactly.",
    animatable: true,
    legal: [0, 2],
    default: 1,
    surprise: { range: [0.4, 1.2], distribution: { kind: "uniform" }, weight: 1 },
  },
  {
    key: ORDERED_PARAM.tileScale,
    label: "Tile scale",
    type: "float",
    description: "Size of the matrix on screen, in pixels per matrix cell.",
    animatable: true,
    legal: [0.25, 64],
    default: 1,
    surprise: { range: [0.5, 8], distribution: { kind: "log" }, weight: 1 },
  },
  {
    key: ORDERED_PARAM.tileRotation,
    label: "Tile rotation",
    type: "float",
    // Turns, not degrees: a modulator ramping 0 -> 1 lands back where it
    // started, so an animated rotation loops without the UI having to know
    // that 360 is special.
    description: "Rotation of the matrix about the image centre, in turns.",
    animatable: true,
    legal: [-1, 1],
    default: 0,
    surprise: { range: [-0.25, 0.25], distribution: { kind: "uniform" }, weight: 1.2 },
  },
  {
    key: ORDERED_PARAM.offsetX,
    label: "Offset X",
    type: "float",
    description: "Shifts the matrix horizontally, in matrix cells.",
    animatable: true,
    legal: [-1024, 1024],
    default: 0,
    surprise: { range: [-8, 8], distribution: { kind: "uniform" }, weight: 0.8 },
  },
  {
    key: ORDERED_PARAM.offsetY,
    label: "Offset Y",
    type: "float",
    description: "Shifts the matrix vertically, in matrix cells.",
    animatable: true,
    legal: [-1024, 1024],
    default: 0,
    surprise: { range: [-8, 8], distribution: { kind: "uniform" }, weight: 0.8 },
  },
];

/**
 * Search terms every ordered dither answers to, on top of its own (F-UI-15).
 *
 * Someone looking for this family types "dither", "pattern" or "retro" long
 * before they type "Bayer", and "blue noise" was the case that proved the point:
 * search matched only names and structural fields, so the word "noise" found
 * nothing. Merged into each tile's own list by the descriptor factory so that no
 * tile can forget them.
 */
const ORDERED_KEYWORDS: readonly string[] = [
  "dither",
  "dithering",
  "ordered",
  "ordered dither",
  "threshold matrix",
  "matrix",
  "tile",
  "pattern",
  "retro",
];

/** One ordered dither: its identity, its tile size and its shader. */
export interface OrderedDitherSpec {
  readonly effectId: string;
  readonly name: string;
  /**
   * F-UI-15's three fields, per tile.
   *
   * Per-tile rather than shared, because what the five have in common is
   * already written once in `EFFECT_CONCEPTS["ordered-dithering"]` and what a
   * person choosing between them needs is the rest: how coarse this tile is and
   * what it is reached for. A shared paragraph would say nothing at the moment
   * of choosing.
   */
  readonly summary: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly requirement: string;
  /** Tile edge in texels, restated as `TILE` in the shader. */
  readonly tile: number;
  readonly wgsl: string;
  readonly surpriseWeight: number;
}

/**
 * The five, in the order the spec lists them.
 *
 * `surpriseWeight` puts 4x4 and 8x8 — the two that carry the look — ahead of
 * 2x2 and 16x16, which are the ones you reach for on purpose (F-SM-03). Blue
 * noise sits highest because it flatters more images than any of the Bayer
 * tiles do.
 */
export const ORDERED_DITHERS: readonly OrderedDitherSpec[] = [
  {
    effectId: "bayer-2",
    name: "Bayer 2×2",
    summary:
      "The coarsest ordered dither there is — four thresholds, so above one pixel per cell it reads as a visible checker.",
    description:
      "Four thresholds in the classic 2×2 recursion. There is not enough tile here to hide in, which is exactly why it is reached for on purpose: raise the tile scale and the checkerboard becomes the subject rather than the texture. Against a two-colour palette it gives the hard 50% screen of early bitmap graphics. If you want the pattern to dissolve into tone instead, use Bayer 8×8 or blue noise.",
    keywords: ["bayer", "checker", "checkerboard", "2x2", "coarse", "retro", "bitmap", "chunky"],
    requirement: "F-OD-01",
    tile: 2,
    wgsl: bayer2Wgsl,
    surpriseWeight: 0.6,
  },
  {
    effectId: "bayer-4",
    name: "Bayer 4×4",
    summary:
      "The tile most people picture when they say 'ordered dither' — coarse enough to see, fine enough to hold a gradient.",
    description:
      "Sixteen thresholds in a 4×4 recursion. This is the middle of the Bayer family and the usual first choice: the woven pattern is clearly visible but still fine enough that a gradient reads as a gradient rather than as bands. Raise the tile scale to make the pattern the subject, or drop the spread to let the palette show through with less texture.",
    keywords: ["bayer", "4x4", "retro", "gradient", "classic", "game boy", "gameboy"],
    requirement: "F-OD-02",
    tile: 4,
    wgsl: bayer4Wgsl,
    surpriseWeight: 1,
  },
  {
    effectId: "bayer-8",
    name: "Bayer 8×8",
    summary:
      "The finest Bayer tile that still shows its own structure — ordered dithering without it announcing itself.",
    description:
      "Sixty-four thresholds. At one pixel per cell the pattern nearly dissolves into texture at ordinary output sizes, which makes this the Bayer tile to use when you want the regularity of an ordered dither but not a visible weave. Scale the tile up and the 8×8 recursion becomes plainly legible again.",
    keywords: ["bayer", "8x8", "fine", "subtle", "retro"],
    requirement: "F-OD-03",
    tile: 8,
    wgsl: bayer8Wgsl,
    surpriseWeight: 1,
  },
  {
    effectId: "bayer-16",
    name: "Bayer 16×16",
    summary:
      "The largest Bayer tile — 256 thresholds, one for every level an 8-bit channel has.",
    description:
      "Two hundred and fifty-six thresholds, which is as many as an 8-bit channel has levels, so this is the largest Bayer tile that can add anything at all. At one pixel per cell its structure is nearly invisible; the recursion only becomes legible once the tile is scaled up, which is the main reason to choose it over 8×8.",
    keywords: ["bayer", "16x16", "large tile", "smooth", "fine"],
    requirement: "F-OD-04",
    tile: 16,
    wgsl: bayer16Wgsl,
    surpriseWeight: 0.7,
  },
  {
    effectId: "blue-noise",
    name: "Blue noise",
    summary:
      "Ordered dithering with no visible pattern at all — the thresholds are arranged so there is no structure to see.",
    description:
      "A void-and-cluster tile rather than a recursion: the thresholds are placed so the spectrum carries no low-frequency energy, which is what stops the eye finding a repeating figure in the result. It flatters more images than any of the Bayer tiles, and it is the one to reach for when you want a dither that reads as grain rather than as a screen. It is still an ordered dither, so it costs one pass and survives scaling and animation the way Bayer does and error diffusion does not.",
    keywords: ["noise", "blue noise", "random", "grain", "stochastic", "void and cluster", "organic", "no pattern", "smooth"],
    requirement: "F-OD-05",
    tile: 64,
    wgsl: blueNoiseWgsl,
    surpriseWeight: 1.2,
  },
];

export function orderedDitherSpec(effectId: string): OrderedDitherSpec {
  const spec = ORDERED_DITHERS.find((candidate) => candidate.effectId === effectId);
  if (spec === undefined) {
    throw new Error(`no ordered dither named "${effectId}"`);
  }
  return spec;
}

/** The registry descriptor for one ordered dither. */
export function orderedDitherDescriptor(spec: OrderedDitherSpec): EffectDescriptor {
  return {
    id: spec.effectId,
    name: spec.name,
    summary: spec.summary,
    description: spec.description,
    // Deduplicated: a tile's own list may legitimately repeat a shared term, and
    // the registry validator rejects a keyword declared twice.
    keywords: [...new Set([...spec.keywords, ...ORDERED_KEYWORDS])],
    concept: "ordered-dithering",
    requirement: spec.requirement,
    slot: "dither",
    family: "ordered",
    execution: "gpu",
    params: ORDERED_CONTROL_PARAMS,
    surpriseWeight: spec.surpriseWeight,
    // Quantizing is the point: the index map it emits is what makes outline,
    // dilate/erode, hue-targeted recolour and the tracer lossless downstream.
    producesIndexMap: true,
    requiresIndexMap: false,
  };
}

/**
 * The compute pass for one ordered dither, bound to a specific tile.
 *
 * The matrix is a constructor argument rather than something this module
 * fetches, because it comes from the Rust core and this layer must not be able
 * to run without it.
 */
export function orderedDitherEffect(
  spec: OrderedDitherSpec,
  matrix: ThresholdMatrix,
): GpuEffect {
  if (matrix.id !== spec.effectId) {
    throw new Error(
      `threshold matrix "${matrix.id}" was given to effect "${spec.effectId}"`,
    );
  }
  if (matrix.size !== spec.tile) {
    // The shader restates the tile size as a compile-time constant, so a
    // mismatch here would index a table of the wrong length — robust buffer
    // access turns that into zeroes, i.e. a picture that is wrong and silent.
    throw new Error(
      `${spec.effectId}: shader expects a ${spec.tile}x${spec.tile} tile, matrix is ${matrix.size}x${matrix.size}`,
    );
  }

  const bindings: readonly PassBinding[] = [
    { role: "input-color", binding: ORDERED_BINDING.inputColor },
    { role: "output-color", binding: ORDERED_BINDING.outputColor },
    { role: "output-index", binding: ORDERED_BINDING.outputIndex },
    { role: "palette", binding: ORDERED_BINDING.palette },
    { role: "uniforms", binding: ORDERED_BINDING.uniforms },
    { role: "table", binding: ORDERED_BINDING.matrix, data: thresholdMatrixBytes(matrix) },
  ];

  const pass: ComputePass = {
    id: `${spec.effectId}/threshold`,
    label: `${spec.name} threshold`,
    wgsl: spec.wgsl,
    entryPoint: "main",
    // 64 invocations, well under the 256 guaranteed everywhere.
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    // Reads only its own pixel; the threshold comes from the coordinate, not
    // from a neighbour.
    access: "pointwise",
    bindings,
    uniforms: ORDERED_DITHER_UNIFORMS,
  };

  return { effect: spec.effectId, passes: [pass] };
}

/** Descriptor and compute pass together, which is what the compiler takes. */
export function createOrderedDither(
  spec: OrderedDitherSpec,
  matrix: ThresholdMatrix,
): { readonly descriptor: EffectDescriptor; readonly gpu: GpuEffect } {
  return { descriptor: orderedDitherDescriptor(spec), gpu: orderedDitherEffect(spec, matrix) };
}

/**
 * Parameter descriptors keyed for {@link packUniforms}.
 *
 * Every ordered-dither control is a float, so this map is only ever consulted
 * to confirm that — but the packer takes it for every effect, and an effect
 * with an enum control needs it to resolve the ordinal.
 */
export const ORDERED_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  ORDERED_CONTROL_PARAMS.map((param) => [param.key, param]),
);

/** Defaults, for a node created without an explicit parameter set. */
export function orderedDitherDefaults(): Record<string, number> {
  const defaults: Record<string, number> = {};
  for (const param of ORDERED_CONTROL_PARAMS) {
    if (param.type === "float") defaults[param.key] = param.default;
  }
  return defaults;
}
