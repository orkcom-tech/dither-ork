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
import {
  PassCompileError,
  validateFeedbackDeclaration,
  validateResamplingDeclaration,
  validateSourceDeclaration,
} from "./compiler";

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

/** The same pass with the previous frame bound at the conventional slot. */
function feedbackPass(id: string): ComputePass {
  return {
    ...pass(id),
    bindings: [
      { role: "input-color", binding: 0 },
      { role: "output-color", binding: 1 },
      { role: "feedback-color", binding: 6 },
    ],
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

/**
 * The same cross-check for feedback, and the stakes are higher.
 *
 * `resamples` drifting produces a *permission* — a stack the grammar accepts
 * and the scheduler then refuses. `readsFeedback` drifting produces a wrong
 * picture with nothing reporting it: the node cache would key a node whose
 * output depends on every frame before it on a hash that cannot see any of
 * them, hand back frame 3's pixels for frame 40, and log a hit while doing it.
 */
describe("validateFeedbackDeclaration", () => {
  it("accepts an effect that declares nothing and binds nothing", () => {
    expect(() =>
      validateFeedbackDeclaration(descriptor("blur"), effect("blur", [pass("blur/main")])),
    ).not.toThrow();
  });

  it("accepts a declared feedback effect whose pass binds the previous frame", () => {
    expect(() =>
      validateFeedbackDeclaration(
        { ...descriptor("feedback"), readsFeedback: true },
        effect("feedback", [feedbackPass("feedback/accumulate")]),
      ),
    ).not.toThrow();
  });

  it("refuses a declaration no pass backs up", () => {
    // The node and everything downstream of it would be excluded from the cache
    // — a permanent re-render of the tail of the stack — and the document would
    // be marked non-looping, for a history nothing reads.
    expect(() =>
      validateFeedbackDeclaration(
        { ...descriptor("feedback"), readsFeedback: true },
        effect("feedback", [pass("feedback/accumulate")]),
      ),
    ).toThrow(PassCompileError);
    expect(() =>
      validateFeedbackDeclaration(
        { ...descriptor("feedback"), readsFeedback: true },
        effect("feedback", [pass("feedback/accumulate")]),
      ),
    ).toThrow(/declares readsFeedback: true/);
  });

  it("refuses a pass that binds the previous frame under an effect that did not declare it", () => {
    expect(() =>
      validateFeedbackDeclaration(
        descriptor("ghost-echo"),
        effect("ghost-echo", [feedbackPass("ghost-echo/gather")]),
      ),
    ).toThrow(/ghost-echo\/gather/);
  });
});

/**
 * The same cross-check for a generator, where the two directions of drift are
 * two different failures.
 *
 * **Source that reads its input** is a filter wearing a generator's badge: the
 * picker would offer it under "source", the stack panel would say it makes its
 * own image, and on a blank canvas it would render black.
 *
 * **Filter that reads nothing** is a generator nobody declared: it would be
 * offered anywhere in the stack, discard everything above it, and
 * `registry/stack.ts` would have no grounds to mark the rows it killed — which
 * is precisely the "silently discards" outcome the slot exists to prevent.
 */
describe("validateSourceDeclaration", () => {
  /** A pass that reads nothing and writes a frame: the generator shape. */
  const generatorPass = (id: string): ComputePass => ({
    ...pass(id),
    bindings: [{ role: "output-color", binding: 1 }],
    access: "pointwise",
  });

  const sourceDescriptor = (id: string): EffectDescriptor => ({
    ...descriptor(id),
    slot: "source",
  });

  it("accepts an ordinary filter whose first pass reads the picture", () => {
    expect(() =>
      validateSourceDeclaration(descriptor("blur"), effect("blur", [pass("blur/main")])),
    ).not.toThrow();
  });

  it("accepts a source whose first pass reads nothing", () => {
    expect(() =>
      validateSourceDeclaration(
        sourceDescriptor("gen-noise"),
        effect("gen-noise", [generatorPass("gen-noise/main")]),
      ),
    ).not.toThrow();
  });

  it("accepts a source whose later pass reads what its first pass wrote", () => {
    // The rule is about which pass reads the *node's* input. A second pass
    // reading the surface chain this node already wrote is how every multi-pass
    // effect works.
    expect(() =>
      validateSourceDeclaration(
        sourceDescriptor("gen-two-pass"),
        effect("gen-two-pass", [generatorPass("gen-two-pass/field"), pass("gen-two-pass/blur")]),
      ),
    ).not.toThrow();
  });

  /**
   * The case that shipped broken.
   *
   * Row and column displacement open with a sequential walk that writes a
   * per-row offset table and binds no texture at all; the pass that reads the
   * picture is the second one. A rule written against `passes[0]` called both of
   * them generators and refused to compile them, which cost a quarter of every
   * Surprise Me press on both generators until it was found.
   */
  it("accepts a filter whose first pass only fills a scratch buffer", () => {
    const setup: ComputePass = {
      ...pass("row-displacement/slices"),
      bindings: [
        { role: "uniforms", binding: 5 },
        {
          role: "scratch",
          binding: 6,
          slot: "offsets",
          access: "read-write",
          size: { kind: "per-row", bytesPerRow: 4 },
        },
      ],
      dispatch: { kind: "fixed", workgroups: [1, 1, 1] },
      workgroupSize: [1, 1, 1],
      access: "global",
    };
    expect(() =>
      validateSourceDeclaration(
        descriptor("row-displacement"),
        effect("row-displacement", [setup, pass("row-displacement/apply")]),
      ),
    ).not.toThrow();
  });

  it("refuses a source whose first pass binds the picture it is defined not to read", () => {
    expect(() =>
      validateSourceDeclaration(
        sourceDescriptor("gen-noise"),
        effect("gen-noise", [pass("gen-noise/main")]),
      ),
    ).toThrow(PassCompileError);
    expect(() =>
      validateSourceDeclaration(
        sourceDescriptor("gen-noise"),
        effect("gen-noise", [pass("gen-noise/main")]),
      ),
    ).toThrow(/sits in the source slot/);
  });

  it("refuses a filter that reads no picture at all", () => {
    expect(() =>
      validateSourceDeclaration(
        descriptor("halftone"),
        effect("halftone", [generatorPass("halftone/main")]),
      ),
    ).toThrow(/binds input-color before the first pass that writes a frame/);
  });

  it("refuses a filter that only reads a frame it drew itself", () => {
    // A generator wearing a filter's badge: the first pass writes a picture out
    // of nothing and the second one filters it, so the node's own input is never
    // read and everything above it in the stack is discarded in silence.
    expect(() =>
      validateSourceDeclaration(
        descriptor("halftone"),
        effect("halftone", [generatorPass("halftone/field"), pass("halftone/screen")]),
      ),
    ).toThrow(PassCompileError);
  });
});
