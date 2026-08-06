/**
 * F-GL-08 — Scanlines.
 *
 * Pitch, strength and phase are the requirement. Thickness and softness are
 * here because without them "strength" has to mean two different things at
 * once: a thin hard line at half depth and a fat soft line at half depth are
 * different pictures, and one slider cannot reach both. Every control moves
 * something in the shader — see `web/src/shaders/scanlines.wgsl`.
 *
 * There is no seed. F-GL says the glitch family exposes a seed, and this effect
 * has no stochastic axis at all: the pattern is a deterministic function of the
 * line index. A seed parameter here would sit in the properties panel moving
 * nothing, which is the failure `web/src/effects/error-diffusion.ts` argues
 * against at length.
 *
 * The descriptor, the uniform layout and the compute pass live in this one file
 * because that is what lets effects be written in parallel — nothing central is
 * edited to add one (see `web/src/registry/README.md`). The ordered dithers put
 * theirs in `web/src/gpu/effects/ordered.ts` instead because five effects share
 * one layout there; one effect sharing nothing has no such reason.
 */

import { staticGpuEffect, defineEffect, type ParamDescriptor } from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/scanlines.wgsl?raw";

/** Registry id. Used for the pass id and the shader file name. */
export const SCANLINES_ID = "scanlines";

/**
 * Canonical binding numbers, restated from CONVENTIONS.md.
 *
 * Only three roles: this is a colour filter, so there is no palette to search
 * and no index map to read or write. The numbers do not close up — a role's
 * binding number is the same in every shader whether or not its neighbours are
 * present.
 */
export const SCANLINES_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const SCANLINES_PARAM = {
  pitch: "pitch",
  phase: "phase",
  strength: "strength",
  thickness: "thickness",
  softness: "softness",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `scanlines.wgsl`.
 *
 * All scalars, so nothing needs padding in front of it and the only padding is
 * the tail that rounds 28 up to 32.
 */
export const SCANLINES_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: SCANLINES_PARAM.pitch }, type: "f32", offset: 8 },
    { source: { kind: "param", key: SCANLINES_PARAM.phase }, type: "f32", offset: 12 },
    { source: { kind: "param", key: SCANLINES_PARAM.strength }, type: "f32", offset: 16 },
    { source: { kind: "param", key: SCANLINES_PARAM.thickness }, type: "f32", offset: 20 },
    { source: { kind: "param", key: SCANLINES_PARAM.softness }, type: "f32", offset: 24 },
  ],
};

const PARAMS: readonly ParamDescriptor[] = [
  {
    key: SCANLINES_PARAM.pitch,
    label: "Pitch",
    type: "float",
    hint: "Raster lines per lit/dark cycle. 2 is one dark line between each lit one.",
    animatable: true,
    // Below one line the pattern has nothing to land on; above ~64 there is one
    // band across the whole frame and it stops being scanlines.
    legal: [1, 64],
    default: 2,
    step: 0.5,
    surprise: {
      // Measured in octaves — uniform sampling of 2..64 spends most of its
      // draws above 32, where every result is the same single dark band.
      range: [2, 10],
      distribution: { kind: "log" },
      weight: 1,
    },
  },
  {
    key: SCANLINES_PARAM.phase,
    label: "Phase",
    type: "float",
    // Cycles, not pixels: a modulator ramping 0 -> 1 lands back where it
    // started whatever the pitch is, so a rolling-scanline animation closes its
    // loop by construction rather than by the UI knowing that some number of
    // pixels is special.
    hint: "Shifts the pattern along the raster, in cycles. 1 is one whole cycle.",
    animatable: true,
    legal: [-1, 1],
    default: 0,
    surprise: {
      range: [-0.5, 0.5],
      distribution: { kind: "uniform" },
      // Low: at a pitch of 2 or 3 a phase shift moves the picture by a line or
      // two, which is not what a reroll should spend its budget on.
      weight: 0.5,
    },
  },
  {
    key: SCANLINES_PARAM.strength,
    label: "Strength",
    type: "float",
    hint: "How much light the dark band loses. 1 blacks it out completely.",
    animatable: true,
    legal: [0, 1],
    default: 0.5,
    step: 0.01,
    surprise: {
      // Below ~0.2 the effect is invisible on anything but a flat field; 1 is a
      // real look but it throws away half the picture, so the range stops short
      // of it and leaves that as a decision.
      range: [0.25, 0.85],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: SCANLINES_PARAM.thickness,
    label: "Line thickness",
    type: "float",
    hint: "Share of each cycle the dark band occupies. 0.5 is even lit/dark.",
    animatable: true,
    legal: [0, 1],
    default: 0.5,
    step: 0.01,
    surprise: {
      // The ends are degenerate: 0 is no line at all and 1 is a flat multiply
      // over the whole frame. Neither is a scanline.
      range: [0.3, 0.7],
      distribution: { kind: "uniform" },
      weight: 0.7,
    },
  },
  {
    key: SCANLINES_PARAM.softness,
    label: "Edge softness",
    type: "float",
    // Also the anti-aliasing control: at 0 the band edge is a step, and a step
    // sampled on a raster at a non-integer pitch beats against the pixel grid.
    hint: "Width of the band's edge, as a fraction of its own half-width. 0 is a hard bar.",
    animatable: true,
    legal: [0, 1],
    default: 0.25,
    step: 0.01,
    surprise: {
      range: [0, 0.8],
      distribution: { kind: "uniform" },
      weight: 0.6,
    },
  },
];

/**
 * The compute pass.
 *
 * Pointwise: the attenuation is a function of the line index, so no invocation
 * reads a pixel other than its own.
 */
export function scanlinesEffect(): GpuEffect {
  const bindings: readonly PassBinding[] = [
    { role: "input-color", binding: SCANLINES_BINDING.inputColor },
    { role: "output-color", binding: SCANLINES_BINDING.outputColor },
    { role: "uniforms", binding: SCANLINES_BINDING.uniforms },
  ];

  const pass: ComputePass = {
    id: `${SCANLINES_ID}/attenuate`,
    label: "Scanlines",
    wgsl,
    entryPoint: "main",
    // 64 invocations, well under the 256 guaranteed everywhere.
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    access: "pointwise",
    bindings,
    uniforms: SCANLINES_UNIFORMS,
  };

  return { effect: SCANLINES_ID, passes: [pass] };
}

/** Parameter descriptors keyed for `packUniforms`. */
export const SCANLINES_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  PARAMS.map((param) => [param.key, param]),
);

export default defineEffect({
  id: SCANLINES_ID,
  name: "Scanlines",
  requirement: "F-GL-08",
  slot: "postprocess",
  family: "glitch",
  execution: "gpu",
  params: PARAMS,
  // A signature look rather than a curiosity, and it combines with almost
  // anything upstream of it.
  surpriseWeight: 1,
  producesIndexMap: false,
  // Attenuating a quantized image moves its colours off their palette entries,
  // so any index map carried past this node no longer describes the pixels. The
  // graph is what reconciles that; this descriptor only states that the node
  // neither reads nor writes one.
  requiresIndexMap: false,
});

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("scanlines", () => scanlinesEffect());
