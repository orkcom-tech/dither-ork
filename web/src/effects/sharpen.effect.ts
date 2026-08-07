/**
 * F-SP-03 — Sharpen (unsharp mask).
 *
 *     out = src + amount * gate * (src - blur(src))
 *
 * Three controls, exactly the three the requirement names, and each one moves
 * something in the shader: `radius` is the gaussian inside the mask, `amount`
 * the gain on what that blur removed, `threshold` the floor below which a
 * difference is left alone so grain is not amplified with the edges.
 *
 * Two passes. The blur is separable, and the composite needs the ORIGINAL
 * pixel that the blur has by then overwritten — the colour surface ping-pongs
 * between passes — so pass 0 stashes the untouched source in a scratch buffer
 * on its way past. Eight bytes per pixel for the life of the node, which is
 * the honest cost of an effect that reads its own input twice.
 *
 * Slot is `preprocess`: sharpening before a dither is how edges stay legible
 * through a small palette. Sharpening after one operates on the dither's own
 * texture rather than on the picture. The slot steers Surprise Me's grammar
 * only — F-ST-01 lets the user drag the node anywhere.
 */

import { staticGpuEffect, defineEffect, type ParamDescriptor } from "../types/registry";
import type { ComputePass, GpuEffect, PassBinding, UniformLayout } from "../types/gpu";

import wgsl from "../shaders/sharpen.wgsl?raw";

/** Canonical binding numbers, restated from CONVENTIONS.md. */
const BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
  stash: 6,
} as const;

const PARAM = {
  amount: "amount",
  radius: "radius",
  threshold: "threshold",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `sharpen.wgsl`.
 *
 * Five 4-byte scalars, so nothing needs padding in front of it and the only
 * padding is the tail that rounds 20 up to 32.
 */
export const SHARPEN_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: PARAM.amount }, type: "f32", offset: 8 },
    { source: { kind: "param", key: PARAM.radius }, type: "f32", offset: 12 },
    { source: { kind: "param", key: PARAM.threshold }, type: "f32", offset: 16 },
  ],
};

const AMOUNT: ParamDescriptor = {
  key: PARAM.amount,
  label: "Amount",
  type: "float",
  animatable: true,
  description: "Gain on the detail the blur removed. 1 doubles local contrast at the radius.",
  legal: [0, 4],
  default: 1,
  step: 0.05,
  surprise: {
    // Above roughly 2 the halos stop reading as sharpening and start reading
    // as an outline effect, which is F-SP-10's job, not this one's (F-SM-04).
    range: [0.3, 1.8],
    // Gain is heard in ratios, so log: 0.3 to 0.6 is the same step as 0.9 to
    // 1.8, and uniform sampling would put most draws in the top half.
    distribution: { kind: "log" },
    weight: 1,
  },
};

const RADIUS: ParamDescriptor = {
  key: PARAM.radius,
  label: "Radius",
  type: "float",
  animatable: true,
  description: "Size of the detail the mask isolates, in pixels. Small is edges, large is local contrast.",
  // Half the blur node's ceiling. Past about 32 an unsharp mask has stopped
  // sharpening and become a contrast curve with a very slow falloff.
  legal: [0, 32],
  default: 2,
  step: 0.25,
  surprise: {
    range: [0.75, 6],
    distribution: { kind: "log" },
    weight: 0.9,
  },
};

const THRESHOLD: ParamDescriptor = {
  key: PARAM.threshold,
  label: "Threshold",
  type: "float",
  animatable: true,
  description: "Lightness difference below which nothing is sharpened. 0 sharpens everything.",
  legal: [0, 1],
  // Zero: a sharpen should render as the plain unsharp mask unless asked
  // otherwise, and that is the case a golden image can pin.
  default: 0,
  step: 0.005,
  surprise: {
    // Lightness differences across a real edge are a few hundredths; past
    // about 0.1 the threshold has switched the effect off entirely.
    range: [0, 0.08],
    distribution: { kind: "uniform" },
    // Low: moving the threshold changes where sharpening happens, not what
    // the picture looks like from across the room.
    weight: 0.4,
  },
};

export default defineEffect({
  id: "sharpen",
  name: "Sharpen",
  summary:
    "Unsharp mask — subtracts a blurred copy to bring detail back, so edges survive a small palette.",
  description:
    "The picture minus a blurred version of itself is the detail that blur removed; amount is the gain on it, radius decides which size of detail counts as detail, and threshold is the floor below which a difference is left alone so grain is not amplified along with the edges. Sharpening before a dither is how edges stay legible through a handful of colours. After a dither it operates on the dither's own texture rather than on the picture, which only makes the grain louder.",
  keywords: ["sharpen", "unsharp", "unsharp mask", "clarity", "detail", "crisp", "edges", "acutance", "definition", "punch"],
  concept: "neighbourhood-filter",
  requirement: "F-SP-03",
  slot: "preprocess",
  family: "special",
  execution: "gpu",
  params: [AMOUNT, RADIUS, THRESHOLD],
  // Slightly below an ordinary effect: sharpening is a correction more often
  // than it is a look, and it reads as one.
  surpriseWeight: 0.9,
  producesIndexMap: false,
  requiresIndexMap: false,
});

/**
 * The untouched source, kept across the ping-pong.
 *
 * Two u32 per pixel holding four halves — bit for bit what the rgba16float
 * surface it copies holds, so the round trip loses nothing and buys no headroom
 * the source cannot reach.
 *
 * Both passes declare it read-write even though pass 1 only reads: one WGSL
 * file per effect means one declaration of the variable, and a shader's access
 * mode has to match the bind group layout's buffer type in every pass that
 * uses it.
 */
const STASH: PassBinding = {
  role: "scratch",
  binding: BINDING.stash,
  slot: "source",
  access: "read-write",
  size: { kind: "per-pixel", bytesPerPixel: 8 },
};

const BINDINGS: readonly PassBinding[] = [
  { role: "input-color", binding: BINDING.inputColor },
  { role: "output-color", binding: BINDING.outputColor },
  { role: "uniforms", binding: BINDING.uniforms },
  STASH,
];

const PASSES: readonly ComputePass[] = [
  {
    id: "sharpen/blur-h-stash",
    label: "Sharpen horizontal blur and stash",
    wgsl,
    entryPoint: "blur_h_stash",
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    access: "neighbourhood",
    bindings: BINDINGS,
    uniforms: SHARPEN_UNIFORMS,
  },
  {
    id: "sharpen/blur-v-composite",
    label: "Sharpen vertical blur and composite",
    wgsl,
    entryPoint: "blur_v_sharpen",
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    access: "neighbourhood",
    bindings: BINDINGS,
    uniforms: SHARPEN_UNIFORMS,
  },
];

export const sharpenGpuEffect: GpuEffect = { effect: "sharpen", passes: PASSES };

/** Parameter descriptors keyed for `packUniforms`. */
export const SHARPEN_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> =
  new Map<string, ParamDescriptor>([
    [AMOUNT.key, AMOUNT],
    [RADIUS.key, RADIUS],
    [THRESHOLD.key, THRESHOLD],
  ]);

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("sharpen", () => sharpenGpuEffect);
