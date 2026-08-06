/**
 * Coalescing, and the extent a scheduled pass writes.
 *
 * Everything here runs without a device. `BatchExecutor` needs one and is
 * exercised by the pinned-browser golden harness in `web/test/gpu-golden/`;
 * what can be checked without one is the pair of decisions that produce wrong
 * pictures rather than errors — which nodes end up in one submission, and
 * whether the extent a pass was scheduled to write agrees with what its
 * descriptor said it would.
 */

import { describe, expect, it } from "vitest";

import type {
  ComputePass,
  Extent,
  PassExtent,
  ScheduledPass,
  UniformLayout,
} from "../types/gpu";
import { setLevel } from "../lib/log";
import { ScheduleError, planExecution, resolveScheduledOutput } from "./scheduler";

setLevel("error");

const UNIFORMS: UniformLayout = { sizeBytes: 16, fields: [] };

function pass(id: string, extent?: PassExtent): ComputePass {
  return {
    id,
    label: id,
    wgsl: "// not compiled here",
    entryPoint: "main",
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    access: "neighbourhood",
    bindings: [
      { role: "input-color", binding: 0 },
      { role: "output-color", binding: 1 },
    ],
    uniforms: UNIFORMS,
    ...(extent === undefined ? {} : { extent }),
  };
}

function scheduled(
  nodeId: string,
  computePass: ComputePass,
  input: Extent,
  output?: Extent,
): ScheduledPass {
  return {
    nodeId,
    pass: computePass,
    uniforms: new ArrayBuffer(UNIFORMS.sizeBytes),
    width: input.width,
    height: input.height,
    ...(output === undefined ? {} : { output }),
  };
}

const HD: Extent = { width: 1920, height: 1080 };
const CRUSHED: Extent = { width: 480, height: 270 };
const DOWNSCALE: PassExtent = { kind: "downscale", factorParam: "factor" };

describe("planExecution", () => {
  it("coalesces a maximal run of gpu nodes into one batch", () => {
    const plan = planExecution([
      { nodeId: "a", execution: "gpu", passes: [scheduled("a", pass("a/main"), HD)] },
      { nodeId: "b", execution: "gpu", passes: [scheduled("b", pass("b/main"), HD)] },
    ]);
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]?.passes).toHaveLength(2);
    expect(plan.crossings).toBe(0);
  });

  it("counts one crossing per gpu/wasm transition", () => {
    const plan = planExecution([
      { nodeId: "a", execution: "gpu", passes: [scheduled("a", pass("a/main"), HD)] },
      { nodeId: "b", execution: "wasm", passes: [] },
      { nodeId: "c", execution: "gpu", passes: [scheduled("c", pass("c/main"), HD)] },
    ]);
    expect(plan.batches).toHaveLength(2);
    expect(plan.crossings).toBe(2);
  });

  it("does not split a batch at a resolution change", () => {
    // It looks as though it should — every surface in a batch used to be one
    // shape. The reason was the fixed-shape ping-pong in `SurfaceChain`, not
    // anything about WebGPU, which orders dispatches within one command buffer
    // whatever shape their textures are. F-PP-01 is expected in almost every
    // stack, so splitting there would mean two submissions for almost every
    // render.
    const plan = planExecution([
      { nodeId: "a", execution: "gpu", passes: [scheduled("a", pass("a/main"), HD)] },
      {
        nodeId: "crush",
        execution: "gpu",
        passes: [scheduled("crush", pass("crush/main", DOWNSCALE), HD, CRUSHED)],
      },
      {
        nodeId: "b",
        execution: "gpu",
        passes: [scheduled("b", pass("b/main"), CRUSHED)],
      },
    ]);
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]?.passes).toHaveLength(3);
    expect(plan.crossings).toBe(0);
  });

  it("refuses a gpu node with no passes and a wasm node with some", () => {
    expect(() => planExecution([{ nodeId: "a", execution: "gpu", passes: [] }])).toThrowError(
      ScheduleError,
    );
    expect(() =>
      planExecution([
        {
          nodeId: "a",
          execution: "wasm",
          passes: [scheduled("a", pass("a/main"), HD)],
        },
      ]),
    ).toThrowError(ScheduleError);
  });
});

describe("resolveScheduledOutput", () => {
  it("returns the input for a pass that declares no extent rule", () => {
    expect(resolveScheduledOutput(scheduled("a", pass("a/main"), HD), HD)).toEqual(HD);
  });

  it("returns the resolved output for a pass that does", () => {
    expect(
      resolveScheduledOutput(
        scheduled("crush", pass("crush/main", DOWNSCALE), HD, CRUSHED),
        HD,
      ),
    ).toEqual(CRUSHED);
  });

  it("refuses a resampling pass scheduled without a resolved output", () => {
    // The executor cannot derive it — resolving a `PassExtent` needs the node's
    // parameters and all the executor holds is packed uniform bytes. Dispatched
    // at the input extent, an upscale would leave the tail of its output
    // unwritten.
    expect(() =>
      resolveScheduledOutput(scheduled("crush", pass("crush/main", DOWNSCALE), HD), HD),
    ).toThrowError(ScheduleError);
  });

  it("refuses a non-resampling pass scheduled to write a different shape", () => {
    // Its shader knows nothing about a second extent, so the texture would be
    // allocated at one shape and written at another.
    expect(() =>
      resolveScheduledOutput(scheduled("a", pass("a/main"), HD, CRUSHED), HD),
    ).toThrowError(ScheduleError);
  });

  it("accepts a redundant output that agrees with the input", () => {
    expect(
      resolveScheduledOutput(scheduled("a", pass("a/main"), HD, { ...HD }), HD),
    ).toEqual(HD);
  });

  it("names the node and the pass in every refusal", () => {
    try {
      resolveScheduledOutput(scheduled("n7", pass("crush/main", DOWNSCALE), HD), HD);
      expect.unreachable("a resampling pass with no output must not resolve");
    } catch (error) {
      expect(String(error)).toContain("n7");
      expect(String(error)).toContain("crush/main");
    }
  });
});
