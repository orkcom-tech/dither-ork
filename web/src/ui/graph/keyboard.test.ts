import { describe, expect, it } from "vitest";

import type { GraphDraft } from "../../graph/edit";
import { edge, fixtureRegistry, node } from "./fixture";
import { SHORTCUTS, firstConnectable, stepSelection, stepTarget } from "./keyboard";
import { buildEditorGraph, dropTargets, type DropTarget } from "./model";

const registry = fixtureRegistry();

/**
 * a -> b -> c on row 0, with g -> m feeding c's mask on row 1.
 *
 * The smallest graph with both axes in it, which is what arrow navigation has
 * to be tested against.
 */
function branched(): GraphDraft {
  return {
    stack: [
      node("a", "test-plain"),
      node("b", "test-plain"),
      node("c", "test-plain", {
        mask: { source: { kind: "image", channel: "luminance" }, invert: false },
      }),
      node("g", "test-plain"),
      node("m", "test-plain"),
    ],
    edges: [edge("a", "b"), edge("b", "c"), edge("g", "m"), edge("m", "c", "mask")],
    output: "c",
  };
}

describe("moving between nodes", () => {
  const graph = buildEditorGraph(branched(), registry);

  it("moves along the chain with left and right", () => {
    expect(stepSelection(graph, "a", "right")).toBe("b");
    expect(stepSelection(graph, "b", "left")).toBe("a");
  });

  it("clamps at the ends rather than wrapping", () => {
    // Wrapping from the last column to the first reads as a jump to somewhere
    // else rather than as a move.
    expect(stepSelection(graph, "a", "left")).toBeNull();
    expect(stepSelection(graph, "c", "right")).toBeNull();
  });

  it("moves down onto the branch and back up", () => {
    expect(stepSelection(graph, "a", "down")).toBe("g");
    expect(stepSelection(graph, "g", "up")).toBe("a");
  });

  it("stays in the column when moving vertically", () => {
    // A graph's columns are its stages. Jumping between stages when asked to
    // move down is the one thing that would make arrow navigation unpredictable.
    expect(stepSelection(graph, "b", "down")).toBe("m");
    expect(stepSelection(graph, "c", "down")).toBeNull();
  });

  it("starts at the first node in reading order when nothing is selected", () => {
    expect(stepSelection(graph, null, "right")).toBe("a");
  });

  it("gives nothing for an empty graph", () => {
    const empty = buildEditorGraph({ stack: [], edges: [], output: null }, registry);
    expect(stepSelection(empty, null, "right")).toBeNull();
  });

  it("recovers when the selection names a node that is gone", () => {
    expect(stepSelection(graph, "deleted", "right")).toBe("a");
  });
});

describe("the connection cursor", () => {
  const draft = branched();
  const graph = buildEditorGraph(draft, registry);
  const targets: readonly DropTarget[] = dropTargets(graph, draft, registry, "a");

  it("opens on a target that can actually be committed", () => {
    const index = firstConnectable(targets);
    expect(targets[index]?.refusal).toBeNull();
  });

  it("steps and clamps", () => {
    expect(stepTarget(targets, 0, 1)).toBe(1);
    expect(stepTarget(targets, 0, -1)).toBe(0);
    expect(stepTarget(targets, targets.length - 1, 1)).toBe(targets.length - 1);
  });

  it("lands on refused targets rather than skipping them", () => {
    // Their refusal is written to be read, and a cursor that skipped them would
    // make an illegal port look like a port that does not exist.
    const refusedAt = targets.findIndex((target) => target.refusal !== null);
    expect(refusedAt).toBeGreaterThanOrEqual(0);
    expect(stepTarget(targets, refusedAt - 1, 1)).toBe(refusedAt);
  });

  it("reports no cursor at all when there is nothing to wire into", () => {
    expect(firstConnectable([])).toBe(-1);
    expect(stepTarget([], -1, 1)).toBe(-1);
  });
});

describe("the printed shortcuts", () => {
  it("name every key the editor handles, once each", () => {
    const keys = SHORTCUTS.map((shortcut) => shortcut.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(SHORTCUTS.every((shortcut) => shortcut.what.length > 0)).toBe(true);
  });
});
