/**
 * F-SP-04 — Edge detect, Sobel and Laplacian, with mix-back.
 *
 * Both operators are 3x3 convolutions over lightness, so they are one dispatch
 * with the choice in a uniform rather than two effects that would drift apart.
 * They are normalised against each other — a full-contrast step edge reads 1.0
 * from either — so `strength` means one thing regardless of which is selected.
 *
 * `strength` is not in the requirement's list and is not decoration. An edge
 * response is a difference between neighbouring pixels, so on anything but a
 * hard graphic edge it lands in the low hundredths; without a gain the effect
 * produces a black frame on most photographs and the mix-back control has
 * nothing to mix.
 *
 * Slot is `preprocess`. Run after a dither, an edge detector finds the dither's
 * own texture rather than the picture's edges — every pixel is a step edge by
 * then. Run before it, it makes line art that dithers cleanly. The slot steers
 * Surprise Me's grammar only; F-ST-01 lets the user drag the node anywhere.
 */

import { defineEffect, type ParamDescriptor } from "../types/registry";
import type { ComputePass, GpuEffect, PassBinding, UniformLayout } from "../types/gpu";

import wgsl from "../shaders/edge-detect.wgsl?raw";

/** Canonical binding numbers, restated from CONVENTIONS.md. */
const BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

const PARAM = {
  operator: "operator",
  strength: "strength",
  mix: "mix",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `edge-detect.wgsl`.
 *
 * Five 4-byte scalars, so nothing needs padding in front of it and the only
 * padding is the tail that rounds 20 up to 32. `operator` is a `u32` because an
 * enum parameter reaches the shader as its ordinal.
 */
export const EDGE_DETECT_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: PARAM.strength }, type: "f32", offset: 8 },
    { source: { kind: "param", key: PARAM.mix }, type: "f32", offset: 12 },
    { source: { kind: "param", key: PARAM.operator }, type: "u32", offset: 16 },
  ],
};

const OPERATOR: ParamDescriptor = {
  key: PARAM.operator,
  label: "Operator",
  type: "enum",
  animatable: false,
  hint: "Sobel is a gradient magnitude and gives thick directional edges. Laplacian is a second derivative and gives thin symmetric ones.",
  // Append-only. The shader sees the ordinal, so inserting a value in the
  // middle silently renumbers every document already saved.
  values: [
    { value: "sobel", label: "Sobel" },
    { value: "laplacian", label: "Laplacian" },
  ],
  default: "sobel",
  surprise: {
    // Sobel is the more forgiving of the two on photographic input: the
    // Laplacian is a second derivative and amplifies whatever noise the source
    // arrived with.
    values: [
      { value: "sobel", weight: 3 },
      { value: "laplacian", weight: 2 },
    ],
    weight: 0.7,
  },
};

const STRENGTH: ParamDescriptor = {
  key: PARAM.strength,
  label: "Strength",
  type: "float",
  animatable: true,
  hint: "Gain on the edge response before it is clipped to white.",
  legal: [0, 8],
  default: 1,
  step: 0.05,
  surprise: {
    // Below about 0.6 most photographic input produces a near-black map; above
    // 3 every edge is clipped to white and the operator stops being legible
    // (F-SM-04).
    range: [0.6, 3],
    // Gain is heard in ratios, so log.
    distribution: { kind: "log" },
    weight: 1,
  },
};

const MIX: ParamDescriptor = {
  key: PARAM.mix,
  label: "Mix back",
  type: "float",
  animatable: true,
  hint: "0 leaves the picture alone, 1 replaces it with the edge map.",
  legal: [0, 1],
  // The plain edge map. An effect called "edge detect" should render edges
  // unless asked to blend them.
  default: 1,
  step: 0.01,
  surprise: {
    // Under about half the edges are a texture on the picture rather than a
    // visible decision, which is a subtler effect than this one is for.
    range: [0.5, 1],
    distribution: { kind: "uniform" },
    weight: 0.8,
  },
};

export default defineEffect({
  id: "edge-detect",
  name: "Edge detect",
  requirement: "F-SP-04",
  slot: "preprocess",
  family: "special",
  execution: "gpu",
  params: [OPERATOR, STRENGTH, MIX],
  // Well below an ordinary effect. It discards most of the picture, so it is
  // something reached for on purpose rather than something a random stack
  // should keep landing on (F-SM-03).
  surpriseWeight: 0.6,
  producesIndexMap: false,
  requiresIndexMap: false,
});

const BINDINGS: readonly PassBinding[] = [
  { role: "input-color", binding: BINDING.inputColor },
  { role: "output-color", binding: BINDING.outputColor },
  { role: "uniforms", binding: BINDING.uniforms },
];

const PASSES: readonly ComputePass[] = [
  {
    id: "edge-detect/detect",
    label: "Edge detect",
    wgsl,
    entryPoint: "detect",
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    // Reads a 3x3 window, so input and output must not alias.
    access: "neighbourhood",
    bindings: BINDINGS,
    uniforms: EDGE_DETECT_UNIFORMS,
  },
];

export const edgeDetectGpuEffect: GpuEffect = {
  effect: "edge-detect",
  passes: PASSES,
};

/**
 * Parameter descriptors keyed for `packUniforms`.
 *
 * Not optional here: `operator` arrives as a string and only the descriptor
 * knows which ordinal it is, so the packer refuses the node without this map.
 */
export const EDGE_DETECT_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> =
  new Map<string, ParamDescriptor>([
    [OPERATOR.key, OPERATOR],
    [STRENGTH.key, STRENGTH],
    [MIX.key, MIX],
  ]);
