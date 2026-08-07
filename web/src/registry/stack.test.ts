/**
 * The stack grammar.
 *
 * The case this file exists for is the last block: CMYK halftone under an
 * outline. It is the one combination the catalogue can express and the renderer
 * cannot run — every other dither-slot node emits an index map, and F-PT-02 does
 * not because its output colours are ink overprints rather than palette entries.
 * Before `validateStack` that stack could be built in the editor and generated
 * by Surprise Me, and it failed with a `ScheduleError` at render time, which is
 * both too late and the wrong message.
 *
 * The blocks above it use constructed descriptors, for the same reason
 * `registry.test.ts` does: a rule is easier to read against two effects than
 * against sixty, and the shipped catalogue happens to declare no `excludes` at
 * all, so nothing in it would exercise that half.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLevel } from "../lib/log";
import type { EffectDescriptor } from "../types/registry";
import { discoverEffects } from "./discovery";
import { createEffectRegistry, type EffectRegistry } from "./registry";
import { validateStack, type StackNodeRef } from "./stack";

setLevel("error");

// A rejected stack logs a warning; several tests provoke it.
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// --- fixtures ------------------------------------------------------------

interface DescriptorOverrides {
  readonly slot?: EffectDescriptor["slot"];
  readonly producesIndexMap?: boolean;
  readonly requiresIndexMap?: boolean;
  readonly excludes?: readonly string[];
  readonly resamples?: boolean;
}

function effect(id: string, overrides: DescriptorOverrides = {}): EffectDescriptor {
  const slot = overrides.slot ?? "postprocess";
  return {
    id,
    name: id,
    requirement: "F-SP-08",
    slot,
    family: slot === "dither" ? "pattern" : "special",
    execution: "gpu",
    params: [],
    surpriseWeight: 1,
    producesIndexMap: overrides.producesIndexMap ?? false,
    requiresIndexMap: overrides.requiresIndexMap ?? false,
    ...(overrides.excludes === undefined ? {} : { excludes: overrides.excludes }),
    ...(overrides.resamples === undefined ? {} : { resamples: overrides.resamples }),
  };
}

function registryOf(...descriptors: readonly EffectDescriptor[]): EffectRegistry {
  return createEffectRegistry(
    descriptors.map((descriptor) => ({
      descriptor,
      module: `../effects/${descriptor.id}.effect.ts`,
    })),
  );
}

function node(id: string, effectId: string, enabled = true): StackNodeRef {
  return { id, effect: effectId, enabled };
}

const QUANTIZER = effect("quantizer", { slot: "dither", producesIndexMap: true });
const INK = effect("ink", { slot: "dither", producesIndexMap: false });
const CONSUMER = effect("consumer", {
  requiresIndexMap: true,
  producesIndexMap: true,
});
const PLAIN = effect("plain");
/** F-PP-01's shape: resamples colour, writes no index map. */
const CRUSH = effect("crush", { slot: "preprocess", resamples: true });
/** F-SP-14's shape: resamples, and carries the index map across with it. */
const NEAREST_UP = effect("nearest-up", {
  resamples: true,
  requiresIndexMap: true,
  producesIndexMap: true,
});

// --- extents -------------------------------------------------------------

describe("the extent rule", () => {
  const registry = registryOf(QUANTIZER, INK, CRUSH, NEAREST_UP, PLAIN);

  it("accepts a resampler in front of every quantizer", () => {
    // Where F-PP-01 is meant to sit, and the whole reason the node exists: it
    // decides the grid every kernel downstream measures itself against.
    const result = validateStack(registry, [
      node("n1", "crush"),
      node("n2", "quantizer"),
    ]);
    expect(result.ok).toBe(true);
  });

  it("refuses a colour resampler downstream of a live index map", () => {
    // Interpolating palette indices is meaningless — the average of index 3 and
    // index 7 is not a colour — so this node would leave indices at the old
    // extent naming a different pixel grid than the colours beside them. It was
    // refused before, by the scheduler, after the user had built the stack.
    const result = validateStack(registry, [
      node("n1", "quantizer"),
      node("n2", "crush"),
    ]);
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue?.code).toBe("index-map-resampled");
    // Both nodes named, which is what makes the message actionable.
    expect(issue?.nodeId).toBe("n2");
    expect(issue?.otherNodeId).toBe("n1");
    expect(issue?.message).toContain("crush");
    expect(issue?.message).toContain("quantizer");
  });

  it("accepts a resampler that carries the index map across", () => {
    // Nearest upscale replicates each texel into the block it now covers, so
    // every output index is copied rather than averaged with another. It is the
    // only rule under which resampling an index map means anything.
    const result = validateStack(registry, [
      node("n1", "quantizer"),
      node("n2", "nearest-up"),
    ]);
    expect(result.ok).toBe(true);
  });

  it("accepts a colour resampler after a dither that emits no index map", () => {
    // CMYK halftone's case from the other side: nothing is live, so there is
    // nothing for the resample to contradict.
    const result = validateStack(registry, [node("n1", "ink"), node("n2", "crush")]);
    expect(result.ok).toBe(true);
  });

  it("ignores a disabled quantizer in front of a resampler", () => {
    // A disabled node is not in the render (F-ST-02), so it produces no map for
    // the resampler to invalidate.
    const result = validateStack(registry, [
      node("n1", "quantizer", false),
      node("n2", "crush"),
    ]);
    expect(result.ok).toBe(true);
  });

  it("ignores a disabled resampler after a quantizer", () => {
    const result = validateStack(registry, [
      node("n1", "quantizer"),
      node("n2", "crush", false),
    ]);
    expect(result.ok).toBe(true);
  });
});

// --- the index map -------------------------------------------------------

describe("the index-map rule", () => {
  const registry = registryOf(QUANTIZER, INK, CONSUMER, PLAIN);

  it("accepts a consumer downstream of a quantizer", () => {
    const result = validateStack(registry, [
      node("n1", "quantizer"),
      node("n2", "consumer"),
    ]);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects a consumer with nothing quantizing in front of it", () => {
    const result = validateStack(registry, [node("n1", "plain"), node("n2", "consumer")]);
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toEqual(["index-map-missing"]);
    expect(result.issues[0]?.nodeId).toBe("n2");
    expect(result.issues[0]?.message).toContain("nothing in front of it quantizes");
  });

  it("rejects a consumer under a dither that emits no map, naming both", () => {
    const result = validateStack(registry, [node("n1", "ink"), node("n2", "consumer")]);
    expect(result.ok).toBe(false);
    const issue = result.issues[0];
    expect(issue?.code).toBe("index-map-missing");
    expect(issue?.nodeId).toBe("n2");
    expect(issue?.otherNodeId).toBe("n1");
    expect(issue?.otherEffect).toBe("ink");
    expect(issue?.message).toContain("consumer");
    expect(issue?.message).toContain("ink");
  });

  it("treats a later dither as replacing the map, not adding to it", () => {
    // Quantizing is what the dither slot is for: whatever indices arrived at
    // that node no longer describe the pixels leaving it. A stack with two
    // dithers in it is legal (F-ST-01 lets any node go anywhere), and the one
    // that runs last is the one that decides whether a map exists.
    const result = validateStack(registry, [
      node("n1", "quantizer"),
      node("n2", "ink"),
      node("n3", "consumer"),
    ]);
    expect(result.issues.map((i) => i.code)).toEqual(["index-map-missing"]);
    expect(result.issues[0]?.otherNodeId).toBe("n2");
  });

  it("lets a consumer that rewrites the map feed the next one", () => {
    const result = validateStack(registry, [
      node("n1", "quantizer"),
      node("n2", "consumer"),
      node("n3", "consumer"),
    ]);
    expect(result.ok).toBe(true);
  });

  it("does not count a disabled quantizer", () => {
    // A disabled node is not in the render (F-ST-02), so counting it would
    // accept a stack that fails the moment it runs.
    const result = validateStack(registry, [
      node("n1", "quantizer", false),
      node("n2", "consumer"),
    ]);
    expect(result.issues.map((i) => i.code)).toEqual(["index-map-missing"]);
  });

  it("does not fault a disabled consumer", () => {
    const result = validateStack(registry, [
      node("n1", "plain"),
      node("n2", "consumer", false),
    ]);
    expect(result.ok).toBe(true);
  });

  it("reports every consumer that is left without a map", () => {
    const result = validateStack(registry, [
      node("n1", "ink"),
      node("n2", "consumer"),
      node("n3", "plain"),
    ]);
    // n2 is reported; it then re-produces a map, so nothing after it is.
    expect(result.issues).toHaveLength(1);
  });
});

// --- exclusions ----------------------------------------------------------

describe("the exclusion rule", () => {
  it("rejects a declared incompatibility, naming both nodes", () => {
    const registry = registryOf(effect("a", { excludes: ["b"] }), effect("b"));
    const result = validateStack(registry, [node("n1", "a"), node("n2", "b")]);
    expect(result.ok).toBe(false);
    const issue = result.issues[0];
    expect(issue?.code).toBe("excluded-combination");
    expect(issue?.nodeId).toBe("n2");
    expect(issue?.otherNodeId).toBe("n1");
    expect(issue?.message).toContain("a (node n1)");
  });

  it("reads the exclusion from either side", () => {
    const registry = registryOf(effect("a"), effect("b", { excludes: ["a"] }));
    expect(validateStack(registry, [node("n1", "a"), node("n2", "b")]).ok).toBe(false);
    expect(validateStack(registry, [node("n1", "b"), node("n2", "a")]).ok).toBe(false);
  });

  it("reports one issue per pair, not per direction", () => {
    const registry = registryOf(effect("a", { excludes: ["b"] }), effect("b", { excludes: ["a"] }));
    const result = validateStack(registry, [node("n1", "a"), node("n2", "b")]);
    expect(result.issues).toHaveLength(1);
  });

  it("ignores an exclusion against a disabled node", () => {
    const registry = registryOf(effect("a", { excludes: ["b"] }), effect("b"));
    expect(
      validateStack(registry, [node("n1", "a"), node("n2", "b", false)]).ok,
    ).toBe(true);
  });
});

// --- unknown effects -----------------------------------------------------

describe("an effect this build does not have", () => {
  it("is reported alone, without inventing consequences", () => {
    // Nothing is known about what a missing effect produces or reads, so every
    // later verdict would be a guess. The id is reported and the walk stops.
    const registry = registryOf(CONSUMER);
    const result = validateStack(registry, [node("n1", "ghost"), node("n2", "consumer")]);
    expect(result.issues.map((i) => i.code)).toEqual(["unknown-effect"]);
    expect(result.issues[0]?.effect).toBe("ghost");
  });
});

// --- the shipped catalogue ----------------------------------------------

describe("the shipped catalogue", () => {
  const registry = createEffectRegistry(discoverEffects());

  it("makes CMYK halftone under an outline impossible to build", () => {
    // F-PT-02 is the only dither-slot node in the catalogue that emits no index
    // map. F-SP-10 requires one. Rendering this stack throws a ScheduleError
    // from the pass compiler; it should never get that far.
    const result = validateStack(registry, [
      node("n1", "cmyk-halftone"),
      node("n2", "outline"),
    ]);
    expect(result.ok).toBe(false);
    const issue = result.issues[0];
    expect(issue?.code).toBe("index-map-missing");
    expect(issue?.message).toContain("Outline");
    expect(issue?.message).toContain("CMYK");
    expect(issue?.otherEffect).toBe("cmyk-halftone");
  });

  it("makes CMYK halftone under dilate/erode impossible to build", () => {
    const result = validateStack(registry, [
      node("n1", "cmyk-halftone"),
      node("n2", "dilate-erode"),
    ]);
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("index-map-missing");
    expect(result.issues[0]?.otherEffect).toBe("cmyk-halftone");
  });

  it("accepts the same consumers under any other dither", () => {
    const dithers = registry
      .bySlot("dither")
      .filter((descriptor) => descriptor.producesIndexMap);
    // Every dither except CMYK halftone: the rule is about that one node, and a
    // rule that also rejected the other twenty-six would be a bug nobody could
    // see from the failing case alone.
    expect(dithers.length).toBeGreaterThan(1);
    const rejected = dithers
      .map((descriptor) => ({
        id: descriptor.id,
        result: validateStack(registry, [
          node("n1", descriptor.id),
          node("n2", "outline"),
        ]),
      }))
      .filter((entry) => !entry.result.ok)
      .map((entry) => entry.id);
    expect(rejected).toEqual([]);
  });

  it("rejects an outline with no dither in front of it at all", () => {
    const result = validateStack(registry, [node("n1", "blur"), node("n2", "outline")]);
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain("nothing in front of it quantizes");
  });
});
