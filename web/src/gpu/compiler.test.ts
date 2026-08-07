/**
 * The one compiler check that needs no device.
 *
 * `PassCompiler` itself does — it creates modules and pipelines, and the pinned
 * browser image in `web/test/gpu-golden/` is where that is exercised. What runs
 * here is the cross-check between an effect's `resamples` declaration and what
 * its passes actually do, and it is worth a test of its own because of what it
 * guards against.
 *
 * `EffectDescriptor.resamples` is read by two layers that never see a pass:
 * `registry/stack.ts`, which refuses a resampler placed where an index map is
 * live, and `graph/plan.ts`, which refuses a composite on a node whose output
 * and input are different pixel grids. Both are refusals, so a flag that has
 * drifted from the passes does not produce a wrong picture — it produces a
 * **permission**, and the stack it lets through is one the scheduler then
 * rejects at render time. That is the exact defect the flag exists to close, so
 * the flag not agreeing with reality has to fail loudly and early.
 */

import { describe, expect, it } from "vitest";

import type { ComputePass, GpuEffect, PassExtent, UniformLayout } from "../types/gpu";
import type { EffectDescriptor } from "../types/registry";
import { setLevel } from "../lib/log";
import { PassCompileError, validateResamplingDeclaration } from "./compiler";

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

function descriptor(id: string, resamples?: boolean): EffectDescriptor {
  return {
    id,
    name: id,
    summary: "Fixture effect, constructed by a test rather than shipped in the catalogue.",
    description:
      "Not one of the sixty-seven. It exists so this test can exercise one rule in isolation, which a real descriptor cannot do without dragging its whole parameter set along.",
    keywords: ["fixture", "test"],
    requirement: "F-PP-01",
    slot: "preprocess",
    family: "preprocess",
    execution: "gpu",
    params: [],
    surpriseWeight: 1,
    producesIndexMap: false,
    requiresIndexMap: false,
    ...(resamples === undefined ? {} : { resamples }),
  };
}

function effect(id: string, passes: readonly ComputePass[]): GpuEffect {
  return { effect: id, passes };
}

const DOWNSCALE: PassExtent = { kind: "downscale", factorParam: "factor" };
const UPSCALE: PassExtent = { kind: "upscale", factorParam: "factor" };

describe("validateResamplingDeclaration", () => {
  it("accepts an effect that declares nothing and resizes nothing", () => {
    expect(() =>
      validateResamplingDeclaration(descriptor("blur"), effect("blur", [pass("blur/main")])),
    ).not.toThrow();
  });

  it("accepts a declared resampler whose passes resize", () => {
    // F-PP-01's shape: two separable passes, one per axis.
    expect(() =>
      validateResamplingDeclaration(
        descriptor("internal-resolution", true),
        effect("internal-resolution", [
          pass("internal-resolution/x", { ...DOWNSCALE, axes: "x" }),
          pass("internal-resolution/y", { ...DOWNSCALE, axes: "y" }),
        ]),
      ),
    ).not.toThrow();
  });

  it("accepts a declared resampler where only one of several passes resizes", () => {
    // A prepare-then-resample effect is legal; the declaration is about the
    // node, not about every pass in it.
    expect(() =>
      validateResamplingDeclaration(
        descriptor("nn-upscale", true),
        effect("nn-upscale", [pass("nn-upscale/prepare"), pass("nn-upscale/main", UPSCALE)]),
      ),
    ).not.toThrow();
  });

  it("refuses passes that resize under an effect that did not declare it", () => {
    // This is the drift that matters: the grammar would go on accepting this
    // node after a quantizer, and the scheduler would refuse the render.
    expect(() =>
      validateResamplingDeclaration(
        descriptor("internal-resolution"),
        effect("internal-resolution", [pass("internal-resolution/x", DOWNSCALE)]),
      ),
    ).toThrow(PassCompileError);
    expect(() =>
      validateResamplingDeclaration(
        descriptor("internal-resolution"),
        effect("internal-resolution", [pass("internal-resolution/x", DOWNSCALE)]),
      ),
    ).toThrow(/internal-resolution\/x/);
  });

  it("refuses a declaration no pass backs up", () => {
    // The other direction is not harmless either: the grammar would refuse
    // placements that render perfectly well, and the plan would refuse an
    // opacity the node could in fact honour.
    expect(() =>
      validateResamplingDeclaration(
        descriptor("invert", true),
        effect("invert", [pass("invert/main")]),
      ),
    ).toThrow(/declares resamples: true/);
  });
});
