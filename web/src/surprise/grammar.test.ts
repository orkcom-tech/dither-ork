/**
 * The graph grammar, against the real catalogue.
 *
 * These run over the seventy-one descriptors actually in `web/src/effects/`,
 * discovered by the same glob the application uses, because the property that
 * matters is not "the grammar is internally consistent" — it is **"the grammar
 * cannot produce a graph this build refuses to render"**, and only the shipped
 * descriptors can establish that.
 *
 * The headline test draws a thousand graphs across the chaos range and across
 * every shape, and puts every one through `validateGraph`. That is deliberately
 * the same check the grammar runs on itself: here it is a test of the grammar,
 * there it is a tripwire in production, and having both is what makes the
 * tripwire something that has never fired rather than something nobody has
 * looked at.
 */

import { describe, expect, it } from "vitest";

import type { GraphEdge } from "../types/document";
import { MASK_INPUT_PORT, PRIMARY_INPUT_PORT } from "../types/registry";
import { portsOf } from "../graph/ports";
import { discoverEffects } from "../registry/discovery";
import { createEffectRegistry, type EffectRegistry } from "../registry/registry";
import { validateGraph, type GraphRef } from "../registry/graph";
import {
  CHAOS,
  GrammarError,
  composeGraph,
  edgesOf,
  lerp,
  type ComposedGraph,
} from "./grammar";
import { PLAIN_CHAIN, decideShape, type GraphShape } from "./shape";
import { seededPcg32, streamFor } from "./rng";

const registry: EffectRegistry = createEffectRegistry(discoverEffects());

/** Every shape the grammar can be asked for, so no test only exercises chains. */
const EVERY_SHAPE: readonly GraphShape[] = [
  PLAIN_CHAIN,
  { generator: true, newGenerator: true, feedback: false, branch: false },
  { generator: false, newGenerator: false, feedback: true, branch: false },
  { generator: false, newGenerator: false, feedback: false, branch: true },
  { generator: true, newGenerator: true, feedback: true, branch: true },
];

function shapeAt(i: number): GraphShape {
  return EVERY_SHAPE[i % EVERY_SHAPE.length] ?? PLAIN_CHAIN;
}

function ids(composed: ComposedGraph): readonly string[] {
  return composed.nodes.map((_node, index) => `n${index + 1}`);
}

/** The composition as the document the application would validate. */
function documentOf(composed: ComposedGraph): GraphRef {
  const list = ids(composed);
  return {
    nodes: composed.nodes.map((node, index) => ({
      id: list[index] ?? `n${index + 1}`,
      effect: node.effect,
      enabled: true,
      ...(composed.maskAt === index && composed.mask !== null ? { mask: composed.mask } : {}),
    })),
    edges: edgesOf(composed, list),
    output: list[composed.outputIndex] ?? "",
  };
}

function compose(seed: bigint, chaos: number, shape: GraphShape): ComposedGraph {
  return composeGraph(streamFor(seed, "surprise/stack"), { registry, chaos, shape });
}

/** The main chain: everything up to and including the output node. */
function mainOf(composed: ComposedGraph): readonly string[] {
  return composed.nodes.slice(0, composed.outputIndex + 1).map((node) => node.effect);
}

describe("composeGraph against the shipped catalogue", () => {
  it("never produces a graph the registry rejects", () => {
    let longest = 0;
    let indexConsumers = 0;
    let branches = 0;
    for (let i = 0; i < 1_000; i += 1) {
      const chaos = (i % 11) / 10;
      const composed = compose(BigInt(i), chaos, shapeAt(i));
      const verdict = validateGraph(registry, documentOf(composed));
      expect(verdict.issues.map((issue) => issue.message)).toEqual([]);
      expect(verdict.ok).toBe(true);
      longest = Math.max(longest, composed.nodes.length);
      if (composed.shape.branch) branches += 1;
      indexConsumers += composed.nodes.filter(
        (node) => registry.get(node.effect)?.requiresIndexMap === true,
      ).length;
    }
    // The run has to have actually reached the interesting shapes, or it proves
    // only that short chains are legal.
    expect(longest).toBeGreaterThanOrEqual(6);
    expect(indexConsumers).toBeGreaterThan(0);
    expect(branches).toBeGreaterThan(0);
  });

  it("puts exactly one dither on the main chain, in the middle", () => {
    for (let i = 0; i < 400; i += 1) {
      const composed = compose(BigInt(i), 0.7, shapeAt(i));
      const parts = composed.nodes.map((node) => node.part);
      expect(parts.filter((part) => part === "dither")).toHaveLength(1);
      expect(parts.filter((part) => part === "generator").length).toBeLessThanOrEqual(1);
      expect(parts.filter((part) => part === "feedback").length).toBeLessThanOrEqual(1);

      const dither = parts.indexOf("dither");
      // Before the dither: the optional generator, then preprocessing. After it:
      // postprocessing and at most one feedback node. The branch is last.
      expect(
        parts.slice(0, dither).every((part) => part === "generator" || part === "preprocess"),
      ).toBe(true);
      expect(
        parts
          .slice(dither + 1, composed.outputIndex + 1)
          .every((part) => part === "postprocess" || part === "feedback"),
      ).toBe(true);
      expect(parts.slice(composed.outputIndex + 1).every((part) => part === "branch")).toBe(
        true,
      );
      expect(composed.nodes[dither]?.effect).toBe(composed.dither);
    }
  });

  it("never repeats an effect anywhere in the graph, branch included", () => {
    for (let i = 0; i < 400; i += 1) {
      const composed = compose(BigInt(i), 1, shapeAt(i));
      const effects = composed.nodes.map((node) => node.effect);
      expect(new Set(effects).size).toBe(effects.length);
    }
  });

  /**
   * The rule this file exists for. CMYK halftone is the one dither-slot node
   * that emits no index map — its colours are ink overprints rather than palette
   * entries — so outline, dilate/erode and nearest upscale must never appear
   * behind it. Excluded by the pool, not filtered afterwards.
   */
  it("never puts an index-map consumer behind a dither that emits no map", () => {
    let sawMaplessDither = 0;
    for (let i = 0; i < 2_000; i += 1) {
      const composed = compose(BigInt(i) * 7n + 1n, 1, shapeAt(i));
      const dither = registry.require(composed.dither);
      if (dither.producesIndexMap) continue;
      sawMaplessDither += 1;
      expect(composed.indexMapLive).toBe(false);
      for (const node of composed.nodes) {
        expect(registry.require(node.effect).requiresIndexMap).toBe(false);
      }
    }
    // If the catalogue's one map-less dither never came up, this test asserted
    // nothing at all.
    expect(sawMaplessDither).toBeGreaterThan(0);
  });

  /**
   * The extent rule, in its original form. A node that resamples while an index
   * map is live must produce the map it leaves behind — palette indices are
   * names, not quantities, so no filter means anything applied to them.
   */
  it("never resamples over a live index map without carrying it", () => {
    for (let i = 0; i < 1_000; i += 1) {
      const composed = compose(BigInt(i) * 13n, 1, shapeAt(i));
      let live = false;
      for (const effect of mainOf(composed)) {
        const descriptor = registry.require(effect);
        if (descriptor.resamples === true && live) {
          expect(descriptor.producesIndexMap).toBe(true);
        }
        if (descriptor.slot === "dither") live = descriptor.producesIndexMap;
        else live = live || descriptor.producesIndexMap;
      }
    }
  });

  it("reproduces the same graph from the same seed", () => {
    for (const seed of [0n, 1n, 0xdead_beefn, 0xffff_ffff_ffff_ffffn]) {
      const shape = decideShape(streamFor(seed, "surprise/shape"), {
        chaos: 0.5,
        graph: true,
        carriedGenerator: false,
        blankCanvas: false,
      });
      const a = compose(seed, 0.5, shape);
      const b = compose(seed, 0.5, shape);
      expect(a.nodes).toEqual(b.nodes);
      expect(a.edges).toEqual(b.edges);
      expect(a.mask).toEqual(b.mask);
    }
  });
});

/**
 * The shapes beyond a chain, and the rules that keep each of them renderable.
 *
 * Every one of these is a rule stated in `shape.ts`'s header, checked against
 * what the grammar actually emits rather than against what it intends.
 */
describe("the shapes a graph may be", () => {
  const BRANCHED: GraphShape = {
    generator: false,
    newGenerator: false,
    feedback: false,
    branch: true,
  };

  function branched(): ComposedGraph[] {
    const found: ComposedGraph[] = [];
    for (let i = 0; i < 600; i += 1) {
      const composed = compose(BigInt(i) * 3n + 11n, 0.8, BRANCHED);
      if (composed.shape.branch) found.push(composed);
    }
    return found;
  }

  it("wires the branch into exactly one mask port, and nothing else", () => {
    const graphs = branched();
    expect(graphs.length).toBeGreaterThan(100);
    for (const composed of graphs) {
      const maskEdges = composed.edges.filter((edge) => edge.port === MASK_INPUT_PORT);
      expect(maskEdges).toHaveLength(1);
      const edge = maskEdges[0];
      expect(edge?.to).toBe(composed.maskAt);
      // The mask edge comes out of the last branch node, and the branch is the
      // tail of the node list.
      expect(edge?.from).toBe(composed.nodes.length - 1);
      expect(composed.mask?.source.kind).toBe("image");
      // Alpha is deliberately never drawn: every picture this grammar can put in
      // a branch is opaque, so alpha coverage would be 1 everywhere.
      expect(composed.mask?.source).not.toMatchObject({ channel: "alpha" });
    }
  });

  it("roots every branch in a generator, and never masks a preprocess node", () => {
    // Both rules came out of looking at renders: a branch rooted at the picture
    // reproduces what the built-in luminance mask already does, and a mask on a
    // node upstream of the dither is erased by the quantization after it. Both
    // showed up as pairs that rendered identical to the same seed with no branch.
    for (const composed of branched()) {
      const root = composed.nodes[composed.outputIndex + 1];
      expect(registry.require(root?.effect ?? "").slot).toBe("source");
      expect(composed.nodes[composed.maskAt ?? -1]?.part).not.toBe("preprocess");
    }
  });

  /**
   * The third rule read off pictures, and the one the second review bought.
   *
   * "A generator" was not enough. A mask multiplies the masked node's opacity per
   * pixel, so coverage that varies at the scale of a pixel blends that node's
   * output with its own input everywhere at once — and the average of two similar
   * pictures is the picture. Measured over ninety-six documents at chaos 0.8, a
   * branch rooted in the noise field moved the picture by a median 0.017 mean
   * absolute RGB with six of thirteen under 0.01, against 0.145 for the shape
   * generator and 0.045 for the gradient.
   *
   * So the pool is narrowed by a *declaration* — `EffectDescriptor.coverage`, which
   * the registry validator requires of every source-slot effect — and not by a
   * list of effect ids in this module that a fourth generator would fall out of.
   */
  it("roots every branch in a generator whose picture has large-scale structure", () => {
    const graphs = branched();
    expect(graphs.length).toBeGreaterThan(100);
    const roots = new Set<string>();
    for (const composed of graphs) {
      const root = registry.require(composed.nodes[composed.outputIndex + 1]?.effect ?? "");
      expect(root.coverage, `${root.id} rooted a branch`).toBe("large-scale");
      roots.add(root.id);
    }
    // Not vacuous: the catalogue really does hold a generator this excludes, and
    // it really is drawable as the *head of a chain*, which this rule leaves
    // alone. A noise field is one of the best things here to dither; it is only a
    // poor mask.
    const fine = registry
      .bySlot("source")
      .filter((descriptor) => descriptor.coverage === "fine");
    expect(fine.length).toBeGreaterThan(0);
    for (const descriptor of fine) expect(roots).not.toContain(descriptor.id);
  });

  it("keeps the branch short and free of dithers and resamplers", () => {
    for (const composed of branched()) {
      expect(composed.branch).toBeGreaterThanOrEqual(1);
      // One root plus the ceiling. `branchCeiling` is the number of nodes
      // *beyond* the root.
      expect(composed.branch).toBeLessThanOrEqual(1 + CHAOS.branchCeiling[1]);
      for (let i = composed.outputIndex + 1; i < composed.nodes.length; i += 1) {
        const descriptor = registry.require(composed.nodes[i]?.effect ?? "");
        expect(descriptor.slot === "source" || descriptor.slot === "preprocess").toBe(true);
        expect(descriptor.resamples ?? false).toBe(false);
        expect(descriptor.requiresIndexMap).toBe(false);
      }
    }
  });

  /**
   * The extent rule in its *graph* form, and the one that would be invisible
   * until somebody looked at a picture.
   *
   * `_composite.wgsl` reads the mask with `textureLoad` at the masked node's own
   * coordinates, so a resampler between the two roots and the masked node puts
   * coverage on the wrong pixels — or, where the mask is the smaller of the two,
   * on none at all. Nothing in `validateGraph` catches it, which is exactly why
   * it is checked here.
   */
  it("never masks a node that sits downstream of a resampler", () => {
    for (const composed of branched()) {
      const maskAt = composed.maskAt ?? -1;
      expect(maskAt).toBeGreaterThanOrEqual(0);
      for (let i = 0; i <= maskAt; i += 1) {
        const descriptor = registry.require(composed.nodes[i]?.effect ?? "");
        expect(descriptor.resamples ?? false).toBe(false);
      }
      // And the node it masks actually has a mask port to wire into.
      const masked = registry.require(composed.nodes[maskAt]?.effect ?? "");
      expect(portsOf(masked).some((port) => port.key === MASK_INPUT_PORT)).toBe(true);
    }
  });

  it("puts feedback on the main chain after the dither, and never more than one", () => {
    const shape: GraphShape = {
      generator: false,
      newGenerator: false,
      feedback: true,
      branch: true,
    };
    let seen = 0;
    for (let i = 0; i < 400; i += 1) {
      const composed = compose(BigInt(i) * 5n + 2n, 0.9, shape);
      const feedbackNodes = composed.nodes.filter(
        (node) => registry.require(node.effect).readsFeedback === true,
      );
      expect(feedbackNodes.length).toBeLessThanOrEqual(1);
      if (feedbackNodes.length === 0) continue;
      seen += 1;
      const at = composed.nodes.findIndex(
        (node) => registry.require(node.effect).readsFeedback === true,
      );
      const dither = composed.nodes.findIndex((node) => node.part === "dither");
      expect(at).toBeGreaterThan(dither);
      expect(at).toBeLessThanOrEqual(composed.outputIndex);
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("never emits a feedback node when the shape did not ask for one", () => {
    // The whole point of making feedback a shape decision rather than a lucky
    // postprocess draw: "no trails" has to be obeyed, not merely unlikely.
    for (let i = 0; i < 1_500; i += 1) {
      const composed = compose(BigInt(i) * 29n + 7n, 1, {
        generator: true,
        newGenerator: true,
        feedback: false,
        branch: true,
      });
      for (const node of composed.nodes) {
        expect(registry.require(node.effect).readsFeedback ?? false).toBe(false);
      }
      expect(composed.shape.feedback).toBe(false);
    }
  });

  it("heads the chain with the generator when one was asked for", () => {
    let generated = 0;
    for (let i = 0; i < 200; i += 1) {
      const composed = compose(BigInt(i) * 11n + 4n, 0.5, {
        generator: true,
        newGenerator: true,
        feedback: false,
        branch: false,
      });
      if (!composed.shape.newGenerator) continue;
      generated += 1;
      expect(registry.require(composed.nodes[0]?.effect ?? "").slot).toBe("source");
      expect(composed.nodes[0]?.part).toBe("generator");
    }
    expect(generated).toBe(200);
  });

  it("makes a plain chain a plain chain", () => {
    for (let i = 0; i < 300; i += 1) {
      const composed = compose(BigInt(i), 1, PLAIN_CHAIN);
      expect(composed.maskAt).toBeNull();
      expect(composed.branch).toBe(0);
      expect(composed.outputIndex).toBe(composed.nodes.length - 1);
      expect(composed.edges.every((edge) => edge.port === PRIMARY_INPUT_PORT)).toBe(true);
      for (let j = 1; j < composed.nodes.length; j += 1) {
        expect(composed.edges).toContainEqual({
          from: j - 1,
          to: j,
          port: PRIMARY_INPUT_PORT,
        });
      }
    }
  });
});

describe("chaos (F-SM-07)", () => {
  function meanLength(chaos: number): number {
    let total = 0;
    const runs = 600;
    for (let i = 0; i < runs; i += 1) {
      total += compose(BigInt(i) * 31n + 5n, chaos, PLAIN_CHAIN).nodes.length;
    }
    return total / runs;
  }

  it("makes stacks longer as it rises", () => {
    const tame = meanLength(0);
    const wild = meanLength(1);
    expect(wild).toBeGreaterThan(tame + 1.5);
  });

  it("makes glitch nodes more likely as it rises", () => {
    function glitchShare(chaos: number): number {
      let glitch = 0;
      let total = 0;
      for (let i = 0; i < 800; i += 1) {
        const composed = compose(BigInt(i) * 17n + 3n, chaos, PLAIN_CHAIN);
        for (const node of composed.nodes) {
          total += 1;
          if (registry.require(node.effect).family === "glitch") glitch += 1;
        }
      }
      return glitch / total;
    }
    expect(glitchShare(1)).toBeGreaterThan(glitchShare(0) * 1.5);
  });

  it("still reaches a bare dither at the wild end and a full stack at the tame end", () => {
    // Neither end is a corner: chaos moves the ceiling of a `0..=ceiling` draw,
    // so "no preprocessing at all" stays reachable everywhere and a longer stack
    // is possible even when tame.
    const lengths = new Set<number>();
    for (let i = 0; i < 400; i += 1) {
      lengths.add(compose(BigInt(i), 1, PLAIN_CHAIN).nodes.length);
    }
    expect(lengths.has(1)).toBe(true);
  });

  it("interpolates its stated ends", () => {
    expect(lerp(CHAOS.preprocessCeiling, 0)).toBe(CHAOS.preprocessCeiling[0]);
    expect(lerp(CHAOS.preprocessCeiling, 1)).toBe(CHAOS.preprocessCeiling[1]);
    // Out-of-range inputs are clamped rather than extrapolated: a chaos of 2
    // must not produce a ceiling nothing declared.
    expect(lerp(CHAOS.glitchWeight, 5)).toBe(CHAOS.glitchWeight[1]);
    expect(lerp(CHAOS.glitchWeight, -5)).toBe(CHAOS.glitchWeight[0]);
  });
});

describe("what it refuses", () => {
  it("refuses a catalogue with no dither rather than emitting a graph with none", () => {
    const ditherless = createEffectRegistry(
      discoverEffects().filter((entry) => entry.descriptor.slot !== "dither"),
    );
    expect(() =>
      composeGraph(seededPcg32(1n), { registry: ditherless, chaos: 0.5, shape: PLAIN_CHAIN }),
    ).toThrow(GrammarError);
  });

  /**
   * A branch the catalogue cannot supply is dropped, not retried around and not
   * emitted half-built. The shape that comes back says so, which is what lets
   * the summary report what the document *is* rather than what was asked for.
   */
  it("drops the branch rather than emitting one with no source of pictures", () => {
    const bare = createEffectRegistry(
      discoverEffects().filter(
        (entry) =>
          entry.descriptor.slot === "dither" || entry.descriptor.slot === "postprocess",
      ),
    );
    const composed = composeGraph(seededPcg32(3n), {
      registry: bare,
      chaos: 1,
      shape: { generator: false, newGenerator: false, feedback: false, branch: true },
    });
    expect(composed.shape.branch).toBe(false);
    expect(composed.maskAt).toBeNull();
    expect(validateGraph(bare, documentOf(composed)).ok).toBe(true);
  });
});

