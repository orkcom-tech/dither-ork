import { describe, expect, it } from "vitest";

import type { SrgbTriplet } from "../../types/document";
import { hueAngle, tripletToOklab } from "./color";
import type { Swatch } from "./model";
import {
  PermutationError,
  applyPermutation,
  canSortBy,
  identityOrder,
  invertPermutation,
  isIdentity,
  isPermutation,
  moveOrder,
  remapIndices,
  sortOrder,
} from "./order";

function swatch(rgb: SrgbTriplet, population: number | null = null): Swatch {
  return { rgb, locked: false, population };
}

describe("isPermutation", () => {
  it("accepts a permutation and refuses everything else", () => {
    expect(isPermutation([0, 1, 2], 3)).toBe(true);
    expect(isPermutation([2, 0, 1], 3)).toBe(true);
    expect(isPermutation([0, 0, 1], 3)).toBe(false); // repeats
    expect(isPermutation([0, 1], 3)).toBe(false); // short
    expect(isPermutation([0, 1, 3], 3)).toBe(false); // out of range
    expect(isPermutation([0, 1, 1.5], 3)).toBe(false); // not an index
  });
});

describe("sortOrder", () => {
  it("orders by OKLab lightness, dark to light", () => {
    const swatches = [swatch([255, 255, 255]), swatch([0, 0, 0]), swatch([128, 128, 128])];
    expect(sortOrder(swatches, "luminance")).toEqual([1, 2, 0]);
  });

  it("orders by hue red, yellow, green, blue", () => {
    const swatches = [
      swatch([0, 0, 255]),
      swatch([0, 255, 0]),
      swatch([255, 255, 0]),
      swatch([255, 0, 0]),
    ];
    expect(sortOrder(swatches, "hue")).toEqual([3, 2, 1, 0]);
  });

  it("groups neutrals together between the reds and the yellows", () => {
    // Not at the start, which is what the core's comment claims: a neutral's
    // chroma residual is tiny but not zero and its angle is a fixed 1.5009 rad.
    // Pinned here because it is what a hue sort of a real palette looks like.
    const swatches = [
      swatch([255, 255, 0]),
      swatch([200, 200, 200]),
      swatch([255, 0, 0]),
      swatch([64, 64, 64]),
    ];
    expect(sortOrder(swatches, "hue")).toEqual([2, 3, 1, 0]);
  });

  it("orders neutrals by lightness rather than by floating-point residue", () => {
    // The reason HUE_QUANTUM exists. Every grey's hue angle agrees to nine
    // significant figures and differs in the last few bits; compared directly,
    // those bits decide the order and this comes out shuffled.
    const greys = [200, 32, 255, 96, 64].map((v) => swatch([v, v, v]));
    const order = sortOrder(greys, "hue");
    const lightness = order.map((i) => greys[i]?.rgb[0] ?? -1);
    expect(lightness).toEqual([32, 64, 96, 200, 255]);
  });

  it("still separates two hues a single code value apart", () => {
    // The quantum is four orders of magnitude below any real hue difference,
    // so it groups floating-point residue and nothing else. Which of these two
    // comes first is a fact about OKLab, so the test reads it rather than
    // asserting a direction from memory — what is pinned is that they are not
    // treated as one hue.
    const swatches = [swatch([0, 0, 255]), swatch([1, 0, 255])];
    const angles = swatches.map((s) => hueAngle(tripletToOklab(s.rgb)));
    expect(angles[0]).not.toBe(angles[1]);
    const expected = (angles[0] ?? 0) < (angles[1] ?? 0) ? [0, 1] : [1, 0];
    expect(sortOrder(swatches, "hue")).toEqual(expected);
  });

  it("puts pure black first, which is the one exact zero", () => {
    const swatches = [swatch([255, 0, 0]), swatch([0, 0, 0]), swatch([128, 128, 128])];
    expect(sortOrder(swatches, "hue")).toEqual([1, 0, 2]);
  });

  it("orders by population descending", () => {
    const swatches = [swatch([0, 0, 0], 5), swatch([1, 1, 1], 90), swatch([2, 2, 2], 40)];
    expect(sortOrder(swatches, "population")).toEqual([1, 2, 0]);
  });

  it("sinks uncounted entries below counted ones", () => {
    const swatches = [swatch([0, 0, 0], null), swatch([1, 1, 1], 3), swatch([2, 2, 2], null)];
    expect(sortOrder(swatches, "population")).toEqual([1, 0, 2]);
  });

  it("breaks every tie on the original index, so two runs cannot disagree", () => {
    const grey = (): Swatch => swatch([128, 128, 128], 7);
    const swatches = [grey(), grey(), grey(), grey()];
    for (const key of ["hue", "luminance", "population"] as const) {
      expect(sortOrder(swatches, key)).toEqual([0, 1, 2, 3]);
    }
  });

  it("always returns a permutation", () => {
    const swatches = [
      swatch([255, 0, 0], 1),
      swatch([0, 255, 0], 9),
      swatch([0, 0, 255], 4),
      swatch([200, 200, 10], 4),
      swatch([10, 10, 10], null),
    ];
    for (const key of ["hue", "luminance", "population"] as const) {
      expect(isPermutation(sortOrder(swatches, key), swatches.length)).toBe(true);
    }
  });
});

describe("canSortBy", () => {
  it("refuses a population sort on a palette that never came from an extraction", () => {
    const swatches = [swatch([0, 0, 0]), swatch([255, 255, 255])];
    const verdict = canSortBy(swatches, "population");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("extraction");
  });

  it("allows it as soon as one entry carries a count", () => {
    const swatches = [swatch([0, 0, 0], 4), swatch([255, 255, 255])];
    expect(canSortBy(swatches, "population").ok).toBe(true);
  });

  it("refuses any sort of a one-colour palette", () => {
    expect(canSortBy([swatch([0, 0, 0])], "luminance").ok).toBe(false);
  });
});

describe("applyPermutation", () => {
  it("moves entries to where the permutation says they came from", () => {
    expect(applyPermutation(["a", "b", "c"], [2, 0, 1])).toEqual(["c", "a", "b"]);
  });

  it("refuses a malformed permutation rather than dropping entries", () => {
    expect(() => applyPermutation(["a", "b", "c"], [0, 0, 1])).toThrow(PermutationError);
  });
});

describe("invertPermutation", () => {
  it("answers where an old index went", () => {
    // order[new] = old; inverse[old] = new.
    expect(invertPermutation([2, 0, 1])).toEqual([1, 2, 0]);
  });

  it("is its own inverse when applied twice", () => {
    const order = [3, 1, 0, 2];
    expect(invertPermutation(invertPermutation(order))).toEqual(order);
  });
});

describe("remapIndices", () => {
  it("keeps an index map pointing at the colour it pointed at", () => {
    // The whole reason a reorder is a permutation. Palette [red, green, blue]
    // reordered to [blue, red, green]; a pixel that was green must still be
    // green afterwards.
    const palette = ["red", "green", "blue"];
    const order = [2, 0, 1];
    const reordered = applyPermutation(palette, order);
    const indices = new Uint16Array([0, 1, 2, 1]);
    const before = Array.from(indices, (i) => palette[i]);

    remapIndices(indices, order);

    expect(Array.from(indices, (i) => reordered[i])).toEqual(before);
  });

  it("refuses an index outside the palette instead of remapping it to something plausible", () => {
    const indices = new Uint16Array([0, 5]);
    expect(() => remapIndices(indices, [1, 0])).toThrow(PermutationError);
  });

  it("leaves an index map alone under the identity", () => {
    const indices = new Uint16Array([0, 2, 1, 1]);
    remapIndices(indices, identityOrder(3));
    expect(Array.from(indices)).toEqual([0, 2, 1, 1]);
  });
});

describe("moveOrder", () => {
  it("lifts one entry and drops it at the target", () => {
    expect(applyPermutation(["a", "b", "c", "d"], moveOrder(4, 0, 2))).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
    expect(applyPermutation(["a", "b", "c", "d"], moveOrder(4, 3, 0))).toEqual([
      "d",
      "a",
      "b",
      "c",
    ]);
  });

  it("is the identity when the entry does not move", () => {
    expect(isIdentity(moveOrder(4, 2, 2))).toBe(true);
  });

  it("refuses an out-of-range endpoint", () => {
    expect(() => moveOrder(3, -1, 0)).toThrow(PermutationError);
    expect(() => moveOrder(3, 0, 3)).toThrow(PermutationError);
  });
});
