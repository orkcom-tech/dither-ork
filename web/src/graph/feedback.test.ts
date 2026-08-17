/**
 * Decision 1 of `docs/dither-ork-node-graph.md`, as arithmetic.
 *
 * The whole of it is one sentence — *a feedback node and everything downstream
 * of it are excluded from the content-hash cache* — and every assertion here is
 * about one of its two halves. The second half is the one worth testing hardest:
 *
 * - **Downstream must be excluded**, or the cache serves a node whose input
 *   changed under it and reports a hit while doing so. That failure is silent:
 *   the picture is simply wrong, and the log says everything went well.
 * - **Upstream must not be**, or feedback turns every stack containing it into
 *   a full re-render on every frame — which is the outcome the honest option
 *   was chosen to avoid, and it would look like the honest option *failing*.
 *
 * The exclusion is checked twice over: as a set (`analyseFeedback`) and through
 * the planner, where it has to survive the backward walk that stops at cache
 * hits. The second is what actually protects the picture, because a node's hash
 * being resident is all `planRender` needs to stop looking.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Palette } from "../types/document";
import type { ContentHash, GraphNode, RenderGraph } from "../types/graph";
import type { EffectDescriptor } from "../types/registry";
import { setLevel } from "../lib/log";
import { analyseFeedback, stackReadsFeedback } from "./feedback";
import { planRender, prepareGraph } from "./plan";
import { analyseGraph } from "./topology";

setLevel("error");

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const SOURCE_HASH = "source-image-hash" as ContentHash;

const PALETTE: Palette = {
  id: "test",
  name: "Test",
  colors: [0, 0, 0, 255, 255, 255],
  metric: "oklab",
};

function descriptor(id: string, readsFeedback = false): EffectDescriptor {
  return {
    id,
    name: id,
    summary: "Fixture effect, constructed by a test rather than shipped in the catalogue.",
    description:
      "Not one of the sixty-eight. It exists so this test can exercise the cache exclusion in isolation, which a real descriptor cannot do without dragging its whole parameter set along.",
    keywords: ["fixture", "test"],
    requirement: "F-PP-01",
    slot: "postprocess",
    family: "special",
    execution: "gpu",
    params: [],
    surpriseWeight: 1,
    producesIndexMap: false,
    requiresIndexMap: false,
    ...(readsFeedback ? { readsFeedback: true } : {}),
  };
}

const EFFECTS: ReadonlyMap<string, EffectDescriptor> = new Map([
  ["blur", descriptor("blur")],
  ["invert", descriptor("invert")],
  ["levels", descriptor("levels")],
  ["feedback", descriptor("feedback", true)],
]);

function node(id: string, effect: string, from: string | null, enabled = true): GraphNode {
  return {
    id,
    effect,
    enabled,
    opacity: 1,
    blend: "normal",
    params: {},
    seed: 1,
    inputs: from === null ? [] : [{ port: "in", from: { nodeId: from, port: "out" } }],
  };
}

/** A linear stack, wired the way `state/render/graph.ts` wires one. */
function chain(effects: readonly { effect: string; enabled?: boolean }[]): RenderGraph {
  const nodes: GraphNode[] = [];
  let previous: string | null = null;
  effects.forEach((entry, index) => {
    const id = `n${index}`;
    nodes.push(node(id, entry.effect, previous, entry.enabled ?? true));
    previous = id;
  });
  const last = nodes[nodes.length - 1];
  if (last === undefined) throw new Error("a chain needs at least one node");
  return {
    nodes,
    output: { nodeId: last.id, port: "out" },
    width: 320,
    height: 240,
    quality: "full",
    frame: 0,
  };
}

function analyse(graph: RenderGraph): ReturnType<typeof analyseFeedback> {
  return analyseFeedback(analyseGraph(graph, EFFECTS));
}

describe("analyseFeedback", () => {
  it("finds nothing in a stack with no feedback node", () => {
    const analysis = analyse(chain([{ effect: "blur" }, { effect: "invert" }]));
    expect(analysis.feedbackNodes).toEqual([]);
    expect(analysis.excludedOrder).toEqual([]);
  });

  it("excludes the feedback node and everything after it, and nothing before it", () => {
    // blur -> invert -> feedback -> levels. The first two are pure functions of
    // the document and must keep caching; the last two cannot be.
    const analysis = analyse(
      chain([
        { effect: "blur" },
        { effect: "invert" },
        { effect: "feedback" },
        { effect: "levels" },
      ]),
    );
    expect(analysis.feedbackNodes).toEqual(["n2"]);
    expect(analysis.excludedOrder).toEqual(["n2", "n3"]);
    expect(analysis.excluded.has("n0")).toBe(false);
    expect(analysis.excluded.has("n1")).toBe(false);
  });

  it("excludes everything after the first of two feedback nodes", () => {
    const analysis = analyse(
      chain([
        { effect: "blur" },
        { effect: "feedback" },
        { effect: "invert" },
        { effect: "feedback" },
      ]),
    );
    expect(analysis.feedbackNodes).toEqual(["n1", "n3"]);
    expect(analysis.excludedOrder).toEqual(["n1", "n2", "n3"]);
    expect(analysis.excluded.has("n0")).toBe(false);
  });

  it("ignores a disabled feedback node", () => {
    // A disabled node is wired out of the graph entirely and never runs, so it
    // reads no history. Excluding the tail of the stack for it would be a
    // permanent re-render bought for a node that does nothing.
    const analysis = analyse(
      chain([{ effect: "blur" }, { effect: "feedback", enabled: false }, { effect: "levels" }]),
    );
    expect(analysis.feedbackNodes).toEqual([]);
    expect(analysis.excludedOrder).toEqual([]);
  });
});

describe("stackReadsFeedback", () => {
  it("answers for a document that has not been compiled", () => {
    expect(
      stackReadsFeedback([{ effect: "blur", enabled: true }], EFFECTS),
    ).toBe(false);
    expect(
      stackReadsFeedback([{ effect: "feedback", enabled: true }], EFFECTS),
    ).toBe(true);
    expect(
      stackReadsFeedback([{ effect: "feedback", enabled: false }], EFFECTS),
    ).toBe(false);
  });

  it("ignores an effect the registry does not have rather than guessing", () => {
    expect(stackReadsFeedback([{ effect: "not-an-effect", enabled: true }], EFFECTS)).toBe(false);
  });
});

describe("planRender with a feedback node in the stack", () => {
  const graph = chain([
    { effect: "blur" },
    { effect: "invert" },
    { effect: "feedback" },
    { effect: "levels" },
  ]);
  const prepared = prepareGraph(graph, SOURCE_HASH, PALETTE, EFFECTS);

  it("marks exactly the excluded nodes uncacheable on the plan", () => {
    const plan = planRender(prepared, () => false);
    const byId = new Map(
      plan.steps
        .flatMap((step) => (step.kind === "gpu-batch" ? step.nodes : [step.node]))
        .map((planned) => [planned.node.id, planned.cacheable]),
    );
    expect(byId.get("n0")).toBe(true);
    expect(byId.get("n1")).toBe(true);
    expect(byId.get("n2")).toBe(false);
    expect(byId.get("n3")).toBe(false);
    expect(plan.uncached).toEqual(["n2", "n3"]);
  });

  it("still stops the backward walk at a cached pure node", () => {
    // The half that must not regress. Everything upstream of the feedback node
    // is a pure function of the document, so an unchanged prefix is still a
    // cache hit and still ends the walk — which is F-ST-01 and is most of the
    // work in a real stack.
    const cached = new Set<ContentHash>([
      prepared.hashes.get("n1") as ContentHash,
    ]);
    const plan = planRender(prepared, (hash) => cached.has(hash));
    expect(plan.seeded.map((seed) => seed.nodeId)).toEqual(["n1"]);
    // n0 is upstream of a satisfied node, so it does not run at all.
    expect(plan.steps.flatMap((step) =>
      step.kind === "gpu-batch" ? step.nodes.map((planned) => planned.node.id) : [step.node.node.id],
    )).toEqual(["n2", "n3"]);
  });

  it("refuses to treat an excluded node as satisfied even when its hash is resident", () => {
    // The failure this is really about. A hash left over from a render before
    // the feedback node existed — or from a sibling branch — would otherwise end
    // the backward walk at a node whose pixels depend on a history the hash
    // cannot see, and the frame would come back wrong with a cache *hit*
    // logged against it.
    const everything = (): boolean => true;
    const plan = planRender(prepared, everything);
    expect(plan.seeded.map((seed) => seed.nodeId)).toEqual(["n1"]);
    expect(
      plan.steps.flatMap((step) =>
        step.kind === "gpu-batch" ? step.nodes.map((planned) => planned.node.id) : [step.node.node.id],
      ),
    ).toEqual(["n2", "n3"]);
  });

  it("caches every node when the same stack has no feedback in it", () => {
    // The control. Swap the feedback node for an ordinary one and the identical
    // graph is fully cacheable, so the exclusion above is attributable to the
    // one declaration rather than to anything about the shape.
    const pure = prepareGraph(
      chain([
        { effect: "blur" },
        { effect: "invert" },
        { effect: "levels" },
        { effect: "levels" },
      ]),
      SOURCE_HASH,
      PALETTE,
      EFFECTS,
    );
    const plan = planRender(pure, () => true);
    expect(plan.uncached).toEqual([]);
    expect(plan.steps).toEqual([]);
    expect(plan.seeded.map((seed) => seed.nodeId)).toEqual(["n3"]);
  });
});
