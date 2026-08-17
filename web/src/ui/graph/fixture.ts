/**
 * A four-effect catalogue for the node editor's tests.
 *
 * Written here rather than taken from the shipped catalogue for the same reason
 * `ui/stack/model.test.ts` writes its own: a test that names a real effect is a
 * test that breaks when somebody rebalances that effect's parameters, and it
 * states which effect happens to have the shape it needs rather than stating the
 * shape. These four are exactly the shapes the editor has to handle — one plain
 * node, one with a second colour input, one that reads its own previous frame,
 * and one that resamples and therefore has no mask port at all.
 *
 * They go through `createEffectRegistry`, which seals **after validating**, so a
 * fixture that would be refused at startup is refused here too. That is the
 * point: these are real descriptors, not stand-ins.
 *
 * It is a `.ts` module rather than a `.test.ts` one so that three test files can
 * share it without one of them owning the others' fixture.
 */

import { createEffectRegistry, type EffectRegistry } from "../../registry";
import type { GraphEdge, StackNode } from "../../types/document";
import { defineEffect } from "../../types/registry";

const FIXTURE_TEXT =
  "Not one of the shipped effects. It exists so a test can exercise one rule in isolation, which a real descriptor cannot do without dragging its whole parameter set along.";

/** One image in, one image out. Seventy-one of the shipped effects are this. */
export const PLAIN = defineEffect({
  id: "test-plain",
  name: "Test Plain",
  summary: "Fixture effect with the default single image input.",
  description: FIXTURE_TEXT,
  keywords: ["fixture", "plain"],
  requirement: "F-PP-02",
  slot: "preprocess",
  family: "preprocess",
  execution: "gpu",
  params: [],
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: false,
});

/** Two colour inputs: the thing multi-input was built for. */
export const BLENDER = defineEffect({
  id: "test-blender",
  name: "Test Blender",
  summary: "Fixture effect that combines a second picture with the first.",
  description: FIXTURE_TEXT,
  keywords: ["fixture", "blend"],
  requirement: "F-PP-03",
  slot: "postprocess",
  family: "special",
  execution: "gpu",
  inputs: [
    {
      key: "in",
      label: "Image",
      role: "image",
      description:
        "The picture this node works on. Unwired, the node is a root and reads the image the document opened.",
      required: false,
    },
    {
      key: "over",
      label: "Second picture",
      role: "layer",
      description:
        "A whole other branch of the graph, combined with the first as colour rather than read as coverage.",
      required: true,
    },
  ],
  params: [],
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: false,
});

/** Reads its own previous frame. The one legal cycle. */
export const LOOPER = defineEffect({
  id: "test-looper",
  name: "Test Looper",
  summary: "Fixture effect that reads the frame before this one.",
  description: FIXTURE_TEXT,
  keywords: ["fixture", "feedback"],
  requirement: "F-SP-20",
  slot: "postprocess",
  family: "special",
  execution: "gpu",
  inputs: [
    {
      key: "in",
      label: "Image",
      role: "image",
      description:
        "The picture this frame's trail is laid over. Unwired, the node is a root and reads the image the document opened.",
      required: false,
    },
    {
      key: "history",
      label: "Previous frame",
      role: "feedback",
      description:
        "This node's own output one frame ago. It is derived from the descriptor rather than stored, so no document carries an edge for it.",
      required: false,
    },
  ],
  params: [],
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: false,
  readsFeedback: true,
});

/** Writes a different extent than it reads, so it gets no mask port. */
export const RESAMPLER = defineEffect({
  id: "test-resampler",
  name: "Test Resampler",
  summary: "Fixture effect that writes a different extent than it reads.",
  description: FIXTURE_TEXT,
  keywords: ["fixture", "resample"],
  requirement: "F-PP-01",
  slot: "preprocess",
  family: "preprocess",
  execution: "gpu",
  params: [],
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: false,
  resamples: true,
});

/** Makes its own picture from its parameters. At full opacity it replaces its input. */
export const GENERATOR = defineEffect({
  id: "test-generator",
  name: "Test Generator",
  summary: "Fixture effect that makes a picture out of nothing.",
  description: FIXTURE_TEXT,
  keywords: ["fixture", "generator"],
  requirement: "F-GN-01",
  slot: "source",
  family: "pattern",
  execution: "gpu",
  params: [],
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: false,
  // Required of every source-slot effect, including a fixture: the validator
  // that seals this registry is the same one that seals the shipped catalogue.
  coverage: "large-scale",
});

export function fixtureRegistry(): EffectRegistry {
  return createEffectRegistry(
    [PLAIN, BLENDER, LOOPER, RESAMPLER, GENERATOR].map((descriptor) => ({
      descriptor,
      module: `fixture/${descriptor.id}.ts`,
    })),
  );
}

/** A node with the fields the editor reads and nothing invented. */
export function node(id: string, effect: string, extra: Partial<StackNode> = {}): StackNode {
  return {
    id,
    effect,
    enabled: true,
    opacity: 1,
    blend: "normal",
    params: {},
    seed: 1,
    ...extra,
  };
}

export function edge(from: string, to: string, port = "in"): GraphEdge {
  return { from, to, port };
}
