/**
 * F-PT-01 — Halftone.
 *
 * A rotated grid of dots whose *area* carries the tone: round, square, diamond
 * or elliptical. The screen geometry and the reasoning behind it live in
 * `../shaders/halftone.wgsl`; what is here is the half the rest of the app
 * reads — the registry descriptor, and the uniform block whose byte offsets the
 * shader restates.
 *
 * Unlike the ordered dithers, which share one descriptor factory across five
 * effects, each pattern dither has its own geometry and therefore its own
 * parameters. So the descriptor, the uniform layout and the pass all sit in
 * this one file next to each other: the parameter keys appear three times —
 * here, in {@link HALFTONE_UNIFORMS}, and as `struct Params` in the shader —
 * and a rename that misses one of them is a wrong image with no error anywhere.
 * Keeping them in the same file is what makes that a one-file diff.
 */

import { logger } from "../lib/log";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";
import { staticGpuEffect, defineEffect, type ParamDescriptor } from "../types/registry";
import wgsl from "../shaders/halftone.wgsl?raw";

const log = logger("gpu");

/**
 * Canonical binding numbers, restated from CONVENTIONS.md.
 *
 * Binding 2 (`input-index`) is absent: a halftone is the node that *creates* the
 * index map, so it has none to read.
 */
export const HALFTONE_BINDING = {
  inputColor: 0,
  outputColor: 1,
  outputIndex: 3,
  palette: 4,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const HALFTONE_PARAM = {
  cellSize: "cellSize",
  angle: "angle",
  dotShape: "dotShape",
  dotAspect: "dotAspect",
  coverage: "coverage",
  spread: "spread",
  offsetX: "offsetX",
  offsetY: "offsetY",
} as const;

/**
 * Dot shapes, in the order the shader's `SHAPE_*` constants number them.
 *
 * The uniform packer sends an enum as its ordinal in the descriptor's `values`
 * list, so this order *is* the wire format. {@link halftoneEffect} asserts the
 * descriptor still matches, because a reordering would silently repaint every
 * saved document with a different dot.
 */
export const HALFTONE_DOT_SHAPES = [
  "round",
  "square",
  "diamond",
  "ellipse",
] as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/halftone.wgsl`.
 *
 * Ten 4-byte scalars and two words of tail padding. Scalars only, deliberately:
 * a `vec2f` for the offset pair would align to 8 and put a hole in the middle
 * that both sides would have to agree about.
 */
export const HALFTONE_UNIFORMS: UniformLayout = {
  sizeBytes: 48,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: HALFTONE_PARAM.cellSize }, type: "f32", offset: 8 },
    { source: { kind: "param", key: HALFTONE_PARAM.angle }, type: "f32", offset: 12 },
    { source: { kind: "param", key: HALFTONE_PARAM.dotShape }, type: "u32", offset: 16 },
    { source: { kind: "param", key: HALFTONE_PARAM.dotAspect }, type: "f32", offset: 20 },
    { source: { kind: "param", key: HALFTONE_PARAM.coverage }, type: "f32", offset: 24 },
    { source: { kind: "param", key: HALFTONE_PARAM.spread }, type: "f32", offset: 28 },
    { source: { kind: "param", key: HALFTONE_PARAM.offsetX }, type: "f32", offset: 32 },
    { source: { kind: "param", key: HALFTONE_PARAM.offsetY }, type: "f32", offset: 36 },
  ],
};

const descriptor = defineEffect({
  id: "halftone",
  name: "Halftone",
  requirement: "F-PT-01",
  slot: "dither",
  family: "pattern",
  execution: "gpu",
  params: [
    {
      key: HALFTONE_PARAM.cellSize,
      label: "Cell size",
      type: "float",
      hint: "Pixels per screen cell. Small cells read as tone, large ones as pattern.",
      animatable: true,
      legal: [1, 256],
      default: 8,
      // Log, because cell size is measured in octaves: uniform sampling of
      // 1..256 spends most of its draws above 100, where every result is the
      // same handful of enormous dots.
      surprise: { range: [3, 32], distribution: { kind: "log" }, weight: 1.2 },
    },
    {
      key: HALFTONE_PARAM.angle,
      label: "Screen angle",
      type: "float",
      // Degrees rather than turns, unlike the ordered dithers' tile rotation:
      // screen angles are quoted in degrees everywhere in print, and F-PT-02's
      // defaults are literally 15/75/0/45.
      hint: "Rotation of the dot grid, in degrees about the image centre.",
      animatable: true,
      legal: [-180, 180],
      default: 45,
      // 45 is the classic single-screen angle because the grid stops lining up
      // with the pixel raster there; the surprise range stays near it.
      surprise: { range: [-60, 60], distribution: { kind: "uniform" }, weight: 1 },
    },
    {
      key: HALFTONE_PARAM.dotShape,
      label: "Dot shape",
      type: "enum",
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
      // Square is legal but left out of the draw: at any real cell size it
      // reads as a mosaic rather than as a screen, which is a deliberate choice
      // rather than a random one.
      surprise: {
        values: [
          { value: "round", weight: 3 },
          { value: "ellipse", weight: 1.5 },
          { value: "diamond", weight: 1 },
        ],
        weight: 0.7,
      },
    },
    {
      key: HALFTONE_PARAM.dotAspect,
      label: "Dot aspect",
      type: "float",
      hint: "Elongation of the elliptical dot. Only the Ellipse shape reads it.",
      animatable: true,
      legal: [0.25, 4],
      default: 1.6,
      // Log for the same reason as cell size, and the range stays above 1: the
      // elliptical screen exists to elongate, and 0.25 is the same ellipse
      // turned a quarter turn, which the angle already reaches.
      surprise: { range: [1.2, 2.5], distribution: { kind: "log" }, weight: 0.4 },
    },
    {
      key: HALFTONE_PARAM.coverage,
      label: "Dot gain",
      type: "float",
      hint: "Grows every dot by the same area. 0 reproduces tone exactly.",
      animatable: true,
      legal: [-0.5, 0.5],
      default: 0,
      surprise: { range: [-0.12, 0.12], distribution: { kind: "uniform" }, weight: 0.6 },
    },
    {
      key: HALFTONE_PARAM.spread,
      label: "Spread",
      type: "float",
      hint: "Screen strength. 0 is plain quantization, 1 reproduces tone exactly.",
      animatable: true,
      legal: [0, 2],
      default: 1,
      surprise: { range: [0.6, 1.2], distribution: { kind: "uniform" }, weight: 0.8 },
    },
    {
      key: HALFTONE_PARAM.offsetX,
      label: "Offset X",
      type: "float",
      // Along the screen's own axes, not the image's, so the control keeps
      // meaning the same thing as the angle animates.
      hint: "Shifts the screen along its first axis, in cells.",
      animatable: true,
      legal: [-1024, 1024],
      default: 0,
      surprise: { range: [-4, 4], distribution: { kind: "uniform" }, weight: 0.6 },
    },
    {
      key: HALFTONE_PARAM.offsetY,
      label: "Offset Y",
      type: "float",
      hint: "Shifts the screen along its second axis, in cells.",
      animatable: true,
      legal: [-1024, 1024],
      default: 0,
      surprise: { range: [-4, 4], distribution: { kind: "uniform" }, weight: 0.6 },
    },
  ],
  surpriseWeight: 1,
  // Quantizing is the point: the index map it emits is what makes outline,
  // dilate/erode, hue-targeted recolour and the tracer lossless downstream.
  producesIndexMap: true,
  requiresIndexMap: false,
});

export default descriptor;

/**
 * Parameter descriptors keyed for `packUniforms`.
 *
 * Needed rather than optional here: `dotShape` is an enum, and its numeric form
 * is its position in `values`, which only the descriptor knows.
 */
export const HALFTONE_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  descriptor.params.map((param) => [param.key, param]),
);

/**
 * Check the enum ordinals the shader hard-codes against the ones the packer
 * will actually send.
 *
 * The uniform packer resolves an enum to its index in `values`; the shader
 * compares that index against its own `SHAPE_*` constants. Nothing connects the
 * two but this assertion, and a mismatch does not fail — it draws diamonds
 * where the document says round.
 */
function assertShapeOrdinals(): void {
  const shape = descriptor.params.find((param) => param.key === HALFTONE_PARAM.dotShape);
  if (shape === undefined || shape.type !== "enum") {
    const message = `halftone: "${HALFTONE_PARAM.dotShape}" is not an enum parameter`;
    log.error("halftone dot shape parameter is missing or the wrong kind");
    throw new Error(message);
  }
  const declared = shape.values.map((option) => option.value);
  const matches =
    declared.length === HALFTONE_DOT_SHAPES.length &&
    HALFTONE_DOT_SHAPES.every((value, index) => declared[index] === value);
  if (!matches) {
    const message =
      `halftone: dot shapes are declared as [${declared.join(", ")}] but the shader numbers ` +
      `them [${HALFTONE_DOT_SHAPES.join(", ")}]`;
    log.error("halftone dot shape ordinals disagree with the shader", {
      declared: declared.join(","),
      shader: HALFTONE_DOT_SHAPES.join(","),
    });
    throw new Error(message);
  }
}

/** The compute pass. One dispatch: the screen is a function of the coordinate. */
export function halftoneEffect(): GpuEffect {
  assertShapeOrdinals();

  const bindings: readonly PassBinding[] = [
    { role: "input-color", binding: HALFTONE_BINDING.inputColor },
    { role: "output-color", binding: HALFTONE_BINDING.outputColor },
    { role: "output-index", binding: HALFTONE_BINDING.outputIndex },
    { role: "palette", binding: HALFTONE_BINDING.palette },
    { role: "uniforms", binding: HALFTONE_BINDING.uniforms },
  ];

  const pass: ComputePass = {
    id: `${descriptor.id}/screen`,
    label: `${descriptor.name} screen`,
    wgsl,
    entryPoint: "main",
    // 64 invocations, well under the 256 guaranteed everywhere.
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    // Reads only its own pixel: the dot geometry comes from the coordinate, not
    // from a neighbour, which is exactly what makes a halftone parallel.
    access: "pointwise",
    bindings,
    uniforms: HALFTONE_UNIFORMS,
  };

  return { effect: descriptor.id, passes: [pass] };
}

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("halftone", () => halftoneEffect());
