/**
 * F-GL-12 — Block shuffle: grid size, seeded permutation, swap probability.
 *
 * The permutation is a **real permutation**, reproducible from the seed alone,
 * and that constraint is what shapes the whole implementation. Hashing each
 * block to a destination is not a permutation — some blocks would arrive twice
 * and others never — and a shuffled table cannot be built inside a dispatch,
 * because there is no sort and no CPU round trip there. What is left is a
 * cipher: a small Feistel network is a bijection by construction and every
 * invocation can evaluate it independently and agree. The construction and the
 * proof that it stays a bijection are written out in
 * `web/src/shaders/block-shuffle.wgsl`.
 *
 * **The grid is counts, not a block size in pixels.** A pixel size would make
 * the block count, and therefore the permutation, a function of the working
 * resolution — so a preview and its export would be two different pictures
 * rather than one picture at two sizes. Everything else in the catalogue
 * measures in pixels; this cannot.
 */

import type { ParameterValue } from "../types/document";
import type { ComputePass, GpuEffect, PassBinding, UniformLayout } from "../types/gpu";
import { staticGpuEffect, defineEffect } from "../types/registry";
import type { EffectDescriptor, ParamDescriptor } from "../types/registry";

import wgsl from "../shaders/block-shuffle.wgsl?raw";

const EFFECT_ID = "block-shuffle";

/**
 * Canonical binding numbers, restated from CONVENTIONS.md.
 *
 * Bindings 2, 3 and 4 are absent: the effect moves whole blocks of pixels
 * without deciding what they are, so it neither reads nor writes an index map
 * and never consults the palette.
 */
export const BLOCK_SHUFFLE_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const BLOCK_SHUFFLE_PARAM = {
  columns: "columns",
  rows: "rows",
  swapProbability: "swapProbability",
  seed: "seed",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `web/src/shaders/block-shuffle.wgsl`.
 *
 * Six 4-byte scalars in a run; the only padding is the tail that rounds 24 up
 * to 32.
 */
export const BLOCK_SHUFFLE_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: BLOCK_SHUFFLE_PARAM.columns }, type: "u32", offset: 8 },
    { source: { kind: "param", key: BLOCK_SHUFFLE_PARAM.rows }, type: "u32", offset: 12 },
    {
      source: { kind: "param", key: BLOCK_SHUFFLE_PARAM.swapProbability },
      type: "f32",
      offset: 16,
    },
    { source: { kind: "param", key: BLOCK_SHUFFLE_PARAM.seed }, type: "u32", offset: 20 },
  ],
};

/**
 * Largest grid the shader's Feistel network is sized for.
 *
 * 256 x 256 is 65536 blocks, which is exactly eight bits per Feistel half. The
 * shader restates this as `MAX_HALF_BITS`; raising the legal range here without
 * raising it there would silently fold the top of the grid onto itself, so the
 * two numbers are named on both sides rather than left as literals.
 */
const MAX_GRID_AXIS = 256;

const PARAMS = [
  {
    key: BLOCK_SHUFFLE_PARAM.columns,
    label: "Columns",
    type: "int",
    hint: "Blocks across. The grid is counts, so it survives a resolution change.",
    animatable: false,
    legal: [1, MAX_GRID_AXIS],
    default: 16,
    surprise: {
      // Under four there are too few blocks for the shuffle to read as one;
      // over about fifty the blocks are small enough that the result is grain
      // rather than displacement.
      range: [4, 48],
      // A block count is read in octaves — 4 to 8 is the same visual step as 24
      // to 48 — so uniform sampling would put most draws in the top octave.
      distribution: { kind: "log" },
      weight: 1,
    },
  },
  {
    key: BLOCK_SHUFFLE_PARAM.rows,
    label: "Rows",
    type: "int",
    hint: "Blocks down. Separate from columns so blocks can be strips.",
    animatable: false,
    legal: [1, MAX_GRID_AXIS],
    default: 16,
    surprise: {
      range: [4, 48],
      distribution: { kind: "log" },
      weight: 1,
    },
  },
  {
    key: BLOCK_SHUFFLE_PARAM.swapProbability,
    label: "Swap probability",
    type: "float",
    // The shader pairs blocks off and draws one coin per pair, so this is
    // literally the fraction of pairs that exchange places — and the map stays
    // a permutation at every value, which a per-block coin could not manage.
    hint: "Fraction of block pairs that exchange places. 0 leaves the image alone.",
    animatable: true,
    legal: [0, 1],
    default: 0.5,
    step: 0.01,
    surprise: {
      // Below about 0.15 the effect is a handful of stray blocks and reads as a
      // rendering fault rather than a treatment; at 1 nothing is left in place
      // and the picture stops being one.
      range: [0.15, 0.8],
      distribution: { kind: "uniform" },
      weight: 1.2,
    },
  },
  {
    key: BLOCK_SHUFFLE_PARAM.seed,
    label: "Seed",
    type: "seed",
    hint: "Fixes the permutation. The same seed and grid always shuffle the same way.",
    animatable: false,
    default: 0,
    surprise: {
      // The seed is the whole arrangement here. Rerolling it while the grid and
      // the probability stay put is the most useful move this effect has.
      weight: 1.5,
    },
  },
] as const satisfies readonly ParamDescriptor[];

const DESCRIPTOR = defineEffect({
  id: EFFECT_ID,
  name: "Block shuffle",
  requirement: "F-GL-12",
  // Glitch effects sit after the primary dither in the stack grammar (F-SM-03).
  slot: "postprocess",
  family: "glitch",
  execution: "gpu",
  params: PARAMS,
  // The most destructive of the four: it is a signature look, but a random
  // document that reaches for it as often as it reaches for a bit crush is a
  // random document that mostly returns scrambled pictures.
  surpriseWeight: 0.5,
  producesIndexMap: false,
  requiresIndexMap: false,
});

/** What the registry glob collects (`registry/discovery.ts`). */
export default DESCRIPTOR;

/** The same object under a name, for the GPU side. */
export const BLOCK_SHUFFLE_DESCRIPTOR: EffectDescriptor = DESCRIPTOR;

const BINDINGS: readonly PassBinding[] = [
  { role: "input-color", binding: BLOCK_SHUFFLE_BINDING.inputColor },
  { role: "output-color", binding: BLOCK_SHUFFLE_BINDING.outputColor },
  { role: "uniforms", binding: BLOCK_SHUFFLE_BINDING.uniforms },
];

const PASS: ComputePass = {
  id: `${EFFECT_ID}/gather`,
  label: "Block shuffle",
  wgsl,
  entryPoint: "main",
  // 64 invocations, well under the 256 guaranteed everywhere.
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  // A block's source may be anywhere in the image.
  access: "global",
  bindings: BINDINGS,
  uniforms: BLOCK_SHUFFLE_UNIFORMS,
};

export const BLOCK_SHUFFLE_GPU: GpuEffect = { effect: EFFECT_ID, passes: [PASS] };

/** Parameter descriptors keyed for `packUniforms`. */
export const BLOCK_SHUFFLE_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  PARAMS.map((param) => [param.key, param]),
);

/** Defaults, for a node created without an explicit parameter set. */
export function blockShuffleDefaults(): Record<string, ParameterValue> {
  const defaults: Record<string, ParameterValue> = {};
  for (const param of PARAMS) {
    switch (param.type) {
      case "int":
      case "float":
      case "seed":
        defaults[param.key] = param.default;
        break;
    }
  }
  return defaults;
}

/** Descriptor and compute pass together, which is what the compiler takes. */
export function createBlockShuffle(): {
  readonly descriptor: EffectDescriptor;
  readonly gpu: GpuEffect;
} {
  return { descriptor: DESCRIPTOR, gpu: BLOCK_SHUFFLE_GPU };
}

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("block-shuffle", () => BLOCK_SHUFFLE_GPU);
