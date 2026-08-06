/**
 * Soft light leak (F-SP-15).
 *
 * One compute pass, read-your-own-pixel. Stray light reaching the emulsion
 * through a gap in the body: a soft coloured pool with a position, a colour and
 * an amount, added to the frame.
 *
 * F-SP-01's epsilon glow is the neighbouring requirement and a different effect:
 * a glow is derived from the image — it finds bright pixels and spreads them —
 * whereas a leak knows nothing about the picture it lands on. That is why this
 * one is `pointwise` and has no threshold or radius over the *source*, only over
 * the frame.
 *
 * ## Why the colour is three floats and not one `color` parameter
 *
 * A `color` parameter cannot reach a shader: `ParameterValue` in
 * `../types/document.ts` is `number | boolean | string`, so a `.dork` file has
 * nowhere to put a triplet, and `resolveParam` in `../gpu/uniforms.ts` handles
 * only numbers, booleans and enum strings — a `color` field wired to a uniform
 * throws `UniformPackError` on every pack. `./gradient-map.effect.ts` writes the
 * gap up in full, including the two changes that would close it, and this file
 * makes the same substitution its stops do: OKLab lightness, chroma and hue,
 * which is the axis set `ColorSurprise` already argues for, so a random leak is
 * a colour rather than mud.
 *
 * Why the light is added rather than screened, and why the falloff has compact
 * support, are in `../shaders/light-leak.wgsl` next to the code that does it.
 */

import { defineEffect, type ParamDescriptor } from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/light-leak.wgsl?raw";

/** Canonical binding numbers, restated from `shaders/CONVENTIONS.md`. */
export const LIGHT_LEAK_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const LIGHT_LEAK_PARAM = {
  positionX: "positionX",
  positionY: "positionY",
  radius: "radius",
  softness: "softness",
  lightness: "lightness",
  chroma: "chroma",
  hue: "hue",
  intensity: "intensity",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/light-leak.wgsl`. Ten 4-byte scalars — 40 bytes in a block WGSL
 * rounds up to 48. Everything is a scalar on purpose: a `vec2f` for the position
 * pair would align to 8 and put a hole in the middle that both sides then have
 * to agree about.
 */
export const LIGHT_LEAK_UNIFORMS: UniformLayout = {
  sizeBytes: 48,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: LIGHT_LEAK_PARAM.positionX }, type: "f32", offset: 8 },
    { source: { kind: "param", key: LIGHT_LEAK_PARAM.positionY }, type: "f32", offset: 12 },
    { source: { kind: "param", key: LIGHT_LEAK_PARAM.radius }, type: "f32", offset: 16 },
    { source: { kind: "param", key: LIGHT_LEAK_PARAM.softness }, type: "f32", offset: 20 },
    { source: { kind: "param", key: LIGHT_LEAK_PARAM.lightness }, type: "f32", offset: 24 },
    { source: { kind: "param", key: LIGHT_LEAK_PARAM.chroma }, type: "f32", offset: 28 },
    { source: { kind: "param", key: LIGHT_LEAK_PARAM.hue }, type: "f32", offset: 32 },
    { source: { kind: "param", key: LIGHT_LEAK_PARAM.intensity }, type: "f32", offset: 36 },
  ],
};

/**
 * Highest OKLab chroma a leak colour may name.
 *
 * `CHROMA_CEILING` in `../types/registry.ts` is 0.5 and is the bound the
 * validator enforces on a `ColorSurprise`; sRGB itself tops out near 0.33 and
 * only for a few hues. 0.35 is past every in-gamut colour and short of the
 * region where the whole range clamps to zero at the shader's gamut guard.
 */
const MAX_CHROMA = 0.35;

export const LIGHT_LEAK_PARAMS: readonly ParamDescriptor[] = [
  {
    key: LIGHT_LEAK_PARAM.positionX,
    label: "Position X",
    type: "float",
    hint: "Where the leak comes from, in frame widths. 0 is the left edge, 1 the right.",
    animatable: true,
    // Past the edges on purpose: a leak enters through a gap in the body, so its
    // source is usually just outside the picture and only its tail is in frame.
    legal: [-1, 2],
    default: 0.12,
    surprise: {
      range: [-0.2, 1.2],
      distribution: { kind: "uniform" },
      weight: 1,
    },
    step: 0.01,
  },
  {
    key: LIGHT_LEAK_PARAM.positionY,
    label: "Position Y",
    type: "float",
    hint: "Where the leak comes from, in frame heights. 0 is the top edge, 1 the bottom.",
    animatable: true,
    legal: [-1, 2],
    default: 0.1,
    surprise: {
      range: [-0.2, 1.2],
      distribution: { kind: "uniform" },
      weight: 1,
    },
    step: 0.01,
  },
  {
    key: LIGHT_LEAK_PARAM.radius,
    label: "Radius",
    type: "float",
    hint: "Size of the fully-lit core, in half-diagonals. 1 spans the whole frame.",
    animatable: true,
    legal: [0, 2],
    default: 0.3,
    surprise: {
      // Log, because it is a size measured in octaves: uniform sampling of
      // 0.1..1 spends most of its draws above 0.5, where the leak is a flat wash
      // over the whole frame and the position control stops showing.
      range: [0.1, 0.8],
      distribution: { kind: "log" },
      weight: 1,
    },
    step: 0.01,
  },
  {
    key: LIGHT_LEAK_PARAM.softness,
    label: "Softness",
    type: "float",
    hint: "How far the leak takes to fade out, in the same units as the radius.",
    animatable: true,
    // Strictly positive: `smoothstep` with a zero-width band is indeterminate in
    // WGSL, and a hard-edged leak is a circle of paint, not light.
    legal: [0.01, 3],
    default: 0.8,
    surprise: {
      range: [0.3, 1.6],
      distribution: { kind: "log" },
      weight: 0.8,
    },
    step: 0.01,
  },
  {
    key: LIGHT_LEAK_PARAM.lightness,
    label: "Colour lightness",
    type: "float",
    hint: "OKLab lightness of the light itself. Low is a deep, dense leak; high is a pale wash.",
    animatable: true,
    legal: [0, 1],
    default: 0.9,
    surprise: {
      // Dark leaks add almost nothing — the light that fogs film is bright by
      // definition — so the draw stays in the top half.
      range: [0.6, 1],
      distribution: { kind: "uniform" },
      weight: 0.7,
    },
    step: 0.01,
  },
  {
    key: LIGHT_LEAK_PARAM.chroma,
    label: "Colour chroma",
    type: "float",
    hint: "OKLab chroma. Zero is a colourless flare; this is where the leak gets its colour.",
    animatable: true,
    legal: [0, MAX_CHROMA],
    default: 0.12,
    surprise: {
      // Above about 0.2 a high-lightness colour leaves the sRGB gamut and the
      // shader's clamp turns further chroma into no further change.
      range: [0.04, 0.2],
      distribution: { kind: "uniform" },
      weight: 1,
    },
    step: 0.005,
  },
  {
    key: LIGHT_LEAK_PARAM.hue,
    label: "Colour hue",
    type: "float",
    // Degrees rather than turns, unlike the ordered dithers' tile rotation: this
    // is a colour wheel, where 360 is the unit everyone reads, and a modulator
    // ramping 0 -> 360 still closes the loop exactly.
    hint: "OKLab hue in degrees. Around 60 is the warm orange of a classic leak.",
    animatable: true,
    legal: [0, 360],
    default: 55,
    surprise: {
      // The warm arc. A green or blue leak is a real thing — it comes from a
      // different gap and a different film — but it reads as a colour cast
      // rather than as sunlight, so the default draw stays where the look is.
      range: [15, 95],
      distribution: { kind: "uniform" },
      weight: 0.8,
    },
    step: 1,
  },
  {
    key: LIGHT_LEAK_PARAM.intensity,
    label: "Intensity",
    type: "float",
    hint: "How much light is added at the centre of the leak. Above 1 blows the highlight out.",
    animatable: true,
    legal: [0, 2],
    default: 0.55,
    surprise: {
      // Below about 0.15 nothing survives a dither — the added light does not
      // move a pixel across a palette boundary anywhere in the frame.
      range: [0.2, 1],
      distribution: { kind: "uniform" },
      weight: 1,
    },
    step: 0.01,
  },
];

/**
 * Parameter descriptors keyed for `packUniforms`. Every one is a float, so this
 * map is only ever consulted to confirm that — but the packer takes it for every
 * effect and it is one place to look when a field stops matching its parameter.
 */
export const LIGHT_LEAK_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  LIGHT_LEAK_PARAMS.map((param) => [param.key, param]),
);

const bindings: readonly PassBinding[] = [
  { role: "input-color", binding: LIGHT_LEAK_BINDING.inputColor },
  { role: "output-color", binding: LIGHT_LEAK_BINDING.outputColor },
  { role: "uniforms", binding: LIGHT_LEAK_BINDING.uniforms },
];

const pass: ComputePass = {
  id: "light-leak/main",
  label: "Light leak",
  wgsl,
  entryPoint: "main",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  // The leak is a function of the coordinate alone; it never reads a neighbour.
  access: "pointwise",
  bindings,
  uniforms: LIGHT_LEAK_UNIFORMS,
};

/** The compute pass, for the pass compiler. */
export const LIGHT_LEAK_GPU: GpuEffect = {
  effect: "light-leak",
  passes: [pass],
};

export default defineEffect({
  id: "light-leak",
  name: "Light leak",
  requirement: "F-SP-15",
  // Preprocess. Downstream of a quantizer the added light would be a colour the
  // palette does not contain while the index map beside it still named the old
  // entry; upstream, the leak is resolved by the dither into palette colours,
  // which is both correct and the reason to have it in this application.
  slot: "preprocess",
  family: "special",
  execution: "gpu",
  params: LIGHT_LEAK_PARAMS,
  surpriseWeight: 0.7,
  producesIndexMap: false,
  requiresIndexMap: false,
});
