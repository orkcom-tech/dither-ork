/**
 * Random animation (F-SM-09).
 *
 * The modulator core is not in this build and `state/render/graph.ts` refuses a
 * document that carries bindings, so nothing in the application calls
 * {@link sampleBindings} yet — the caller passes `animate: false` after probing
 * the real graph builder. This file is what makes that a switch to flip rather
 * than a feature to write: the generator is complete and the properties the spec
 * fixes are pinned, above all the one that decides whether an exported loop
 * closes.
 */

import { describe, expect, it } from "vitest";

import type { DitherDocument, StackNode } from "../types/document";
import { DOCUMENT_SCHEMA_VERSION } from "../types/document";
import { discoverEffects } from "../registry/discovery";
import { createEffectRegistry, type EffectRegistry } from "../registry/registry";
import { setBindings } from "../state/mutations";
import { DEFAULT_CLOCK, DEFAULT_PALETTE } from "../state/document";
import { MAX_BINDINGS, isBindable, retainBindings, sampleBindings } from "./animation";
import { NO_LOCKS, generateSurprise } from "./generate";
import { synthesizePalette } from "./palette";
import { seededPcg32 } from "./rng";

const registry: EffectRegistry = createEffectRegistry(discoverEffects());
const PALETTE = synthesizePalette(seededPcg32(1n), "analogous", "oklab");

const BASE: DitherDocument = {
  schema: DOCUMENT_SCHEMA_VERSION,
  source: null,
  stack: [],
  palette: DEFAULT_PALETTE,
  clock: DEFAULT_CLOCK,
  bindings: [],
};

function stackFor(seed: bigint, chaos = 0.8): readonly StackNode[] {
  return generateSurprise({
    seed,
    registry,
    chaos,
    locks: NO_LOCKS,
    base: BASE,
    palette: PALETTE,
    animate: false,
  }).document.stack;
}

describe("sampleBindings", () => {
  it("keeps cycles-per-loop a positive integer, so the loop closes (F-AN-03)", () => {
    for (let i = 0; i < 300; i += 1) {
      const stack = stackFor(BigInt(i) * 131n + 3n);
      for (const binding of sampleBindings({ seed: BigInt(i), stack, registry, chaos: 1 })) {
        expect(Number.isInteger(binding.cyclesPerLoop)).toBe(true);
        expect(binding.cyclesPerLoop).toBeGreaterThan(0);
      }
    }
  });

  /**
   * The stricter version of the check above: `setBindings` is what the document
   * store calls, and it throws on a non-integral `cyclesPerLoop` and on a
   * binding naming a node the stack does not have. Every generated set has to
   * survive it, because that is the door these go through in the application.
   */
  it("produces bindings the document store accepts", () => {
    for (let i = 0; i < 200; i += 1) {
      const stack = stackFor(BigInt(i) * 7n + 11n);
      const bindings = sampleBindings({ seed: BigInt(i), stack, registry, chaos: 1 });
      expect(() => setBindings({ ...BASE, stack }, bindings)).not.toThrow();
    }
  });

  it("only binds parameters the registry declares animatable", () => {
    for (let i = 0; i < 200; i += 1) {
      const stack = stackFor(BigInt(i) * 17n + 5n);
      for (const binding of sampleBindings({ seed: BigInt(i), stack, registry, chaos: 1 })) {
        const node = stack.find((entry) => entry.id === binding.nodeId);
        expect(node).toBeDefined();
        const param = registry
          .require(node?.effect ?? "")
          .params.find((entry) => entry.key === binding.param);
        expect(param, `${node?.effect ?? "?"}.${binding.param}`).toBeDefined();
        if (param === undefined) continue;
        expect(isBindable(param)).toBe(true);
        expect(param.animatable).toBe(true);
        expect(["float", "int"]).toContain(param.type);
      }
    }
  });

  it("never binds a seed, which is a name rather than a quantity", () => {
    for (let i = 0; i < 200; i += 1) {
      const stack = stackFor(BigInt(i) * 23n + 2n);
      for (const binding of sampleBindings({ seed: BigInt(i), stack, registry, chaos: 1 })) {
        const node = stack.find((entry) => entry.id === binding.nodeId);
        const param = registry
          .require(node?.effect ?? "")
          .params.find((entry) => entry.key === binding.param);
        expect(param?.type).not.toBe("seed");
      }
    }
  });

  it("stays under the cap that keeps an N-frame export cheaper than N renders", () => {
    for (let i = 0; i < 200; i += 1) {
      const stack = stackFor(BigInt(i) * 3n + 1n, 1);
      const bindings = sampleBindings({ seed: BigInt(i), stack, registry, chaos: 1 });
      expect(bindings.length).toBeLessThanOrEqual(MAX_BINDINGS);
    }
  });

  it("keeps amount and phase inside the unit interval it documents", () => {
    for (let i = 0; i < 200; i += 1) {
      const stack = stackFor(BigInt(i) * 5n + 9n);
      for (const binding of sampleBindings({ seed: BigInt(i), stack, registry, chaos: 1 })) {
        expect(binding.amount).toBeGreaterThan(0);
        expect(binding.amount).toBeLessThanOrEqual(1);
        expect(binding.phase).toBeGreaterThanOrEqual(0);
        expect(binding.phase).toBeLessThan(1);
      }
    }
  });

  it("binds more as chaos rises, and something at the wild end", () => {
    function total(chaos: number): number {
      let count = 0;
      for (let i = 0; i < 120; i += 1) {
        const stack = stackFor(BigInt(i) * 29n + 4n, 0.9);
        count += sampleBindings({ seed: BigInt(i), stack, registry, chaos }).length;
      }
      return count;
    }
    const tame = total(0);
    const wild = total(1);
    expect(wild).toBeGreaterThan(tame);
    expect(wild).toBeGreaterThan(0);
  });

  it("is reproducible from the seed", () => {
    const stack = stackFor(12345n);
    const a = sampleBindings({ seed: 77n, stack, registry, chaos: 0.7 });
    const b = sampleBindings({ seed: 77n, stack, registry, chaos: 0.7 });
    expect(a).toEqual(b);
  });

  it("reaches every declared modulator shape across enough draws", () => {
    const shapes = new Set<string>();
    for (let i = 0; i < 2_000; i += 1) {
      const stack = stackFor(BigInt(i) * 37n + 6n, 1);
      for (const binding of sampleBindings({ seed: BigInt(i), stack, registry, chaos: 1 })) {
        shapes.add(binding.shape);
      }
    }
    expect([...shapes].sort()).toEqual([
      "saw",
      "sine",
      "smooth-noise",
      "square",
      "stepped-random",
      "triangle",
    ]);
  });
});

describe("retainBindings", () => {
  const stack: readonly StackNode[] = [
    { id: "n1", effect: "invert", enabled: true, opacity: 1, blend: "normal", params: {}, seed: 1 },
  ];

  it("keeps a binding whose node is still there", () => {
    const bindings = [
      {
        nodeId: "n1",
        param: "amount",
        shape: "sine" as const,
        amount: 0.2,
        cyclesPerLoop: 1,
        phase: 0,
        bipolar: true,
      },
    ];
    expect(retainBindings(bindings, stack)).toEqual(bindings);
  });

  /**
   * The animation lock across a stack reroll. A binding is a reference to a
   * node, so one whose node is gone has nowhere to attach — and `setBindings`
   * throws on it rather than ignoring it.
   */
  it("drops a binding whose node the new stack does not contain", () => {
    const bindings = [
      {
        nodeId: "n9",
        param: "amount",
        shape: "sine" as const,
        amount: 0.2,
        cyclesPerLoop: 1,
        phase: 0,
        bipolar: true,
      },
    ];
    expect(retainBindings(bindings, stack)).toEqual([]);
  });
});

describe("the generator's animate switch", () => {
  /**
   * The whole reason `animate` exists. `state/render/graph.ts` refuses a
   * document carrying bindings, so a surprise must not produce any until the
   * modulator core lands — a control that produces an unrenderable document is
   * worse than a missing one.
   */
  it("produces no bindings at all while animate is false", () => {
    for (let i = 0; i < 200; i += 1) {
      const result = generateSurprise({
        seed: BigInt(i) * 41n + 8n,
        registry,
        chaos: 1,
        locks: NO_LOCKS,
        base: BASE,
        palette: PALETTE,
        animate: false,
      });
      expect(result.document.bindings).toEqual([]);
      expect(result.summary.bindings).toBe(0);
    }
  });

  it("produces bindings once it is on", () => {
    let total = 0;
    for (let i = 0; i < 60; i += 1) {
      total += generateSurprise({
        seed: BigInt(i) * 43n + 12n,
        registry,
        chaos: 1,
        locks: NO_LOCKS,
        base: BASE,
        palette: PALETTE,
        animate: true,
      }).document.bindings.length;
    }
    expect(total).toBeGreaterThan(0);
  });

  it("keeps locked bindings across a stack reroll, dropping those with no node", () => {
    const seeded = generateSurprise({
      seed: 999n,
      registry,
      chaos: 0.9,
      locks: NO_LOCKS,
      base: BASE,
      palette: PALETTE,
      animate: true,
    }).document;

    const rerolled = generateSurprise({
      seed: 1000n,
      registry,
      chaos: 0.9,
      locks: { ...NO_LOCKS, animation: true },
      base: seeded,
      palette: PALETTE,
      animate: true,
    });

    const ids = new Set(rerolled.document.stack.map((node) => node.id));
    for (const binding of rerolled.document.bindings) {
      expect(ids.has(binding.nodeId)).toBe(true);
      expect(seeded.bindings).toContainEqual(binding);
    }
  });
});
