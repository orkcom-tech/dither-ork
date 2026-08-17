/**
 * Graph validation, against the shipped catalogue.
 *
 * Two obligations, and both are stated in the module it tests: **everything the
 * stack validator refused, this refuses**, and a graph that cannot render must
 * be impossible to build. The first half is checked against real effects — CMYK
 * halftone under an outline, internal resolution after a dither — because those
 * are the combinations the rule exists for and a fixture would prove only that
 * the code runs.
 */

import { describe, expect, it } from "vitest";

import type { GraphEdge, NodeMask } from "../types/document";
import { discoverEffects } from "./discovery";
import { createEffectRegistry } from "./registry";
import { validateGraph, type GraphNodeRef } from "./graph";

const registry = createEffectRegistry(discoverEffects());

function node(id: string, effect: string, mask?: NodeMask): GraphNodeRef {
  return { id, effect, enabled: true, ...(mask === undefined ? {} : { mask }) };
}

function disabled(id: string, effect: string): GraphNodeRef {
  return { id, effect, enabled: false };
}

function chain(...nodes: readonly GraphNodeRef[]) {
  const edges: GraphEdge[] = [];
  for (let i = 1; i < nodes.length; i += 1) {
    edges.push({ from: nodes[i - 1]!.id, to: nodes[i]!.id, port: "in" });
  }
  return { nodes, edges, output: nodes[nodes.length - 1]?.id ?? null };
}

function codes(result: ReturnType<typeof validateGraph>): readonly string[] {
  return result.issues.map((issue) => issue.code);
}

describe("everything the stack validator refused", () => {
  it("an index-map consumer with nothing quantizing upstream", () => {
    const result = validateGraph(registry, chain(node("n1", "blur"), node("n2", "outline")));
    expect(codes(result)).toEqual(["index-map-missing"]);
    expect(result.issues[0]?.message).toMatch(/nothing upstream of it quantizes/);
  });

  it("an index-map consumer under a dither that emits none", () => {
    // CMYK halftone's colours are ink overprints rather than palette entries,
    // so there is no index to record. This is the combination the rule exists
    // for.
    const result = validateGraph(
      registry,
      chain(node("n1", "cmyk-halftone"), node("n2", "outline")),
    );
    expect(codes(result)).toEqual(["index-map-missing"]);
    expect(result.issues[0]?.otherNodeId).toBe("n1");
  });

  it("accepts the same consumer under a dither that does emit one", () => {
    expect(validateGraph(registry, chain(node("n1", "bayer-4"), node("n2", "outline"))).ok).toBe(
      true,
    );
  });

  it("a resampler run while an index map is live", () => {
    const result = validateGraph(
      registry,
      chain(node("n1", "bayer-4"), node("n2", "internal-resolution")),
    );
    expect(codes(result)).toEqual(["index-map-resampled"]);
  });

  it("accepts nearest upscale in the same position, which carries the map across", () => {
    expect(
      validateGraph(registry, chain(node("n1", "bayer-4"), node("n2", "nn-upscale"))).ok,
    ).toBe(true);
  });

  it("skips a disabled node on both sides of every rule", () => {
    // A disabled node is not in the render, so it neither produces a map nor
    // needs one. Counting it either way accepts a graph that fails to render or
    // refuses one that renders perfectly well.
    expect(
      validateGraph(registry, chain(disabled("n1", "bayer-4"), node("n2", "outline"))).ok,
    ).toBe(false);
    expect(
      validateGraph(registry, chain(node("n1", "bayer-4"), disabled("n2", "outline"))).ok,
    ).toBe(true);
  });

  it("an effect this build does not have, reported alone", () => {
    const result = validateGraph(
      registry,
      chain(node("n1", "not-an-effect"), node("n2", "outline")),
    );
    // Nothing is known about what a missing effect produces, so the index-map
    // verdict that would follow is not invented.
    expect(codes(result)).toEqual(["unknown-effect"]);
  });
});

describe("what a graph makes possible", () => {
  it("refuses an edge naming a node that is not there", () => {
    const result = validateGraph(registry, {
      nodes: [node("n1", "blur")],
      edges: [{ from: "n1", to: "gone", port: "in" }],
      output: "n1",
    });
    expect(codes(result)).toContain("unknown-node");
  });

  it("refuses an edge to a port the effect does not declare", () => {
    const result = validateGraph(registry, {
      nodes: [node("n1", "blur"), node("n2", "invert")],
      edges: [{ from: "n1", to: "n2", port: "layer" }],
      output: "n2",
    });
    expect(codes(result)).toContain("unknown-port");
    expect(result.issues[0]?.message).toMatch(/has no "layer" input/);
  });

  it("refuses two edges into one port", () => {
    const result = validateGraph(registry, {
      nodes: [node("n1", "blur"), node("n2", "sharpen"), node("n3", "invert")],
      edges: [
        { from: "n1", to: "n3", port: "in" },
        { from: "n2", to: "n3", port: "in" },
      ],
      output: "n3",
    });
    expect(codes(result)).toContain("duplicate-port");
  });

  it("refuses a loop, because no stored edge may close one", () => {
    const result = validateGraph(registry, {
      nodes: [node("n1", "blur"), node("n2", "invert")],
      edges: [
        { from: "n1", to: "n2", port: "in" },
        { from: "n2", to: "n1", port: "in" },
      ],
      output: "n2",
    });
    expect(codes(result)).toContain("cycle");
    expect(result.issues[0]?.message).toMatch(/only a feedback input may close a loop/i);
  });

  it("refuses a document with nodes and no picture", () => {
    const result = validateGraph(registry, {
      nodes: [node("n1", "blur")],
      edges: [],
      output: null,
    });
    expect(codes(result)).toEqual(["no-output"]);
  });

  it("accepts an empty document", () => {
    expect(validateGraph(registry, { nodes: [], edges: [], output: null }).ok).toBe(true);
  });

  it("accepts two branches that rejoin nowhere, because one of them is the picture", () => {
    // A node nothing reads is not an error: it is a branch being built, and the
    // compiler simply does not reach it from the output.
    const result = validateGraph(registry, {
      nodes: [node("n1", "blur"), node("n2", "invert")],
      edges: [],
      output: "n1",
    });
    expect(result.ok).toBe(true);
  });
});

describe("masks", () => {
  const imageMask: NodeMask = {
    source: { kind: "image", channel: "luminance" },
    invert: false,
  };
  const toneMask: NodeMask = {
    source: { kind: "luminance", low: 0, high: 0.5, feather: 0.1 },
    invert: false,
  };

  it("refuses an image mask with nothing wired to it", () => {
    const result = validateGraph(registry, {
      nodes: [node("n1", "blur"), node("n2", "invert", imageMask)],
      edges: [{ from: "n1", to: "n2", port: "in" }],
      output: "n2",
    });
    expect(codes(result)).toContain("mask-edge-mismatch");
  });

  it("accepts it once a branch is wired to the mask port", () => {
    const result = validateGraph(registry, {
      nodes: [node("n1", "blur"), node("n2", "invert", imageMask), node("n3", "sharpen")],
      edges: [
        { from: "n1", to: "n2", port: "in" },
        { from: "n3", to: "n2", port: "mask" },
      ],
      output: "n2",
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a mask edge nothing reads", () => {
    const result = validateGraph(registry, {
      nodes: [node("n1", "blur"), node("n2", "invert", toneMask), node("n3", "sharpen")],
      edges: [
        { from: "n1", to: "n2", port: "in" },
        { from: "n3", to: "n2", port: "mask" },
      ],
      output: "n2",
    });
    expect(codes(result)).toContain("mask-edge-mismatch");
  });

  it("accepts a tone mask with no edge at all", () => {
    const result = validateGraph(registry, chain(node("n1", "blur"), node("n2", "invert", toneMask)));
    expect(result.ok).toBe(true);
  });

  it("refuses a mask on a node that resamples", () => {
    const result = validateGraph(
      registry,
      chain(node("n1", "blur"), node("n2", "internal-resolution", toneMask)),
    );
    expect(codes(result)).toContain("mask-on-resampler");
    expect(result.issues[0]?.message).toMatch(/different pixel grids/);
  });

  it("refuses a mask whose band is empty", () => {
    const empty: NodeMask = {
      source: { kind: "luminance", low: 0.8, high: 0.2, feather: 0 },
      invert: false,
    };
    const result = validateGraph(registry, chain(node("n1", "blur"), node("n2", "invert", empty)));
    expect(codes(result)).toContain("invalid-mask");
  });
});
