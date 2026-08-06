import { describe, expect, it } from "vitest";

import type { Palette, SrgbTriplet } from "../../types/document";
import { formatHex, unpackColors } from "./color";
import type { ExtractionReport } from "./extract";
import type { PaletteEditOutcome, PaletteState } from "./model";
import {
  CUSTOM_PALETTE_ID,
  MAX_SWATCHES,
  MIN_SWATCHES,
  documentPalette,
  initialPaletteState,
  reduce,
} from "./model";
import { applyPermutation, remapIndices } from "./order";

function apply(state: PaletteState, ...edits: Parameters<typeof reduce>[1][]): PaletteState {
  let current = state;
  for (const edit of edits) {
    const outcome = reduce(current, edit);
    if (outcome.kind === "refused") {
      throw new Error(`edit ${edit.kind} was refused: ${outcome.reason}`);
    }
    current = outcome.state;
  }
  return current;
}

function applied(outcome: PaletteEditOutcome): Extract<PaletteEditOutcome, { kind: "applied" }> {
  if (outcome.kind === "refused") throw new Error(`refused: ${outcome.reason}`);
  return outcome;
}

const report: ExtractionReport = {
  method: "wu",
  requestedK: 4,
  askedOfCore: 4,
  lockedKept: 0,
  paletteLen: 4,
  occupiedBins: 900,
  iterations: 0,
  emptyClusterRepairs: 0,
  emptyClustersDropped: 0,
  ms: 3,
  sourceName: "fixture.png",
};

const FOUR: SrgbTriplet[] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [128, 128, 128],
];

function fourColour(): PaletteState {
  return apply(initialPaletteState(), {
    kind: "extracted",
    colors: FOUR,
    populations: [40, 30, 20, 10],
    report,
  });
}

describe("initialPaletteState", () => {
  it("opens on 1-bit mono", () => {
    const state = initialPaletteState();
    expect(state.mode).toEqual({ kind: "mono" });
    expect(state.swatches.map((s) => formatHex(s.rgb))).toEqual(["#000000", "#ffffff"]);
    expect(state.metric).toBe("oklab");
  });
});

describe("documentPalette", () => {
  it("packs the swatches into the layout .dork and the WASM boundary take", () => {
    const palette = documentPalette(fourColour());
    expect(palette.colors).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255, 128, 128, 128]);
    expect(unpackColors(palette.colors)).toEqual(FOUR);
    expect(palette.metric).toBe("oklab");
  });
});

describe("load", () => {
  it("takes a document palette whole, provenance included", () => {
    const palette: Palette = {
      id: "gameboy-dmg",
      name: "Game Boy DMG",
      colors: [8, 24, 32, 52, 104, 86, 136, 192, 112, 224, 248, 208],
      metric: "srgb",
    };
    const state = apply(initialPaletteState(), { kind: "load", palette });
    expect(state.id).toBe("gameboy-dmg");
    expect(state.metric).toBe("srgb");
    expect(state.swatches).toHaveLength(4);
    // A loaded document says nothing about which generator produced it.
    expect(state.mode).toEqual({ kind: "indexed" });
    expect(documentPalette(state).colors).toEqual(palette.colors);
  });

  it("refuses a malformed colour list rather than truncating it", () => {
    const outcome = reduce(initialPaletteState(), {
      kind: "load",
      palette: { id: "x", name: "x", colors: [1, 2, 3, 4], metric: "oklab" },
    });
    expect(outcome.kind).toBe("refused");
  });
});

describe("editing", () => {
  it("adds, removes and recolours", () => {
    let state = apply(initialPaletteState(), { kind: "add", rgb: [1, 2, 3] });
    expect(state.swatches).toHaveLength(3);

    state = apply(state, { kind: "set", index: 0, rgb: [9, 9, 9] });
    expect(state.swatches[0]?.rgb).toEqual([9, 9, 9]);

    state = apply(state, { kind: "remove", index: 1 });
    expect(state.swatches.map((s) => s.rgb)).toEqual([
      [9, 9, 9],
      [1, 2, 3],
    ]);
  });

  it("refuses to take the palette below the minimum", () => {
    const state = initialPaletteState();
    const outcome = reduce(state, { kind: "remove", index: 0 });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.reason).toContain(String(MIN_SWATCHES));
  });

  it("refuses an index that is not in the palette", () => {
    const state = initialPaletteState();
    expect(reduce(state, { kind: "set", index: 7, rgb: [0, 0, 0] }).kind).toBe("refused");
    expect(reduce(state, { kind: "remove", index: -1 }).kind).toBe("refused");
    expect(reduce(state, { kind: "lock", index: 9, locked: true }).kind).toBe("refused");
  });

  it("refuses a no-op rather than announcing a change that did not happen", () => {
    const state = initialPaletteState();
    expect(reduce(state, { kind: "set", index: 0, rgb: [0, 0, 0] }).kind).toBe("refused");
    expect(reduce(state, { kind: "lock", index: 0, locked: false }).kind).toBe("refused");
    expect(reduce(state, { kind: "metric", metric: "oklab" }).kind).toBe("refused");
  });

  it("drops a population when the colour it counted moves", () => {
    const state = apply(fourColour(), { kind: "set", index: 0, rgb: [1, 1, 1] });
    expect(state.swatches[0]?.population).toBeNull();
    expect(state.swatches[1]?.population).toBe(30);
  });

  it("marks a hand-edited palette custom exactly once", () => {
    const library = apply(initialPaletteState(), {
      kind: "library",
      palette: { id: "c64", name: "Commodore 64", colors: [0, 0, 0, 255, 255, 255] },
    });
    expect(library.id).toBe("c64");

    const once = apply(library, { kind: "add", rgb: [1, 1, 1] });
    expect(once.id).toBe(CUSTOM_PALETTE_ID);
    expect(once.name).toBe("Commodore 64 (edited)");

    const twice = apply(once, { kind: "add", rgb: [2, 2, 2] });
    expect(twice.name).toBe("Commodore 64 (edited)");
  });
});

describe("locks", () => {
  it("changes no colour, so nothing has to re-render", () => {
    const outcome = applied(reduce(fourColour(), { kind: "lock", index: 1, locked: true }));
    expect(outcome.state.swatches[1]?.locked).toBe(true);
    expect(outcome.change.rerender).toBe(false);
    expect(outcome.change.permutation).toBeNull();
  });

  it("survives a reorder attached to its own swatch", () => {
    const locked = apply(fourColour(), { kind: "lock", index: 0, locked: true });
    const moved = applied(reduce(locked, { kind: "move", from: 0, to: 3 }));
    expect(moved.state.swatches[3]?.locked).toBe(true);
    expect(moved.state.swatches[3]?.rgb).toEqual([255, 0, 0]);
  });
});

describe("reorders emit a permutation", () => {
  it("carries one for a move and applies it to the swatches", () => {
    const before = fourColour();
    const outcome = applied(reduce(before, { kind: "move", from: 0, to: 2 }));
    const order = outcome.change.permutation;
    expect(order).not.toBeNull();
    if (order === null) return;
    expect(applyPermutation(before.swatches, order)).toEqual(outcome.state.swatches);
  });

  it("carries one for a sort", () => {
    const before = fourColour();
    const outcome = applied(reduce(before, { kind: "sort", key: "luminance" }));
    const order = outcome.change.permutation;
    expect(order).not.toBeNull();
    if (order === null) return;
    expect(applyPermutation(before.swatches, order)).toEqual(outcome.state.swatches);
  });

  it("keeps an index map pointing at the same colour through that permutation", () => {
    // The reason the permutation is on the change at all. An index map made
    // against the palette before the sort still names the same colours after
    // it, provided it is remapped.
    const before = fourColour();
    const indices = new Uint16Array([0, 1, 2, 3, 2, 1]);
    const namesBefore = Array.from(indices, (i) => formatHex(before.swatches[i]?.rgb ?? [0, 0, 0]));

    const outcome = applied(reduce(before, { kind: "sort", key: "hue" }));
    const order = outcome.change.permutation;
    expect(order).not.toBeNull();
    if (order === null) return;
    remapIndices(indices, order);

    const namesAfter = Array.from(indices, (i) =>
      formatHex(outcome.state.swatches[i]?.rgb ?? [0, 0, 0]),
    );
    expect(namesAfter).toEqual(namesBefore);
  });

  it("carries none for anything that changes the colours themselves", () => {
    const state = fourColour();
    for (const edit of [
      { kind: "add", rgb: [1, 1, 1] },
      { kind: "remove", index: 0 },
      { kind: "set", index: 0, rgb: [7, 7, 7] },
      { kind: "ramp", from: 0, to: 3, steps: 5 },
      { kind: "metric", metric: "srgb" },
    ] as const) {
      expect(applied(reduce(state, edit)).change.permutation, edit.kind).toBeNull();
    }
  });

  it("refuses a sort that would not move anything", () => {
    const sorted = apply(fourColour(), { kind: "sort", key: "luminance" });
    expect(reduce(sorted, { kind: "sort", key: "luminance" }).kind).toBe("refused");
  });
});

describe("ramp", () => {
  it("replaces the span and keeps both ends byte for byte", () => {
    const before = fourColour();
    const first = before.swatches[0];
    const last = before.swatches[3];
    const state = apply(before, { kind: "ramp", from: 0, to: 3, steps: 6 });
    expect(state.swatches).toHaveLength(6);
    expect(state.swatches[0]).toEqual(first);
    expect(state.swatches[5]).toEqual(last);
  });

  it("keeps entries outside the span untouched", () => {
    const before = fourColour();
    const state = apply(before, { kind: "ramp", from: 1, to: 2, steps: 4 });
    expect(state.swatches[0]).toEqual(before.swatches[0]);
    expect(state.swatches).toHaveLength(6);
    expect(state.swatches[5]).toEqual(before.swatches[3]);
  });

  it("reads the span the same way whichever end is picked first", () => {
    const forwards = apply(fourColour(), { kind: "ramp", from: 0, to: 3, steps: 5 });
    const backwards = apply(fourColour(), { kind: "ramp", from: 3, to: 0, steps: 5 });
    expect(forwards.swatches).toEqual(backwards.swatches);
  });

  it("refuses a ramp between a swatch and itself", () => {
    expect(reduce(fourColour(), { kind: "ramp", from: 1, to: 1, steps: 4 }).kind).toBe(
      "refused",
    );
  });
});

describe("output modes", () => {
  it("regenerates the palette and names it", () => {
    const state = apply(initialPaletteState(), {
      kind: "mode",
      mode: { kind: "greyscale", levels: 4 },
    });
    expect(state.swatches.map((s) => s.rgb[0])).toEqual([0, 85, 170, 255]);
    expect(state.id).toBe("output-grey-4");
    expect(documentPalette(state).colors).toHaveLength(12);
  });

  it("becomes indexed the moment a generated palette is hand-edited", () => {
    // A generated list that has been edited is no longer generated; pretending
    // otherwise would silently discard the edit at the next level change.
    const grey = apply(initialPaletteState(), {
      kind: "mode",
      mode: { kind: "greyscale", levels: 4 },
    });
    const edited = apply(grey, { kind: "set", index: 1, rgb: [200, 0, 0] });
    expect(edited.mode).toEqual({ kind: "indexed" });
    expect(edited.swatches[1]?.rgb).toEqual([200, 0, 0]);
  });

  it("keeps the colours on the way into indexed", () => {
    const grey = apply(initialPaletteState(), {
      kind: "mode",
      mode: { kind: "greyscale", levels: 5 },
    });
    const outcome = applied(reduce(grey, { kind: "mode", mode: { kind: "indexed" } }));
    expect(outcome.state.swatches).toEqual(grey.swatches);
    expect(outcome.change.rerender).toBe(false);
  });

  it("allows the largest per-channel RGB, which is exactly the ceiling", () => {
    // 16 x 16 x 16 is 4096, which is MAX_SWATCHES: the editor's ceiling is set
    // by what per-channel RGB tops out at, so the two agree by construction and
    // this is the test that says so.
    const outcome = reduce(initialPaletteState(), {
      kind: "mode",
      mode: { kind: "rgb", red: 16, green: 16, blue: 16 },
    });
    expect(outcome.kind).toBe("applied");
    if (outcome.kind === "applied") {
      expect(outcome.state.swatches).toHaveLength(MAX_SWATCHES);
    }
  });
});

describe("extraction results", () => {
  it("names the palette after the extraction that made it", () => {
    const state = fourColour();
    expect(state.id).toBe("extracted");
    expect(state.report?.occupiedBins).toBe(900);
    expect(state.swatches.map((s) => s.population)).toEqual([40, 30, 20, 10]);
  });

  it("refuses a result too short to dither with", () => {
    const outcome = reduce(initialPaletteState(), {
      kind: "extracted",
      colors: [[1, 1, 1]],
      populations: [4],
      report: { ...report, paletteLen: 1 },
    });
    expect(outcome.kind).toBe("refused");
  });
});

describe("settings", () => {
  it("changes no colour, so nothing has to re-render", () => {
    const state = initialPaletteState();
    const outcome = applied(
      reduce(state, {
        kind: "extract-settings",
        settings: { ...state.extract, k: 32, method: "kmeans" },
      }),
    );
    expect(outcome.state.extract.k).toBe(32);
    expect(outcome.change.rerender).toBe(false);
  });

  it("moves the picture when the metric changes, though no swatch did", () => {
    const outcome = applied(reduce(fourColour(), { kind: "metric", metric: "srgb" }));
    expect(outcome.change.rerender).toBe(true);
    expect(outcome.change.palette.metric).toBe("srgb");
  });
});
