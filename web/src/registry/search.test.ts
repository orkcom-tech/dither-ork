/**
 * Effect search, against the real catalogue (F-ST-08, F-UI-15).
 *
 * Constructed fixtures are the wrong tool here. Every one of the failures this
 * file exists to prevent was a *catalogue* failure rather than a ranking bug:
 * "glow" did not find Epsilon glow because that effect's descriptor said
 * nothing about glowing, and no fixture would have noticed. So the queries below
 * run against the sixty-seven descriptors the build ships, and each one is a
 * query a person actually typed or would type.
 *
 * The named-query tests are deliberately assertions about *the top result*, not
 * about membership. "Somewhere in the list" is not finding something when the
 * list is sixty-seven long, which was the original complaint.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../lib/log";
import { discoverEffects } from "./discovery";
import { describeMiss, searchCatalogue, searchEffects } from "./search";
import { UNBUILT_FEATURES } from "./unbuilt";
import type { EffectDescriptor } from "../types/registry";

setLevel("error");

const EFFECTS: readonly EffectDescriptor[] = discoverEffects().map((d) => d.descriptor);

/** The winning effect's id, or null when nothing matched. */
function top(query: string): string | null {
  const results = searchEffects(EFFECTS, query);
  return results[0]?.effect.id ?? null;
}

function ids(query: string): readonly string[] {
  return searchEffects(EFFECTS, query).map((r) => r.effect.id);
}

describe("the queries that failed before descriptions existed", () => {
  // The reason this whole phase happened: the owner could not find the glow
  // effect, because it is called "Epsilon glow" after the reference product and
  // search matched only names and structural fields.
  it.each(["glow", "neon", "bloom", "halo"])("finds Epsilon glow from %s", (query) => {
    expect(top(query)).toBe("epsilon-glow");
  });

  it("finds blue noise from the word noise", () => {
    // Not top — noise burst and noise injection have it in their names — but
    // present, which it was not.
    expect(ids("noise")).toContain("blue-noise");
  });

  it("finds both wave effects from wave", () => {
    // There are two now. `wave-field` (F-PT-10) landed with `wave-warp` already
    // in the catalogue, and the word is a whole-word name match on both, so
    // asserting one of them at the top would be an assertion about the tie
    // break rather than about search. What has to hold is that neither is
    // buried.
    expect(ids("wave")).toEqual(expect.arrayContaining(["wave-warp", "wave-field"]));
  });

  it("finds the CMYK separation node from halftone", () => {
    expect(ids("halftone")).toContain("cmyk-halftone");
  });
});

describe("searchEffects ranks", () => {
  it("a name above a description that merely mentions the word", () => {
    // Several descriptions mention blurring; only one effect is called Blur.
    expect(top("blur")).toBe("blur");
  });

  it("the plain effect above its longer-named relatives", () => {
    expect(top("bayer")).toBe("bayer-16");
    // A tie on score among the four Bayer tiles breaks on id, so the assertion
    // above is about determinism; what matters is that all four are returned.
    expect(ids("bayer")).toEqual(
      expect.arrayContaining(["bayer-2", "bayer-4", "bayer-8", "bayer-16"]),
    );
  });

  it("an exact requirement id straight to its effect, and only it", () => {
    // Ranked as ordinary text this fails badly: `F-SP-01` normalizes to the
    // tokens `f`, `sp` and `01`, and `01` is a whole word inside `F-PP-01`, so
    // the id used to land on internal resolution with full confidence.
    expect(ids("F-SP-01")).toEqual(["epsilon-glow"]);
    expect(ids("F-ED-09")).toEqual(["atkinson"]);
    expect(ids("f-od-05")).toEqual(["blue-noise"]);
  });

  it("a requirement id nothing implements to the gap that explains it", () => {
    const miss = searchCatalogue(EFFECTS, "F-GL-06").miss;
    expect(miss?.kind).toBe("unbuilt");
    if (miss?.kind !== "unbuilt") return;
    expect(miss.feature.requirement).toBe("F-GL-06");
  });

  it("nothing when one token of several fails to match", () => {
    // A second word narrows; it does not broaden.
    expect(ids("bayer glitch")).toEqual([]);
  });

  it("the whole filtered set for an empty query", () => {
    expect(searchEffects(EFFECTS, "   ")).toHaveLength(EFFECTS.length);
    expect(searchEffects(EFFECTS, "", { family: "error-diffusion" })).toHaveLength(15);
  });

  it("the same order for the same query, whatever order the effects arrive in", () => {
    const reversed = [...EFFECTS].reverse();
    expect(searchEffects(reversed, "dither").map((r) => r.effect.id)).toEqual(ids("dither"));
  });
});

describe("searchCatalogue reports a miss instead of returning nothing", () => {
  it("names the requirement when the query is a feature the build does not have", () => {
    // Node masking used to be here. It is built now (F-PP-08), and it is not an
    // effect — it is spatially-varying opacity on every node — so it has no
    // descriptor to find and no unbuilt entry to report. A person typing "mask"
    // still gets CRT mask, which is a real effect, and that was always the
    // right answer for that word.
    //
    // "unknown pleasures" and "radio waves" used to be here too and are not:
    // F-PT-09 and F-PT-10 are built, so those queries now reach `ridgeline` and
    // `wave-field`. That move is asserted below rather than merely deleted.
    for (const query of ["jpeg"]) {
      const search = searchCatalogue(EFFECTS, query);
      expect(search.results, query).toEqual([]);
      expect(search.miss?.kind, query).toBe("unbuilt");
    }
  });

  it("identifies the right gap for each of them", () => {
    const requirementFor = (query: string): string | undefined => {
      const miss = searchCatalogue(EFFECTS, query).miss;
      return miss?.kind === "unbuilt" ? miss.feature.requirement : undefined;
    };
    expect(requirementFor("jpeg glitch")).toBe("F-GL-06");
  });

  it("sends the queries that used to name a gap to the effect that closed it", () => {
    // The other half of the unbuilt table's guarantee. An entry that becomes
    // real must not merely stop being reported — the words a person types have
    // to arrive somewhere, and the descriptor is where they moved to.
    expect(top("unknown pleasures")).toBe("ridgeline");
    expect(top("ridgeline")).toBe("ridgeline");
    expect(top("radio waves")).toBe("wave-field");
    expect(ids("flow around")).toContain("wave-field");
  });

  it("offers the nearest built effects alongside the gap", () => {
    const miss = searchCatalogue(EFFECTS, "jpeg").miss;
    expect(miss?.kind).toBe("unbuilt");
    if (miss?.kind !== "unbuilt") return;
    expect(miss.nearest.map((e) => e.id)).toEqual([
      "bit-crush",
      "block-shuffle",
      "noise-burst",
    ]);
  });

  it("names the nearest effects when the query is a typo", () => {
    const miss = searchCatalogue(EFFECTS, "halftown").miss;
    expect(miss?.kind).toBe("nearest");
    if (miss?.kind !== "nearest") return;
    expect(miss.nearest.map((e) => e.id)).toContain("halftone");
  });

  it("never smuggles the near misses back in as results", () => {
    // The point of the whole design: a poor answer must stay distinguishable
    // from a good one.
    const search = searchCatalogue(EFFECTS, "halftown");
    expect(search.results).toEqual([]);
  });

  it("says the filter is what hid the match, not the query", () => {
    // "bloom" matches epsilon-glow, which is a postprocess node; asking for it
    // in the dither slot is a filter problem and retyping cannot fix it.
    //
    // The query used to be "glow" and had to move: `ridgeline` is a dither-slot
    // node whose description says to put epsilon glow after it, so "glow" now
    // legitimately returns a result under that filter. That is the descriptions
    // working, not the filter failing.
    const search = searchCatalogue(EFFECTS, "bloom", { slot: "dither" });
    expect(search.miss?.kind).toBe("filtered-out");
    if (search.miss?.kind !== "filtered-out") return;
    expect(search.miss.nearest.map((e) => e.id)).toContain("epsilon-glow");
  });

  it("admits it knows nothing rather than guessing", () => {
    const search = searchCatalogue(EFFECTS, "zzzqqqxyw");
    expect(search.miss).toEqual({ kind: "unknown" });
  });

  it("returns no miss at all when there are results", () => {
    const search = searchCatalogue(EFFECTS, "glow");
    expect(search.miss).toBeNull();
    expect(search.results.length).toBeGreaterThan(0);
  });
});

describe("describeMiss", () => {
  it("quotes the query and names the requirement for an unbuilt feature", () => {
    const search = searchCatalogue(EFFECTS, "jpeg");
    expect(search.miss).not.toBeNull();
    if (search.miss === null) return;
    const sentence = describeMiss(search.miss, search.query);
    expect(sentence).toContain("jpeg");
    expect(sentence).toContain("F-GL-06");
    expect(sentence).toContain("Bit crush");
  });

  it("produces a non-empty sentence for every kind of miss", () => {
    for (const query of ["jpeg", "halftown", "zzzqqqxyw"]) {
      const search = searchCatalogue(EFFECTS, query);
      expect(search.miss, query).not.toBeNull();
      if (search.miss === null) continue;
      expect(describeMiss(search.miss, query).length, query).toBeGreaterThan(20);
    }
    const filtered = searchCatalogue(EFFECTS, "bloom", { slot: "dither" });
    expect(filtered.miss).not.toBeNull();
    if (filtered.miss === null) return;
    expect(describeMiss(filtered.miss, "bloom")).toContain("filter");
  });
});

describe("the unbuilt table", () => {
  it("lists nothing the registry actually implements", () => {
    // The guard that keeps this table honest as the catalogue grows: an entry
    // that becomes real must fail the build rather than go on telling people a
    // shipped effect does not exist.
    const built = new Set(EFFECTS.map((e) => e.requirement));
    const wrong = UNBUILT_FEATURES.filter((f) => built.has(f.requirement));
    expect(wrong.map((f) => f.requirement)).toEqual([]);
  });

  it("names only effect ids that do exist as nearest suggestions", () => {
    const known = new Set(EFFECTS.map((e) => e.id));
    const dangling = UNBUILT_FEATURES.flatMap((f) =>
      f.nearest.filter((id) => !known.has(id)).map((id) => `${f.requirement} -> ${id}`),
    );
    expect(dangling).toEqual([]);
  });

  it("gives every entry a reason rather than only a name", () => {
    for (const feature of UNBUILT_FEATURES) {
      expect(feature.reason.trim().length, feature.requirement).toBeGreaterThan(20);
      expect(feature.summary.trim().length, feature.requirement).toBeGreaterThan(20);
      expect(feature.keywords.length, feature.requirement).toBeGreaterThan(0);
    }
  });
});
