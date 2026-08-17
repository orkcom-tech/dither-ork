/**
 * The editing surface a node editor drives.
 *
 * The tests are written as the questions an editor asks: may I drop this wire
 * here, what will happen if I do, and what does a refusal say. A refusal that
 * says the wrong thing is the failure mode that matters here — the editor turns
 * it straight into a tooltip.
 */

import { describe, expect, it } from "vitest";

import type { EffectDescriptor } from "../types/registry";
import type { StackNode } from "../types/document";
import {
  addGraphNode,
  chainOf,
  connect,
  connectionProblem,
  disconnect,
  isLinearChain,
  legalConnections,
  removeGraphNode,
  setNodeMask,
  setOutput,
  type GraphDraft,
} from "./edit";

function effect(id: string, fields: Partial<EffectDescriptor> = {}): EffectDescriptor {
  return {
    id,
    name: id,
    summary: `Fixture ${id}, built by a test.`,
    description: `Fixture ${id}. Nothing renders it; only its declaration matters here.`,
    keywords: [id],
    requirement: "F-ST-01",
    slot: "postprocess",
    family: "special",
    execution: "gpu",
    params: [],
    surpriseWeight: 1,
    producesIndexMap: false,
    requiresIndexMap: false,
    ...fields,
  };
}

const PLAIN = effect("plain");
const BLENDER = effect("blender", {
  inputs: [
    {
      key: "in",
      label: "Image",
      role: "image",
      description: "The picture this node works on.",
      required: false,
    },
    {
      key: "layer",
      label: "Layer",
      role: "layer",
      description: "A second picture combined with the first as colour.",
      required: true,
    },
  ],
});
const FEEDBACK = effect("feedback", {
  readsFeedback: true,
  inputs: [
    {
      key: "in",
      label: "Image",
      role: "image",
      description: "The picture this frame's trail is laid over.",
      required: false,
    },
    {
      key: "history",
      label: "Previous frame",
      role: "feedback",
      description: "This node's own output one frame ago.",
      required: false,
    },
  ],
});

const effects = new Map([PLAIN, BLENDER, FEEDBACK].map((e) => [e.id, e]));

function stackNode(id: string, effectId: string): StackNode {
  return {
    id,
    effect: effectId,
    enabled: true,
    opacity: 1,
    blend: "normal",
    params: {},
    seed: 1,
  };
}

/** `a -> b -> c`, the shape every migrated document has. */
function chain(): GraphDraft {
  const stack = [stackNode("a", "plain"), stackNode("b", "plain"), stackNode("c", "plain")];
  return { stack, ...chainOf(stack) };
}

describe("connectionProblem", () => {
  it("allows an ordinary edge", () => {
    const draft: GraphDraft = { stack: chain().stack, edges: [], output: "c" };
    expect(connectionProblem(draft, effects, "a", "b", "in")).toBeNull();
  });

  it("refuses an edge that would close a loop, and says why", () => {
    const problem = connectionProblem(chain(), effects, "c", "a", "in");
    expect(problem?.code).toBe("would-cycle");
    expect(problem?.message).toMatch(/close a loop/);
    expect(problem?.message).toMatch(/reads the previous frame/);
  });

  it("refuses a node reading itself, except on a feedback port", () => {
    const stack = [stackNode("f", "feedback")];
    const draft: GraphDraft = { stack, edges: [], output: "f" };
    expect(connectionProblem(draft, effects, "f", "f", "in")?.code).toBe("self-edge");
    expect(connectionProblem(draft, effects, "f", "f", "history")).toBeNull();
  });

  it("refuses another node's previous frame", () => {
    const stack = [stackNode("a", "plain"), stackNode("f", "feedback")];
    const draft: GraphDraft = { stack, edges: [], output: "f" };
    const problem = connectionProblem(draft, effects, "a", "f", "history");
    expect(problem?.code).toBe("unsupported-feedback");
    expect(problem?.message).toMatch(/keys a history by node id/);
  });

  it("refuses a port the effect does not have, and lists the ones it does", () => {
    const problem = connectionProblem(chain(), effects, "a", "b", "layer");
    expect(problem?.code).toBe("unknown-port");
    expect(problem?.message).toMatch(/in, mask/);
  });

  it("refuses a mask edge on a node that is not reading a mask picture", () => {
    const problem = connectionProblem(chain(), effects, "a", "c", "mask");
    expect(problem?.code).toBe("mask-not-wanted");
    expect(problem?.message).toMatch(/mask image/);
  });

  it("allows a mask edge once the node reads one", () => {
    const draft = setNodeMask(chain(), "c", {
      source: { kind: "image", channel: "luminance" },
      invert: false,
    });
    expect(connectionProblem(draft, effects, "a", "c", "mask")).toBeNull();
  });

  it("refuses a second picture on an occupied port and names what is there", () => {
    const problem = connectionProblem(chain(), effects, "a", "c", "in");
    expect(problem?.code).toBe("port-occupied");
    expect(problem?.message).toMatch(/already reads b/);
  });

  it("refuses an endpoint that is not in the document", () => {
    expect(connectionProblem(chain(), effects, "gone", "b", "in")?.code).toBe("unknown-node");
  });
});

describe("legalConnections", () => {
  it("offers an occupied port as a replacement rather than hiding it", () => {
    // "You may drop here and it will replace what is there" is a different
    // answer from "you may not drop here", and conflating them greys out the
    // commonest rewiring gesture there is.
    const legal = legalConnections(chain(), effects, "a");
    const intoC = legal.find((entry) => entry.to === "c" && entry.port.key === "in");
    expect(intoC?.occupied).toBe(true);
  });

  it("does not offer a port that would close a loop", () => {
    const legal = legalConnections(chain(), effects, "c");
    expect(legal.some((entry) => entry.to === "a")).toBe(false);
    expect(legal.some((entry) => entry.to === "b")).toBe(false);
  });

  it("does not offer a mask port on an unmasked node", () => {
    const legal = legalConnections(chain(), effects, "a");
    expect(legal.some((entry) => entry.port.key === "mask")).toBe(false);
  });
});

describe("connect and disconnect", () => {
  it("replaces what the port held", () => {
    const next = connect(chain(), effects, "a", "c", "in");
    expect(next.edges.filter((edge) => edge.to === "c")).toEqual([
      { from: "a", to: "c", port: "in" },
    ]);
  });

  it("throws the sentence connectionProblem would have returned", () => {
    expect(() => connect(chain(), effects, "c", "a", "in")).toThrow(/close a loop/);
  });

  it("clearing a port that has no edge is not an error", () => {
    const draft = chain();
    expect(disconnect(draft, "a", "in")).toBe(draft);
  });
});

describe("adding and removing nodes", () => {
  it("inserting after a node rewires everything that read it", () => {
    const next = addGraphNode(chain(), stackNode("x", "plain"), "b");
    expect(next.edges).toContainEqual({ from: "b", to: "x", port: "in" });
    expect(next.edges).toContainEqual({ from: "x", to: "c", port: "in" });
    expect(next.edges).not.toContainEqual({ from: "b", to: "c", port: "in" });
  });

  it("inserting after the output moves the output with it", () => {
    const next = addGraphNode(chain(), stackNode("x", "plain"), "c");
    expect(next.output).toBe("x");
  });

  it("a node added as a root reads the source and is the output of an empty document", () => {
    const empty: GraphDraft = { stack: [], edges: [], output: null };
    const next = addGraphNode(empty, stackNode("a", "plain"), null);
    expect(next.edges).toEqual([]);
    expect(next.output).toBe("a");
  });

  it("refuses a duplicate id", () => {
    expect(() => addGraphNode(chain(), stackNode("b", "plain"), "a")).toThrow(/already in/);
  });

  it("removing from the middle heals the chain through the gap", () => {
    const next = removeGraphNode(chain(), "b");
    expect(next.edges).toEqual([{ from: "a", to: "c", port: "in" }]);
    expect(isLinearChain(next)).toBe(true);
  });

  it("removing a root leaves its consumer a root", () => {
    const next = removeGraphNode(chain(), "a");
    expect(next.edges).toEqual([{ from: "b", to: "c", port: "in" }]);
  });

  it("removing the output moves the output upstream", () => {
    const next = removeGraphNode(chain(), "c");
    expect(next.output).toBe("b");
  });

  it("clears the mask of a node whose mask picture is removed", () => {
    // Found by deleting a generator that fed a mask port. The edge went, the
    // `mask` stayed, and the document could not be rendered or repaired —
    // nothing in the editor clears a mask, so undo was the only way back and a
    // reloaded autosave had none.
    const base = chain();
    const masked = setNodeMask({ ...base, edges: [] }, "c", {
      source: { kind: "image", channel: "luminance" },
      invert: false,
    });
    const wired = connect(masked, effects, "a", "c", "mask");
    expect(wired.edges.some((edge) => edge.port === "mask")).toBe(true);

    const next = removeGraphNode(wired, "a");
    expect(next.edges.some((edge) => edge.port === "mask")).toBe(false);
    expect(next.stack.find((node) => node.id === "c")).not.toHaveProperty("mask");
  });

  it("keeps the mask when the removal can heal the mask edge", () => {
    // `b` feeds the mask and reads `a`, so the edge is rewired rather than
    // dropped: the coverage still comes from a picture and the mask stands.
    const base = chain();
    const masked = setNodeMask({ ...base, edges: [{ from: "a", to: "b", port: "in" }] }, "c", {
      source: { kind: "image", channel: "luminance" },
      invert: false,
    });
    const wired = connect(masked, effects, "b", "c", "mask");

    const next = removeGraphNode(wired, "b");
    expect(next.edges).toContainEqual({ from: "a", to: "c", port: "mask" });
    expect(next.stack.find((node) => node.id === "c")?.mask).toBeDefined();
  });
});

describe("setNodeMask", () => {
  it("drops the mask edge when the node stops reading a picture", () => {
    // Leaving it would be an edge read by nothing, which `graph/plan.ts`
    // refuses — so clearing a mask would leave a document that will not render
    // until a second gesture.
    const masked = setNodeMask(chain(), "c", {
      source: { kind: "image", channel: "luminance" },
      invert: false,
    });
    const wired = connect(masked, effects, "a", "c", "mask");
    expect(wired.edges.some((edge) => edge.port === "mask")).toBe(true);

    const cleared = setNodeMask(wired, "c", null);
    expect(cleared.edges.some((edge) => edge.port === "mask")).toBe(false);
    expect(cleared.stack.find((node) => node.id === "c")).not.toHaveProperty("mask");
  });

  it("drops it when the mask switches to reading the node's own input", () => {
    const masked = setNodeMask(chain(), "c", {
      source: { kind: "image", channel: "luminance" },
      invert: false,
    });
    const wired = connect(masked, effects, "a", "c", "mask");
    const switched = setNodeMask(wired, "c", {
      source: { kind: "luminance", low: 0, high: 0.5, feather: 0.1 },
      invert: false,
    });
    expect(switched.edges.some((edge) => edge.port === "mask")).toBe(false);
  });
});

describe("chainOf and isLinearChain", () => {
  it("round-trips a chain", () => {
    expect(isLinearChain(chain())).toBe(true);
  });

  it("says a branched document is not one", () => {
    const stack = [stackNode("a", "plain"), stackNode("b", "plain"), stackNode("j", "blender")];
    const draft: GraphDraft = {
      stack,
      edges: [
        { from: "a", to: "j", port: "in" },
        { from: "b", to: "j", port: "layer" },
      ],
      output: "j",
    };
    expect(isLinearChain(draft)).toBe(false);
  });

  it("says an empty document is one", () => {
    expect(isLinearChain({ stack: [], edges: [], output: null })).toBe(true);
  });
});

describe("setOutput", () => {
  it("refuses a node that is not in the document", () => {
    expect(() => setOutput(chain(), "gone")).toThrow(/not in this document/);
  });
});
