/**
 * F-PT-02 — CMYK halftone.
 *
 * Four separations, each on its own screen, with **independent angles and cell
 * sizes** — that independence is the whole requirement, and it is why every
 * geometric parameter below comes in fours instead of one shared pair. The
 * defaults are the classical set: cyan 15, magenta 75, yellow 0, black 45.
 *
 * The ink model, the black generation and the reasoning behind both live in
 * `../shaders/cmyk-halftone.wgsl`; what is here is the registry descriptor and
 * the uniform block whose byte offsets the shader restates.
 *
 * Two things this effect does not do, both deliberate:
 *
 * - **It ignores the document palette.** Its output colours are the ink
 *   overprints, and a palette is not a set of inks. Binding one would let a
 *   palette swap silently change nothing.
 * - **It emits no index map.** Sixteen overprints are not palette entries, and
 *   an index into a palette these pixels never came from is a lie that outline,
 *   recolour and the tracer would then act on.
 */

import { logger } from "../lib/log";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";
import { staticGpuEffect, defineEffect, type ParamDescriptor } from "../types/registry";
import wgsl from "../shaders/cmyk-halftone.wgsl?raw";

const log = logger("gpu");

/**
 * Canonical binding numbers, restated from CONVENTIONS.md.
 *
 * Only three roles: no palette (binding 4) and no index map (bindings 2 and 3),
 * for the reasons in the module header. The numbers do not close up — a role's
 * binding number is the same in every shader whether or not its neighbours are
 * present.
 */
export const CMYK_HALFTONE_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const CMYK_HALFTONE_PARAM = {
  cyanAngle: "cyanAngle",
  magentaAngle: "magentaAngle",
  yellowAngle: "yellowAngle",
  blackAngle: "blackAngle",
  cyanCell: "cyanCell",
  magentaCell: "magentaCell",
  yellowCell: "yellowCell",
  blackCell: "blackCell",
  blackGeneration: "blackGeneration",
  inkDensity: "inkDensity",
  dotShape: "dotShape",
  dotAspect: "dotAspect",
} as const;

/**
 * Dot shapes, in the order the shader's `SHAPE_*` constants number them.
 *
 * The uniform packer sends an enum as its ordinal in the descriptor's `values`
 * list, so this order *is* the wire format. {@link cmykHalftoneEffect} asserts
 * the descriptor still matches, because a reordering would silently repaint
 * every saved document with a different dot.
 */
export const CMYK_HALFTONE_DOT_SHAPES = [
  "round",
  "square",
  "diamond",
  "ellipse",
] as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/cmyk-halftone.wgsl`.
 *
 * Fourteen 4-byte scalars and two words of tail padding. The four angles and
 * the four cell sizes are eight separate fields rather than two `vec4f`s: they
 * are eight independent parameters in the registry, and packing them as vectors
 * would make the layout claim a grouping the parameter set does not have.
 */
export const CMYK_HALFTONE_UNIFORMS: UniformLayout = {
  sizeBytes: 64,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: CMYK_HALFTONE_PARAM.cyanAngle }, type: "f32", offset: 8 },
    { source: { kind: "param", key: CMYK_HALFTONE_PARAM.magentaAngle }, type: "f32", offset: 12 },
    { source: { kind: "param", key: CMYK_HALFTONE_PARAM.yellowAngle }, type: "f32", offset: 16 },
    { source: { kind: "param", key: CMYK_HALFTONE_PARAM.blackAngle }, type: "f32", offset: 20 },
    { source: { kind: "param", key: CMYK_HALFTONE_PARAM.cyanCell }, type: "f32", offset: 24 },
    { source: { kind: "param", key: CMYK_HALFTONE_PARAM.magentaCell }, type: "f32", offset: 28 },
    { source: { kind: "param", key: CMYK_HALFTONE_PARAM.yellowCell }, type: "f32", offset: 32 },
    { source: { kind: "param", key: CMYK_HALFTONE_PARAM.blackCell }, type: "f32", offset: 36 },
    { source: { kind: "param", key: CMYK_HALFTONE_PARAM.blackGeneration }, type: "f32", offset: 40 },
    { source: { kind: "param", key: CMYK_HALFTONE_PARAM.inkDensity }, type: "f32", offset: 44 },
    { source: { kind: "param", key: CMYK_HALFTONE_PARAM.dotShape }, type: "u32", offset: 48 },
    { source: { kind: "param", key: CMYK_HALFTONE_PARAM.dotAspect }, type: "f32", offset: 52 },
  ],
};

const descriptor = defineEffect({
  id: "cmyk-halftone",
  name: "CMYK halftone",
  requirement: "F-PT-02",
  slot: "dither",
  family: "pattern",
  execution: "gpu",
  params: [
    {
      key: CMYK_HALFTONE_PARAM.cyanAngle,
      label: "Cyan angle",
      type: "float",
      hint: "Screen angle of the cyan separation, in degrees.",
      animatable: true,
      legal: [-180, 180],
      default: 15,
      // Each separation's surprise range sits around its own classical angle.
      // Drawing all four from one wide range would let two of them coincide,
      // and two coincident separations are the moire the angle set exists to
      // avoid — a random document that looks broken rather than surprising.
      surprise: { range: [0, 30], distribution: { kind: "uniform" }, weight: 0.8 },
    },
    {
      key: CMYK_HALFTONE_PARAM.magentaAngle,
      label: "Magenta angle",
      type: "float",
      hint: "Screen angle of the magenta separation, in degrees.",
      animatable: true,
      legal: [-180, 180],
      default: 75,
      surprise: { range: [60, 90], distribution: { kind: "uniform" }, weight: 0.8 },
    },
    {
      key: CMYK_HALFTONE_PARAM.yellowAngle,
      label: "Yellow angle",
      type: "float",
      // Yellow sits at 0 in the classical set because it is the least visible
      // ink and therefore the one that can afford the angle nearest the raster.
      hint: "Screen angle of the yellow separation, in degrees.",
      animatable: true,
      legal: [-180, 180],
      default: 0,
      surprise: { range: [-15, 15], distribution: { kind: "uniform" }, weight: 0.8 },
    },
    {
      key: CMYK_HALFTONE_PARAM.blackAngle,
      label: "Black angle",
      type: "float",
      hint: "Screen angle of the black separation, in degrees.",
      animatable: true,
      legal: [-180, 180],
      default: 45,
      surprise: { range: [30, 60], distribution: { kind: "uniform" }, weight: 0.8 },
    },
    {
      key: CMYK_HALFTONE_PARAM.cyanCell,
      label: "Cyan cell size",
      type: "float",
      hint: "Pixels per cell in the cyan screen.",
      animatable: true,
      legal: [1, 256],
      default: 8,
      // Log, because cell size is measured in octaves. The weight is low on all
      // four so Surprise Me usually leaves the separations at a common
      // frequency, which is what makes a rosette rather than a clash.
      surprise: { range: [4, 16], distribution: { kind: "log" }, weight: 0.5 },
    },
    {
      key: CMYK_HALFTONE_PARAM.magentaCell,
      label: "Magenta cell size",
      type: "float",
      hint: "Pixels per cell in the magenta screen.",
      animatable: true,
      legal: [1, 256],
      default: 8,
      surprise: { range: [4, 16], distribution: { kind: "log" }, weight: 0.5 },
    },
    {
      key: CMYK_HALFTONE_PARAM.yellowCell,
      label: "Yellow cell size",
      type: "float",
      hint: "Pixels per cell in the yellow screen.",
      animatable: true,
      legal: [1, 256],
      default: 8,
      surprise: { range: [4, 16], distribution: { kind: "log" }, weight: 0.5 },
    },
    {
      key: CMYK_HALFTONE_PARAM.blackCell,
      label: "Black cell size",
      type: "float",
      hint: "Pixels per cell in the black screen.",
      animatable: true,
      legal: [1, 256],
      default: 8,
      surprise: { range: [4, 16], distribution: { kind: "log" }, weight: 0.5 },
    },
    {
      key: CMYK_HALFTONE_PARAM.blackGeneration,
      label: "Black generation",
      type: "float",
      // Tone is reproduced at every setting: cyan, magenta and yellow are
      // solved against whatever black left. What changes is how much of a
      // neutral is printed with one ink instead of three.
      hint: "How much of the neutral component goes to the black plate. Tone holds either way.",
      animatable: true,
      legal: [0, 1],
      default: 0.5,
      surprise: { range: [0.2, 0.9], distribution: { kind: "uniform" }, weight: 0.7 },
    },
    {
      key: CMYK_HALFTONE_PARAM.inkDensity,
      label: "Ink density",
      type: "float",
      hint: "How completely an ink absorbs its own primary. 1 is ideal ink and the only value that reproduces tone.",
      animatable: true,
      legal: [0, 1],
      default: 1,
      surprise: { range: [0.85, 1], distribution: { kind: "uniform" }, weight: 0.4 },
    },
    {
      key: CMYK_HALFTONE_PARAM.dotShape,
      label: "Dot shape",
      type: "enum",
      // Shared by all four separations: printers change the angle per
      // separation, not the dot.
      hint: "Dot shape, the same on all four screens.",
      // Not animatable: a modulator binds a numeric parameter, and stepping
      // through shapes mid-loop is a cut rather than a modulation.
      animatable: false,
      values: [
        { value: "round", label: "Round" },
        { value: "square", label: "Square" },
        { value: "diamond", label: "Diamond" },
        { value: "ellipse", label: "Ellipse" },
      ],
      default: "round",
      surprise: {
        values: [
          { value: "round", weight: 3 },
          { value: "ellipse", weight: 1.5 },
          { value: "diamond", weight: 1 },
        ],
        weight: 0.5,
      },
    },
    {
      key: CMYK_HALFTONE_PARAM.dotAspect,
      label: "Dot aspect",
      type: "float",
      hint: "Elongation of the elliptical dot. Only the Ellipse shape reads it.",
      animatable: true,
      legal: [0.25, 4],
      default: 1.6,
      surprise: { range: [1.2, 2.5], distribution: { kind: "log" }, weight: 0.3 },
    },
  ],
  // Below the plain halftone: a four-ink print look is a strong, specific
  // result rather than a general-purpose screen (F-SM-03).
  surpriseWeight: 0.6,
  // The output colours are ink overprints, not palette entries — see the module
  // header.
  producesIndexMap: false,
  requiresIndexMap: false,
});

export default descriptor;

/**
 * Parameter descriptors keyed for `packUniforms`.
 *
 * Needed rather than optional here: `dotShape` is an enum, and its numeric form
 * is its position in `values`, which only the descriptor knows.
 */
export const CMYK_HALFTONE_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  descriptor.params.map((param) => [param.key, param]),
);

/**
 * Check the enum ordinals the shader hard-codes against the ones the packer
 * will actually send.
 *
 * The uniform packer resolves an enum to its index in `values`; the shader
 * compares that index against its own `SHAPE_*` constants. Nothing connects the
 * two but this assertion, and a mismatch does not fail — it prints diamonds
 * where the document says round.
 */
function assertShapeOrdinals(): void {
  const shape = descriptor.params.find(
    (param) => param.key === CMYK_HALFTONE_PARAM.dotShape,
  );
  if (shape === undefined || shape.type !== "enum") {
    const message = `cmyk-halftone: "${CMYK_HALFTONE_PARAM.dotShape}" is not an enum parameter`;
    log.error("cmyk-halftone dot shape parameter is missing or the wrong kind");
    throw new Error(message);
  }
  const declared = shape.values.map((option) => option.value);
  const matches =
    declared.length === CMYK_HALFTONE_DOT_SHAPES.length &&
    CMYK_HALFTONE_DOT_SHAPES.every((value, index) => declared[index] === value);
  if (!matches) {
    const message =
      `cmyk-halftone: dot shapes are declared as [${declared.join(", ")}] but the shader ` +
      `numbers them [${CMYK_HALFTONE_DOT_SHAPES.join(", ")}]`;
    log.error("cmyk-halftone dot shape ordinals disagree with the shader", {
      declared: declared.join(","),
      shader: CMYK_HALFTONE_DOT_SHAPES.join(","),
    });
    throw new Error(message);
  }
}

/**
 * The compute pass.
 *
 * One dispatch for all four separations. They are independent per pixel — each
 * screen is a function of the coordinate and the separation's own two
 * parameters — so splitting them into four passes would cost four dispatches
 * and three intermediate surfaces to compute exactly the same thing.
 */
export function cmykHalftoneEffect(): GpuEffect {
  assertShapeOrdinals();

  const bindings: readonly PassBinding[] = [
    { role: "input-color", binding: CMYK_HALFTONE_BINDING.inputColor },
    { role: "output-color", binding: CMYK_HALFTONE_BINDING.outputColor },
    { role: "uniforms", binding: CMYK_HALFTONE_BINDING.uniforms },
  ];

  const pass: ComputePass = {
    id: `${descriptor.id}/separations`,
    label: `${descriptor.name} separations`,
    wgsl,
    entryPoint: "main",
    // 64 invocations, well under the 256 guaranteed everywhere.
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    // Reads only its own pixel: all four screens come from the coordinate.
    access: "pointwise",
    bindings,
    uniforms: CMYK_HALFTONE_UNIFORMS,
  };

  return { effect: descriptor.id, passes: [pass] };
}

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("cmyk-halftone", () => cmykHalftoneEffect());
