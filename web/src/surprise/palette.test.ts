/**
 * The random palette (F-SM-05), and the OKLab arithmetic under it.
 *
 * The built-in library is the core's table and is read across the WASM boundary,
 * which is not available in a Node test process. So the library-mode tests use a
 * small stand-in list of the same shape — that is a **fixture, not a mock**: it
 * is real data in the real type, and nothing about the code under test changes
 * because of it. What cannot be tested here is that the core's fifteen palettes
 * are well formed, and that is `ui/palette`'s own concern and its own test.
 */

import { describe, expect, it } from "vitest";

import type { Palette } from "../types/document";
import type { BuiltinPalette } from "../ui/palette/library";
import { tripletToOklab } from "../ui/palette/color";
import {
  PaletteSurpriseError,
  decidePalette,
  describePaletteDecision,
  paletteFromExtraction,
  paletteFromLibrary,
  synthesizePalette,
  type ColorScheme,
} from "./palette";
import { chromaTaper, evenLightness, maxChroma, oklchToSrgb } from "./oklab";
import { seededPcg32 } from "./rng";

/** Two real hardware palettes, in the shape `builtinPalettes()` returns. */
const LIBRARY: readonly BuiltinPalette[] = [
  { id: "1-bit", name: "1-bit", colors: [0, 0, 0, 255, 255, 255] },
  {
    id: "gameboy-dmg",
    name: "Game Boy DMG",
    colors: [8, 24, 32, 52, 104, 86, 136, 192, 112, 224, 248, 208],
  },
];

function entries(palette: Palette): number {
  return palette.colors.length / 3;
}

function unpack(palette: Palette): readonly (readonly [number, number, number])[] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < palette.colors.length; i += 3) {
    out.push([palette.colors[i] ?? 0, palette.colors[i + 1] ?? 0, palette.colors[i + 2] ?? 0]);
  }
  return out;
}

describe("decidePalette", () => {
  it("is reproducible from the seed", () => {
    for (const seed of [0n, 1n, 0xfeed_face_dead_beefn]) {
      expect(decidePalette(seed, { library: LIBRARY })).toEqual(
        decidePalette(seed, { library: LIBRARY }),
      );
    }
  });

  it("reaches all three modes", () => {
    const modes = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      modes.add(decidePalette(BigInt(i), { library: LIBRARY }).mode);
    }
    expect([...modes].sort()).toEqual(["extract", "library", "synthesized"]);
  });

  /**
   * A blank canvas is transparent black. Extraction over it converges on black
   * and comes back with a palette of one colour — it succeeds, and produces
   * nothing, which is worse than an error because nothing says why. So the mode
   * is not in the pool when there is nothing to extract from.
   */
  it("draws no extraction when there is nothing to extract from", () => {
    const modes = new Set<string>();
    for (let i = 0; i < 400; i += 1) {
      modes.add(
        decidePalette(BigInt(i), { library: LIBRARY, extractable: false }).mode,
      );
    }
    expect([...modes].sort()).toEqual(["library", "synthesized"]);
  });

  it("is still reproducible with extraction out of the pool", () => {
    for (const seed of [0n, 1n, 0xfeed_face_dead_beefn]) {
      const options = { library: LIBRARY, extractable: false } as const;
      expect(decidePalette(seed, options)).toEqual(decidePalette(seed, options));
    }
  });

  /**
   * A mode that is sometimes unavailable would have to fall back, and the same
   * seed would then mean two palettes depending on timing. The refusal is what
   * forces the caller to make all three available before offering the control —
   * see `ui/surprise/session.ts`, which disables the button and says which of
   * the two preconditions it is waiting for.
   */
  it("refuses an empty library rather than quietly using two of the three modes", () => {
    expect(() => decidePalette(1n, { library: [] })).toThrow(PaletteSurpriseError);
  });

  it("produces a usable palette for the two modes it resolves itself", () => {
    for (let i = 0; i < 300; i += 1) {
      const decision = decidePalette(BigInt(i) * 31n + 7n, { library: LIBRARY });
      if (decision.mode === "extract") {
        expect(decision.k).toBeGreaterThanOrEqual(2);
        expect(decision.settings.maxIterations).toBeGreaterThan(0);
        expect(typeof decision.settings.seed).toBe("bigint");
        continue;
      }
      const palette = decision.palette;
      expect(entries(palette)).toBeGreaterThanOrEqual(2);
      expect(palette.colors.length % 3).toBe(0);
      for (const component of palette.colors) {
        expect(Number.isInteger(component)).toBe(true);
        expect(component).toBeGreaterThanOrEqual(0);
        expect(component).toBeLessThanOrEqual(255);
      }
    }
  });

  it("names where the palette came from", () => {
    for (let i = 0; i < 60; i += 1) {
      const decision = decidePalette(BigInt(i), { library: LIBRARY });
      expect(describePaletteDecision(decision).length).toBeGreaterThan(0);
    }
  });
});

describe("paletteFromLibrary", () => {
  it("keeps the library entry's provenance", () => {
    const entry = LIBRARY[1];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const palette = paletteFromLibrary(entry, "oklab");
    expect(palette.id).toBe("gameboy-dmg");
    expect(palette.name).toBe("Game Boy DMG");
    expect(palette.colors).toEqual(entry.colors);
  });

  it("copies the colours rather than aliasing the library's array", () => {
    const entry = LIBRARY[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const palette = paletteFromLibrary(entry, "oklab");
    expect(palette.colors).not.toBe(entry.colors);
  });
});

describe("paletteFromExtraction", () => {
  it("labels itself the way a hand-run extraction does", () => {
    const palette = paletteFromExtraction(
      [
        [0, 0, 0],
        [128, 128, 128],
        [255, 255, 255],
      ],
      "wu",
      "oklab",
    );
    expect(palette.id).toBe("extracted");
    expect(palette.name).toBe("Extracted · wu · 3");
    expect(palette.colors).toEqual([0, 0, 0, 128, 128, 128, 255, 255, 255]);
  });

  it("refuses a one-colour result rather than shipping a palette that cannot dither", () => {
    expect(() => paletteFromExtraction([[1, 2, 3]], "wu", "oklab")).toThrow(
      PaletteSurpriseError,
    );
  });
});

describe("synthesizePalette", () => {
  const SCHEMES: readonly ColorScheme[] = [
    "mono",
    "analogous",
    "complementary",
    "split-complementary",
    "triad",
    "random-walk",
  ];

  it("produces at least two distinct colours for every scheme", () => {
    for (const scheme of SCHEMES) {
      for (let i = 0; i < 120; i += 1) {
        const palette = synthesizePalette(seededPcg32(BigInt(i) * 13n + 1n), scheme, "oklab");
        expect(entries(palette), scheme).toBeGreaterThanOrEqual(2);
        const colours = unpack(palette);
        expect(new Set(colours.map((c) => c.join(","))).size, scheme).toBe(colours.length);
      }
    }
  });

  /**
   * The property F-SM-05 asks for by name. Lightness rises monotonically through
   * the palette, which is what "even perceptual lightness spacing" buys and what
   * three independent sRGB draws never give.
   */
  it("spaces lightness evenly and monotonically", () => {
    for (const scheme of SCHEMES) {
      for (let i = 0; i < 40; i += 1) {
        const palette = synthesizePalette(seededPcg32(BigInt(i) * 7n + 5n), scheme, "oklab");
        const lightnesses = unpack(palette).map((c) => tripletToOklab(c).l);
        const gaps: number[] = [];
        for (let n = 1; n < lightnesses.length; n += 1) {
          const previous = lightnesses[n - 1] ?? 0;
          const current = lightnesses[n] ?? 0;
          expect(current, `${scheme} entry ${n}`).toBeGreaterThan(previous);
          gaps.push(current - previous);
        }
        if (gaps.length < 2) continue;
        // Even, not merely increasing: the spread of the gaps stays small
        // relative to their mean. Chroma moves the measured L slightly, so this
        // is a tolerance rather than an equality.
        const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        for (const gap of gaps) {
          expect(Math.abs(gap - mean) / mean, `${scheme}`).toBeLessThan(0.5);
        }
      }
    }
  });

  it("keeps a mono scheme on one hue and a triad on three", () => {
    // Hue is only meaningful where there is chroma, so near-neutral ends are
    // excluded from the count.
    const hueOf = (rgb: readonly [number, number, number]): number => {
      const lab = tripletToOklab(rgb);
      return Math.round((Math.atan2(lab.b, lab.a) * 180) / Math.PI);
    };
    const chromaOf = (rgb: readonly [number, number, number]): number => {
      const lab = tripletToOklab(rgb);
      return Math.hypot(lab.a, lab.b);
    };

    const mono = synthesizePalette(seededPcg32(3n), "mono", "oklab");
    const monoHues = new Set(
      unpack(mono)
        .filter((c) => chromaOf(c) > 0.02)
        .map(hueOf),
    );
    // Rounded to a degree, so a mono palette lands on one or two adjacent values.
    expect(monoHues.size).toBeLessThanOrEqual(2);

    let sawThree = false;
    for (let i = 0; i < 60 && !sawThree; i += 1) {
      const triad = synthesizePalette(seededPcg32(BigInt(i) * 11n + 2n), "triad", "oklab");
      const hues = new Set(
        unpack(triad)
          .filter((c) => chromaOf(c) > 0.02)
          .map((c) => Math.round(hueOf(c) / 10)),
      );
      if (hues.size >= 3) sawThree = true;
    }
    expect(sawThree).toBe(true);
  });

  it("carries the metric it was given", () => {
    expect(synthesizePalette(seededPcg32(1n), "triad", "srgb").metric).toBe("srgb");
    expect(synthesizePalette(seededPcg32(1n), "triad", "oklab").metric).toBe("oklab");
  });
});

describe("oklab", () => {
  it("keeps every synthesised colour inside sRGB", () => {
    // The bisection's whole job. A component that came back outside 0..255 would
    // mean the gamut search returned a chroma that does not fit.
    for (let l = 0.05; l <= 0.95; l += 0.05) {
      for (let h = 0; h < 360; h += 15) {
        const rgb = oklchToSrgb({ l, c: 0.4, h });
        for (const component of rgb) {
          expect(component).toBeGreaterThanOrEqual(0);
          expect(component).toBeLessThanOrEqual(255);
        }
      }
    }
  });

  /**
   * Clipping the three linear components independently is the obvious way to
   * handle an out-of-gamut colour and it moves hue — a saturated blue clips to a
   * violet. Reducing chroma keeps it. Measured here as: the hue of the reduced
   * colour is the hue that was asked for.
   */
  it("keeps hue when it has to give up chroma", () => {
    for (const h of [30, 90, 150, 210, 270, 330]) {
      const rgb = oklchToSrgb({ l: 0.5, c: 0.45, h });
      const lab = tripletToOklab(rgb);
      const got = ((Math.atan2(lab.b, lab.a) * 180) / Math.PI + 360) % 360;
      // Shortest angular distance, so 359 and 1 are two degrees apart.
      const delta = Math.abs(((got - h + 540) % 360) - 180);
      expect(delta, `hue ${h} came back as ${got}`).toBeLessThan(3);
    }
  });

  it("returns the requested chroma when it already fits", () => {
    expect(maxChroma(0.5, 0.02, 40)).toBe(0.02);
    expect(maxChroma(0.5, 0, 40)).toBe(0);
  });

  it("finds less room for chroma at the extremes of lightness", () => {
    const middle = maxChroma(0.5, 0.4, 250);
    const dark = maxChroma(0.05, 0.4, 250);
    const light = maxChroma(0.97, 0.4, 250);
    expect(middle).toBeGreaterThan(dark);
    expect(middle).toBeGreaterThan(light);
  });

  it("spaces lightness evenly and puts a single entry in the middle", () => {
    expect(evenLightness(3, 0, 1)).toEqual([0, 0.5, 1]);
    expect(evenLightness(1, 0.2, 0.8)).toEqual([0.5]);
    expect(() => evenLightness(0, 0, 1)).toThrow(RangeError);
  });

  it("tapers chroma to the declared ends and peaks in the middle", () => {
    expect(chromaTaper(0.5, 1, 0.2)).toBeCloseTo(1, 10);
    expect(chromaTaper(0, 1, 0.2)).toBeCloseTo(0.2, 10);
    expect(chromaTaper(1, 1, 0.2)).toBeCloseTo(0.2, 10);
  });
});
