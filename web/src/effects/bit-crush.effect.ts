/**
 * F-GL-13 — Bit crush: per-channel bit-depth reduction and bit-plane
 * corruption.
 *
 * **The crush happens in sRGB, not in linear light.** The working surface is
 * linear-light `rgba16float` and everything else in this application stays
 * there, because averaging, blending and error diffusion are physical
 * operations on light. Bit-depth reduction is not one of those: it is a
 * statement about a *storage encoding*, and every encoding this effect imitates
 * — a VGA DAC, an RGB565 framebuffer, an 8-bit PNG, an Amiga colour register —
 * stores gamma-encoded values. A crush that does not name its encoding is not
 * defined, so this one names sRGB, converts in, quantizes, corrupts, and
 * converts back out to linear light for the rest of the stack.
 *
 * The failure mode is worth stating because it looks plausible: crushing the
 * linear values puts linear 1/8 at sRGB 0.38, so at three bits per channel the
 * very first step already spans black to mid-grey. Every shadow collapses onto
 * two levels, the highlights get steps nobody can see, and the picture looks
 * like no hardware that ever shipped. Getting this backwards is the difference
 * between the effect and a plausible-looking wrong one.
 *
 * The three depths are independent because the requirement says per-channel,
 * and because the asymmetric depths are the interesting ones — RGB565 and
 * RGB332 are both real formats and neither is expressible with a single slider.
 */

import type { ParameterValue } from "../types/document";
import type { ComputePass, GpuEffect, PassBinding, UniformLayout } from "../types/gpu";
import { staticGpuEffect, defineEffect } from "../types/registry";
import type { EffectDescriptor, ParamDescriptor } from "../types/registry";

import wgsl from "../shaders/bit-crush.wgsl?raw";

const EFFECT_ID = "bit-crush";

/**
 * Canonical binding numbers, restated from CONVENTIONS.md.
 *
 * Bindings 2, 3 and 4 are absent. A crush quantizes, but it quantizes to a
 * *code space*, not to the document palette — there is no palette entry to name
 * for a given code, so there is no index map to emit and none to read.
 */
export const BIT_CRUSH_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const BIT_CRUSH_PARAM = {
  redBits: "redBits",
  greenBits: "greenBits",
  blueBits: "blueBits",
  corruptChance: "corruptChance",
  corruptPlane: "corruptPlane",
  seed: "seed",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `web/src/shaders/bit-crush.wgsl`.
 *
 * Eight 4-byte scalars fill exactly 32 bytes, so this is the one layout of the
 * four with no padding at all.
 */
export const BIT_CRUSH_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: BIT_CRUSH_PARAM.redBits }, type: "u32", offset: 8 },
    { source: { kind: "param", key: BIT_CRUSH_PARAM.greenBits }, type: "u32", offset: 12 },
    { source: { kind: "param", key: BIT_CRUSH_PARAM.blueBits }, type: "u32", offset: 16 },
    { source: { kind: "param", key: BIT_CRUSH_PARAM.corruptChance }, type: "f32", offset: 20 },
    { source: { kind: "param", key: BIT_CRUSH_PARAM.corruptPlane }, type: "u32", offset: 24 },
    { source: { kind: "param", key: BIT_CRUSH_PARAM.seed }, type: "u32", offset: 28 },
  ],
};

/**
 * Surprise metadata shared by the three depth controls.
 *
 * One object rather than three copies: they are the same control three times by
 * requirement, and three copies is three places for one of them to drift. The
 * range stops at 6 because seven and eight bits are visually indistinguishable
 * from the input on any real image — legal, but not a surprise.
 */
const DEPTH_SURPRISE = {
  range: [2, 6],
  distribution: { kind: "uniform" },
  weight: 1,
} as const;

const PARAMS = [
  {
    key: BIT_CRUSH_PARAM.redBits,
    label: "Red depth",
    type: "int",
    hint: "Bits kept in the red channel, measured in sRGB. 8 leaves it alone.",
    animatable: true,
    legal: [1, 8],
    // Four bits per channel is RGB444: a real hardware format, symmetric across
    // the three channels, and unmistakably the effect doing something.
    default: 4,
    surprise: DEPTH_SURPRISE,
  },
  {
    key: BIT_CRUSH_PARAM.greenBits,
    label: "Green depth",
    type: "int",
    hint: "Bits kept in the green channel, measured in sRGB. 8 leaves it alone.",
    animatable: true,
    legal: [1, 8],
    default: 4,
    surprise: DEPTH_SURPRISE,
  },
  {
    key: BIT_CRUSH_PARAM.blueBits,
    label: "Blue depth",
    type: "int",
    hint: "Bits kept in the blue channel, measured in sRGB. 8 leaves it alone.",
    animatable: true,
    legal: [1, 8],
    default: 4,
    surprise: DEPTH_SURPRISE,
  },
  {
    key: BIT_CRUSH_PARAM.corruptChance,
    label: "Corruption",
    type: "float",
    hint: "Chance per pixel per channel that the selected bit plane flips.",
    animatable: true,
    legal: [0, 1],
    // Off. Corruption is a departure from what a crush is, and the crush should
    // render as itself unless asked otherwise — the same reason the diffusion
    // kernels default their threshold jitter to zero.
    default: 0,
    step: 0.005,
    surprise: {
      // Past roughly a sixth the speckle stops being damage on a picture and
      // becomes the picture. Zero stays in range: a clean crush is a perfectly
      // good random result.
      range: [0, 0.15],
      distribution: { kind: "uniform" },
      weight: 0.7,
    },
  },
  {
    key: BIT_CRUSH_PARAM.corruptPlane,
    label: "Corrupted plane",
    type: "int",
    // Counted from the channel's most significant bit, so plane 0 is always the
    // biggest jump that channel can make and the control means the same thing
    // at two bits as at eight. Counting from the bottom instead would make the
    // slider inert on a shallow channel, which is worse than making it coarse.
    hint: "Which bit plane flips, counted from the top. 0 is the loudest.",
    animatable: true,
    legal: [0, 7],
    default: 0,
    surprise: {
      // Beyond the fourth plane down, a flip is smaller than the crush's own
      // step on any channel shallow enough to be worth crushing.
      range: [0, 3],
      distribution: { kind: "uniform" },
      weight: 0.5,
    },
  },
  {
    key: BIT_CRUSH_PARAM.seed,
    label: "Seed",
    type: "seed",
    hint: "Fixes which pixels corrupt. Nothing here reads a clock.",
    animatable: false,
    default: 0,
    surprise: {
      // Lower than the other glitch seeds: the corruption is speckle, so one
      // seed's arrangement looks much like another's, and rerolling it is not
      // the move that changes the result.
      weight: 0.6,
    },
  },
] as const satisfies readonly ParamDescriptor[];

const DESCRIPTOR = defineEffect({
  id: EFFECT_ID,
  name: "Bit crush",
  requirement: "F-GL-13",
  // Glitch effects sit after the primary dither in the stack grammar (F-SM-03).
  slot: "postprocess",
  family: "glitch",
  execution: "gpu",
  params: PARAMS,
  // The gentlest of the glitch four and the one that flatters the most images,
  // so it is drawn more often than the destructive ones.
  surpriseWeight: 0.9,
  // It quantizes to a code space rather than to the document palette, so there
  // is no palette index it could name.
  producesIndexMap: false,
  requiresIndexMap: false,
});

/** What the registry glob collects (`registry/discovery.ts`). */
export default DESCRIPTOR;

/** The same object under a name, for the GPU side. */
export const BIT_CRUSH_DESCRIPTOR: EffectDescriptor = DESCRIPTOR;

const BINDINGS: readonly PassBinding[] = [
  { role: "input-color", binding: BIT_CRUSH_BINDING.inputColor },
  { role: "output-color", binding: BIT_CRUSH_BINDING.outputColor },
  { role: "uniforms", binding: BIT_CRUSH_BINDING.uniforms },
];

const PASS: ComputePass = {
  id: `${EFFECT_ID}/crush`,
  label: "Bit crush",
  wgsl,
  entryPoint: "main",
  // 64 invocations, well under the 256 guaranteed everywhere.
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  // Reads only its own pixel; the corruption draw comes from the coordinate and
  // the seed, not from a neighbour.
  access: "pointwise",
  bindings: BINDINGS,
  uniforms: BIT_CRUSH_UNIFORMS,
};

export const BIT_CRUSH_GPU: GpuEffect = { effect: EFFECT_ID, passes: [PASS] };

/** Parameter descriptors keyed for `packUniforms`. */
export const BIT_CRUSH_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  PARAMS.map((param) => [param.key, param]),
);

/** Defaults, for a node created without an explicit parameter set. */
export function bitCrushDefaults(): Record<string, ParameterValue> {
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
export function createBitCrush(): {
  readonly descriptor: EffectDescriptor;
  readonly gpu: GpuEffect;
} {
  return { descriptor: DESCRIPTOR, gpu: BIT_CRUSH_GPU };
}

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("bit-crush", () => BIT_CRUSH_GPU);
