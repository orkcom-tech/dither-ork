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
import { validateStack } from "../registry/stack";
import { DEFAULT_CLOCK, DEFAULT_PALETTE } from "../state/document";
import {
  NO_EXCLUDES,
  NO_LOCKS,
  SurpriseError,
  generateSurprise,
  rerollNodeParams,
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
    ...overrides,
  });
}

/** Every check the application runs before it will draw a document. */
function assertRenderable(document: DitherDocument, label: string): void {
  const stack = validateStack(registry, document.stack);
  expect(stack.issues.map((issue) => issue.message), label).toEqual([]);
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
        excludes: { animation: true },
        base: BASE,
        palette: PALETTE,
        // The build can animate. That is exactly the case that matters: with
        // `animate: false` the document has no bindings for a reason that has
        // nothing to do with what the user asked for.
        animate: true,
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
      excludes: { animation: true },
      base: animated,
      palette: PALETTE,
      animate: true,
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
      }).document;
      const off = generateSurprise({
        seed,
        registry,
        chaos: 1,
        locks: NO_LOCKS,
        excludes: { animation: true },
        base: BASE,
        palette: PALETTE,
        animate: true,
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
        excludes: { animation: true },
        base: animated,
        palette: PALETTE,
        animate: true,
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
