/**
 * The whole document, against the real catalogue.
 *
 * Two properties carry this file:
 *
 * - **A surprise is reproducible.** The same seed, the same build and the same
 *   inputs produce a byte-identical document. That is F-SM-02 and it is what
 *   makes a share link and a history entry mean anything.
 * - **A surprise is renderable.** Every document is put through `validateStack`
 *   and `validateParams` — the same two checks the application runs before it
 *   draws — so a generator that produced something the renderer refuses fails
 *   here rather than as an error banner over the last good picture.
 */

import { describe, expect, it } from "vitest";

import type { DitherDocument, Palette } from "../types/document";
import { DOCUMENT_SCHEMA_VERSION } from "../types/document";
import { planAnimation } from "../animation";
import { discoverEffects } from "../registry/discovery";
import { createEffectRegistry, type EffectRegistry } from "../registry/registry";
import { validateParams } from "../registry/params";
import { validateGraph } from "../registry/graph";
import { isLinearChain } from "../graph/edit";
import { DEFAULT_CLOCK, DEFAULT_PALETTE } from "../state/document";
import {
  NO_EXCLUDES,
  NO_LOCKS,
  SurpriseError,
  generateSurprise,
  rerollNodeParams,
  type SurpriseResult,
} from "./generate";
import { synthesizePalette } from "./palette";
import { seededPcg32 } from "./rng";
import { formatSeed, parseSeed } from "./seed";

const registry: EffectRegistry = createEffectRegistry(discoverEffects());

const PALETTE: Palette = synthesizePalette(seededPcg32(1n), "triad", "oklab");

const BASE: DitherDocument = {
  schema: DOCUMENT_SCHEMA_VERSION,
  source: { name: "photo.png", width: 1600, height: 1200 },
  stack: [],
  edges: [],
  output: null,
  palette: DEFAULT_PALETTE,
  clock: DEFAULT_CLOCK,
  bindings: [],
};

function surprise(seed: bigint, chaos = 0.5, overrides: Partial<Parameters<typeof generateSurprise>[0]> = {}) {
  return generateSurprise({
    seed,
    registry,
    chaos,
    locks: NO_LOCKS,
    excludes: NO_EXCLUDES,
    base: BASE,
    palette: PALETTE,
    animate: false,
    blankCanvas: false,
    ...overrides,
  });
}

/**
 * Every check the application runs before it will draw a document.
 *
 * `validateGraph` and not `validateStack`: the latter builds the chain a list
 * implies, and a document with a branch in it is not that chain — it would check
 * a graph nobody is going to render and miss the one that is.
 */
function assertRenderable(document: DitherDocument, label: string): void {
  const graph = validateGraph(registry, {
    nodes: document.stack,
    edges: document.edges,
    output: document.output,
  });
  expect(graph.issues.map((issue) => issue.message), label).toEqual([]);
  for (const node of document.stack) {
    const descriptor = registry.require(node.effect);
    const params = validateParams(descriptor, node.params);
    expect(
      params.issues.map((issue) => `${node.effect}.${issue.key}: ${issue.message}`),
      label,
    ).toEqual([]);
  }
  // The bindings, through the real animated path rather than a paraphrase of it.
  // A document that carries one nothing can resolve is not drawn by anybody: the
  // timeline drops the track and stops being the pump, and `state/session.ts`
  // leaves the preview to the timeline for as long as any binding exists, so the
  // previous picture stays on screen while the panel shows the new document.
  expect(() => planAnimation(document, registry), `${label}: bindings resolve`).not.toThrow();
}

describe("generateSurprise", () => {
  it("produces a renderable document across the seed and chaos space", () => {
    for (let i = 0; i < 300; i += 1) {
      const chaos = (i % 11) / 10;
      const result = surprise(BigInt(i) * 0x9e37_79b9_7f4a_7c15n + 1n, chaos);
      assertRenderable(result.document, `seed ${result.summary.seed} chaos ${chaos}`);
      expect(result.document.stack.length).toBeGreaterThan(0);
    }
  });

  it("is byte-identical for the same seed", () => {
    for (const seed of [0n, 1n, 0xfeed_face_dead_beefn, 0xffff_ffff_ffff_ffffn]) {
      const a = surprise(seed, 0.6);
      const b = surprise(seed, 0.6);
      expect(JSON.stringify(a.document)).toBe(JSON.stringify(b.document));
    }
  });

  it("produces a different document for a different seed", () => {
    const a = surprise(1n, 0.6);
    const b = surprise(2n, 0.6);
    expect(JSON.stringify(a.document)).not.toBe(JSON.stringify(b.document));
  });

  it("records the seed in the document, readable back (F-SM-02)", () => {
    const seed = 0x7f3a_1c92_b04e_5d68n;
    const result = surprise(seed);
    expect(result.document.surpriseSeed).toBe(formatSeed(seed));
    expect(parseSeed(result.document.surpriseSeed ?? "")).toBe(seed);
  });

  it("gives every node a distinct id in the form the store expects", () => {
    for (let i = 0; i < 60; i += 1) {
      const result = surprise(BigInt(i) * 31n + 7n, 1);
      const ids = result.document.stack.map((node) => node.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^n\d+$/);
    }
  });

  it("gives every node its own seed", () => {
    const result = surprise(5n, 1);
    const seeds = result.document.stack.map((node) => node.seed);
    expect(new Set(seeds).size).toBe(seeds.length);
    for (const seed of seeds) {
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffff_ffff);
    }
  });

  it("carries the source and clock across untouched", () => {
    const result = surprise(9n);
    expect(result.document.source).toEqual(BASE.source);
    expect(result.document.clock).toEqual(BASE.clock);
  });

  it("opens every node at the identity composite", () => {
    // Stated as a test because it is a deliberate omission rather than a
    // default: `graph/plan.ts` refuses a composite on a resampling node, so
    // randomising blend needs a per-node rule this generator does not have.
    for (let i = 0; i < 40; i += 1) {
      for (const node of surprise(BigInt(i), 1).document.stack) {
        expect(node.opacity).toBe(1);
        expect(node.blend).toBe("normal");
        expect(node.enabled).toBe(true);
      }
    }
  });

  it("takes the palette it was handed", () => {
    expect(surprise(3n).document.palette).toEqual(PALETTE);
  });

  it("refuses a chaos outside 0..1 rather than clamping it silently", () => {
    expect(() => surprise(1n, 1.5)).toThrow(SurpriseError);
    expect(() => surprise(1n, -0.1)).toThrow(SurpriseError);
    expect(() => surprise(1n, Number.NaN)).toThrow(SurpriseError);
  });
});

describe("locks (F-SM-06)", () => {
  const seeded = surprise(0xabcd_ef01_2345_6789n, 0.7).document;

  it("keeps a liked palette across fifty stack rerolls", () => {
    const liked: Palette = { ...PALETTE, id: "liked", name: "Liked" };
    const base: DitherDocument = { ...seeded, palette: liked };
    const stacks = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const result = generateSurprise({
        seed: BigInt(i) * 977n + 13n,
        registry,
        chaos: 0.8,
        locks: { ...NO_LOCKS, palette: true },
        excludes: NO_EXCLUDES,
        base,
        palette: synthesizePalette(seededPcg32(BigInt(i)), "mono", "srgb"),
        animate: false,
        blankCanvas: false,
      });
      expect(result.document.palette).toEqual(liked);
      stacks.add(result.document.stack.map((node) => node.effect).join(","));
    }
    // The point of the lock is that everything *else* moved.
    expect(stacks.size).toBeGreaterThan(10);
  });

  it("keeps the stack composition and its node ids", () => {
    const result = generateSurprise({
      seed: 4242n,
      registry,
      chaos: 0.9,
      locks: { ...NO_LOCKS, stack: true },
      excludes: NO_EXCLUDES,
      base: seeded,
      palette: PALETTE,
      animate: false,
      blankCanvas: false,
    });
    expect(result.document.stack.map((node) => node.effect)).toEqual(
      seeded.stack.map((node) => node.effect),
    );
    expect(result.document.stack.map((node) => node.id)).toEqual(
      seeded.stack.map((node) => node.id),
    );
    // Parameters are a separate lock, so they must have moved.
    expect(JSON.stringify(result.document.stack.map((node) => node.params))).not.toBe(
      JSON.stringify(seeded.stack.map((node) => node.params)),
    );
  });

  it("keeps parameters and seeds for the nodes that survive", () => {
    const result = generateSurprise({
      seed: 555n,
      registry,
      chaos: 0.9,
      locks: { ...NO_LOCKS, stack: true, params: true },
      excludes: NO_EXCLUDES,
      base: seeded,
      palette: PALETTE,
      animate: false,
      blankCanvas: false,
    });
    expect(result.document.stack).toEqual(seeded.stack);
  });

  /**
   * The interaction the file's header calls out: a fresh composition under a
   * parameter lock has nothing to keep, so its nodes take descriptor defaults.
   * Asserted rather than left to be discovered, because it is the one lock
   * combination whose behaviour is a decision rather than a consequence.
   */
  it("gives a freshly composed stack its descriptor defaults when parameters are locked", () => {
    const result = generateSurprise({
      seed: 77n,
      registry,
      chaos: 0.9,
      locks: { ...NO_LOCKS, params: true },
      excludes: NO_EXCLUDES,
      base: BASE,
      palette: PALETTE,
      animate: false,
      blankCanvas: false,
    });
    for (const node of result.document.stack) {
      const descriptor = registry.require(node.effect);
      for (const param of descriptor.params) {
        expect(JSON.stringify(node.params[param.key]), `${node.effect}.${param.key}`).toBe(
          JSON.stringify(param.default),
        );
      }
    }
    assertRenderable(result.document, "params locked, stack fresh");
  });

  /**
   * The reported bug: "with a lock set and a new generation the picture is still
   * the old one."
   *
   * Press surprise, lock animation, press surprise again. The second document
   * keeps the first one's bindings, and a reroll re-uses the node ids `n1..nN`
   * rather than minting new ones — so a binding kept on its id alone lands on
   * whatever effect the grammar put at that position, naming a parameter that
   * effect does not declare. Nothing then draws the document: `planAnimation`
   * refuses it, the timeline drops the track and hands the viewport back, and the
   * session leaves the preview to the timeline for as long as any binding
   * remains. The panel showed the new stack over the old picture.
   *
   * Fifty seed pairs rather than one, and the loop asserts it was not vacuous:
   * whether a reroll happens to re-use an id is a property of the grammar, and a
   * test that silently stopped exercising it would go on passing forever.
   */
  it("keeps the animation lock's bindings resolvable across a stack reroll", () => {
    let carried = 0;
    let rerolls = 0;

    for (let i = 0; i < 50; i += 1) {
      const first = generateSurprise({
        seed: BigInt(i) * 7919n + 5n,
        registry,
        chaos: 1,
        locks: NO_LOCKS,
        excludes: NO_EXCLUDES,
        base: BASE,
        palette: PALETTE,
        animate: true,
        blankCanvas: false,
      });
      if (first.document.bindings.length === 0) continue;

      const second = generateSurprise({
        seed: BigInt(i) * 104_729n + 11n,
        registry,
        chaos: 1,
        locks: { ...NO_LOCKS, animation: true },
        excludes: NO_EXCLUDES,
        base: first.document,
        palette: PALETTE,
        animate: true,
        blankCanvas: false,
      });
      rerolls += 1;
      carried += second.document.bindings.length;

      // Stated on the document itself as well as through the planner, so a
      // failure names the binding that cannot be honoured rather than only the
      // exception it caused.
      for (const binding of second.document.bindings) {
        const node = second.document.stack.find((entry) => entry.id === binding.nodeId);
        expect(node, `${binding.nodeId}.${binding.param} names a node that is in the stack`)
          .toBeDefined();
        const param = registry
          .require(node?.effect ?? "")
          .params.find((candidate) => candidate.key === binding.param);
        expect(
          param?.animatable,
          `${node?.effect ?? "?"}.${binding.param} is a parameter the registry will animate`,
        ).toBe(true);
      }

      assertRenderable(second.document, `seed pair ${i}, animation locked`);
    }

    expect(rerolls, "the loop found no surprise with a binding to carry").toBeGreaterThan(0);
    expect(carried, "no binding survived any reroll, so nothing was exercised").toBeGreaterThan(0);
  });

  it("all four locks together leave the document alone but for its recorded seed", () => {
    const result = generateSurprise({
      seed: 31337n,
      registry,
      chaos: 0.5,
      locks: { palette: true, stack: true, params: true, animation: true },
      excludes: NO_EXCLUDES,
      base: seeded,
      palette: PALETTE,
      animate: false,
      blankCanvas: false,
    });
    expect({ ...result.document, surpriseSeed: undefined }).toEqual({
      ...seeded,
      surpriseSeed: undefined,
    });
  });
});

/**
 * The off-switch.
 *
 * The reported complaint was that animation could not be turned off: the only
 * animation control in the panel was the lock, and a lock pins it **on**. An
 * exclude is the other question — do not make this at all — and for animation it
 * has to reach all the way to `bindings: []`, because that empty array is what
 * every downstream consumer reads as "nothing moves": `planAnimation` has nothing
 * to resolve, `ui/timeline/model.ts` adopts no tracks and stops a transport that
 * was running, and `state/session.ts` draws the still frame itself rather than
 * waiting on a timeline that is not pumping.
 */
describe("excludes", () => {
  const animated = generateSurprise({
    seed: 0x0bad_c0ff_ee0d_df00n,
    registry,
    chaos: 1,
    locks: NO_LOCKS,
    excludes: NO_EXCLUDES,
    base: BASE,
    palette: PALETTE,
    animate: true,
    blankCanvas: false,
  }).document;

  it("draws bindings when nothing is excluded, so the rest of this block is not vacuous", () => {
    expect(animated.bindings.length).toBeGreaterThan(0);
  });

  it("yields zero bindings on a build that can animate", () => {
    for (let i = 0; i < 60; i += 1) {
      const result = generateSurprise({
        seed: BigInt(i) * 0x9e37_79b9_7f4a_7c15n + 3n,
        registry,
        chaos: 1,
        locks: NO_LOCKS,
        excludes: { ...NO_EXCLUDES, animation: true },
        base: BASE,
        palette: PALETTE,
        // The build can animate. That is exactly the case that matters: with
        // `animate: false` the document has no bindings for a reason that has
        // nothing to do with what the user asked for.
        animate: true,
        blankCanvas: false,
      });
      expect(result.document.bindings, `seed ${result.summary.seed}`).toEqual([]);
      expect(result.summary.bindings).toBe(0);
      assertRenderable(result.document, `animation excluded, seed ${result.summary.seed}`);
    }
  });

  /**
   * The base document's bindings are not a special case: an exclude means the
   * document comes back without them, whatever it started with. This is the
   * reroll a person actually does — press surprise, get something moving, decide
   * they want it still.
   */
  it("drops the bindings the base document arrived with", () => {
    expect(animated.bindings.length).toBeGreaterThan(0);
    const result = generateSurprise({
      seed: 0x5555_aaaa_5555_aaaan,
      registry,
      chaos: 1,
      locks: { ...NO_LOCKS, stack: true, params: true, palette: true },
      excludes: { ...NO_EXCLUDES, animation: true },
      base: animated,
      palette: PALETTE,
      animate: true,
      blankCanvas: false,
    });
    expect(result.document.bindings).toEqual([]);
    // Everything else was kept, so the exclude is the only thing that acted.
    expect(result.document.stack).toEqual(animated.stack);
    expect(result.document.palette).toEqual(animated.palette);
  });

  /**
   * An exclude is a subtraction rather than a different draw.
   *
   * `sampleBindings` takes its numbers from streams named per node and per
   * parameter (`surprise/bind/<node>/<key>`) rather than from the sequence the
   * stack and the parameters are drawn from, so removing it cannot shift what
   * anything else got. Stated as a test because it is the property that makes
   * "off" mean what the panel says it means: the same seed gives the same
   * picture, standing still.
   */
  it("changes nothing but the bindings, for the same seed", () => {
    for (const seed of [1n, 0xfeed_face_dead_beefn, 0x7f3a_1c92_b04e_5d68n]) {
      const on = generateSurprise({
        seed,
        registry,
        chaos: 1,
        locks: NO_LOCKS,
        excludes: NO_EXCLUDES,
        base: BASE,
        palette: PALETTE,
        animate: true,
        blankCanvas: false,
      }).document;
      const off = generateSurprise({
        seed,
        registry,
        chaos: 1,
        locks: NO_LOCKS,
        excludes: { ...NO_EXCLUDES, animation: true },
        base: BASE,
        palette: PALETTE,
        animate: true,
        blankCanvas: false,
      }).document;

      expect(off.bindings).toEqual([]);
      expect(JSON.stringify({ ...off, bindings: [] })).toBe(
        JSON.stringify({ ...on, bindings: [] }),
      );
    }
  });

  /**
   * "Keep this" and "do not make this at all" are not a precedence puzzle, and
   * picking a winner would leave the panel and the document disagreeing about
   * what was asked for. The UI cannot produce this — one aspect carries one mode
   * — but this module is pure and public, so it checks rather than trusts.
   */
  it("refuses an aspect that is both locked and excluded", () => {
    expect(() =>
      generateSurprise({
        seed: 1n,
        registry,
        chaos: 0.5,
        locks: { ...NO_LOCKS, animation: true },
        excludes: { ...NO_EXCLUDES, animation: true },
        base: animated,
        palette: PALETTE,
        animate: true,
        blankCanvas: false,
      }),
    ).toThrow(SurpriseError);
  });
});

describe("what it refuses", () => {
  it("refuses a base document naming an effect this build does not have", () => {
    const foreign: DitherDocument = {
      ...BASE,
      stack: [
        {
          id: "n1",
          effect: "quantum-dither",
          enabled: true,
          opacity: 1,
          blend: "normal",
          params: {},
          seed: 1,
        },
      ],
    };
    expect(() =>
      generateSurprise({
        seed: 1n,
        registry,
        chaos: 0.5,
        locks: { ...NO_LOCKS, stack: true },
        excludes: NO_EXCLUDES,
        base: foreign,
        palette: PALETTE,
        animate: false,
        blankCanvas: false,
      }),
    ).toThrow(SurpriseError);
  });

  /**
   * A locked stack that the grammar would never build. The user has to be told,
   * because the alternative is a document that reaches the renderer and fails
   * there — or, worse, one this generator silently un-locks.
   */
  it("refuses a locked stack the registry rejects", () => {
    const illegal: DitherDocument = {
      ...BASE,
      stack: [
        {
          id: "n1",
          effect: "outline",
          enabled: true,
          opacity: 1,
          blend: "normal",
          params: {},
          seed: 1,
        },
      ],
    };
    expect(() =>
      generateSurprise({
        seed: 1n,
        registry,
        chaos: 0.5,
        locks: { ...NO_LOCKS, stack: true },
        excludes: NO_EXCLUDES,
        base: illegal,
        palette: PALETTE,
        animate: false,
        blankCanvas: false,
      }),
    ).toThrow(/registry rejects/);
  });
});

describe("rerollNodeParams (F-SM-08)", () => {
  const document = surprise(0x1234_5678_9abc_def0n, 0.7).document;
  const first = document.stack[0];

  it("changes one node and leaves every other alone", () => {
    expect(first).toBeDefined();
    if (first === undefined) return;
    const next = rerollNodeParams({
      document,
      registry,
      nodeId: first.id,
      seed: 99n,
      chaos: 0.7,
    });
    expect(next.stack).toHaveLength(document.stack.length);
    expect(next.stack[0]?.effect).toBe(first.effect);
    expect(JSON.stringify(next.stack.slice(1))).toBe(JSON.stringify(document.stack.slice(1)));
    assertRenderable(next, "after reroll");
  });

  it("lands on a different face each throw", () => {
    expect(first).toBeDefined();
    if (first === undefined) return;
    const seen = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const next = rerollNodeParams({
        document,
        registry,
        nodeId: first.id,
        seed: BigInt(i) * 7919n + 1n,
        chaos: 0.9,
      });
      seen.add(JSON.stringify(next.stack[0]));
    }
    expect(seen.size).toBeGreaterThan(15);
  });

  /**
   * The document is no longer the one the seed produces, so the seed goes.
   * Leaving it would make a share link reproduce something other than what the
   * sender is looking at.
   */
  it("drops the recorded seed, because the document is no longer that seed's", () => {
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(document.surpriseSeed).toBeDefined();
    const next = rerollNodeParams({
      document,
      registry,
      nodeId: first.id,
      seed: 5n,
      chaos: 0.5,
    });
    expect("surpriseSeed" in next).toBe(false);
  });

  it("refuses a node that is not in the stack", () => {
    expect(() =>
      rerollNodeParams({ document, registry, nodeId: "n99", seed: 1n, chaos: 0.5 }),
    ).toThrow(SurpriseError);
  });
});

/**
 * The generator prefix — which a reroll must not throw away **on a blank
 * canvas**, and must not weld on anywhere else.
 *
 * On a blank canvas the picture is made by a Noise or Gradient node, so a reroll
 * that dropped it would leave a black frame through the feature the owner uses
 * most. With a photograph open the same carry is a ratchet: one press in
 * twenty-five draws a generator at chaos 0, and from that press on every reroll
 * kept it, so the photograph never came back and the only exit was deleting the
 * node by hand. Both halves are tested here, because the defect was the second
 * half of a rule written only for the first.
 */
/**
 * The nodes on the chain of `in` edges that ends at the picture.
 *
 * Walked backwards from the output, because that is the chain the document's
 * picture is actually made of — a branch reaches the picture too, but through
 * some node's second input, which is a different question.
 */
function mainChainOf(document: DitherDocument): ReadonlySet<string> {
  const chain = new Set<string>();
  let at = document.output;
  while (at !== null && !chain.has(at)) {
    chain.add(at);
    at = document.edges.find((edge) => edge.to === at && edge.port === "in")?.from ?? null;
  }
  return chain;
}

describe("a stack that begins with a generator", () => {
  const GENERATOR = "gen-noise";

  function withGenerator(nodeId: string): DitherDocument {
    return {
      ...BASE,
      source: { name: "Blank 1024×1024", width: 1024, height: 1024 },
      stack: [
        {
          id: nodeId,
          effect: GENERATOR,
          enabled: true,
          opacity: 1,
          blend: "normal",
          params: {},
          seed: 1,
        },
      ],
    };
  }

  /** A reroll of that document with the canvas stated blank, as the app does. */
  function rerollOnBlank(seed: bigint, chaos: number, nodeId = "n1", overrides = {}) {
    return surprise(seed, chaos, {
      base: withGenerator(nodeId),
      blankCanvas: true,
      ...overrides,
    });
  }

  it("keeps the generator at the head of the rerolled stack", () => {
    const result = rerollOnBlank(0x9e3779b97f4a7c15n, 0.5);
    expect(result.document.stack[0]?.effect).toBe(GENERATOR);
    expect(result.document.stack[0]?.id).toBe("n1");
    // And the rest is a real reroll rather than the generator alone.
    expect(result.document.stack.length).toBeGreaterThan(1);
  });

  it("resamples the generator's own parameters, so the look still rerolls", () => {
    const a = rerollOnBlank(1n, 0.9);
    const b = rerollOnBlank(2n, 0.9);
    expect(a.document.stack[0]?.params).not.toEqual(b.document.stack[0]?.params);
  });

  it("mints unique ids when the generator's own id is in the composed range", () => {
    // Both id generators mint `n<k>`. A base document whose generator happens
    // to be `n2` would collide with the second composed node, and a stack with
    // two nodes of one id is one `analyseGraph` refuses as an ambiguous edge
    // target — correctly, and far from here.
    const result = rerollOnBlank(7n, 0.8, "n2");
    const ids = result.document.stack.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("n2");
  });

  it("does not keep a source node that is not at the head", () => {
    // A generator further down is a composite over the picture rather than the
    // thing making it, so it is rerolled away with everything else. The id is
    // one the minter never produces, so "it survived" is a fact about identity
    // rather than about which effect the grammar happened to draw.
    const base: DitherDocument = {
      ...BASE,
      stack: [
        { id: "n1", effect: "invert", enabled: true, opacity: 1, blend: "normal", params: {}, seed: 1 },
        { id: "kept", effect: GENERATOR, enabled: true, opacity: 0.5, blend: "normal", params: {}, seed: 2 },
      ],
    };
    const result = surprise(11n, 0.5, { base, blankCanvas: true });
    expect(result.document.stack.map((node) => node.id)).not.toContain("kept");
  });

  it("still produces a graph the registry accepts", () => {
    for (let seed = 1n; seed <= 40n; seed += 1n) {
      const result = rerollOnBlank(seed, 0.7);
      assertRenderable(result.document, `carried generator, seed ${seed}`);
    }
  });

  it("never draws a second generator on top of the carried one", () => {
    // The carry and the shape decision both want a source node at the head, and
    // two of them would be two pictures in a document that shows one. The shape
    // is told about the carry so the drawn one is suppressed.
    for (let seed = 1n; seed <= 200n; seed += 1n) {
      const result = rerollOnBlank(seed, 1);
      const sources = result.document.stack.filter(
        (node) => registry.require(node.effect).slot === "source",
      );
      // One on the chain that ends at the picture, plus at most one rooting a
      // mask branch — a different picture for a different port, not a second
      // head.
      expect(sources[0]?.id).toBe("n1");
      const onChain = sources.filter((node) => mainChainOf(result.document).has(node.id));
      expect(onChain.map((node) => node.id)).toEqual(["n1"]);
    }
  });

  /**
   * The ratchet, which is what the carry actually did to the owner.
   *
   * A photograph is open. One press draws a generator; every press after it kept
   * that generator at the head — measured at 29 of 29 in the running app, at
   * every chaos including 0, where the panel promises a plain chain over your
   * image. The photograph never came back.
   */
  it("does not keep it when the canvas holds a photograph", () => {
    for (const chaos of [0, 0.5, 1]) {
      const survived: string[] = [];
      for (let seed = 1n; seed <= 60n; seed += 1n) {
        // `blankCanvas` false: the same base document, the same generator at its
        // head, and a picture underneath it. The id is one the minter never
        // produces, so a node carrying it is the base document's own node and
        // not a fresh draw that happens to be the same effect.
        const result = surprise(seed, chaos, { base: withGenerator("kept") });
        if (result.document.stack.some((node) => node.id === "kept")) {
          survived.push(result.summary.seed);
        }
      }
      expect(survived, `chaos ${chaos}: the generator was carried anyway`).toEqual([]);
    }
  });

  it("brings the photograph back on the very next press", () => {
    // The end-to-end statement of the same thing: reroll the generated document
    // sixty times against a photograph and count how many still open with a
    // source node. Only the ones the shape genuinely drew, which at chaos 0 is
    // a few in a hundred rather than all of them.
    let generated = 0;
    for (let seed = 1n; seed <= 60n; seed += 1n) {
      const result = surprise(seed, 0, { base: withGenerator("n1") });
      if (registry.require(result.document.stack[0]?.effect ?? "").slot === "source") {
        generated += 1;
      }
    }
    expect(generated).toBeLessThan(10);
  });

  it("clears it when graph shape is off, on a blank canvas too", () => {
    // "Off" says make no shape at all, and a carried node welded to the head is
    // one. The frame is still not black: `decideShape` forces a generator on a
    // blank canvas whatever the exclude says, so one is *drawn* rather than kept.
    for (let seed = 1n; seed <= 40n; seed += 1n) {
      const result = rerollOnBlank(seed, 1, "kept", {
        excludes: { ...NO_EXCLUDES, shape: true },
      });
      // A generator, so the canvas is not black.
      expect(registry.require(result.document.stack[0]?.effect ?? "").slot).toBe("source");
      // Freshly drawn, not the base document's node.
      expect(result.document.stack.map((node) => node.id)).not.toContain("kept");
      assertRenderable(result.document, `blank, shape off, seed ${seed}`);
    }
  });
});

/**
 * The graph shapes, at the level of a whole document.
 *
 * `grammar.test.ts` checks the composition; this checks the three things only a
 * document can be wrong about — that the edges and the node list agree, that the
 * mask and the edge carrying its picture arrive together, and that what the
 * summary says about looping is what `animation/plan.ts` will say when the
 * export asks.
 */
describe("graphs (step 4 of docs/dither-ork-node-graph.md)", () => {
  /** Documents across the chaos range, so every shape is reached. */
  function sample(count: number, chaos: number): SurpriseResult[] {
    const out: SurpriseResult[] = [];
    for (let i = 0; i < count; i += 1) {
      out.push(surprise(BigInt(i) * 0x2545_f491_4f6c_dd1dn + 7n, chaos));
    }
    return out;
  }

  it("produces branches, generators and feedback across the chaos range", () => {
    const wild = sample(400, 1);
    expect(wild.filter((run) => run.summary.branch > 0).length).toBeGreaterThan(40);
    expect(wild.filter((run) => !run.summary.loops).length).toBeGreaterThan(40);
    expect(
      wild.filter((run) => registry.require(run.document.stack[0]?.effect ?? "").slot === "source")
        .length,
    ).toBeGreaterThan(20);
  });

  it("is nearly always a chain at the tame end", () => {
    const tame = sample(400, 0);
    const graphs = tame.filter((run) => run.summary.branch > 0).length;
    expect(graphs / tame.length).toBeLessThan(0.1);
    // And every one of them loops, which is what makes the tame end safe to
    // export.
    expect(tame.every((run) => run.summary.loops)).toBe(true);
  });

  it("agrees with the animation planner about whether the document loops", () => {
    // Two modules decide this from two different things — the summary from the
    // shape, the plan from the nodes that ended up in the document — and a
    // disagreement is a panel that promises a loop the encoder will not deliver.
    for (const run of sample(200, 1)) {
      expect(planAnimation(run.document, registry).loops, run.summary.seed).toBe(
        run.summary.loops,
      );
    }
  });

  it("wires every image mask to a picture, and every mask edge to a mask", () => {
    for (const run of sample(300, 0.9)) {
      const { document } = run;
      const maskEdges = document.edges.filter((edge) => edge.port === "mask");
      const masked = document.stack.filter(
        (node) => node.mask !== undefined && node.mask.source.kind === "image",
      );
      expect(maskEdges.length).toBe(masked.length);
      for (const node of masked) {
        expect(maskEdges.some((edge) => edge.to === node.id)).toBe(true);
        // A mask is a composite, and a resampling node has no common pixel grid
        // with its own input for coverage to be of. `graph/ports.ts` gives such
        // a node no mask port at all.
        expect(registry.require(node.effect).resamples ?? false).toBe(false);
      }
      // Every node with no mask carries no `mask` key at all — not `undefined`,
      // which is different bytes to `JSON.stringify` and would make two
      // identical documents hash differently.
      for (const node of document.stack) {
        if (masked.includes(node)) continue;
        expect(Object.prototype.hasOwnProperty.call(node, "mask")).toBe(false);
      }
    }
  });

  it("names an output that is in the document, and reaches every node from it", () => {
    for (const run of sample(200, 1)) {
      const { document } = run;
      expect(document.stack.some((node) => node.id === document.output)).toBe(true);
      // Nothing detached: every node reaches the picture, through `in` edges or
      // through a mask port. A node whose work reaches nothing is a row in the
      // panel that does nothing.
      const reaching = new Set<string>([document.output ?? ""]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const edge of document.edges) {
          if (reaching.has(edge.to) && !reaching.has(edge.from)) {
            reaching.add(edge.from);
            grew = true;
          }
        }
      }
      expect([...document.stack].map((node) => node.id).filter((id) => !reaching.has(id))).toEqual(
        [],
      );
    }
  });

  it("reproduces a graph document byte for byte from its seed", () => {
    // The masks and the edges are part of what a seed means now, so the
    // reproducibility guarantee (F-SM-02) is re-checked on documents that
    // actually have them.
    const branched = sample(200, 1).filter((run) => run.summary.branch > 0);
    expect(branched.length).toBeGreaterThan(10);
    for (const run of branched) {
      const seed = parseSeed(run.summary.seed);
      expect(seed, run.summary.seed).not.toBeNull();
      const again = surprise(seed ?? 0n, 1);
      expect(JSON.stringify(again.document)).toBe(JSON.stringify(run.document));
    }
  });

  describe("a blank canvas", () => {
    // `io/source.ts`'s blank canvas is transparent black, so a document with no
    // generator in it renders nothing at all. This is the honest form of "a
    // surprise with no image open" this build can hold: the document schema
    // carries no extent of its own, so there is no such thing as a document
    // with no source — there is a stated empty canvas, and this is it.
    function onBlank(seed: bigint, chaos: number, overrides = {}): SurpriseResult {
      return surprise(seed, chaos, { blankCanvas: true, ...overrides });
    }

    it("always puts a generator at the head, at every chaos setting", () => {
      for (const chaos of [0, 0.5, 1]) {
        for (let i = 0; i < 60; i += 1) {
          const run = onBlank(BigInt(i) * 17n + 5n, chaos);
          const first = run.document.stack[0];
          expect(registry.require(first?.effect ?? "").slot, `chaos ${chaos}`).toBe("source");
          assertRenderable(run.document, `blank ${run.summary.seed}`);
        }
      }
    });

    it("puts one there even with graph shape off", () => {
      for (let i = 0; i < 40; i += 1) {
        const run = onBlank(BigInt(i) * 7n + 1n, 1, {
          excludes: { ...NO_EXCLUDES, shape: true },
        });
        expect(registry.require(run.document.stack[0]?.effect ?? "").slot).toBe("source");
        expect(run.summary.loops).toBe(true);
        expect(run.summary.branch).toBe(0);
      }
    });

    it("does not put one there when the source is a photograph", () => {
      // The flag is what does it, not the chaos setting: the same seeds against
      // an image are mostly plain chains.
      let generated = 0;
      for (let i = 0; i < 60; i += 1) {
        const run = surprise(BigInt(i) * 17n + 5n, 0);
        if (registry.require(run.document.stack[0]?.effect ?? "").slot === "source") {
          generated += 1;
        }
      }
      expect(generated).toBeLessThan(10);
    });
  });

  describe("graph shape set to off", () => {
    function chainOnly(seed: bigint, chaos: number): SurpriseResult {
      return surprise(seed, chaos, { excludes: { ...NO_EXCLUDES, shape: true } });
    }

    it("gives a plain chain that loops, at every chaos setting", () => {
      for (const chaos of [0, 0.5, 1]) {
        for (let i = 0; i < 120; i += 1) {
          const run = chainOnly(BigInt(i) * 13n + 3n, chaos);
          expect(run.summary.loops, run.summary.seed).toBe(true);
          expect(run.summary.branch).toBe(0);
          expect(run.document.edges.every((edge) => edge.port === "in")).toBe(true);
          expect(run.document.stack.every((node) => node.mask === undefined)).toBe(true);
          expect(
            run.document.stack.every(
              (node) => registry.require(node.effect).readsFeedback !== true,
            ),
          ).toBe(true);
          expect(isLinearChain(run.document)).toBe(true);
          assertRenderable(run.document, `chain-only ${run.summary.seed}`);
        }
      }
    });

    it("drops a generator the base document already had", () => {
      // "A plain chain over your image" is the sentence the panel prints, and a
      // source node at the head replaces that image outright. It is dropped
      // whether it was drawn last press or carried, which is the difference
      // between the sentence being true and being nearly true.
      const base: DitherDocument = {
        ...BASE,
        stack: [
          {
            id: "n1",
            effect: "gen-noise",
            enabled: true,
            opacity: 1,
            blend: "normal",
            params: {},
            seed: 1,
          },
        ],
      };
      for (let seed = 1n; seed <= 40n; seed += 1n) {
        const run = surprise(seed, 1, { base, excludes: { ...NO_EXCLUDES, shape: true } });
        expect(
          registry.require(run.document.stack[0]?.effect ?? "").slot,
          run.summary.seed,
        ).not.toBe("source");
        expect(run.summary.loops).toBe(true);
      }
    });
  });

  describe("a locked stack keeps its wiring", () => {
    /** A graph document with a branch in it, made by the generator itself. */
    function branchedDocument(): DitherDocument {
      for (let i = 0; i < 400; i += 1) {
        const run = surprise(BigInt(i) * 0x2545_f491_4f6c_dd1dn + 7n, 1);
        if (run.summary.branch > 0) return run.document;
      }
      throw new Error("no branched document was generated; the sample is not exercising branches");
    }

    it("carries the edges, the output and the masks across a reroll", () => {
      const base = branchedDocument();
      const run = surprise(0xabc_defn, 0.8, {
        base,
        locks: { ...NO_LOCKS, stack: true },
      });
      expect(run.document.edges).toEqual(base.edges);
      expect(run.document.output).toBe(base.output);
      expect(run.document.stack.map((node) => node.mask)).toEqual(
        base.stack.map((node) => node.mask),
      );
      // And the parameters really did reroll, so this is a lock rather than a
      // no-op.
      expect(run.document.stack.map((node) => node.params)).not.toEqual(
        base.stack.map((node) => node.params),
      );
      assertRenderable(run.document, "locked graph");
    });

    it("reports the shape the kept document actually has", () => {
      const base = branchedDocument();
      const run = surprise(1n, 0.8, { base, locks: { ...NO_LOCKS, stack: true } });
      expect(run.summary.branch === 0).toBe(true);
      expect(run.summary.shape).toContain("masked branch");
    });

    it("refuses to keep a graph and leave graph shape out at the same time", () => {
      const base = branchedDocument();
      expect(() =>
        surprise(1n, 0.8, {
          base,
          locks: { ...NO_LOCKS, stack: true },
          excludes: { ...NO_EXCLUDES, shape: true },
        }),
      ).toThrow(SurpriseError);
    });

    it("allows the two together when the kept stack is a plain chain", () => {
      const chain = surprise(3n, 0, { excludes: { ...NO_EXCLUDES, shape: true } }).document;
      const run = surprise(4n, 0.5, {
        base: chain,
        locks: { ...NO_LOCKS, stack: true },
        excludes: { ...NO_EXCLUDES, shape: true },
      });
      expect(run.summary.loops).toBe(true);
      assertRenderable(run.document, "kept chain with shape off");
    });
  });
});
