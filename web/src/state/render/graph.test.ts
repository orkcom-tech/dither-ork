/**
 * A document compiled to a graph.
 *
 * The interesting assertions are about the *edges*, because everything the
 * render graph does — what re-runs, what is cached, where the boundary
 * crossings fall — is derived from them.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../../lib/log";
import { createDocument } from "../document";
import { DocumentError } from "../errors";
import { testRegistry } from "../fixture";
import { addNode, setBindings, setNodeEnabled } from "../mutations";
import { buildRenderGraph } from "./graph";

setLevel("error");

const registry = testRegistry();
const options = { width: 64, height: 48, quality: "full" as const, frame: 0 };

function stackOf(...effects: readonly string[]) {
  let document = createDocument();
  const ids: string[] = [];
  for (const effect of effects) {
    const result = addNode(document, registry, effect);
    document = result.document;
    ids.push(result.nodeId);
  }
  return { document, ids };
}

describe("wiring", () => {
  it("returns null for a document with no nodes", () => {
    // Not an error and not an empty graph: the picture is the image, and the
    // caller shows it.
    expect(buildRenderGraph(createDocument(), options)).toBeNull();
  });

  it("chains each node to the one before it, and leaves the first unwired", () => {
    const { document, ids } = stackOf("test-levels", "test-diffusion", "test-invert");
    const graph = buildRenderGraph(document, options);

    expect(graph?.nodes.map((node) => node.id)).toEqual(ids);
    // No edge on the first node is what `prepareGraph` reads as "this node is a
    // root and takes the decoded source".
    expect(graph?.nodes[0]?.inputs).toEqual([]);
    expect(graph?.nodes[1]?.inputs).toEqual([
      { port: "in", from: { nodeId: ids[0], port: "out" } },
    ]);
    expect(graph?.output).toEqual({ nodeId: ids[2], port: "out" });
  });

  it("carries the working resolution and the frame", () => {
    const { document } = stackOf("test-invert");
    const graph = buildRenderGraph(document, { ...options, width: 800, height: 600, frame: 7 });
    expect(graph?.width).toBe(800);
    expect(graph?.height).toBe(600);
    expect(graph?.frame).toBe(7);
    expect(graph?.quality).toBe("full");
  });

  it("keeps a disabled node wired", () => {
    // A disabled node is resolved past by `prepareGraph`, so it stays in the
    // graph and toggling it does not rebuild the chain.
    const { document, ids } = stackOf("test-levels", "test-invert");
    const graph = buildRenderGraph(setNodeEnabled(document, ids[0] ?? "", false), options);
    expect(graph?.nodes[0]?.enabled).toBe(false);
    expect(graph?.nodes[1]?.inputs).toEqual([
      { port: "in", from: { nodeId: ids[0], port: "out" } },
    ]);
  });
});

describe("solo (F-ST-02)", () => {
  it("moves the output upstream and drops what follows", () => {
    const { document, ids } = stackOf("test-levels", "test-diffusion", "test-invert");
    const graph = buildRenderGraph(document, { ...options, solo: ids[1] ?? null });
    expect(graph?.nodes.map((node) => node.id)).toEqual([ids[0], ids[1]]);
    expect(graph?.output.nodeId).toBe(ids[1]);
  });

  it("refuses a solo target that is not in the stack", () => {
    const { document } = stackOf("test-invert");
    expect(() => buildRenderGraph(document, { ...options, solo: "n99" })).toThrow(
      DocumentError,
    );
  });
});

describe("what it refuses", () => {
  it("refuses a document with modulator bindings", () => {
    // No modulator is implemented; rendering the document with its unbound
    // defaults would produce a picture that is not the document.
    const { document, ids } = stackOf("test-levels");
    const bound = setBindings(document, [
      {
        nodeId: ids[0] ?? "",
        param: "amount",
        shape: "sine",
        amount: 0.5,
        cyclesPerLoop: 2,
        phase: 0,
        bipolar: true,
      },
    ]);
    expect(() => buildRenderGraph(bound, options)).toThrow(/modulator/);
  });
});
