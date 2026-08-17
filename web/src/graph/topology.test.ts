/**
 * Topology: multi-input wiring, the cycle rule, and a deterministic order.
 *
 * Three things are asserted here that nothing else can assert, because they are
 * properties of the *order* rather than of any node:
 *
 * - a cycle of ordinary edges is refused, and a feedback loop is not;
 * - the order is the same every time, including when the ready set has a choice;
 * - an edge to a port the effect does not declare is refused before anything
 *   allocates a texture for it.
 */

import { describe, expect, it } from "vitest";

import type { EffectDescriptor } from "../types/registry";
import type { GraphNode, RenderGraph } from "../types/graph";
import { analyseGraph } from "./topology";
import { portOrder, portsOf } from "./ports";

function effect(
  id: string,
  fields: Partial<EffectDescriptor> = {},
): EffectDescriptor {
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
const SERIAL = effect("serial", { execution: "wasm", family: "error-diffusion" });
const RESAMPLER = effect("resampler", { resamples: true });
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

const EFFECTS = new Map(
  [PLAIN, SERIAL, RESAMPLER, BLENDER, FEEDBACK].map((e) => [e.id, e]),
);

function node(
  id: string,
  effectId: string,
  inputs: readonly { port: string; from: string }[] = [],
): GraphNode {
  return {
    id,
    effect: effectId,
    enabled: true,
    opacity: 1,
    blend: "normal",
    params: {},
    seed: 1,
    inputs: inputs.map((input) => ({
      port: input.port,
      from: { nodeId: input.from, port: "out" as const },
    })),
  };
}

function graphOf(nodes: readonly GraphNode[], output: string): RenderGraph {
  return {
    nodes,
    output: { nodeId: output, port: "out" },
    width: 100,
    height: 100,
    quality: "full",
    frame: 0,
  };
}

describe("ports", () => {
  it("gives an effect that declares nothing one image input plus a mask", () => {
    expect(portOrder(PLAIN)).toEqual(["in", "mask"]);
  });

  it("appends the mask port after whatever the effect declared", () => {
    expect(portOrder(BLENDER)).toEqual(["in", "layer", "mask"]);
  });

  it("gives a resampling node no mask port at all", () => {
    // A mask is applied by the composite, and a node whose output is a
    // different pixel grid from its own input has nothing for the coverage to
    // be of. Refusing the port is the same rule the plan enforces, stated where
    // an editor can see it.
    expect(portOrder(RESAMPLER)).toEqual(["in"]);
  });

  it("labels and explains every port, because an editor draws them", () => {
    for (const port of portsOf(BLENDER)) {
      expect(port.label.length).toBeGreaterThan(0);
      expect(port.description.length).toBeGreaterThan(0);
    }
  });
});

describe("wiring", () => {
  it("orders a chain", () => {
    const topology = analyseGraph(
      graphOf(
        [
          node("a", "plain"),
          node("b", "plain", [{ port: "in", from: "a" }]),
          node("c", "plain", [{ port: "in", from: "b" }]),
        ],
        "c",
      ),
      EFFECTS,
    );
    expect(topology.order).toEqual(["a", "b", "c"]);
  });

  it("orders a node with two image inputs after both of them", () => {
    const topology = analyseGraph(
      graphOf(
        [
          node("a", "plain"),
          node("b", "plain"),
          node("c", "blender", [
            { port: "in", from: "a" },
            { port: "layer", from: "b" },
          ]),
        ],
        "c",
      ),
      EFFECTS,
    );
    expect(topology.order.indexOf("c")).toBeGreaterThan(topology.order.indexOf("a"));
    expect(topology.order.indexOf("c")).toBeGreaterThan(topology.order.indexOf("b"));
  });

  it("refuses an edge to a port the effect does not declare", () => {
    expect(() =>
      analyseGraph(
        graphOf([node("a", "plain"), node("b", "plain", [{ port: "layer", from: "a" }])], "b"),
        EFFECTS,
      ),
    ).toThrow(/does not declare/);
  });

  it("refuses two edges into one port", () => {
    expect(() =>
      analyseGraph(
        graphOf(
          [
            node("a", "plain"),
            node("b", "plain", [
              { port: "in", from: "a" },
              { port: "in", from: "a" },
            ]),
          ],
          "b",
        ),
        EFFECTS,
      ),
    ).toThrow(/port twice/);
  });
});

describe("cycles", () => {
  it("refuses a cycle of ordinary edges, naming the nodes", () => {
    expect(() =>
      analyseGraph(
        graphOf(
          [
            node("a", "plain", [{ port: "in", from: "b" }]),
            node("b", "plain", [{ port: "in", from: "a" }]),
          ],
          "b",
        ),
        EFFECTS,
      ),
    ).toThrow(/cycle of ordinary edges/);
  });

  it("permits the loop a feedback port makes", () => {
    // The whole flip: "no cycles" stops being an invariant and becomes a
    // property only a feedback edge may violate, because such an edge reads the
    // previous frame and so imposes no order within this one.
    const topology = analyseGraph(
      graphOf(
        [
          node("a", "plain"),
          node("f", "feedback", [
            { port: "in", from: "a" },
            { port: "history", from: "f" },
          ]),
        ],
        "f",
      ),
      EFFECTS,
    );
    expect(topology.order).toEqual(["a", "f"]);
    expect(topology.feedbackPorts.get("f")).toEqual(["history"]);
  });

  it("reports the loop even when no edge was written down for it", () => {
    // The edge is derived from the descriptor rather than saved, so a document
    // that never mentions it still has the loop — and an editor still draws it.
    const topology = analyseGraph(
      graphOf([node("a", "plain"), node("f", "feedback", [{ port: "in", from: "a" }])], "f"),
      EFFECTS,
    );
    expect(topology.feedbackPorts.get("f")).toEqual(["history"]);
  });

  it("refuses a feedback edge from anything but the node itself", () => {
    // The frame store keys histories by node id and records each node's own
    // composited output, so no other node's previous frame exists to read.
    expect(() =>
      analyseGraph(
        graphOf(
          [
            node("a", "plain"),
            node("f", "feedback", [{ port: "history", from: "a" }]),
          ],
          "f",
        ),
        EFFECTS,
      ),
    ).toThrow(/only previous frame that exists is the node's own/);
  });
});

describe("the order is deterministic", () => {
  /** A diamond: two independent branches that rejoin. The ready set has a choice. */
  function diamond(): readonly GraphNode[] {
    return [
      node("root", "plain"),
      node("left", "plain", [{ port: "in", from: "root" }]),
      node("right", "plain", [{ port: "in", from: "root" }]),
      node("join", "blender", [
        { port: "in", from: "left" },
        { port: "layer", from: "right" },
      ]),
    ];
  }

  it("gives the same order every time it is asked", () => {
    const first = analyseGraph(graphOf(diamond(), "join"), EFFECTS).order;
    for (let i = 0; i < 20; i += 1) {
      expect(analyseGraph(graphOf(diamond(), "join"), EFFECTS).order).toEqual(first);
    }
  });

  it("breaks a tie by position in the node list, not by discovery order", () => {
    // Both branches are ready at the same moment and both are `gpu`, so the
    // execution-kind preference cannot decide. The document's own list does.
    const order = analyseGraph(graphOf(diamond(), "join"), EFFECTS).order;
    expect(order).toEqual(["root", "left", "right", "join"]);

    // The same graph with the two branches listed the other way round orders
    // them the other way round — which is the proof that the list decides.
    const swapped = [
      node("root", "plain"),
      node("right", "plain", [{ port: "in", from: "root" }]),
      node("left", "plain", [{ port: "in", from: "root" }]),
      node("join", "blender", [
        { port: "in", from: "left" },
        { port: "layer", from: "right" },
      ]),
    ];
    expect(analyseGraph(graphOf(swapped, "join"), EFFECTS).order).toEqual([
      "root",
      "right",
      "left",
      "join",
    ]);
  });

  it("prefers the execution kind just scheduled, to keep GPU runs together", () => {
    // Every switch between the serial and parallel paths costs a readback plus
    // an upload. With two independent nodes ready and one of them matching the
    // kind just run, the matching one goes first however the list is ordered.
    const nodes = [
      node("root", "serial"),
      node("gpuA", "plain", [{ port: "in", from: "root" }]),
      node("serialB", "serial", [{ port: "in", from: "root" }]),
      node("join", "blender", [
        { port: "in", from: "gpuA" },
        { port: "layer", from: "serialB" },
      ]),
    ];
    expect(analyseGraph(graphOf(nodes, "join"), EFFECTS).order).toEqual([
      "root",
      "serialB",
      "gpuA",
      "join",
    ]);
  });
});
