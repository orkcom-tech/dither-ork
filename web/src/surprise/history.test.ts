import { describe, expect, it } from "vitest";

import type { DitherDocument } from "../types/document";
import { DOCUMENT_SCHEMA_VERSION } from "../types/document";
import { DEFAULT_CLOCK, DEFAULT_PALETTE } from "../state/document";
import type { SurpriseSummary } from "./generate";
import {
  HISTORY_LIMIT,
  describeEntry,
  pushSurprise,
  withThumbnail,
  type SurpriseHistoryEntry,
} from "./history";

const DOCUMENT: DitherDocument = {
  schema: DOCUMENT_SCHEMA_VERSION,
  source: null,
  stack: [],
  edges: [],
  output: null,
  palette: DEFAULT_PALETTE,
  clock: DEFAULT_CLOCK,
  bindings: [],
};

function summary(seed: string): SurpriseSummary {
  return {
    seed,
    effects: ["blur", "floyd-steinberg"],
    effectNames: ["Blur", "Floyd–Steinberg"],
    dither: "floyd-steinberg",
    paletteName: "Game Boy DMG",
    paletteEntries: 4,
    bindings: 0,
    chaos: 0.5,
  };
}

function entry(seed: string): SurpriseHistoryEntry {
  return {
    id: `e-${seed}`,
    seed,
    summary: summary(seed),
    document: { ...DOCUMENT, surpriseSeed: seed },
    thumbnail: null,
    thumbnailProblem: null,
  };
}

describe("pushSurprise", () => {
  it("puts the newest first", () => {
    const one = pushSurprise([], entry("0000000000000001"));
    const two = pushSurprise(one, entry("0000000000000002"));
    expect(two.map((e) => e.seed)).toEqual(["0000000000000002", "0000000000000001"]);
  });

  it("keeps at most the limit", () => {
    let history: readonly SurpriseHistoryEntry[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 8; i += 1) {
      history = pushSurprise(history, entry(i.toString(16).padStart(16, "0")));
    }
    expect(history).toHaveLength(HISTORY_LIMIT);
    // The oldest are the ones that went.
    expect(history[0]?.seed).toBe((HISTORY_LIMIT + 7).toString(16).padStart(16, "0"));
  });

  /**
   * Restoring an old surprise and looking at it again must not push a second
   * copy of it in front of eleven others. Two documents cannot share a seed —
   * one is minted per surprise — so matching on it is matching on identity.
   */
  it("moves a seed that is already present rather than duplicating it", () => {
    const history = pushSurprise(
      pushSurprise(pushSurprise([], entry("a".repeat(16))), entry("b".repeat(16))),
      entry("c".repeat(16)),
    );
    const moved = pushSurprise(history, entry("a".repeat(16)));
    expect(moved.map((e) => e.seed)).toEqual([
      "a".repeat(16),
      "c".repeat(16),
      "b".repeat(16),
    ]);
    expect(moved).toHaveLength(3);
  });

  it("does not mutate the list it was given", () => {
    const before = pushSurprise([], entry("1".repeat(16)));
    const snapshot = [...before];
    pushSurprise(before, entry("2".repeat(16)));
    expect(before).toEqual(snapshot);
  });

  it("never produces an empty list from a positive push", () => {
    expect(pushSurprise([], entry("1".repeat(16)), 0)).toHaveLength(1);
  });
});

describe("withThumbnail", () => {
  const history = pushSurprise([], entry("1".repeat(16)));

  it("attaches the picture to the entry it belongs to", () => {
    const next = withThumbnail(history, "e-" + "1".repeat(16), "data:image/png;base64,AAA", null);
    expect(next[0]?.thumbnail).toBe("data:image/png;base64,AAA");
    expect(next[0]?.thumbnailProblem).toBeNull();
  });

  it("records why there is no picture instead of inventing one", () => {
    const next = withThumbnail(history, "e-" + "1".repeat(16), null, "the render failed");
    expect(next[0]?.thumbnail).toBeNull();
    expect(next[0]?.thumbnailProblem).toBe("the render failed");
  });

  /**
   * A thumbnail render can outlive its entry — twelve more surprises can be
   * pressed while one is in flight. Ordinary, so the list comes back unchanged
   * rather than growing an entry back.
   */
  it("ignores a thumbnail for an entry that has fallen off the end", () => {
    expect(withThumbnail(history, "gone", "data:image/png;base64,AAA", null)).toBe(history);
  });
});

describe("describeEntry", () => {
  it("names the seed, the stack and the palette", () => {
    const line = describeEntry(entry("7f3a1c92b04e5d68"));
    expect(line).toContain("7f3a1c92b04e5d68");
    expect(line).toContain("Blur → Floyd–Steinberg");
    expect(line).toContain("Game Boy DMG (4)");
  });

  it("says so when the stack is empty rather than showing nothing", () => {
    const empty = entry("0".repeat(16));
    const line = describeEntry({
      ...empty,
      summary: { ...empty.summary, effectNames: [] },
    });
    expect(line).toContain("empty stack");
  });
});
