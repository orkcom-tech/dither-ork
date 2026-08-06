/**
 * F-SP-02 — Gaussian blur.
 *
 * One control, because the requirement is one control: a true gaussian has
 * exactly one shape parameter and everything else about it is arithmetic. The
 * shader separates it into a horizontal and a vertical pass, which is exact
 * rather than an approximation — a 2D gaussian is the outer product of two 1D
 * gaussians — and costs 2(2r+1) taps instead of (2r+1)^2.
 *
 * Slot is `preprocess`. A blur placed after a dither erases the dither, which
 * is a real look but a rare one; placed before it, it is the standard way to
 * decide how much detail reaches the kernel. The slot only steers Surprise Me's
 * grammar — F-ST-01 lets the user drag the node anywhere — so it should name
 * the ordinary use, not the exotic one.
 *
 * Unlike the ordered dithers this descriptor is built in the effect file rather
 * than beside a shared uniform layout: there is no family to share with, and
 * the layout below is read by exactly one shader.
 */

import { staticGpuEffect, defineEffect, type ParamDescriptor } from "../types/registry";
import type { ComputePass, GpuEffect, PassBinding, UniformLayout } from "../types/gpu";

import wgsl from "../shaders/blur.wgsl?raw";

/** Canonical binding numbers, restated from CONVENTIONS.md. */
const BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

const PARAM = {
  radius: "radius",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `blur.wgsl`.
 *
 * Three 4-byte scalars, so nothing needs padding in front of it and the only
 * padding is the tail that rounds 12 up to 16.
 */
export const BLUR_UNIFORMS: UniformLayout = {
  sizeBytes: 16,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: PARAM.radius }, type: "f32", offset: 8 },
  ],
};

const RADIUS: ParamDescriptor = {
  key: PARAM.radius,
  label: "Radius",
  type: "float",
  animatable: true,
  hint: "Truncation half-width of the kernel, in pixels. Sigma is a third of it.",
  // The ceiling is the same number as MAX_BLUR_RADIUS in the shader, so a
  // document can never ask for a radius the loop bound silently refuses.
  legal: [0, 64],
  default: 4,
  step: 0.25,
  surprise: {
    // The legal range goes to 64 because someone will want a wash; a musical
    // one stops around 12, past which every image becomes the same grey field
    // and the dither downstream has nothing left to resolve (F-SM-04).
    range: [1, 12],
    // Radius is measured in octaves — 1 to 2 is the same visual step as 6 to
    // 12 — so uniform sampling would spend most of its draws above 6.
    distribution: { kind: "log" },
    weight: 1,
  },
};

export default defineEffect({
  id: "blur",
  name: "Blur",
  requirement: "F-SP-02",
  slot: "preprocess",
  family: "special",
  execution: "gpu",
  params: [RADIUS],
  // Below the dithers: a blur is a modifier of another effect's result rather
  // than a look of its own, and on its own it only ever removes information.
  surpriseWeight: 0.8,
  producesIndexMap: false,
  requiresIndexMap: false,
});

const BINDINGS: readonly PassBinding[] = [
  { role: "input-color", binding: BINDING.inputColor },
  { role: "output-color", binding: BINDING.outputColor },
  { role: "uniforms", binding: BINDING.uniforms },
];

/**
 * Both halves of the separable kernel, in order.
 *
 * `neighbourhood`, so the compiler must not alias input and output, and the
 * vertical pass must not start before the horizontal one has finished writing.
 * WebGPU orders dispatches within a command buffer, so the batch executor gets
 * that for free — but declaring it is what stops a future scheduler from
 * reordering them.
 */
const PASSES: readonly ComputePass[] = [
  {
    id: "blur/horizontal",
    label: "Blur horizontal",
    wgsl,
    entryPoint: "blur_h",
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    access: "neighbourhood",
    bindings: BINDINGS,
    uniforms: BLUR_UNIFORMS,
  },
  {
    id: "blur/vertical",
    label: "Blur vertical",
    wgsl,
    entryPoint: "blur_v",
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    access: "neighbourhood",
    bindings: BINDINGS,
    uniforms: BLUR_UNIFORMS,
  },
];

export const blurGpuEffect: GpuEffect = { effect: "blur", passes: PASSES };

/** Parameter descriptors keyed for `packUniforms`. */
export const BLUR_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> =
  new Map<string, ParamDescriptor>([
    [RADIUS.key, RADIUS],
  ]);

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("blur", () => blurGpuEffect);
