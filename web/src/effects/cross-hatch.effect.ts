/**
 * F-PT-04 — Cross-hatch.
 *
 * Two to four line screens overlaid. The geometry, and in particular why the
 * layer angles are a *spread* across a half-circle rather than a free step
 * between them, is argued in `../shaders/cross-hatch.wgsl`; what is here is the
 * registry descriptor and the uniform block whose byte offsets the shader
 * restates.
 *
 * Descriptor, layout and pass sit together because the parameter keys appear
 * three times — here, in {@link CROSS_HATCH_UNIFORMS}, and as `struct Params` in
 * the shader — and a rename that misses one of them is a wrong image with no
 * error anywhere.
 */

import { logger } from "../lib/log";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";
import { staticGpuEffect, defineEffect, type ParamDescriptor } from "../types/registry";
import wgsl from "../shaders/cross-hatch.wgsl?raw";

const log = logger("gpu");

/**
 * Layers the shader's loop is bounded by, restated from `MAX_LAYERS` in
 * `../shaders/cross-hatch.wgsl`.
 *
 * Typed as `number` rather than left as a literal so the check below compares
 * values instead of being folded away as a comparison of two identical literal
 * types.
 */
export const CROSS_HATCH_MAX_LAYERS: number = 4;

/**
 * Canonical binding numbers, restated from CONVENTIONS.md.
 *
 * Binding 2 (`input-index`) is absent: a cross-hatch is the node that *creates*
 * the index map, so it has none to read.
 */
export const CROSS_HATCH_BINDING = {
  inputColor: 0,
  outputColor: 1,
  outputIndex: 3,
  palette: 4,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const CROSS_HATCH_PARAM = {
  layers: "layers",
  pitch: "pitch",
  angle: "angle",
  angleSpread: "angleSpread",
  pitchRatio: "pitchRatio",
  duty: "duty",
  spread: "spread",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/cross-hatch.wgsl`. Nine 4-byte scalars and three words of tail
 * padding.
 */
export const CROSS_HATCH_UNIFORMS: UniformLayout = {
  sizeBytes: 48,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: CROSS_HATCH_PARAM.layers }, type: "u32", offset: 8 },
    { source: { kind: "param", key: CROSS_HATCH_PARAM.pitch }, type: "f32", offset: 12 },
    { source: { kind: "param", key: CROSS_HATCH_PARAM.angle }, type: "f32", offset: 16 },
    { source: { kind: "param", key: CROSS_HATCH_PARAM.angleSpread }, type: "f32", offset: 20 },
    { source: { kind: "param", key: CROSS_HATCH_PARAM.pitchRatio }, type: "f32", offset: 24 },
    { source: { kind: "param", key: CROSS_HATCH_PARAM.duty }, type: "f32", offset: 28 },
    { source: { kind: "param", key: CROSS_HATCH_PARAM.spread }, type: "f32", offset: 32 },
  ],
};

const descriptor = defineEffect({
  id: "cross-hatch",
  name: "Cross-hatch",
  requirement: "F-PT-04",
  slot: "dither",
  family: "pattern",
  execution: "gpu",
  params: [
    {
      key: CROSS_HATCH_PARAM.layers,
      label: "Layers",
      type: "int",
      // The honest statement of the tone model's precondition, at the control
      // that decides whether it holds. Two layers are the exactly-true case;
      // three or four rely on the layer pitches not standing in a simple ratio,
      // which is what the pitch ratio's default is for. Measured: at three
      // layers with a pitch ratio of exactly 1, a 15% tone prints 6% dark.
      hint: "Overlaid gratings. At three or more, a pitch ratio of exactly 1 prints light tones dark.",
      // Not animatable: a modulator crossing an integer boundary is a cut, not
      // a modulation.
      animatable: false,
      legal: [2, 4],
      default: 2,
      surprise: { range: [2, 3], distribution: { kind: "uniform" }, weight: 0.8 },
    },
    {
      key: CROSS_HATCH_PARAM.pitch,
      label: "Pitch",
      type: "float",
      hint: "Pixels between line centres in the first layer.",
      animatable: true,
      legal: [1, 256],
      default: 8,
      // Log, because pitch is measured in octaves.
      surprise: { range: [3, 20], distribution: { kind: "log" }, weight: 1 },
    },
    {
      key: CROSS_HATCH_PARAM.angle,
      label: "Base angle",
      type: "float",
      hint: "Direction of the first layer, in degrees. 0 is horizontal.",
      animatable: true,
      legal: [-180, 180],
      default: 45,
      surprise: { range: [-90, 90], distribution: { kind: "uniform" }, weight: 1 },
    },
    {
      key: CROSS_HATCH_PARAM.angleSpread,
      label: "Angle spread",
      type: "float",
      // Divided by the layer count in the shader, so 180 is an even spread
      // across the half-circle for any count and no two layers can land on the
      // same direction. That is a correctness property, not a preference — see
      // the shader header.
      hint: "Total angle the layers are spread over. 180 spaces them evenly and never repeats a direction.",
      animatable: true,
      legal: [15, 180],
      default: 180,
      surprise: { range: [60, 180], distribution: { kind: "uniform" }, weight: 0.6 },
    },
    {
      key: CROSS_HATCH_PARAM.pitchRatio,
      label: "Pitch ratio",
      type: "float",
      hint: "Each layer's pitch relative to the one before it. Off 1, so three or more layers cannot lock in phase.",
      animatable: true,
      legal: [0.5, 2],
      // Not 1, and that is the whole job of this control. Equal pitches let
      // three evenly spread layers close on a lattice, where the union law the
      // screen is renormalised by stops holding: measured across 0.15..0.85 at
      // a 9.3px pitch, worst tone error is 6.2% at ratio 1 against 0.16% here,
      // and 1.3 is the best of the ratios measured at two, three and four
      // layers alike. Exactly 1 stays legal — at two layers it is exact and it
      // is the classical equal-pitch hatch.
      default: 1.3,
      // Log: a ratio is a multiplier, and 0.5 and 2 are the same distance from
      // 1 only in log space. The range excludes 1 for the reason above.
      surprise: { range: [1.15, 1.6], distribution: { kind: "log" }, weight: 0.5 },
    },
    {
      key: CROSS_HATCH_PARAM.duty,
      label: "Duty cycle",
      type: "float",
      hint: "Line width as a fraction of the pitch at 50% tone. 0.5 reproduces tone exactly.",
      animatable: true,
      legal: [0.05, 0.95],
      default: 0.5,
      surprise: { range: [0.35, 0.65], distribution: { kind: "uniform" }, weight: 0.7 },
    },
    {
      key: CROSS_HATCH_PARAM.spread,
      label: "Spread",
      type: "float",
      hint: "Screen strength. 0 is plain quantization, 1 reproduces tone exactly.",
      animatable: true,
      legal: [0, 2],
      default: 1,
      surprise: { range: [0.6, 1.2], distribution: { kind: "uniform" }, weight: 0.8 },
    },
  ],
  surpriseWeight: 0.7,
  // Quantizing is the point: the index map it emits is what makes outline,
  // dilate/erode, hue-targeted recolour and the tracer lossless downstream.
  producesIndexMap: true,
  requiresIndexMap: false,
});

export default descriptor;

/**
 * Parameter descriptors keyed for `packUniforms`.
 *
 * `layers` is an int that the layout sends as a `u32`, so the packer needs the
 * descriptor to know it may not be fractional.
 */
export const CROSS_HATCH_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  descriptor.params.map((param) => [param.key, param]),
);

/**
 * Check the descriptor's layer ceiling against the shader's loop bound.
 *
 * The shader clamps its loop to `MAX_LAYERS`, so a descriptor that let a
 * document ask for more would render with the extra layers silently missing —
 * a picture that is wrong and says nothing, which is exactly the failure this
 * layer's compile-time checks exist to convert into a message.
 */
function assertLayerCeiling(): void {
  const layers = descriptor.params.find((param) => param.key === CROSS_HATCH_PARAM.layers);
  if (layers === undefined || layers.type !== "int") {
    const message = `cross-hatch: "${CROSS_HATCH_PARAM.layers}" is not an int parameter`;
    log.error("cross-hatch layer parameter is missing or the wrong kind");
    throw new Error(message);
  }
  const ceiling = layers.legal[1];
  if (ceiling > CROSS_HATCH_MAX_LAYERS) {
    const message =
      `cross-hatch: the descriptor allows ${ceiling} layers but the shader loops over at most ` +
      `${CROSS_HATCH_MAX_LAYERS}`;
    log.error("cross-hatch layer ceiling exceeds the shader's loop bound", {
      declared: ceiling,
      shader: CROSS_HATCH_MAX_LAYERS,
    });
    throw new Error(message);
  }
}

/** The compute pass. One dispatch: every layer is a function of the coordinate. */
export function crossHatchEffect(): GpuEffect {
  assertLayerCeiling();

  const bindings: readonly PassBinding[] = [
    { role: "input-color", binding: CROSS_HATCH_BINDING.inputColor },
    { role: "output-color", binding: CROSS_HATCH_BINDING.outputColor },
    { role: "output-index", binding: CROSS_HATCH_BINDING.outputIndex },
    { role: "palette", binding: CROSS_HATCH_BINDING.palette },
    { role: "uniforms", binding: CROSS_HATCH_BINDING.uniforms },
  ];

  const pass: ComputePass = {
    id: `${descriptor.id}/screen`,
    label: `${descriptor.name} screen`,
    wgsl,
    entryPoint: "main",
    // 64 invocations, well under the 256 guaranteed everywhere.
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    // Reads only its own pixel: every layer's phase comes from the coordinate,
    // not from a neighbour.
    access: "pointwise",
    bindings,
    uniforms: CROSS_HATCH_UNIFORMS,
  };

  return { effect: descriptor.id, passes: [pass] };
}

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("cross-hatch", () => crossHatchEffect());
