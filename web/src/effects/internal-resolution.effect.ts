/**
 * Internal resolution (F-PP-01).
 *
 * Two compute passes, one per axis, each dividing the extent it reads by an
 * integer factor. This is the node docs/ARCHITECTURE.md calls both the
 * detail-crush mechanism and the main performance lever, and those are the same
 * operation seen from two sides: everything downstream of it runs on a buffer
 * `factor` times smaller on each axis, so the dither grid and the halftone cell
 * are measured against the reduced grid, and the stack costs a fraction of what
 * it did.
 *
 * **It leaves the frame smaller, and that is the whole design.** "Without
 * changing output resolution" (the spec's phrase) is what the *pair* does: this
 * node, then Nearest upscale (F-SP-14) at the same factor. A single node that
 * went down and back up again would crush detail but win no performance and,
 * worse, would run the dither on the full-resolution grid — which is precisely
 * the look the crush exists to avoid.
 *
 * **Three filters, and the difference between them is a look decision.**
 * Nearest keeps a source texel's exact colour and aliases hard, box is the area
 * average an integer downscale actually calls for, Lanczos-3 keeps the most
 * detail at the cost of ringing. Box is the default because it is the only one
 * of the three that is *correct* for an integer reduction; the other two are
 * there because a dither is about to quantize everything anyway and correctness
 * is not always the look.
 *
 * The resampling argument in full — separability, premultiplied filtering, the
 * clamped window at the frame edge — is at the top of
 * `../shaders/internal-resolution.wgsl`.
 */

import { defineEffect, staticGpuEffect, type ParamDescriptor } from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/internal-resolution.wgsl?raw";

/** Canonical binding numbers, restated from `shaders/CONVENTIONS.md`. */
export const INTERNAL_RESOLUTION_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const INTERNAL_RESOLUTION_PARAM = {
  factor: "factor",
  filter: "filter",
} as const;

/**
 * Largest reduction the node accepts.
 *
 * It bounds the Lanczos window — the kernel is widened by the factor, so the
 * loop in the shader runs `6 * factor + 1` times — and 16 is where the useful
 * range ends anyway: a 1920-wide frame reduces to 120, which is already past
 * the point where a dither has any tone left to reproduce.
 */
export const INTERNAL_RESOLUTION_MAX_FACTOR = 16;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/internal-resolution.wgsl`. Six 4-byte scalars occupy 24 bytes and
 * the block rounds up to 32; the two tail words are declared as padding in the
 * shader and written by nobody.
 *
 * Both passes share it. They differ only in which axis they scale, and that is
 * the entry point rather than a uniform — a pass that could be told its own
 * axis at run time would be a pass whose extent rule and whose arithmetic could
 * disagree.
 */
export const INTERNAL_RESOLUTION_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "builtin", name: "output-width" }, type: "u32", offset: 8 },
    { source: { kind: "builtin", name: "output-height" }, type: "u32", offset: 12 },
    {
      source: { kind: "param", key: INTERNAL_RESOLUTION_PARAM.factor },
      type: "u32",
      offset: 16,
    },
    {
      source: { kind: "param", key: INTERNAL_RESOLUTION_PARAM.filter },
      type: "u32",
      offset: 20,
    },
  ],
};

export const INTERNAL_RESOLUTION_PARAMS: readonly ParamDescriptor[] = [
  {
    key: INTERNAL_RESOLUTION_PARAM.factor,
    label: "Factor",
    type: "int",
    description: "Divides the working resolution on both axes. Everything after this node runs at the reduced size.",
    // Not animatable, and this is the one parameter in the catalogue where that
    // is a hard constraint rather than a judgement: the extent rule reads this
    // value to size a texture, so a modulator sweeping it would reallocate the
    // whole chain every frame and change the shape of the buffer the export is
    // assembling. F-EX-12's export multiplier is the place a scale is meant to
    // vary.
    animatable: false,
    legal: [1, INTERNAL_RESOLUTION_MAX_FACTOR],
    // 1 is the identity, and a node that does nothing when it is added looks
    // broken. 2 is the smallest factor that visibly crushes.
    default: 2,
    surprise: {
      // Past 8 there is not enough of the image left for a dither to reproduce
      // tone with, which is a random draw that looks like a mistake (F-SM-04).
      range: [2, 8],
      // Factors are octaves: 2 to 3 is most of the picture, 7 to 8 is nothing.
      distribution: { kind: "log" },
      weight: 1.2,
    },
  },
  {
    key: INTERNAL_RESOLUTION_PARAM.filter,
    label: "Filter",
    type: "enum",
    description: "How source texels are combined. Nearest aliases, box averages, Lanczos keeps detail and rings.",
    animatable: false,
    // Append-only: the shader reads the ordinal, so inserting a value in the
    // middle renumbers every document already saved.
    values: [
      { value: "nearest", label: "Nearest" },
      { value: "box", label: "Box" },
      { value: "lanczos", label: "Lanczos" },
    ],
    // The area average, which is what an integer reduction actually means.
    default: "box",
    surprise: {
      // Nearest is drawn as often as box: under a dither its aliasing reads as
      // deliberate chunk rather than as a mistake, which is not true of a
      // photograph. Lanczos sits lower because its ringing and the dither's own
      // texture fight for the same frequencies.
      values: [
        { value: "nearest", weight: 1 },
        { value: "box", weight: 1 },
        { value: "lanczos", weight: 0.5 },
      ],
      weight: 0.8,
    },
  },
];

/**
 * Parameter descriptors keyed for `packUniforms`. `filter` is an enum, whose
 * document value is a string and whose numeric form is its position in
 * `values`, so the packer cannot resolve it without this.
 */
export const INTERNAL_RESOLUTION_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> =
  new Map(INTERNAL_RESOLUTION_PARAMS.map((param) => [param.key, param]));

const bindings: readonly PassBinding[] = [
  { role: "input-color", binding: INTERNAL_RESOLUTION_BINDING.inputColor },
  { role: "output-color", binding: INTERNAL_RESOLUTION_BINDING.outputColor },
  { role: "uniforms", binding: INTERNAL_RESOLUTION_BINDING.uniforms },
];

/**
 * One axis of the separable reduction.
 *
 * `access` is `neighbourhood` rather than `pointwise` for a reason the compiler
 * also enforces: a pass writing a different shape than it reads is by
 * definition not reading its own pixel, so it can never alias its input.
 */
function axisPass(
  axis: "x" | "y",
  entryPoint: string,
  label: string,
): ComputePass {
  return {
    id: `internal-resolution/${axis}`,
    label,
    wgsl,
    entryPoint,
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    access: "neighbourhood",
    bindings,
    uniforms: INTERNAL_RESOLUTION_UNIFORMS,
    extent: {
      kind: "downscale",
      factorParam: INTERNAL_RESOLUTION_PARAM.factor,
      axes: axis,
    },
  };
}

/**
 * The compute passes, for the pass compiler.
 *
 * Order matters and is not arbitrary: the horizontal pass runs first, so the
 * vertical pass reads an already-narrowed intermediate and its own gather costs
 * `1/factor` of what it would have. `prepareNodePasses` threads the extent
 * from the first to the second.
 */
export const INTERNAL_RESOLUTION_GPU: GpuEffect = {
  effect: "internal-resolution",
  passes: [
    axisPass("x", "reduce_x", "Internal resolution (horizontal)"),
    axisPass("y", "reduce_y", "Internal resolution (vertical)"),
  ],
};

export default defineEffect({
  id: "internal-resolution",
  name: "Internal resolution",
  summary:
    "Runs everything after it on a smaller grid, which coarsens the dither and makes the whole stack cheaper.",
  description:
    "Divides the working resolution by an integer factor on both axes, so the dither grid, the halftone cell and every radius after this node are measured against the reduced grid. It leaves the frame smaller, and that is the design: 'without changing the output resolution' is what the *pair* does — this node, then Nearest upscale at the same factor. A single node that went down and back up again would crush detail but win no performance, and would run the dither on the full-resolution grid, which is exactly the look the crush exists to avoid. Box is the default because it is the only one of the three filters that is correct for an integer reduction; nearest aliases hard, and Lanczos keeps the most detail at the cost of ringing.",
  keywords: ["resolution", "downscale", "downsample", "pixelate", "chunky", "crush", "detail", "performance", "speed", "scale down", "low res", "factor", "mosaic"],
  concept: "working-resolution",
  requirement: "F-PP-01",
  // Preprocess, and it is the node the slot exists for: it decides the grid
  // every kernel downstream measures itself against. After a quantizer it would
  // resample colours that an index map beside them still claims are palette
  // entries, and the scheduler refuses that combination outright.
  slot: "preprocess",
  family: "preprocess",
  execution: "gpu",
  params: INTERNAL_RESOLUTION_PARAMS,
  // High. Almost every stack the architecture describes has one of these, and
  // it changes the character of everything after it more than any other
  // preprocess node does.
  surpriseWeight: 1.3,
  producesIndexMap: false,
  requiresIndexMap: false,
  // It writes an extent it did not read, and it writes no index map. That pair
  // is what `registry/stack.ts` refuses downstream of a quantizer: interpolating
  // palette indices is meaningless — the average of index 3 and index 7 is not a
  // colour — so there is nothing this node could do to the map, and leaving it
  // at the old extent beside resampled colour is a buffer whose two halves name
  // different pixel grids. `gpu/compiler.ts` checks this flag against the extent
  // rules on the two passes above, so it cannot drift from them.
  resamples: true,
});

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect(
  "internal-resolution",
  () => INTERNAL_RESOLUTION_GPU,
);
