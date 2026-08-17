/**
 * Noise source (F-GN-01).
 *
 * Value, gradient (Perlin), simplex, Worley and Worley edges, summed over
 * octaves as fractional Brownian motion. **It takes no image**: it sits in the
 * `source` slot and its pass binds no `input-color`, so a document containing
 * one needs no photograph.
 *
 * ## Why five kinds are one effect
 *
 * Everything around the field is identical — the domain, the octave sum, the
 * ridge fold, the encoding — and what differs is one function call. Five
 * effects would be five copies of the fBm loop, and the first time anyone
 * changed how `gain` normalises they would change one of them.
 *
 * ## Worley is the one to read the description of
 *
 * It is the basis of most of what people mean by generative texture, and its
 * two readings are different pictures from the same work: `worley` is the
 * distance to the nearest feature point, which gives rounded cell interiors —
 * scales, cracked earth, crumpled foil — and `worley-edges` is the gap between
 * the nearest two, which is zero exactly on a cell wall and gives the Voronoi
 * network. Both are argued where they are computed, in
 * `../shaders/gen-noise.wgsl`.
 *
 * ## Animation
 *
 * `evolve` is the third coordinate of a three-dimensional field, and it is the
 * animation control this node exists to have: panning a 2D field slides the
 * texture, and moving through a 3D one makes it boil in place. Bound to a sine
 * with an integral `cyclesPerLoop` (F-AN-03) it returns to its own starting
 * value at frame N, so the loop closes bit-exactly. `offsetX`/`offsetY` are the
 * pan, and `scale` breathes.
 *
 * The cost of three dimensions is stated on the parameter rather than hidden:
 * eight lattice corners instead of four, and 27 Worley cells instead of nine.
 */

import {
  defineEffect,
  staticGpuEffect,
  type ParamDescriptor,
} from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/gen-noise.wgsl?raw";

/**
 * Canonical binding numbers, restated from `shaders/CONVENTIONS.md`.
 *
 * **There is no `inputColor`.** That absence is what makes this a source, and
 * `gpu/compiler.ts` checks it against the descriptor's slot both ways.
 */
export const GEN_NOISE_BINDING = {
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const GEN_NOISE_PARAM = {
  kind: "kind",
  octaves: "octaves",
  seed: "seed",
  ridged: "ridged",
  scale: "scale",
  lacunarity: "lacunarity",
  gain: "gain",
  offsetX: "offsetX",
  offsetY: "offsetY",
  evolve: "evolve",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/gen-noise.wgsl`.
 *
 * Twelve 4-byte scalars in one run, so nothing needs padding anywhere: 48 bytes
 * exactly, already a multiple of the 16-byte round-up.
 */
export const GEN_NOISE_UNIFORMS: UniformLayout = {
  sizeBytes: 48,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: GEN_NOISE_PARAM.kind }, type: "u32", offset: 8 },
    { source: { kind: "param", key: GEN_NOISE_PARAM.octaves }, type: "u32", offset: 12 },
    { source: { kind: "param", key: GEN_NOISE_PARAM.seed }, type: "u32", offset: 16 },
    { source: { kind: "param", key: GEN_NOISE_PARAM.ridged }, type: "u32", offset: 20 },
    { source: { kind: "param", key: GEN_NOISE_PARAM.scale }, type: "f32", offset: 24 },
    { source: { kind: "param", key: GEN_NOISE_PARAM.lacunarity }, type: "f32", offset: 28 },
    { source: { kind: "param", key: GEN_NOISE_PARAM.gain }, type: "f32", offset: 32 },
    { source: { kind: "param", key: GEN_NOISE_PARAM.offsetX }, type: "f32", offset: 36 },
    { source: { kind: "param", key: GEN_NOISE_PARAM.offsetY }, type: "f32", offset: 40 },
    { source: { kind: "param", key: GEN_NOISE_PARAM.evolve }, type: "f32", offset: 44 },
  ],
};

/**
 * How far the field may be panned, in pixels.
 *
 * Four thousand is past the long side of any frame this build renders, so a
 * modulator bound to it can carry the field entirely off and back. Larger
 * values do nothing a smaller one does not, and they start losing float
 * precision in the lattice coordinate.
 */
const MAX_OFFSET = 4096;

const GEN_NOISE_PARAMS: readonly ParamDescriptor[] = [
  {
    key: GEN_NOISE_PARAM.kind,
    label: "Field",
    type: "enum",
    // A choice, not a quantity: a modulator bound to it would cut between five
    // unrelated textures rather than animate one.
    animatable: false,
    description:
      "Which noise the field is made of. Value is blobby, gradient and simplex are smooth billows, Worley is cells and Worley edges is the network of walls between them.",
    // Append-only: the shader reads the ordinal, so inserting a value in the
    // middle renumbers every document already saved.
    values: [
      { value: "value", label: "Value" },
      { value: "perlin", label: "Gradient (Perlin)" },
      { value: "simplex", label: "Simplex" },
      { value: "worley", label: "Worley" },
      { value: "worley-edges", label: "Worley edges" },
    ],
    // Simplex: the smooth field with no axis-aligned grain, which is the one
    // that survives being dithered without giving away its own lattice.
    default: "simplex",
    surprise: {
      values: [
        { value: "simplex", weight: 2 },
        { value: "perlin", weight: 1.5 },
        // Worley twice over, because its two readings are two different looks
        // and both are what a generative texture is usually made of.
        { value: "worley", weight: 1.5 },
        { value: "worley-edges", weight: 1.2 },
        // Value noise is the plainest of the five and reads as a blur of dots
        // more often than as a texture.
        { value: "value", weight: 0.6 },
      ],
      weight: 1,
    },
  },
  {
    key: GEN_NOISE_PARAM.scale,
    label: "Feature size",
    type: "float",
    animatable: true,
    description:
      "How many pixels across one feature of the first octave is. Small values give fine grain, large values give slow billows.",
    legal: [1, 4096],
    default: 64,
    step: 0.5,
    surprise: {
      // Log, because this is a size measured in octaves: uniform sampling of
      // 8..512 spends most of its draws above 250, where every result is one
      // slow billow across the frame (F-SM-04).
      range: [12, 400],
      distribution: { kind: "log" },
      weight: 1,
    },
  },
  {
    key: GEN_NOISE_PARAM.octaves,
    label: "Octaves",
    type: "int",
    // Integral and discrete: ramping it adds a whole octave at a time, which is
    // a step in the texture rather than an animation of it.
    animatable: false,
    description:
      "How many times the field is layered at ever finer scales. One is the plain field; four or more give the fractal detail that reads as terrain or cloud.",
    // Eight is where the finest octave is below a pixel at any sensible feature
    // size, so a ninth would cost a full Worley evaluation for nothing.
    legal: [1, 8],
    default: 4,
    surprise: {
      range: [1, 6],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: GEN_NOISE_PARAM.lacunarity,
    label: "Octave step",
    type: "float",
    animatable: true,
    description:
      "How much finer each octave is than the one before it. 2 halves the feature size each time, which is the usual fractal; near 1 the octaves pile up at almost the same size and interfere.",
    legal: [1.01, 8],
    default: 2,
    step: 0.01,
    surprise: {
      // Narrow on purpose. Away from 2 the octaves stop being a fractal and
      // start being a moiré, which is occasionally wanted and rarely what a
      // random draw should produce.
      range: [1.7, 2.6],
      distribution: { kind: "normal", mean: 2, sigma: 0.25 },
      weight: 0.6,
    },
  },
  {
    key: GEN_NOISE_PARAM.gain,
    label: "Octave falloff",
    type: "float",
    animatable: true,
    description:
      "How much quieter each octave is than the one before it. 0.5 is the usual fractal; near 1 every octave is equally loud and the field turns to grain.",
    legal: [0.05, 1],
    default: 0.5,
    step: 0.01,
    surprise: {
      // Below about 0.3 the second octave is already invisible and the octave
      // count stops meaning anything.
      range: [0.35, 0.75],
      distribution: { kind: "uniform" },
      weight: 0.9,
    },
  },
  {
    key: GEN_NOISE_PARAM.ridged,
    label: "Ridges",
    type: "bool",
    // A fold, not a quantity: there is no half-folded field between the two.
    animatable: false,
    description:
      "Fold each octave about its middle, so the smooth zero crossings become sharp creases. This is what turns a cloud field into eroded terrain.",
    default: false,
    surprise: {
      trueProbability: 0.35,
      weight: 0.8,
    },
  },
  {
    key: GEN_NOISE_PARAM.offsetX,
    label: "Pan X",
    type: "float",
    animatable: true,
    description:
      "Slides the whole field right, in pixels. Bound to a modulator this drifts the texture across the frame without changing it.",
    legal: [-MAX_OFFSET, MAX_OFFSET],
    // Zero: a node added to a stack should do the thing it is named for and
    // nothing else. Motion is what a binding is for.
    default: 0,
    step: 0.5,
    surprise: {
      // Small: the field is statistically the same everywhere, so a large
      // random pan is a different picture for no reason a viewer can see. It
      // moves at all so that two nodes with the same seed are not identical.
      range: [-256, 256],
      distribution: { kind: "normal", mean: 0, sigma: 100 },
      weight: 0.4,
    },
  },
  {
    key: GEN_NOISE_PARAM.offsetY,
    label: "Pan Y",
    type: "float",
    animatable: true,
    description: "Slides the whole field down, in pixels. Negative drifts it upward.",
    legal: [-MAX_OFFSET, MAX_OFFSET],
    default: 0,
    step: 0.5,
    surprise: {
      range: [-256, 256],
      distribution: { kind: "normal", mean: 0, sigma: 100 },
      weight: 0.4,
    },
  },
  {
    key: GEN_NOISE_PARAM.evolve,
    label: "Evolve",
    type: "float",
    animatable: true,
    description:
      "Moves through the field's third dimension, so features grow and dissolve in place rather than sliding past. This is the control to animate; one unit is one feature size of travel.",
    // Wide, because a modulator's amount is measured against this range and a
    // long loop wants many units of travel.
    legal: [-1024, 1024],
    default: 0,
    step: 0.01,
    surprise: {
      // The field is statistically identical at every depth, so a random start
      // depth only matters for making two nodes with the same seed differ.
      range: [0, 64],
      distribution: { kind: "uniform" },
      weight: 0.4,
    },
  },
  {
    key: GEN_NOISE_PARAM.seed,
    label: "Seed",
    type: "seed",
    // A seed is not a quantity either: the field at seed 5 and the field at
    // seed 6 have nothing in common, so ramping between them is a cut per
    // frame rather than an animation.
    animatable: false,
    description:
      "Which field this is. Every seed gives a completely different texture at the same settings; nothing here reads a clock, so one seed is one picture forever.",
    default: 0x5eed,
    surprise: {
      // High: the seed is the cheapest way for two draws to be different
      // pictures, and every seed is as good as every other (F-AN-05).
      weight: 1.5,
    },
  },
];

export default defineEffect({
  id: "gen-noise",
  name: "Noise field",
  summary:
    "Fills the frame with value, Perlin, simplex or Worley noise — a source node, so it needs no image.",
  description:
    "A generator: it takes no picture and makes one from its parameters, so a document can start here instead of with a photograph. Five fields are on offer and they are genuinely different textures rather than variations: value noise is blobby, gradient (Perlin) and simplex are smooth billows — simplex without the faint square grain Perlin leaves — Worley is the distance to the nearest of one point per cell, which reads as scales or cracked earth, and Worley edges is the gap between the nearest two, which draws the network of walls between the cells and is what most people mean by a Voronoi texture. Octaves layer the field at ever finer scales for fractal detail, and ridges fold each octave about its middle to turn cloud into eroded terrain. The field is three-dimensional and Evolve moves through it, so an animated noise boils in place instead of sliding past — bind a modulator to Evolve rather than to the pan. It is greyscale on purpose: put Gradient map after it for colour. Dithering a noise field is what makes it look printed rather than rendered, and a small palette turns Worley edges into line art.",
  keywords: [
    "noise",
    "perlin",
    "simplex",
    "worley",
    "cellular",
    "voronoi",
    "fbm",
    "fractal",
    "fractal noise",
    "value noise",
    "gradient noise",
    "octaves",
    "turbulence",
    "ridged",
    "terrain",
    "clouds",
    "smoke",
    "marble",
    "organic",
    "texture",
    "generator",
    "source",
    "background",
    "no image",
    "from scratch",
    "procedural",
    "touchdesigner",
  ],
  concept: "optical",
  requirement: "F-GN-01",
  slot: "source",
  family: "pattern",
  execution: "gpu",
  params: GEN_NOISE_PARAMS,
  surpriseWeight: 0.7,
  producesIndexMap: false,
  requiresIndexMap: false,
});

/** Parameter descriptors keyed for `packUniforms`, which needs them for enums. */
export const GEN_NOISE_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  GEN_NOISE_PARAMS.map((param) => [param.key, param]),
);

const bindings: readonly PassBinding[] = [
  // No `input-color`. That absence is the whole of what makes this a source.
  { role: "output-color", binding: GEN_NOISE_BINDING.outputColor },
  { role: "uniforms", binding: GEN_NOISE_BINDING.uniforms },
];

const pass: ComputePass = {
  id: "gen-noise/main",
  label: "Noise source",
  wgsl,
  entryPoint: "main",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  // Every pixel is a function of its own coordinate and the seed. It reads no
  // neighbour because it reads no texture at all.
  access: "pointwise",
  bindings,
  uniforms: GEN_NOISE_UNIFORMS,
};

/** The compute pass, for the pass compiler. */
export const GEN_NOISE_GPU: GpuEffect = {
  effect: "gen-noise",
  passes: [pass],
};

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("gen-noise", () => GEN_NOISE_GPU);
