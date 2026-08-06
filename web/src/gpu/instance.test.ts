/**
 * Per-node bulk data.
 *
 * The property that matters is not that a builder runs — it is that the bytes
 * it produces are checked, digested, and that the digest moves when and only
 * when the bytes do. A digest that does not move means a curve edit renders
 * with the previous LUT; a digest that moves when nothing did means every frame
 * of a playing animation re-uploads a buffer that did not change.
 */

import { describe, expect, it } from "vitest";

import type { InstanceDataBinding, PassBinding } from "../types/gpu";
import type { ParamDescriptor } from "../types/registry";
import { setLevel } from "../lib/log";
import {
  InstanceDataError,
  instanceBindingsOf,
  resolveInstanceData,
  resolvePassInstances,
} from "./instance";

setLevel("error");

const NO_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map();

/**
 * The shape F-PP-05 will use: a fixed-length LUT sampled from the node's own
 * `curve` parameter. Deliberately trivial arithmetic — this file is about the
 * channel, not about spline interpolation.
 */
const curveLut: InstanceDataBinding = {
  role: "instance-data",
  binding: 6,
  slot: "curve-lut",
  supplied: "none",
  build: ({ params }) => {
    const points = params["curve"];
    const gain = Array.isArray(points) ? points.length : 1;
    const lut = new Float32Array(256);
    for (let i = 0; i < lut.length; i += 1) lut[i] = (i / 255) * gain;
    return new Uint8Array(lut.buffer);
  },
};

/** The shape F-PP-07 will use: bytes the node cannot produce from anything it holds. */
const uploadedTile: InstanceDataBinding = {
  role: "instance-data",
  binding: 7,
  slot: "threshold-map",
  supplied: "required",
  build: ({ supplied }) => {
    if (supplied === null) throw new Error("unreachable: supplied is required");
    return supplied;
  },
};

function inputFor(
  params: Record<string, never> | Record<string, unknown> = {},
  supplied: Uint8Array | null = null,
) {
  return {
    nodeId: "n1",
    params: params as Readonly<Record<string, never>>,
    paramTypes: NO_PARAM_TYPES,
    seed: 7,
    supplied,
  };
}

describe("resolveInstanceData", () => {
  it("builds bytes and digests them", () => {
    const data = resolveInstanceData("pp05/main", curveLut, inputFor());
    expect(data.slot).toBe("curve-lut");
    expect(data.bytes.byteLength).toBe(256 * 4);
    expect(data.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives identical bytes an identical digest", () => {
    // The property the buffer channel rests on: a slider drag that leaves the
    // curve alone must cost no upload.
    const a = resolveInstanceData("pp05/main", curveLut, inputFor());
    const b = resolveInstanceData("pp05/main", curveLut, inputFor());
    expect(a.digest).toBe(b.digest);
  });

  it("moves the digest when the node's own parameters move", () => {
    const flat = resolveInstanceData(
      "pp05/main",
      curveLut,
      inputFor({ curve: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }),
    );
    const steeper = resolveInstanceData(
      "pp05/main",
      curveLut,
      inputFor({ curve: [{ x: 0, y: 0 }, { x: 0.5, y: 0.7 }, { x: 1, y: 1 }] }),
    );
    expect(steeper.digest).not.toBe(flat.digest);
  });

  it("refuses a required slot the node carries no bytes for", () => {
    try {
      resolveInstanceData("pp07/main", uploadedTile, inputFor());
      expect.unreachable("a required slot with no bytes must not resolve");
    } catch (error) {
      expect(error).toBeInstanceOf(InstanceDataError);
      expect((error as InstanceDataError).slot).toBe("threshold-map");
      // Nothing is substituted for an image the user has not chosen.
      expect(String(error)).toContain("threshold-map");
    }
  });

  it("accepts a required slot the node does carry bytes for", () => {
    const tile = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const data = resolveInstanceData("pp07/main", uploadedTile, inputFor({}, tile));
    expect(data.bytes).toBe(tile);
    expect(data.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses bytes filed under a slot the pass says it does not take", () => {
    // Not ignored: bytes under a slot the pass does not read mean the caller
    // and the effect disagree about what this node holds.
    expect(() =>
      resolveInstanceData("pp05/main", curveLut, inputFor({}, new Uint8Array(4))),
    ).toThrowError(InstanceDataError);
  });

  it("refuses an empty buffer", () => {
    const empty: InstanceDataBinding = {
      ...curveLut,
      build: () => new Uint8Array(0),
    };
    expect(() => resolveInstanceData("p", empty, inputFor())).toThrowError(
      InstanceDataError,
    );
  });

  it("refuses a length that is not a multiple of four", () => {
    // WGSL reads this buffer as words, and a trailing partial word has no
    // length — `arrayLength` would report one element fewer than was written.
    const ragged: InstanceDataBinding = {
      ...curveLut,
      build: () => new Uint8Array(6),
    };
    expect(() => resolveInstanceData("p", ragged, inputFor())).toThrowError(
      InstanceDataError,
    );
  });

  it("refuses a builder that returns something other than bytes", () => {
    const wrong: InstanceDataBinding = {
      ...curveLut,
      build: () => new Float32Array(4) as unknown as Uint8Array,
    };
    expect(() => resolveInstanceData("p", wrong, inputFor())).toThrowError(
      InstanceDataError,
    );
  });

  it("lets a builder's own error through rather than absorbing it", () => {
    const failing: InstanceDataBinding = {
      ...curveLut,
      build: () => {
        throw new RangeError("the curve has one point");
      },
    };
    expect(() => resolveInstanceData("p", failing, inputFor())).toThrowError(RangeError);
  });
});

describe("resolvePassInstances", () => {
  const bindings: readonly PassBinding[] = [
    { role: "input-color", binding: 0 },
    { role: "output-color", binding: 1 },
    curveLut,
    uploadedTile,
  ];

  it("resolves every declared slot, in declaration order", () => {
    const tile = new Uint8Array([9, 9, 9, 9]);
    const resolved = resolvePassInstances(
      "multi/main",
      bindings,
      { nodeId: "n1", params: {}, paramTypes: NO_PARAM_TYPES, seed: 0 },
      new Map([["threshold-map", tile]]),
    );
    expect(resolved.map((entry) => entry.slot)).toEqual([
      "curve-lut",
      "threshold-map",
    ]);
  });

  it("returns nothing for a pass that declares no bulk data", () => {
    expect(
      resolvePassInstances(
        "plain/main",
        [{ role: "input-color", binding: 0 }],
        { nodeId: "n1", params: {}, paramTypes: NO_PARAM_TYPES, seed: 0 },
        undefined,
      ),
    ).toEqual([]);
  });

  it("picks each slot's bytes by name, not by position", () => {
    const tile = new Uint8Array([1, 2, 3, 4]);
    const resolved = resolvePassInstances(
      "multi/main",
      bindings,
      { nodeId: "n1", params: {}, paramTypes: NO_PARAM_TYPES, seed: 0 },
      new Map([
        ["unrelated", new Uint8Array([7, 7, 7, 7])],
        ["threshold-map", tile],
      ]),
    );
    expect(resolved.find((entry) => entry.slot === "threshold-map")?.bytes).toBe(tile);
  });
});

describe("instanceBindingsOf", () => {
  it("selects only the instance-data bindings", () => {
    const selected = instanceBindingsOf([
      { role: "input-color", binding: 0 },
      curveLut,
      { role: "uniforms", binding: 5 },
      uploadedTile,
    ]);
    expect(selected).toEqual([curveLut, uploadedTile]);
  });
});
