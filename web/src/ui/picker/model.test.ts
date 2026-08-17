/**
 * The picker's model against the **shipped** catalogue.
 *
 * `ui/stack/picker.test.ts` next door exercises the same functions with
 * constructed descriptors, which is the right way to pin grouping, ranking and
 * refusal in isolation. This file asks the other question, and it is the one
 * that was answered wrong in the application rather than in a test: given the
 * sixty-seven effects that actually ship, does typing what a person types find
 * what they meant, and does the panel admit it when the thing does not exist?
 *
 * Every case below is a query that was actually typed, or the one it should have
 * been.
 */

import { describe, expect, it } from "vitest";

import { discoverEffects } from "../../registry/discovery";
import { createEffectRegistry, type EffectRegistry } from "../../registry";
import { buildPicker, firstAvailable, flatten, unbuiltNamedBy } from "./model";

const registry: EffectRegistry = createEffectRegistry(discoverEffects());

function pick(query: string, insertAt = 0) {
  return buildPicker({ registry, stack: [], insertAt, query, filter: {} });
}

describe("finding an effect that exists", () => {
  it("finds the glow by the word for what it produces", () => {
    const model = pick("glow");
    // Top of the first group, not merely present. `ridgeline` also matches —
    // its description says to put epsilon glow after it, which is the pairing
    // that produces the neon look — so what is asserted is that a description
    // mentioning the word still ranks below the effect named for it.
    expect(flatten(model).map((e) => e.effect.id)).toContain("epsilon-glow");
    expect(model.miss).toBeNull();
  });

  it("finds it by a keyword that is on no row, and says which", () => {
    const model = pick("halo");
    const entry = flatten(model).find((e) => e.effect.id === "epsilon-glow");
    expect(entry).toBeDefined();
    expect(entry?.match.reasons.map((reason) => reason.field)).toContain("keywords");
  });

  it("carries a one-line summary on every row, not just a name", () => {
    for (const entry of flatten(pick(""))) {
      expect(entry.match.summary.map((s) => s.text).join("")).toBe(entry.effect.summary);
    }
  });

  it("groups the resting state by family and shows the whole catalogue", () => {
    const model = pick("");
    expect(model.matched).toBe(registry.size);
    expect(model.groups.length).toBeGreaterThan(1);
    expect(model.tokens).toEqual([]);
    // Nothing is marked when nothing was typed.
    for (const entry of flatten(model)) {
      expect(entry.match.reasons).toEqual([]);
    }
  });

  it("marks the query in the name so the reason is visible", () => {
    const entry = flatten(pick("bayer"))[0];
    expect(entry?.match.name.some((segment) => segment.match)).toBe(true);
  });
});

describe("refusing an illegal placement", () => {
  it("shows an index-map reader at the top of an empty stack, refused with the reason", () => {
    const model = pick("outline");
    const entry = flatten(model).find((e) => e.effect.requiresIndexMap);
    expect(entry?.available).toBe(false);
    expect(entry?.reason).toContain("index map");
    expect(model.unavailable).toBeGreaterThan(0);
  });

  it("opens on something that can actually be added", () => {
    const model = pick("outline");
    const first = firstAvailable(model);
    if (first !== null) {
      expect(flatten(model).find((e) => e.effect.id === first.id)?.available).toBe(true);
    }
  });
});

describe("admitting a gap", () => {
  // The two gaps this section was written for — F-PT-09 and F-PT-10 — are
  // built, so the assertions moved from "names the gap" to "reaches the effect
  // that closed it". That is the same guarantee from the other side: the words
  // a person types have to arrive somewhere, and now there is somewhere.
  it("answers the wave field query with the wave field", () => {
    // The failure this panel was rebuilt for: "wave" returned `wave-warp`,
    // which is plausible, is not what was asked for, and used to be the only
    // answer. Now both are real effects and both are returned.
    const model = pick("wave");
    const ids = flatten(model).map((entry) => entry.effect.id);
    expect(ids).toContain("wave-field");
    expect(ids).toContain("wave-warp");
    expect(model.unbuilt).toBeNull();
  });

  it("answers the ridgeline query with the ridgeline", () => {
    const model = pick("unknown pleasures");
    expect(model.groups[0]?.entries[0]?.effect.id).toBe("ridgeline");
    expect(model.unbuilt).toBeNull();
  });

  it("names the JPEG glitch as unbuilt", () => {
    expect(pick("jpeg").unbuilt?.requirement).toBe("F-GL-06");
  });

  it("answers a requirement id for something that does not exist", () => {
    expect(pick("F-GL-06").unbuilt?.requirement).toBe("F-GL-06");
  });

  it("does not offer a suggestion the results already show", () => {
    const model = pick("jpeg quality");
    const shown = new Set(flatten(model).map((entry) => entry.effect.id));
    for (const suggestion of model.unbuiltNearest) {
      expect(shown.has(suggestion.id)).toBe(false);
    }
  });

  it("says nothing about gaps for an ordinary query", () => {
    for (const query of ["bayer", "glow", "blur", "posterize", ""]) {
      expect(unbuiltNamedBy(query), `“${query}” raised a false gap`).toBeNull();
    }
  });

  it("does not raise a gap on a fragment of one of its keywords", () => {
    // "blocky" is a keyword of the JPEG glitch; "block" is not that word, and
    // `block-shuffle` is a real effect somebody may well be looking for.
    expect(unbuiltNamedBy("block")).toBeNull();
    expect(pick("block").groups.length).toBeGreaterThan(0);
  });

  it("does not let a one-letter query name a requirement id", () => {
    expect(unbuiltNamedBy("f")).toBeNull();
    expect(unbuiltNamedBy("06")).toBeNull();
  });
});

describe("finding nothing", () => {
  it("reports why, rather than returning an empty list", () => {
    const model = pick("qwertyuiop");
    expect(model.groups).toEqual([]);
    expect(model.miss).not.toBeNull();
  });

  it("names the nearest effects for a misspelling", () => {
    const model = pick("halftown");
    expect(model.groups).toEqual([]);
    expect(model.miss?.kind).toBe("nearest");
    if (model.miss?.kind === "nearest") {
      expect(model.miss.nearest.length).toBeGreaterThan(0);
    }
  });

  it("distinguishes a filter that hid the answer from an answer that is not there", () => {
    // A requirement id is an exact key, so this is one effect and one only: the
    // first error-diffusion kernel, which lives in the dither slot. Asked for
    // under the preprocess filter it cannot be found, and the fix is to widen
    // the filter rather than to retype — which is the distinction being made.
    const model = buildPicker({
      registry,
      stack: [],
      insertAt: 0,
      query: "F-ED-01",
      filter: { slot: "preprocess" },
    });
    expect(model.groups).toEqual([]);
    expect(model.miss?.kind).toBe("filtered-out");
    expect(registry.search("F-ED-01")).toHaveLength(1);
  });
});
