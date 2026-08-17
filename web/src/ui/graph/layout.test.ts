import { describe, expect, it } from "vitest";

import type { GraphEdge } from "../../types/document";
import { COLUMN_GAP, NODE_WIDTH, nodeHeight } from "./metrics";
import { layoutGraph, type LayoutInput } from "./layout";

const ONE_PORT = (): number => 1;

function nodes(...ids: readonly string[]): readonly { readonly id: string }[] {
  return ids.map((id) => ({ id }));
}

function chain(...ids: readonly string[]): readonly GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (let i = 1; i < ids.length; i += 1) {
    const from = ids[i - 1];
    const to = ids[i];
    if (from === undefined || to === undefined) continue;
    edges.push({ from, to, port: "in" });
  }
  return edges;
}

describe("layout", () => {
  it("puts a chain on one row, one column per node", () => {
    const input: LayoutInput = { nodes: nodes("a", "b", "c"), edges: chain("a", "b", "c") };
    const layout = layoutGraph(input, ONE_PORT);

    expect([...layout.nodes.values()].map((node) => node.row)).toEqual([0, 0, 0]);
    expect([...layout.nodes.values()].map((node) => node.column)).toEqual([0, 1, 2]);
    expect(layout.rows).toBe(1);
    expect(layout.columns).toBe(3);
  });

  it("spaces columns by the card width plus the gap", () => {
    const layout = layoutGraph({ nodes: nodes("a", "b"), edges: chain("a", "b") }, ONE_PORT);
    expect(layout.nodes.get("b")?.x).toBe(NODE_WIDTH + COLUMN_GAP);
    expect(layout.nodes.get("a")?.x).toBe(0);
  });

  it("gives every card the same height stride, taken from the tallest", () => {
    // Two roots, so they land in one column and the row stride is visible.
    const layout = layoutGraph(
      { nodes: nodes("a", "b"), edges: [] },
      (id) => (id === "a" ? 3 : 1),
    );
    const a = layout.nodes.get("a");
    const b = layout.nodes.get("b");
    expect(a?.height).toBe(nodeHeight(3));
    expect(b?.height).toBe(nodeHeight(1));
    // The stride is the tallest card plus the gap, so `b` clears `a` rather than
    // being placed under a card of its own height and overlapping it.
    expect(b?.y).toBeGreaterThanOrEqual(nodeHeight(3));
  });

  it("places a node right of everything it reads, not right of the first one", () => {
    // `d` reads both `a` (column 0) and `c` (column 2). Shortest-path layering
    // would put it at column 1 and run its second wire backwards through `b`.
    const edges: readonly GraphEdge[] = [
      ...chain("a", "b", "c"),
      { from: "a", to: "d", port: "in" },
      { from: "c", to: "d", port: "mask" },
    ];
    const layout = layoutGraph({ nodes: nodes("a", "b", "c", "d"), edges }, () => 2);
    expect(layout.nodes.get("d")?.column).toBe(3);
  });

  it("puts a mask branch on its own row under the chain it modifies", () => {
    // source -> a -> b, and generator -> m -> b.mask. The chain keeps row 0 and
    // the branch takes row 1, which is the picture somebody draws on paper when
    // they explain what a mask is.
    const edges: readonly GraphEdge[] = [
      { from: "a", to: "b", port: "in" },
      { from: "g", to: "m", port: "in" },
      { from: "m", to: "b", port: "mask" },
    ];
    const layout = layoutGraph({ nodes: nodes("a", "g", "m", "b"), edges }, () => 2);

    expect(layout.nodes.get("a")?.row).toBe(0);
    expect(layout.nodes.get("g")?.row).toBe(1);
    expect(layout.nodes.get("m")?.row).toBe(1);
    expect(layout.nodes.get("b")?.column).toBe(2);
  });

  it("is a pure function of the document: same input, identical output", () => {
    const input: LayoutInput = {
      nodes: nodes("a", "b", "c", "d"),
      edges: [...chain("a", "b", "c"), { from: "d", to: "c", port: "mask" }],
    };
    const first = layoutGraph(input, () => 2);
    const second = layoutGraph(input, () => 2);
    expect([...second.nodes.entries()]).toEqual([...first.nodes.entries()]);
  });

  it("does not depend on the order the edges are listed in", () => {
    // Edge order is explicitly irrelevant to a document's meaning
    // (`types/document.ts`), so two documents that are the same graph must lay
    // out the same way — otherwise the same `.dork` re-saved would move.
    const forward: readonly GraphEdge[] = [
      { from: "a", to: "b", port: "in" },
      { from: "g", to: "m", port: "in" },
      { from: "m", to: "b", port: "mask" },
    ];
    const shuffled: readonly GraphEdge[] = [forward[2], forward[0], forward[1]].filter(
      (edge): edge is GraphEdge => edge !== undefined,
    );
    const a = layoutGraph({ nodes: nodes("a", "g", "m", "b"), edges: forward }, () => 2);
    const b = layoutGraph({ nodes: nodes("a", "g", "m", "b"), edges: shuffled }, () => 2);
    expect([...b.nodes.entries()]).toEqual([...a.nodes.entries()]);
  });

  it("puts the chain that ends at the picture on the top row", () => {
    // Two roots asking for row 0: the source of the chain, and a generator that
    // only feeds a mask. Ordering them by list position alone puts the branch
    // above the chain it modifies as often as not.
    const edges: readonly GraphEdge[] = [
      { from: "g", to: "b", port: "mask" },
      { from: "src", to: "b", port: "in" },
    ];
    const layout = layoutGraph(
      { nodes: nodes("g", "src", "b"), edges, output: "b" },
      () => 2,
    );
    expect(layout.nodes.get("src")?.row).toBe(0);
    expect(layout.nodes.get("b")?.row).toBe(0);
    expect(layout.nodes.get("g")?.row).toBe(1);
  });

  it("falls back to list position when the document names no picture", () => {
    const layout = layoutGraph({ nodes: nodes("g", "src"), edges: [] }, () => 2);
    expect(layout.nodes.get("g")?.row).toBe(0);
    expect(layout.nodes.get("src")?.row).toBe(1);
  });

  it("breaks ties on list position rather than on anything incidental", () => {
    // Three roots with nothing to separate them. The document's own order is the
    // answer, which is the same tie-break `graph/topology.ts` uses.
    const layout = layoutGraph({ nodes: nodes("z", "a", "m"), edges: [] }, ONE_PORT);
    expect(layout.nodes.get("z")?.row).toBe(0);
    expect(layout.nodes.get("a")?.row).toBe(1);
    expect(layout.nodes.get("m")?.row).toBe(2);
  });

  it("orders `order` by column then row, which is reading order", () => {
    const edges: readonly GraphEdge[] = [
      { from: "a", to: "b", port: "in" },
      { from: "g", to: "b", port: "mask" },
    ];
    const layout = layoutGraph({ nodes: nodes("a", "g", "b"), edges }, () => 2);
    expect(layout.order.map((node) => node.id)).toEqual(["a", "g", "b"]);
  });

  it("ignores an edge naming a node that is not in the document", () => {
    // Validation reports that properly; a layout that threw would take the whole
    // editor down instead of drawing the document with the problem in it.
    const layout = layoutGraph(
      { nodes: nodes("a"), edges: [{ from: "ghost", to: "a", port: "in" }] },
      ONE_PORT,
    );
    expect(layout.nodes.get("a")?.column).toBe(0);
  });

  it("lays a cycle out rather than hanging", () => {
    // Validation refuses this and the editor never commits one, but a hand-edited
    // file can contain it and must still open.
    const edges: readonly GraphEdge[] = [
      { from: "a", to: "b", port: "in" },
      { from: "b", to: "a", port: "in" },
    ];
    const layout = layoutGraph({ nodes: nodes("a", "b"), edges }, ONE_PORT);
    expect(layout.nodes.size).toBe(2);
  });

  it("has no size for an empty document", () => {
    const layout = layoutGraph({ nodes: [], edges: [] }, ONE_PORT);
    expect(layout.width).toBe(0);
    expect(layout.height).toBe(0);
    expect(layout.order).toEqual([]);
  });
});
