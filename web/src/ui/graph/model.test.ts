import { describe, expect, it } from "vitest";

import type { GraphDraft } from "../../graph/edit";
import type { NodeMask } from "../../types/document";
import { edge, fixtureRegistry, node } from "./fixture";
import { SNAP_RADIUS } from "./metrics";
import {
  IMAGE_MASK,
  buildEditorGraph,
  dropTargetAt,
  dropTargets,
  judgeDrop,
  maskAction,
  nodeAt,
} from "./model";

const registry = fixtureRegistry();

const LUMINANCE_MASK: NodeMask = {
  source: { kind: "luminance", low: 0.2, high: 0.8, feather: 0.1 },
  invert: false,
};

/** a -> b -> c, the shape every migrated document has. */
function chain(): GraphDraft {
  return {
    stack: [node("a", "test-plain"), node("b", "test-plain"), node("c", "test-plain")],
    edges: [edge("a", "b"), edge("b", "c")],
    output: "c",
  };
}

function portOf(draft: GraphDraft, nodeId: string, key: string) {
  const graph = buildEditorGraph(draft, registry);
  const port = graph.byId.get(nodeId)?.ports.find((candidate) => candidate.key === key);
  if (port === undefined) throw new Error(`fixture has no port ${nodeId}.${key}`);
  return port;
}

describe("the drawn graph", () => {
  it("gives every node its ports, mask included", () => {
    const graph = buildEditorGraph(chain(), registry);
    expect(graph.byId.get("b")?.ports.map((port) => port.key)).toEqual(["in", "mask"]);
  });

  it("gives a resampling node no mask port at all", () => {
    // A mask is applied by the composite and a node that writes a different
    // extent has no pixel grid for the coverage to be *of*. The connection
    // cannot be drawn rather than failing when the plan is built.
    const draft: GraphDraft = {
      stack: [node("r", "test-resampler")],
      edges: [],
      output: "r",
    };
    const graph = buildEditorGraph(draft, registry);
    expect(graph.byId.get("r")?.ports.map((port) => port.key)).toEqual(["in"]);
  });

  it("marks an unwired `in` as a root, which reads the opened image", () => {
    const graph = buildEditorGraph(chain(), registry);
    expect(graph.byId.get("a")?.isRoot).toBe(true);
    expect(graph.byId.get("b")?.isRoot).toBe(false);
  });

  it("draws a feedback loop from the descriptor, with no edge in the document", () => {
    const draft: GraphDraft = {
      stack: [node("f", "test-looper")],
      edges: [],
      output: "f",
    };
    const graph = buildEditorGraph(draft, registry);
    expect(graph.edges).toEqual([]);
    expect(graph.loops).toEqual([{ nodeId: "f", port: "history", portIndex: 1 }]);
    // And the port knows its producer without one being stored.
    expect(graph.byId.get("f")?.ports[1]?.from).toBe("f");
  });

  it("says which nodes cannot reach the picture", () => {
    const draft: GraphDraft = {
      stack: [node("a", "test-plain"), node("b", "test-plain"), node("x", "test-plain")],
      edges: [edge("a", "b")],
      output: "b",
    };
    const graph = buildEditorGraph(draft, registry);
    expect(graph.byId.get("a")?.reachesOutput).toBe(true);
    expect(graph.byId.get("x")?.reachesOutput).toBe(false);
  });

  it("carries the role on every edge, so a mask wire can look like one", () => {
    const draft: GraphDraft = {
      stack: [
        node("a", "test-plain"),
        node("m", "test-plain"),
        node("b", "test-plain", { mask: { source: { kind: "image", channel: "luminance" }, invert: false } }),
      ],
      edges: [edge("a", "b"), edge("m", "b", "mask")],
      output: "b",
    };
    const graph = buildEditorGraph(draft, registry);
    expect(graph.edges.find((candidate) => candidate.port === "mask")?.role).toBe("mask");
  });

  it("finds the card under a point and nothing under open canvas", () => {
    const graph = buildEditorGraph(chain(), registry);
    const b = graph.byId.get("b");
    expect(b).toBeDefined();
    if (b === undefined) return;
    expect(nodeAt(graph, { x: b.layout.x + 4, y: b.layout.y + 4 })?.id).toBe("b");
    expect(nodeAt(graph, { x: b.layout.x - 40, y: b.layout.y - 40 })).toBeNull();
  });
});

describe("judging a drop", () => {
  it("allows an ordinary connection", () => {
    const draft = chain();
    const verdict = judgeDrop(draft, registry, "a", "c", portOf(draft, "c", "in"));
    expect(verdict.refusal).toBeNull();
    expect(verdict.occupied).toBe(true);
  });

  it("refuses an edge that would close a loop, in the engine's own words", () => {
    const draft = chain();
    const verdict = judgeDrop(draft, registry, "c", "a", portOf(draft, "a", "in"));
    expect(verdict.refusal?.code).toBe("would-cycle");
    expect(verdict.refusal?.message).toContain("close a loop");
  });

  it("refuses a node reading itself", () => {
    const draft = chain();
    const verdict = judgeDrop(draft, registry, "b", "b", portOf(draft, "b", "in"));
    expect(verdict.refusal?.code).toBe("self-edge");
  });

  it("reports replacing an occupied port as legal rather than as a refusal", () => {
    // Dropping on an occupied port replaces what is there. Judging it against
    // the draft *with* the edge still in it would answer the wrong question and
    // grey out the commonest rewiring gesture there is.
    const draft = chain();
    const verdict = judgeDrop(draft, registry, "a", "c", portOf(draft, "c", "in"));
    expect(verdict.occupied).toBe(true);
    expect(verdict.refusal).toBeNull();
  });
});

describe("dropping on a mask port", () => {
  it("classifies an unmasked node as one that would be enabled", () => {
    expect(maskAction(node("b", "test-plain"))).toEqual({ kind: "enable" });
  });

  it("classifies a node already reading a picture as an ordinary wire", () => {
    expect(
      maskAction(node("b", "test-plain", { mask: IMAGE_MASK })),
    ).toEqual({ kind: "wire" });
  });

  it("classifies a luminance mask as a replacement, naming what would be lost", () => {
    expect(
      maskAction(node("b", "test-plain", { mask: LUMINANCE_MASK })),
    ).toEqual({ kind: "replace", existing: "luminance" });
  });

  it("allows the drop on an unmasked node — the gesture sets the coverage", () => {
    // The engine refuses this edge on its own terms, because the mask is not set
    // yet. The editor performs both halves as one step, so the drop is allowed
    // and the verdict says which of the two it is.
    const draft = chain();
    const verdict = judgeDrop(draft, registry, "a", "c", portOf(draft, "c", "mask"));
    expect(verdict.mask).toEqual({ kind: "enable" });
    expect(verdict.refusal).toBeNull();
  });

  it("refuses replacing a luminance mask, and says what it would cost", () => {
    const draft: GraphDraft = {
      stack: [
        node("a", "test-plain"),
        node("b", "test-plain"),
        node("c", "test-plain", { mask: LUMINANCE_MASK }),
      ],
      edges: [edge("a", "b"), edge("b", "c")],
      output: "c",
    };
    const verdict = judgeDrop(draft, registry, "a", "c", portOf(draft, "c", "mask"));
    expect(verdict.refusal?.message).toContain("luminance band");
    expect(verdict.refusal?.message).toContain("Test Plain");
  });

  it("still refuses a mask drop that would close a loop", () => {
    // The mask special case must not become a hole in the cycle rule.
    const draft = chain();
    const verdict = judgeDrop(draft, registry, "c", "a", portOf(draft, "a", "mask"));
    expect(verdict.refusal?.code).toBe("would-cycle");
  });
});

describe("snapping a drop", () => {
  it("lands on a port from well outside it — no pixel accuracy required", () => {
    const draft = chain();
    const graph = buildEditorGraph(draft, registry);
    const port = portOf(draft, "c", "in");
    // Twenty units left of the card and six down, which is nowhere near the
    // nine-pixel dot and is exactly where somebody dragging a wire lets go.
    const near = { x: port.point.x - 20, y: port.point.y + 6 };
    const hit = dropTargetAt(graph, draft, registry, "a", near);
    expect(hit?.port.key).toBe("in");
    expect(hit?.distance).toBeLessThan(SNAP_RADIUS);
  });

  it("resolves two ports a row apart to whichever is nearer", () => {
    // Forgiving is not the same as vague: the radius is bigger than the gap
    // between rows, so "nearest wins" is what stops a generous radius from
    // making adjacent ports ambiguous.
    const draft = chain();
    const graph = buildEditorGraph(draft, registry);
    const mask = portOf(draft, "c", "mask");
    expect(
      dropTargetAt(graph, draft, registry, "a", { x: mask.point.x - 4, y: mask.point.y + 2 })
        ?.port.key,
    ).toBe("mask");
  });

  it("gives nothing when the pointer is over open canvas", () => {
    const draft = chain();
    const graph = buildEditorGraph(draft, registry);
    expect(dropTargetAt(graph, draft, registry, "a", { x: -400, y: -400 })).toBeNull();
  });

  it("never snaps to a feedback port", () => {
    // Its producer is the node itself by construction, so aiming at it could
    // only ever end in a refusal or in an edge that restates the descriptor.
    const draft: GraphDraft = {
      stack: [node("a", "test-plain"), node("f", "test-looper")],
      edges: [edge("a", "f")],
      output: "f",
    };
    const graph = buildEditorGraph(draft, registry);
    const history = portOf(draft, "f", "history");
    const hit = dropTargetAt(graph, draft, registry, "a", history.point);
    expect(hit?.port.key).not.toBe("history");
  });
});

describe("every target", () => {
  it("offers each node's ports and leaves feedback ports out", () => {
    const draft: GraphDraft = {
      stack: [node("a", "test-plain"), node("f", "test-looper")],
      edges: [edge("a", "f")],
      output: "f",
    };
    const graph = buildEditorGraph(draft, registry);
    const keys = dropTargets(graph, draft, registry, "a").map(
      (target) => `${target.to}.${target.port.key}`,
    );
    expect(keys).toContain("f.in");
    expect(keys).toContain("f.mask");
    expect(keys).not.toContain("f.history");
  });

  it("keeps refused targets in the list, with their reason", () => {
    // The picker's precedent: an unavailable row is shown with the reason
    // rather than hidden, because the user knows the port is there.
    const draft = chain();
    const graph = buildEditorGraph(draft, registry);
    const targets = dropTargets(graph, draft, registry, "c");
    const selfEdge = targets.find((target) => target.to === "c" && target.port.key === "in");
    expect(selfEdge?.refusal?.code).toBe("self-edge");
  });

  it("names the required second input of a two-input node", () => {
    const draft: GraphDraft = {
      stack: [node("a", "test-plain"), node("b", "test-blender")],
      edges: [edge("a", "b")],
      output: "b",
    };
    const graph = buildEditorGraph(draft, registry);
    const over = graph.byId.get("b")?.ports.find((port) => port.key === "over");
    expect(over?.required).toBe(true);
    expect(over?.role).toBe("layer");
    expect(dropTargets(graph, draft, registry, "a").some((target) => target.port.key === "over")).toBe(
      true,
    );
  });
});
