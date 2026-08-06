import { describe, expect, it } from "vitest";

import { createEffectRegistry, type EffectRegistry } from "../../registry";
import type { StackNode } from "../../types/document";
import { defineEffect, type EffectDescriptor } from "../../types/registry";
import { stackRefs } from "./model";
import { buildPicker, firstAvailable, flatten, stepHighlight } from "./picker";

const TONE = defineEffect({
  id: "test-tone",
  name: "Test Tone",
  requirement: "F-PP-02",
  slot: "preprocess",
  family: "preprocess",
  execution: "gpu",
  params: [],
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: false,
});

const QUANTIZER = defineEffect({
  id: "test-quantizer",
  name: "Test Quantizer",
  requirement: "F-OD-01",
  slot: "dither",
  family: "ordered",
  execution: "gpu",
  params: [],
  surpriseWeight: 1,
  producesIndexMap: true,
  requiresIndexMap: false,
});

const DIFFUSION = defineEffect({
  id: "test-diffusion",
  name: "Test Diffusion",
  requirement: "F-ED-01",
  slot: "dither",
  family: "error-diffusion",
  execution: "wasm",
  params: [],
  surpriseWeight: 1,
  producesIndexMap: true,
  requiresIndexMap: false,
});

const OUTLINE = defineEffect({
  id: "test-outline",
  name: "Test Outline",
  requirement: "F-SP-10",
  slot: "postprocess",
  family: "special",
  execution: "gpu",
  params: [],
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: true,
});

// Same family and slot as the outline, and sorts after it on a tie, so that a
// group can be built whose first row is unavailable and whose second is not.
const GRAIN = defineEffect({
  id: "test-zgrain",
  name: "Test Zgrain",
  requirement: "F-SP-01",
  slot: "postprocess",
  family: "special",
  execution: "gpu",
  params: [],
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: false,
});

function registryOf(...effects: readonly EffectDescriptor[]): EffectRegistry {
  return createEffectRegistry(
    effects.map((descriptor) => ({ descriptor, module: `test/${descriptor.id}` })),
  );
}

function node(id: string, effect: string): StackNode {
  return { id, effect, enabled: true, opacity: 1, blend: "normal", params: {}, seed: 0 };
}

const registry = registryOf(TONE, QUANTIZER, DIFFUSION, OUTLINE, GRAIN);

describe("buildPicker", () => {
  it("groups by family, in family order, with nothing empty", () => {
    const model = buildPicker({
      registry,
      stack: [],
      insertAt: 0,
      query: "",
      filter: {},
    });
    expect(model.groups.map((g) => g.family)).toEqual([
      "preprocess",
      "error-diffusion",
      "ordered",
      "special",
    ]);
    expect(model.total).toBe(5);
    expect(model.matched).toBe(5);
  });

  it("narrows on the query and keeps the ranking inside a group", () => {
    const model = buildPicker({
      registry,
      stack: [],
      insertAt: 0,
      query: "quantizer",
      filter: {},
    });
    expect(model.matched).toBe(1);
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]?.entries[0]?.effect.id).toBe("test-quantizer");
  });

  it("finds an effect by its spec requirement id", () => {
    const model = buildPicker({
      registry,
      stack: [],
      insertAt: 0,
      query: "F-ED-01",
      filter: {},
    });
    expect(model.groups[0]?.entries[0]?.effect.id).toBe("test-diffusion");
  });

  it("applies a structural filter as well as the query", () => {
    const model = buildPicker({
      registry,
      stack: [],
      insertAt: 0,
      query: "",
      filter: { slot: "dither" },
    });
    expect(model.matched).toBe(2);
    expect(model.total).toBe(5);
  });

  it("marks an effect that cannot go at this insertion point, with the reason", () => {
    const model = buildPicker({
      registry,
      stack: [],
      insertAt: 0,
      query: "outline",
      filter: {},
    });
    const entry = model.groups[0]?.entries[0];
    expect(entry?.available).toBe(false);
    expect(entry?.reason).toContain("index map");
    expect(model.unavailable).toBe(1);
  });

  it("makes the same effect available behind a quantizer", () => {
    const stack = stackRefs([node("n1", "test-quantizer")]);
    const model = buildPicker({
      registry,
      stack,
      insertAt: 1,
      query: "outline",
      filter: {},
    });
    expect(model.groups[0]?.entries[0]?.available).toBe(true);
    expect(model.unavailable).toBe(0);
  });

  it("judges by position, not by membership", () => {
    // Same stack, same effect, inserted in front of the quantizer instead of
    // behind it: the map does not exist yet there.
    const stack = stackRefs([node("n1", "test-quantizer")]);
    const model = buildPicker({
      registry,
      stack,
      insertAt: 0,
      query: "outline",
      filter: {},
    });
    expect(model.groups[0]?.entries[0]?.available).toBe(false);
  });
});

describe("firstAvailable", () => {
  it("skips an unavailable first row and takes the next one that can be added", () => {
    const model = buildPicker({
      registry,
      stack: [],
      insertAt: 0,
      query: "",
      filter: { family: "special" },
    });
    expect(model.groups[0]?.entries[0]?.effect.id).toBe("test-outline");
    expect(model.groups[0]?.entries[0]?.available).toBe(false);
    expect(firstAvailable(model)?.id).toBe("test-zgrain");
  });

  it("is null when nothing matched", () => {
    const model = buildPicker({
      registry,
      stack: [],
      insertAt: 0,
      query: "nothing matches this",
      filter: {},
    });
    expect(firstAvailable(model)).toBeNull();
  });
});

describe("stepHighlight", () => {
  const entries = flatten(
    buildPicker({ registry, stack: [], insertAt: 0, query: "", filter: {} }),
  );

  it("starts at the first row when moving down from nothing", () => {
    expect(stepHighlight(entries, null, 1)).toBe(entries[0]?.effect.id);
  });

  it("starts at the last row when moving up from nothing", () => {
    expect(stepHighlight(entries, null, -1)).toBe(
      entries[entries.length - 1]?.effect.id,
    );
  });

  it("clamps rather than wrapping", () => {
    const first = entries[0]?.effect.id ?? null;
    expect(stepHighlight(entries, first, -1)).toBe(first);
    const last = entries[entries.length - 1]?.effect.id ?? null;
    expect(stepHighlight(entries, last, 1)).toBe(last);
  });

  it("lands on unavailable rows too, because they carry the reason", () => {
    const ids = new Set<string>();
    let cursor: string | null = null;
    for (let i = 0; i < entries.length; i += 1) {
      cursor = stepHighlight(entries, cursor, 1);
      if (cursor !== null) ids.add(cursor);
    }
    expect(ids.size).toBe(entries.length);
  });

  it("is null with nothing to highlight", () => {
    expect(stepHighlight([], null, 1)).toBeNull();
  });
});
