/**
 * Output modes — F-CO-01.
 *
 * **An output mode is a palette generator, not a second rendering path.** Every
 * mode here resolves to an ordinary list of sRGB triplets, which is what the
 * document already carries and what every quantizing node already consumes. A
 * 1-bit mono render is a two-entry palette; a 4-level greyscale is four greys;
 * per-channel RGB with independent level counts is the cross product of the
 * three channels' levels. Nothing downstream learns a new concept, nothing
 * branches on a mode, and a `.dork` document written in any mode round-trips as
 * the palette it actually used.
 *
 * The mode is therefore state the editor keeps in order to *regenerate* the
 * palette when a level count changes. Hand-editing a swatch moves the mode to
 * `indexed`, because a generated list that has been edited is no longer
 * generated and pretending otherwise would silently discard the edit the next
 * time a level count moved.
 *
 * **Levels are evenly spaced in sRGB code value, not in linear light.** The
 * levels of an N-level output are device states — what a 4-level greyscale
 * display can actually show — and those are code values. Dithering against them
 * still happens in linear light, which is where the correctness argument
 * belongs; spacing the levels themselves linearly would produce a ramp that is
 * visually almost entirely black, which is not what any 4-level device does.
 *
 * **CMYK separation, the fifth mode F-CO-01 names, is not here.** It is not a
 * palette: it is four separations at four screen angles, which is the halftone
 * family's shape and not a colour list. Implementing it as a palette would have
 * meant a mode that looks selectable and produces something else.
 */

import type { SrgbTriplet } from "../../types/document";

export type OutputMode =
  | { readonly kind: "mono" }
  | { readonly kind: "greyscale"; readonly levels: number }
  | { readonly kind: "indexed" }
  | {
      readonly kind: "rgb";
      readonly red: number;
      readonly green: number;
      readonly blue: number;
    };

export type OutputModeKind = OutputMode["kind"];

export const OUTPUT_MODE_KINDS: readonly OutputModeKind[] = [
  "mono",
  "greyscale",
  "indexed",
  "rgb",
];

export const GREY_LEVEL_RANGE = { min: 2, max: 64 } as const;
export const RGB_LEVEL_RANGE = { min: 2, max: 16 } as const;

/**
 * Above this entry count the per-pixel nearest-colour scan is the render's cost
 * centre — it is a linear scan by design (the core says so: a k-d tree only
 * pays off far above the sizes this tool deals with). The editor states the
 * count and warns past this line rather than refusing, because a 512-entry RGB
 * output is a legitimate thing to ask for and a slow render is the user's
 * trade to make.
 */
export const PALETTE_SIZE_WARNING = 256;

export class OutputModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputModeError";
  }
}

function assertLevels(name: string, value: number, range: { min: number; max: number }): void {
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw new OutputModeError(
      `${name} levels must be a whole number in ${range.min}..${range.max}, got ${value}`,
    );
  }
}

/** The `n` evenly spaced 8-bit code values of an n-level channel. */
export function levelValues(n: number): number[] {
  assertLevels("channel", n, { min: 2, max: Math.max(GREY_LEVEL_RANGE.max, 256) });
  return Array.from({ length: n }, (_unused, i) => Math.round((i * 255) / (n - 1)));
}

/** How many entries a mode produces. `indexed` keeps whatever the palette holds. */
export function entryCount(mode: OutputMode, indexedLength: number): number {
  switch (mode.kind) {
    case "mono":
      return 2;
    case "greyscale":
      return mode.levels;
    case "rgb":
      return mode.red * mode.green * mode.blue;
    case "indexed":
      return indexedLength;
  }
}

/**
 * The colours a generated mode produces, or `null` for `indexed`, which
 * generates nothing and keeps the palette it was handed.
 *
 * RGB order is red-major: red varies slowest, blue fastest. Stated because the
 * order fixes which palette index each colour gets, and an index map written
 * against one order is nonsense read against the other.
 */
export function derivedColors(mode: OutputMode): SrgbTriplet[] | null {
  switch (mode.kind) {
    case "indexed":
      return null;
    case "mono":
      return [
        [0, 0, 0],
        [255, 255, 255],
      ];
    case "greyscale": {
      assertLevels("greyscale", mode.levels, GREY_LEVEL_RANGE);
      return levelValues(mode.levels).map((v): SrgbTriplet => [v, v, v]);
    }
    case "rgb": {
      assertLevels("red", mode.red, RGB_LEVEL_RANGE);
      assertLevels("green", mode.green, RGB_LEVEL_RANGE);
      assertLevels("blue", mode.blue, RGB_LEVEL_RANGE);
      const reds = levelValues(mode.red);
      const greens = levelValues(mode.green);
      const blues = levelValues(mode.blue);
      const out: SrgbTriplet[] = [];
      for (const r of reds) {
        for (const g of greens) {
          for (const b of blues) out.push([r, g, b]);
        }
      }
      return out;
    }
  }
}

/** The id and name a generated palette carries into the document. */
export function describeMode(mode: OutputMode): { readonly id: string; readonly name: string } {
  switch (mode.kind) {
    case "mono":
      // Prefixed rather than plain "mono": the built-in library ships a
      // hardware 1-bit palette under that id, and two different provenances
      // sharing one id is a document that cannot say where its colours came from.
      return { id: "output-mono", name: "1-bit mono" };
    case "greyscale":
      return { id: `output-grey-${mode.levels}`, name: `${mode.levels}-level greyscale` };
    case "rgb":
      return {
        id: `output-rgb-${mode.red}-${mode.green}-${mode.blue}`,
        name: `RGB ${mode.red}x${mode.green}x${mode.blue}`,
      };
    case "indexed":
      throw new OutputModeError("the indexed mode does not generate a palette");
  }
}

export function modeLabel(kind: OutputModeKind): string {
  switch (kind) {
    case "mono":
      return "1-bit mono";
    case "greyscale":
      return "greyscale";
    case "indexed":
      return "indexed";
    case "rgb":
      return "per-channel rgb";
  }
}

/** A mode of `kind` with the level counts carried over where they apply. */
export function modeOfKind(kind: OutputModeKind, previous: OutputMode): OutputMode {
  switch (kind) {
    case "mono":
      return { kind: "mono" };
    case "indexed":
      return { kind: "indexed" };
    case "greyscale":
      return { kind: "greyscale", levels: previous.kind === "greyscale" ? previous.levels : 4 };
    case "rgb":
      return previous.kind === "rgb" ? previous : { kind: "rgb", red: 2, green: 2, blue: 2 };
  }
}
