import { describe, expect, it } from "vitest";

import type { BuiltinPalette } from "./library";
import { paletteSize, searchPalettes } from "./library";

const library: readonly BuiltinPalette[] = [
  { id: "mono", name: "1-bit", colors: [0, 0, 0, 255, 255, 255] },
  { id: "gameboy-dmg", name: "Game Boy DMG", colors: new Array(12).fill(0) },
  { id: "gameboy-pocket", name: "Game Boy Pocket", colors: new Array(12).fill(0) },
  { id: "cga-0-high", name: "CGA mode 0, high intensity", colors: new Array(12).fill(0) },
  { id: "cga-1-high", name: "CGA mode 1, high intensity", colors: new Array(12).fill(0) },
  { id: "c64", name: "Commodore 64", colors: new Array(48).fill(0) },
];

describe("searchPalettes", () => {
  it("returns the library in catalogue order for an empty query", () => {
    expect(searchPalettes(library, "")).toBe(library);
    expect(searchPalettes(library, "   ")).toBe(library);
  });

  it("requires every term to match", () => {
    expect(searchPalettes(library, "game boy").map((p) => p.id)).toEqual([
      "gameboy-dmg",
      "gameboy-pocket",
    ]);
    expect(searchPalettes(library, "cga high").map((p) => p.id)).toEqual([
      "cga-0-high",
      "cga-1-high",
    ]);
  });

  it("matches the id as well as the name", () => {
    expect(searchPalettes(library, "c64").map((p) => p.id)).toEqual(["c64"]);
  });

  it("is case insensitive", () => {
    expect(searchPalettes(library, "COMMODORE").map((p) => p.id)).toEqual(["c64"]);
  });

  it("returns nothing rather than everything when a term matches nothing", () => {
    expect(searchPalettes(library, "amiga")).toHaveLength(0);
  });
});

describe("paletteSize", () => {
  it("counts entries, not components", () => {
    expect(paletteSize({ id: "x", name: "x", colors: [0, 0, 0, 1, 1, 1] })).toBe(2);
  });
});
