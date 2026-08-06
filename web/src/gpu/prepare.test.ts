/**
 * From one node to its scheduled passes.
 *
 * This is where the three numbers that must agree are produced together: the
 * extent a texture is allocated at, the extent the dispatch covers, and the
 * extent the shader reads out of its uniform block. Every assertion here is
 * about them staying one number, and about a multi-pass effect threading them
 * from each pass to the next rather than each pass reading the node's input.
 */

import { describe, expect, it } from "vitest";

import type {
  ComputePass,
  Extent,
  GpuEffect,
  InstanceDataBinding,
  PassBinding,
  UniformLayout,
} from "../types/gpu";
import type { ParamDescriptor } from "../types/registry";
import { setLevel } from "../lib/log";
import { prepareNodePasses } from "./prepare";

setLevel("error");

/** `width`, `height`, `output-width`, `output-height` — one 16-byte block. */
const EXTENT_UNIFORMS: UniformLayout = {
  sizeBytes: 16,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "builtin", name: "output-width" }, type: "u32", offset: 8 },
    { source: { kind: "builtin", name: "output-height" }, type: "u32", offset: 12 },
  ],
};

const COLOUR_BINDINGS: readonly PassBinding[] = [
  { role: "input-color", binding: 0 },
  { role: "output-color", binding: 1 },
  { role: "uniforms", binding: 5 },
];

function pass(id: string, extra: Partial<ComputePass> = {}): ComputePass {
  return {
    id,
    label: id,
    wgsl: "// not compiled here",
    entryPoint: "main",
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    access: "neighbourhood",
    bindings: COLOUR_BINDINGS,
    uniforms: EXTENT_UNIFORMS,
    ...extra,
  };
}

const NO_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map();

function state(params: Readonly<Record<string, never>> | object = {}) {
  return {
    nodeId: "n1",
    params: params as Readonly<Record<string, never>>,
    paramTypes: NO_PARAM_TYPES,
    seed: 5,
    normalizedTime: 0,
    paletteSize: 4,
  };
}

/** Read the four extent words back out of a packed uniform block. */
function extentsOf(uniforms: ArrayBuffer): readonly number[] {
  const view = new DataView(uniforms);
  return [
    view.getUint32(0, true),
    view.getUint32(4, true),
    view.getUint32(8, true),
    view.getUint32(12, true),
  ];
}

const HD: Extent = { width: 1920, height: 1080 };

describe("prepareNodePasses", () => {
  it("leaves a non-resampling node's passes without an output extent", () => {
    // Absent rather than equal to the input, so "this pass resizes" stays a
    // visible fact about the scheduled pass.
    const effect: GpuEffect = { effect: "blur", passes: [pass("blur/main")] };
    const { unit, output } = prepareNodePasses(effect, state(), HD);
    expect(output).toEqual(HD);
    expect(unit.passes).toHaveLength(1);
    expect(unit.passes[0]?.output).toBeUndefined();
    expect(unit.passes[0]?.width).toBe(1920);
    expect(extentsOf(unit.passes[0]?.uniforms as ArrayBuffer)).toEqual([
      1920, 1080, 1920, 1080,
    ]);
  });

  it("resolves a resampling pass's output and reports it as the node's", () => {
    const effect: GpuEffect = {
      effect: "internal-resolution",
      passes: [
        pass("crush/main", { extent: { kind: "downscale", factorParam: "factor" } }),
      ],
    };
    const { unit, output } = prepareNodePasses(effect, state({ factor: 4 }), HD);
    expect(output).toEqual({ width: 480, height: 270 });
    expect(unit.passes[0]?.output).toEqual({ width: 480, height: 270 });
    // The shader is told both: it reads 1920x1080 and writes 480x270.
    expect(extentsOf(unit.passes[0]?.uniforms as ArrayBuffer)).toEqual([
      1920, 1080, 480, 270,
    ]);
  });

  it("threads the extent from each pass to the next", () => {
    // A separable resampler: horizontal, then vertical. The second pass reads
    // what the first wrote, which is the whole reason the extent is threaded
    // rather than read from the node's input by every pass.
    const effect: GpuEffect = {
      effect: "internal-resolution",
      passes: [
        pass("crush/x", {
          extent: { kind: "downscale", factorParam: "factor", axes: "x" },
        }),
        pass("crush/y", {
          extent: { kind: "downscale", factorParam: "factor", axes: "y" },
        }),
      ],
    };
    const { unit, output } = prepareNodePasses(effect, state({ factor: 2 }), HD);
    expect(output).toEqual({ width: 960, height: 540 });

    expect(extentsOf(unit.passes[0]?.uniforms as ArrayBuffer)).toEqual([
      1920, 1080, 960, 1080,
    ]);
    expect(extentsOf(unit.passes[1]?.uniforms as ArrayBuffer)).toEqual([
      960, 1080, 960, 540,
    ]);
    expect(unit.passes[1]?.width).toBe(960);
    expect(unit.passes[1]?.height).toBe(1080);
  });

  it("carries a node's bulk data on the pass that declares it", () => {
    const lut: InstanceDataBinding = {
      role: "instance-data",
      binding: 6,
      slot: "curve-lut",
      supplied: "none",
      build: () => new Uint8Array(new Float32Array(256).buffer),
    };
    const effect: GpuEffect = {
      effect: "curves",
      passes: [
        pass("curves/main", { bindings: [...COLOUR_BINDINGS, lut] }),
        pass("curves/second"),
      ],
    };
    const { unit } = prepareNodePasses(effect, state(), HD);
    expect(unit.passes[0]?.instances?.map((entry) => entry.slot)).toEqual([
      "curve-lut",
    ]);
    // Absent, not empty: a pass with no bulk data carries no field for it.
    expect(unit.passes[1]?.instances).toBeUndefined();
  });

  it("hands a supplied slot's bytes to the builder that asked for it", () => {
    const tile = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const map: InstanceDataBinding = {
      role: "instance-data",
      binding: 6,
      slot: "threshold-map",
      supplied: "required",
      build: ({ supplied }) => supplied ?? new Uint8Array(0),
    };
    const effect: GpuEffect = {
      effect: "threshold-map",
      passes: [pass("map/main", { bindings: [...COLOUR_BINDINGS, map] })],
    };
    const { unit } = prepareNodePasses(
      effect,
      { ...state(), supplied: new Map([["threshold-map", tile]]) },
      HD,
    );
    expect(unit.passes[0]?.instances?.[0]?.bytes).toBe(tile);
  });

  it("declares the node as a gpu unit under its own id", () => {
    const effect: GpuEffect = { effect: "blur", passes: [pass("blur/main")] };
    const { unit } = prepareNodePasses(effect, state(), HD);
    expect(unit.nodeId).toBe("n1");
    expect(unit.execution).toBe("gpu");
    expect(unit.passes.every((scheduled) => scheduled.nodeId === "n1")).toBe(true);
  });

  it("refuses an effect with no passes and an extent nothing could allocate", () => {
    expect(() =>
      prepareNodePasses({ effect: "empty", passes: [] }, state(), HD),
    ).toThrowError();
    expect(() =>
      prepareNodePasses(
        { effect: "blur", passes: [pass("blur/main")] },
        state(),
        { width: 0, height: 8 },
      ),
    ).toThrowError();
  });
});
