import { describe, expect, it } from "vitest";

import { createEffectRegistry, type EffectRegistry } from "../../registry";
import type { StackNode } from "../../types/document";
import { defineEffect, type EffectDescriptor } from "../../types/registry";
import {
  BLEND_MODES,
  indexOfNode,
  insertionIndex,
  isExcludedBySolo,
  judgeCandidate,
  liveStack,
  moveItem,
  newIssues,
  stackRefs,
  withCandidate,
} from "./model";

// A four-effect catalogue with the one grammar rule the editor has to enforce
// in it: a quantizer that emits an index map, a dither that does not, and a
// node that reads one. Written here rather than taken from the shipped
// catalogue so the test states the rule it is about instead of depending on
// which real effect happens to have that shape this month.
const TONE = defineEffect({
  id: "test-tone",
  name: "Test Tone",
  summary: "Fixture effect, constructed by a test rather than shipped in the catalogue.",
  description:
    "Not one of the sixty-seven. It exists so this test can exercise one rule in isolation, which a real descriptor cannot do without dragging its whole parameter set along.",
  keywords: ["fixture", "test"],
  requirement: "F-PP-02",
  slot: "preprocess",
  family: "preprocess",
  execution: "gpu",
  params: [],
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: false,
});

const QUANTIZER = defineEffect({
  id: "test-quantizer",
  name: "Test Quantizer",
  summary: "Fixture effect, constructed by a test rather than shipped in the catalogue.",
  description:
    "Not one of the sixty-seven. It exists so this test can exercise one rule in isolation, which a real descriptor cannot do without dragging its whole parameter set along.",
  keywords: ["fixture", "test"],
  requirement: "F-OD-01",
  slot: "dither",
  family: "ordered",
  execution: "gpu",
  params: [],
  surpriseWeight: 1,
  producesIndexMap: true,
  requiresIndexMap: false,
});

const INKS = defineEffect({
  id: "test-inks",
  name: "Test Inks",
  summary: "Fixture effect, constructed by a test rather than shipped in the catalogue.",
  description:
    "Not one of the sixty-seven. It exists so this test can exercise one rule in isolation, which a real descriptor cannot do without dragging its whole parameter set along.",
  keywords: ["fixture", "test"],
  requirement: "F-PT-02",
  slot: "dither",
  family: "pattern",
  execution: "gpu",
  params: [],
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: false,
});

const OUTLINE = defineEffect({
  id: "test-outline",
  name: "Test Outline",
  summary: "Fixture effect, constructed by a test rather than shipped in the catalogue.",
  description:
    "Not one of the sixty-seven. It exists so this test can exercise one rule in isolation, which a real descriptor cannot do without dragging its whole parameter set along.",
  keywords: ["fixture", "test"],
  requirement: "F-SP-10",
  slot: "postprocess",
  family: "special",
  execution: "gpu",
  params: [],
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: true,
});

function registryOf(...effects: readonly EffectDescriptor[]): EffectRegistry {
  return createEffectRegistry(
    effects.map((descriptor) => ({ descriptor, module: `test/${descriptor.id}` })),
  );
}

function node(id: string, effect: string, enabled = true): StackNode {
  return {
    id,
    effect,
    enabled,
    opacity: 1,
    blend: "normal",
    params: {},
    seed: 0,
  };
}

describe("moveItem", () => {
  it("moves an element down", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });

  it("moves an element up", () => {
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("returns the same array when nothing moves", () => {
    const items = ["a", "b"];
    expect(moveItem(items, 1, 1)).toBe(items);
  });

  it("clamps a target past the end", () => {
    expect(moveItem(["a", "b", "c"], 0, 99)).toEqual(["b", "c", "a"]);
  });

  it("ignores an out-of-range source", () => {
    const items = ["a"];
    expect(moveItem(items, 5, 0)).toBe(items);
    expect(moveItem(items, -1, 0)).toBe(items);
  });
});

describe("insertionIndex", () => {
  const stack = [node("n1", "test-tone"), node("n2", "test-quantizer")];

  it("puts a new node directly after the selection", () => {
    expect(insertionIndex(stack, "n1")).toBe(1);
  });

  it("appends when nothing is selected", () => {
    expect(insertionIndex(stack, null)).toBe(2);
  });

  it("appends when the selection is not in the stack", () => {
    expect(insertionIndex(stack, "gone")).toBe(2);
  });
});

describe("indexOfNode", () => {
  it("reports -1 for null and for an unknown id", () => {
    const stack = [node("n1", "test-tone")];
    expect(indexOfNode(stack, null)).toBe(-1);
    expect(indexOfNode(stack, "n9")).toBe(-1);
    expect(indexOfNode(stack, "n1")).toBe(0);
  });
});

describe("solo", () => {
  const stack = [
    node("n1", "test-tone"),
    node("n2", "test-quantizer"),
    node("n3", "test-outline"),
  ];

  it("excludes everything below the solo point and nothing above it", () => {
    expect(isExcludedBySolo(stack, "n2", 0)).toBe(false);
    expect(isExcludedBySolo(stack, "n2", 1)).toBe(false);
    expect(isExcludedBySolo(stack, "n2", 2)).toBe(true);
  });

  it("excludes nothing when there is no solo point", () => {
    expect(isExcludedBySolo(stack, null, 2)).toBe(false);
  });

  it("renders up to and including the solo node", () => {
    expect(liveStack(stack, "n2").map((n) => n.id)).toEqual(["n1", "n2"]);
  });

  it("drops disabled nodes from the live stack", () => {
    const withDisabled = [
      node("n1", "test-tone", false),
      node("n2", "test-quantizer"),
    ];
    expect(liveStack(withDisabled, null).map((n) => n.id)).toEqual(["n2"]);
  });
});

describe("newIssues", () => {
  const issue = {
    code: "index-map-missing",
    nodeId: "n3",
    effect: "test-outline",
    message: "…",
  } as const;

  it("reports an issue that was not there before", () => {
    expect(newIssues([], [issue])).toEqual([issue]);
  });

  it("reports nothing when the issue was already present", () => {
    expect(newIssues([issue], [issue])).toEqual([]);
  });

  it("ignores the wording and keys on the rule and the nodes", () => {
    const reworded = { ...issue, message: "different words entirely" };
    expect(newIssues([issue], [reworded])).toEqual([]);
  });
});

describe("judgeCandidate", () => {
  const registry = registryOf(TONE, QUANTIZER, INKS, OUTLINE);

  it("refuses an index-map consumer with nothing quantizing in front of it", () => {
    const current = stackRefs([node("n1", "test-tone")]);
    const verdict = judgeCandidate(
      registry,
      current,
      withCandidate(current, "test-outline", 1),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("index map");
  });

  it("accepts the same node behind a quantizer", () => {
    const current = stackRefs([node("n1", "test-quantizer")]);
    expect(
      judgeCandidate(registry, current, withCandidate(current, "test-outline", 1)).ok,
    ).toBe(true);
  });

  it("refuses a dither that clears the map in front of a consumer", () => {
    const current = stackRefs([
      node("n1", "test-quantizer"),
      node("n2", "test-outline"),
    ]);
    const verdict = judgeCandidate(
      registry,
      current,
      withCandidate(current, "test-inks", 1),
    );
    expect(verdict.ok).toBe(false);
  });

  it("does not refuse an edit for a problem the stack already had", () => {
    // The outline is already unsatisfied. Adding an unrelated node must not be
    // blamed for it.
    const current = stackRefs([node("n1", "test-outline")]);
    expect(
      judgeCandidate(registry, current, withCandidate(current, "test-tone", 0)).ok,
    ).toBe(true);
  });

  it("judges a reorder the same way it judges an insertion", () => {
    const current = stackRefs([
      node("n1", "test-quantizer"),
      node("n2", "test-outline"),
    ]);
    const swapped = moveItem(current, 0, 1);
    expect(judgeCandidate(registry, current, swapped).ok).toBe(false);
  });

  it("ignores a disabled quantizer, because a disabled node does not render", () => {
    const current = stackRefs([node("n1", "test-quantizer", false)]);
    expect(
      judgeCandidate(registry, current, withCandidate(current, "test-outline", 1)).ok,
    ).toBe(false);
  });
});

describe("withCandidate", () => {
  it("clamps the insertion point to the stack", () => {
    const refs = stackRefs([node("n1", "test-tone")]);
    expect(withCandidate(refs, "test-tone", 99).map((r) => r.effect)).toEqual([
      "test-tone",
      "test-tone",
    ]);
    expect(withCandidate(refs, "test-quantizer", -5)[0]?.effect).toBe(
      "test-quantizer",
    );
  });
});

describe("BLEND_MODES", () => {
  it("lists every mode the document schema declares, once", () => {
    expect(new Set(BLEND_MODES).size).toBe(BLEND_MODES.length);
  });
});
