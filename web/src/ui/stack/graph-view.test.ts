import { describe, expect, it } from "vitest";

import { edge, fixtureRegistry, node } from "../graph/fixture";
import { describeRows, shapeNote, type GraphViewInput } from "./graph-view";

const registry = fixtureRegistry();

/** a -> b -> c, which is what every schema-1 document migrates to. */
const CHAIN: GraphViewInput = {
  stack: [node("a", "test-plain"), node("b", "test-plain"), node("c", "test-plain")],
  edges: [edge("a", "b"), edge("b", "c")],
  output: "c",
};

describe("a chain", () => {
  it("has nothing to say about any row", () => {
    // The whole point: a document written before schema 2 must read exactly as
    // it did. A badge on all twenty rows of a chain says nothing and costs the
    // width the effect name needs.
    const view = describeRows(CHAIN, registry);
    expect([...view.rows.values()].every((row) => row.badge === null && row.note === null)).toBe(
      true,
    );
  });

  it("is reported as linear, with no shape note", () => {
    const view = describeRows(CHAIN, registry);
    expect(view.linear).toBe(true);
    expect(view.branches).toBe(0);
    expect(view.detached).toBe(0);
    expect(shapeNote(view)).toBeNull();
  });

  it("numbers the chain back from the picture", () => {
    const view = describeRows(CHAIN, registry);
    expect(view.rows.get("c")?.placement).toEqual({ kind: "chain", step: 0 });
    expect(view.rows.get("a")?.placement).toEqual({ kind: "chain", step: 2 });
  });
});

describe("a branch", () => {
  const MASKED: GraphViewInput = {
    stack: [
      node("a", "test-plain"),
      node("m", "test-plain"),
      node("b", "test-plain", {
        mask: { source: { kind: "image", channel: "luminance" }, invert: false },
      }),
    ],
    edges: [edge("a", "b"), edge("m", "b", "mask")],
    output: "b",
  };

  it("names the port the branch feeds, and the node it belongs to", () => {
    const view = describeRows(MASKED, registry);
    const row = view.rows.get("m");
    expect(row?.placement).toMatchObject({ kind: "feeds", into: "b", port: "mask" });
    expect(row?.badge).toBe("→ mask");
    expect(row?.note).toContain("Test Plain");
  });

  it("leaves the chain rows plain", () => {
    const view = describeRows(MASKED, registry);
    expect(view.rows.get("a")?.badge).toBeNull();
    expect(view.rows.get("b")?.badge).toBeNull();
  });

  it("says the document is a graph, once, at the top", () => {
    const note = shapeNote(describeRows(MASKED, registry));
    expect(note).toContain("This document is a graph");
    expect(note).toContain("node editor");
  });

  it("lists every node, including the ones off the chain", () => {
    // A panel that silently omitted nodes would make the node count disagree
    // with the rows, and a node that exists and is not listed is unreachable.
    const view = describeRows(MASKED, registry);
    expect([...view.rows.keys()].sort()).toEqual(["a", "b", "m"]);
  });
});

describe("a node that reaches nothing", () => {
  const ORPHANED: GraphViewInput = {
    stack: [node("a", "test-plain"), node("b", "test-plain"), node("x", "test-plain")],
    edges: [edge("a", "b")],
    output: "b",
  };

  it("says so rather than looking like part of the chain", () => {
    const view = describeRows(ORPHANED, registry);
    expect(view.rows.get("x")?.placement).toEqual({ kind: "detached" });
    expect(view.rows.get("x")?.note).toContain("reaches the picture");
    expect(view.detached).toBe(1);
  });

  it("counts it in the shape note", () => {
    expect(shapeNote(describeRows(ORPHANED, registry))).toContain("not at all");
  });
});

describe("what a source node throws away", () => {
  it("marks the chain in front of a replacing generator, exactly as the list rule did", () => {
    // a -> b -> gen -> c. The generator makes its own picture at full opacity in
    // normal blend, so a and b never reach the frame.
    const view = describeRows(
      {
        stack: [
          node("a", "test-plain"),
          node("b", "test-plain"),
          node("gen", "test-generator"),
          node("c", "test-plain"),
        ],
        edges: [edge("a", "b"), edge("b", "gen"), edge("gen", "c")],
        output: "c",
      },
      registry,
    );
    expect([...view.shadowed.keys()].sort()).toEqual(["a", "b"]);
    expect(view.shadowed.get("a")).toContain("Test Generator");
  });

  it("says nothing when the generator is composited rather than replacing", () => {
    // At any other opacity or blend the input is still in the picture, which is
    // what makes "a gradient at 40% over a photograph" a real thing to want.
    const view = describeRows(
      {
        stack: [
          node("a", "test-plain"),
          node("gen", "test-generator", { opacity: 0.4 }),
        ],
        edges: [edge("a", "gen")],
        output: "gen",
      },
      registry,
    );
    expect(view.shadowed.size).toBe(0);
  });

  it("says nothing when the generator is only feeding a mask branch", () => {
    // The bug this replaced `analyseSources` for. A generator wired into a mask
    // port sits at the end of the list and discards nothing at all; the
    // positional rule marked the whole chain as thrown away.
    const view = describeRows(
      {
        stack: [
          node("a", "test-plain"),
          node("b", "test-plain", {
            mask: { source: { kind: "image", channel: "luminance" }, invert: false },
          }),
          node("gen", "test-generator"),
        ],
        edges: [edge("a", "b"), edge("gen", "b", "mask")],
        output: "b",
      },
      registry,
    );
    expect(view.shadowed.size).toBe(0);
  });

  it("says nothing about a disabled generator", () => {
    const view = describeRows(
      {
        stack: [node("a", "test-plain"), node("gen", "test-generator", { enabled: false })],
        edges: [edge("a", "gen")],
        output: "gen",
      },
      registry,
    );
    expect(view.shadowed.size).toBe(0);
  });

  it("blames the generator nearest the picture when there are two", () => {
    const view = describeRows(
      {
        stack: [
          node("a", "test-plain"),
          node("g1", "test-generator"),
          node("g2", "test-generator"),
        ],
        edges: [edge("a", "g1"), edge("g1", "g2")],
        output: "g2",
      },
      registry,
    );
    expect(view.shadowed.get("a")).toContain("node g2");
    expect(view.shadowed.get("g1")).toContain("node g2");
  });
});

describe("linearity", () => {
  it("is false when the list order is not the wiring", () => {
    // The wiring is a chain but the list is in a different order, so dragging a
    // row is not the same thing as rewiring and the panel must not imply it is.
    const view = describeRows(
      {
        stack: [node("b", "test-plain"), node("a", "test-plain")],
        edges: [edge("a", "b")],
        output: "b",
      },
      registry,
    );
    expect(view.linear).toBe(false);
  });

  it("is true for an empty document", () => {
    const view = describeRows({ stack: [], edges: [], output: null }, registry);
    expect(view.linear).toBe(true);
    expect(shapeNote(view)).toBeNull();
  });
});
