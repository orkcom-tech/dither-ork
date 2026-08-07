import { describe, expect, it } from "vitest";

import { searchEffects } from "../../registry";
import { discoverEffects } from "../../registry/discovery";
import { defineEffect, type EffectDescriptor } from "../../types/registry";
import {
  contains,
  explainMatch,
  hasMatch,
  highlight,
  highlightTokens,
  tokenize,
  type Segment,
} from "./match";

/** The marked runs, so a test can say what was highlighted without the noise. */
function marked(segments: readonly Segment[]): readonly string[] {
  return segments.filter((segment) => segment.match).map((segment) => segment.text);
}

/** The whole string back, so a test can prove nothing was lost or duplicated. */
function joined(segments: readonly Segment[]): string {
  return segments.map((segment) => segment.text).join("");
}

describe("tokenize", () => {
  it("folds case and every separator, the way the search does", () => {
    expect(tokenize("Floyd-Steinberg")).toEqual(["floyd", "steinberg"]);
    expect(tokenize("  16×16  ")).toEqual(["16", "16"]);
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("highlightTokens", () => {
  it("refuses to tokenize a requirement id", () => {
    // `F-ED-01` would otherwise mark an `f` inside half the words on screen.
    expect(highlightTokens("F-ED-01")).toEqual([]);
    expect(highlightTokens("f-ed-01")).toEqual([]);
    expect(highlightTokens("F-ED-01 blur")).toEqual(["f", "ed", "01", "blur"]);
  });
});

describe("highlight", () => {
  it("marks a token and leaves the text intact", () => {
    const segments = highlight("Epsilon glow", ["glow"]);
    expect(marked(segments)).toEqual(["glow"]);
    expect(joined(segments)).toBe("Epsilon glow");
  });

  it("marks a prefix of a word", () => {
    expect(marked(highlight("Bayer 8x8", ["bay"]))).toEqual(["Bay"]);
  });

  it("prefers word starts and falls back to substrings", () => {
    // "err" starts a word in "error" and also sits inside "serpentine"; only the
    // word start is marked while one exists.
    expect(marked(highlight("Serpentine error", ["err"]))).toEqual(["err"]);
    expect(joined(highlight("Serpentine error", ["err"]))).toBe("Serpentine error");
    // With no word start anywhere, the substring is marked rather than nothing —
    // the scorer counted it, so the reader has to be able to see it.
    expect(marked(highlight("Serpentine", ["pent"]))).toEqual(["pent"]);
  });

  it("merges overlapping tokens into one mark", () => {
    const segments = highlight("halftone", ["half", "halftone"]);
    expect(marked(segments)).toEqual(["halftone"]);
    expect(segments).toHaveLength(1);
  });

  it("marks every occurrence", () => {
    expect(marked(highlight("dot dot", ["dot"]))).toEqual(["dot", "dot"]);
  });

  it("marks nothing for an empty query, and keeps the text", () => {
    expect(highlight("Epsilon glow", [])).toEqual([{ text: "Epsilon glow", match: false }]);
    expect(hasMatch(highlight("Epsilon glow", []))).toBe(false);
  });

  it("marks nothing when the token is absent", () => {
    expect(hasMatch(highlight("Epsilon glow", ["bayer"]))).toBe(false);
  });

  it("has nothing to say about an empty string", () => {
    expect(highlight("", ["glow"])).toEqual([]);
  });
});

const GLOWLIKE = defineEffect({
  id: "test-lamp",
  name: "Test Lamp",
  summary: "Fixture effect, constructed by a test rather than shipped in the catalogue.",
  description:
    "Spills light out of the bright parts of the picture, a physical artefact rather than a computed one. Pairs with a hard dither, where a soft halo over quantized colour reads as photography.",
  keywords: ["bloom", "neon", "halo"],
  concept: "optical",
  requirement: "F-SP-01",
  slot: "postprocess",
  family: "special",
  execution: "gpu",
  params: [],
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: false,
});

describe("explainMatch", () => {
  it("says nothing extra when the name already shows the match", () => {
    const match = explainMatch(GLOWLIKE, ["lamp"]);
    expect(marked(match.name)).toEqual(["Lamp"]);
    expect(match.reasons).toEqual([]);
  });

  it("names the keyword that put an invisible row on screen", () => {
    const match = explainMatch(GLOWLIKE, ["bloom"]);
    expect(hasMatch(match.name)).toBe(false);
    expect(hasMatch(match.summary)).toBe(false);
    const reason = match.reasons[0];
    expect(reason?.field).toBe("keywords");
    expect(marked(reason?.segments ?? [])).toEqual(["bloom"]);
  });

  it("lists every keyword that matched, and only those", () => {
    const match = explainMatch(GLOWLIKE, ["neon", "halo"]);
    expect(joined(match.reasons[0]?.segments ?? [])).toBe("neon, halo");
  });

  it("names a structural field when that is what matched", () => {
    const match = explainMatch(GLOWLIKE, ["optical"]);
    expect(match.reasons.map((reason) => reason.field)).toEqual(["concept"]);
  });

  it("quotes the description, elided, when nothing shorter explains it", () => {
    const match = explainMatch(GLOWLIKE, ["photography"]);
    const reason = match.reasons[0];
    expect(reason?.field).toBe("description");
    expect(marked(reason?.segments ?? [])).toEqual(["photography"]);
    // A window, not the whole paragraph.
    expect(joined(reason?.segments ?? []).length).toBeLessThan(
      GLOWLIKE.description.length,
    );
    expect(joined(reason?.segments ?? [])).toContain("…");
  });

  it("explains each token once, in the cheapest field that carries it", () => {
    const match = explainMatch(GLOWLIKE, ["bloom", "photography"]);
    expect(match.reasons.map((reason) => reason.field)).toEqual([
      "keywords",
      "description",
    ]);
  });

  it("has no reasons for an empty query", () => {
    expect(explainMatch(GLOWLIKE, []).reasons).toEqual([]);
  });
});

/**
 * The rule this file has to keep: every result the ranker returns is a result
 * this module can account for.
 *
 * The two implement the same matching rules separately — see the note at the top
 * of `match.ts` — so the thing worth pinning is not that they agree on scores
 * but that they agree on *whether something matched at all*. A row the ranker
 * returned and this module cannot explain is a row on screen with no visible
 * reason to be there, which is the failure the whole panel exists to prevent.
 */
describe("against the shipped catalogue", () => {
  const effects: readonly EffectDescriptor[] = discoverEffects().map((e) => e.descriptor);

  const queries = [
    "glow",
    "bloom",
    "halo",
    "neon",
    "wave",
    "noise",
    "halftone",
    "cmyk",
    "sharpen",
    "posterize",
    "serpentine",
    "blue",
    "print",
    "vhs",
  ];

  it.each(queries)("explains every result for “%s”", (query) => {
    const tokens = highlightTokens(query);
    const results = searchEffects(effects, query);
    expect(results.length).toBeGreaterThan(0);
    for (const { effect } of results) {
      const match = explainMatch(effect, tokens);
      const explained =
        hasMatch(match.name) || hasMatch(match.summary) || match.reasons.length > 0;
      expect(explained, `${effect.id} matched “${query}” with nothing to show for it`).toBe(
        true,
      );
    }
  });

  it("finds the effect the owner could not: glow is Epsilon glow", () => {
    expect(searchEffects(effects, "glow")[0]?.effect.id).toBe("epsilon-glow");
  });

  it("finds it by the words of somebody who never heard of the product", () => {
    for (const word of ["bloom", "halo", "neon", "phosphor"]) {
      const results = searchEffects(effects, word);
      const glow = results.find((result) => result.effect.id === "epsilon-glow");
      expect(glow, `“${word}” did not find the glow`).toBeDefined();
      const match = explainMatch(glow!.effect, highlightTokens(word));
      const explained =
        hasMatch(match.name) || hasMatch(match.summary) || match.reasons.length > 0;
      expect(explained, `“${word}” found the glow without saying why`).toBe(true);
    }
  });

  it("shows the keyword for a word that is nowhere on the row", () => {
    // "halo" is in the keywords and in the description, and in neither the name
    // nor the summary — so the row would otherwise be a result with no visible
    // connection to what was typed.
    const glow = effects.find((effect) => effect.id === "epsilon-glow");
    expect(glow).toBeDefined();
    const match = explainMatch(glow!, highlightTokens("halo"));
    expect(hasMatch(match.name)).toBe(false);
    expect(hasMatch(match.summary)).toBe(false);
    expect(match.reasons[0]?.field).toBe("keywords");
    expect(marked(match.reasons[0]?.segments ?? [])).toContain("halo");
  });
});

describe("contains", () => {
  it("is case-insensitive and does not care about word boundaries", () => {
    expect(contains("Epsilon Glow", "glow")).toBe(true);
    expect(contains("Epsilon Glow", "lo")).toBe(true);
    expect(contains("Epsilon Glow", "bayer")).toBe(false);
  });
});
