/**
 * Nearest-neighbour upscale (F-SP-14).
 *
 * One compute pass that multiplies the extent by an integer factor and
 * replicates each texel into the block it now covers — colour and index map
 * together. It is the second half of the F-PP-01 pair: internal resolution runs
 * the middle of the stack small, this brings the frame back to size with the
 * chunk intact.
 *
 * **It reads the index map, so it is only legal downstream of a quantizer.**
 * That is a real constraint and it is declared rather than discovered: the
 * scheduler refuses any pass that resamples colour while an index map is live
 * at the old extent, because the two would then name different pixel grids and
 * nothing would notice until an outline or the SVG tracer read them. Carrying
 * the map is the only way to resample an indexed frame at all, and carrying it
 * means requiring it.
 *
 * The one combination this rules out is **CMYK halftone** (F-PT-02), the single
 * dither-slot node in the catalogue that emits no index map, because its output
 * colours are ink overprints rather than palette entries. A stack of CMYK
 * halftone followed by this node is refused by `registry/stack.ts` with a
 * message naming both, before anything renders. Scaling an overprint result
 * would need a second variant of this node that touches no index map; it is
 * left out rather than guessed at.
 *
 * Why nearest and integer-only is argued at the top of
 * `../shaders/nn-upscale.wgsl`.
 */

import { defineEffect, staticGpuEffect, type ParamDescriptor } from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/nn-upscale.wgsl?raw";

/** Canonical binding numbers, restated from `shaders/CONVENTIONS.md`. */
export const NN_UPSCALE_BINDING = {
  inputColor: 0,
  outputColor: 1,
  inputIndex: 2,
  outputIndex: 3,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const NN_UPSCALE_PARAM = {
  factor: "factor",
} as const;

/**
 * Largest multiplication the node accepts.
 *
 * The bound is memory, not taste: the output texture is `factor²` times the
 * area, and WebGPU's guaranteed `maxTextureDimension2D` is 8192. At 8 a
 * 1024-wide frame is already at that ceiling, and the texture pool refuses
 * anything past it with a message naming the extent — this keeps the common
 * mistake inside the parameter's own legal range instead.
 */
export const NN_UPSCALE_MAX_FACTOR = 8;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/nn-upscale.wgsl`. Five 4-byte scalars occupy 20 bytes and the
 * block rounds up to 32; the three tail words are declared as padding in the
 * shader and written by nobody.
 */
export const NN_UPSCALE_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "builtin", name: "output-width" }, type: "u32", offset: 8 },
    { source: { kind: "builtin", name: "output-height" }, type: "u32", offset: 12 },
    { source: { kind: "param", key: NN_UPSCALE_PARAM.factor }, type: "u32", offset: 16 },
  ],
};

export const NN_UPSCALE_PARAMS: readonly ParamDescriptor[] = [
  {
    key: NN_UPSCALE_PARAM.factor,
    label: "Factor",
    type: "int",
    description: "Each texel becomes a block this many texels on a side. Pair it with Internal resolution to keep the output size.",
    // Not animatable, for the same reason F-PP-01's factor is not: the extent
    // rule reads this value to size a texture, so a modulator sweeping it would
    // reallocate the chain every frame and change the shape of the buffer an
    // export is assembling.
    animatable: false,
    legal: [1, NN_UPSCALE_MAX_FACTOR],
    // 1 is the identity, and a node that does nothing when it is added looks
    // broken.
    default: 2,
    surprise: {
      // Above 4 the frame is mostly one flat block per source texel and the
      // dither it was applied to stops being legible at all.
      range: [2, 4],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
];

/** Parameter descriptors keyed for `packUniforms`. */
export const NN_UPSCALE_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  NN_UPSCALE_PARAMS.map((param) => [param.key, param]),
);

const bindings: readonly PassBinding[] = [
  { role: "input-color", binding: NN_UPSCALE_BINDING.inputColor },
  { role: "output-color", binding: NN_UPSCALE_BINDING.outputColor },
  { role: "input-index", binding: NN_UPSCALE_BINDING.inputIndex },
  { role: "output-index", binding: NN_UPSCALE_BINDING.outputIndex },
  { role: "uniforms", binding: NN_UPSCALE_BINDING.uniforms },
];

/**
 * `access` is `neighbourhood` rather than `pointwise`, which the compiler also
 * enforces: a pass writing a different shape than it reads is not reading its
 * own pixel and can never alias its input.
 */
const pass: ComputePass = {
  id: "nn-upscale/main",
  label: "Nearest upscale",
  wgsl,
  entryPoint: "main",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  access: "neighbourhood",
  bindings,
  uniforms: NN_UPSCALE_UNIFORMS,
  extent: { kind: "upscale", factorParam: NN_UPSCALE_PARAM.factor },
};

/** The compute pass, for the pass compiler. */
export const NN_UPSCALE_GPU: GpuEffect = {
  effect: "nn-upscale",
  passes: [pass],
};

export default defineEffect({
  id: "nn-upscale",
  name: "Nearest upscale",
  summary:
    "Multiplies the frame by a whole number, replicating each pixel into a hard block.",
  description:
    "The other half of the internal-resolution pair: run the middle of the stack small, then bring the frame back to size with the chunk intact. It carries the index map up alongside the colours, which is the only way to resample an indexed frame at all — and it is why the node requires one, so it is legal only downstream of a quantizer. Nearest and integer-only is not a limitation but the requirement: any smoothing would average palette colours into ones the palette does not contain, and a fractional factor would make some source pixels physically bigger than others. It cannot follow CMYK halftone, which emits no index map.",
  keywords: ["upscale", "scale", "enlarge", "nearest neighbour", "nearest neighbor", "pixelate", "blocky", "zoom", "integer scale", "resize", "chunky", "pixel art"],
  concept: "working-resolution",
  requirement: "F-SP-14",
  slot: "postprocess",
  family: "special",
  execution: "gpu",
  params: NN_UPSCALE_PARAMS,
  // Below an ordinary node. It is the right move constantly — but only in a
  // stack that also crushed the resolution, and Surprise Me draws each node
  // independently, so on its own it mostly produces a large soft frame.
  surpriseWeight: 0.7,
  // It writes an index map because it must, and reads one because it cannot
  // write one otherwise. Both are true at once, which is the same shape outline
  // and dilate/erode have: a rewriter, not a quantizer.
  producesIndexMap: true,
  requiresIndexMap: true,
  // It resamples, and unlike internal resolution it is *allowed* to do so while
  // an index map is live, because it carries the map across with it. Integer
  // nearest replication is the only rule under which that is meaningful: every
  // output texel takes exactly one source index, so no index is ever averaged
  // with another. `registry/stack.ts` reads `resamples` together with
  // `producesIndexMap` for precisely this distinction.
  resamples: true,
});

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("nn-upscale", () => NN_UPSCALE_GPU);
