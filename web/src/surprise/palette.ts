/**
 * The random palette — F-SM-05.
 *
 * "Mode chosen at random per surprise: extracted from the source with a random
 * algorithm and K; a random palette from the built-in library; or synthesized —
 * a random colour scheme (mono, analogous, complementary, split-complementary,
 * triad, random walk) built in OKLab with even perceptual lightness spacing and
 * a random size."
 *
 * # The decision is separated from the resolution
 *
 * {@link decidePalette} is pure and synchronous: it draws the mode, and for two
 * of the three modes it produces the finished `Palette` there and then. For the
 * extracted mode it produces the *settings* — algorithm, K, seed — and stops,
 * because running an extraction means calling into WASM with the decoded source,
 * which is asynchronous and belongs to the layer that has an image.
 *
 * That split is what keeps the generator testable without a browser and without
 * a WASM build, and it is why there is no extraction callback threaded through
 * `generate.ts`. The UI adapter resolves a {@link PaletteDecision} into a
 * `Palette` and hands the result in.
 *
 * # All three modes are always available, and that is enforced upstream
 *
 * A mode drawn and then found unavailable — no image open, library not read yet
 * — would have to fall back to another, and the same seed would then mean two
 * different palettes depending on timing. So the surprise control is disabled
 * until a source is open **and** the hardware library has been read, and states
 * which of the two it is waiting for. See `ui/surprise/session.ts`.
 */

import { logger } from "../lib/log";
import type { ColorMetric, Palette, SrgbTriplet } from "../types/document";
import type { ExtractMethodId, ExtractSettings } from "../ui/palette/extract";
import type { BuiltinPalette } from "../ui/palette/library";
import type { Weighted } from "../types/registry";
import { chromaTaper, evenLightness, oklchToSrgb } from "./oklab";
import { streamFor, type Pcg32 } from "./rng";
import { quantise, weightedChoice } from "./sample";

const log = logger("app");

export class PaletteSurpriseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaletteSurpriseError";
  }
}

/** The colour schemes F-SM-05 names. */
export type ColorScheme =
  | "mono"
  | "analogous"
  | "complementary"
  | "split-complementary"
  | "triad"
  | "random-walk";

/** Which of the three ways this surprise got its palette. */
export type PaletteDecision =
  | { readonly mode: "library"; readonly palette: Palette; readonly source: string }
  | {
      readonly mode: "synthesized";
      readonly palette: Palette;
      readonly scheme: ColorScheme;
    }
  | {
      readonly mode: "extract";
      readonly settings: ExtractSettings;
      /** Entries asked of the core. Also the name the resolved palette takes. */
      readonly k: number;
      readonly metric: ColorMetric;
    };

export interface PaletteDecisionOptions {
  /** The hardware palettes, read from the core (F-CO-04). Must be non-empty. */
  readonly library: readonly BuiltinPalette[];
  /**
   * Whether there is anything in the picture to extract a palette *from*.
   *
   * `false` on a **blank canvas** (`io/source.ts`, `format: "blank"`), which is
   * transparent black everywhere: k-means over it converges on black, and the
   * document comes back with a palette of one colour and a picture that is that
   * colour. The extraction runs, succeeds, and produces nothing — which is
   * worse than an error, because nothing says why.
   *
   * This does not weaken the paragraph above about all three modes being
   * available. That argument is about a mode drawn and then found *unavailable*,
   * which would make one seed mean two palettes depending on timing. This is an
   * input, like the chaos setting and like `SurpriseRequest.animate`: the same
   * seed against the same source always produces the same palette, and a
   * different source was always going to.
   *
   * Optional, defaulting to `true`, so every caller that has a photograph open
   * reads exactly as it did before this existed.
   */
  readonly extractable?: boolean;
}

/**
 * Relative likelihood of each mode.
 *
 * Extraction leads because a palette taken from the picture is the one that most
 * often looks deliberate. Synthesis is close behind because it is the only mode
 * that can produce something the image and the hardware library both lack. The
 * library is a third of the weight and is still hit roughly one surprise in six,
 * which is about right for fifteen fixed answers.
 */
const MODE_WEIGHTS: readonly Weighted<PaletteDecision["mode"]>[] = [
  { value: "extract", weight: 1.2 },
  { value: "synthesized", weight: 1 },
  { value: "library", weight: 0.55 },
];

/**
 * OKLab is the default and sRGB Euclidean is a look control, not a fallback
 * (F-CO-03) — it reproduces what period-accurate tools did. Weighted so it turns
 * up, rather than offered evenly, because it is the more surprising of the two
 * and is wrong more often than it is right.
 */
const METRIC_WEIGHTS: readonly Weighted<ColorMetric>[] = [
  { value: "oklab", weight: 6 },
  { value: "srgb", weight: 1 },
];

const SCHEME_WEIGHTS: readonly Weighted<ColorScheme>[] = [
  { value: "analogous", weight: 1.2 },
  { value: "complementary", weight: 1 },
  { value: "triad", weight: 0.9 },
  { value: "split-complementary", weight: 0.8 },
  { value: "mono", weight: 0.8 },
  { value: "random-walk", weight: 0.6 },
];

/**
 * Palette sizes, weighted rather than drawn from a range.
 *
 * A dither reads completely differently at 2, at 4 and at 16 entries, and the
 * interesting sizes are not evenly spread: 2 is the product's subject, 3 to 6 is
 * where a palette still reads as a palette, and past about 12 the dither stops
 * being visible at all. A uniform draw over 2..16 would spend most of its
 * surprises in the range where the effect disappears.
 */
const SIZE_WEIGHTS: readonly Weighted<number>[] = [
  { value: 2, weight: 1.1 },
  { value: 3, weight: 1.3 },
  { value: 4, weight: 1.5 },
  { value: 5, weight: 1.2 },
  { value: 6, weight: 1.1 },
  { value: 8, weight: 0.9 },
  { value: 10, weight: 0.5 },
  { value: 12, weight: 0.35 },
  { value: 16, weight: 0.2 },
];

const EXTRACT_METHOD_WEIGHTS: readonly Weighted<ExtractMethodId>[] = [
  { value: "wu", weight: 1.2 },
  { value: "median-cut", weight: 0.9 },
  { value: "kmeans", weight: 0.8 },
];

/** The core's own Lloyd ceiling, and the palette editor's default. */
const EXTRACT_MAX_ITERATIONS = 64;

/** Ends of the chroma taper, as a fraction of the peak. See `oklab.ts`. */
const CHROMA_END_FRACTION = 0.22;

/** Draw the whole palette decision for one surprise. */
export function decidePalette(
  seed: bigint,
  options: PaletteDecisionOptions,
): PaletteDecision {
  if (options.library.length === 0) {
    throw new PaletteSurpriseError(
      "the built-in palette library is empty; the library mode has nothing to draw from, and a mode that is sometimes unavailable would make one seed mean two palettes",
    );
  }

  const rng = streamFor(seed, "surprise/palette");
  // Extraction is removed from the pool rather than drawn and then redirected:
  // a redirect would make the mode depend on a draw that no longer means
  // anything, and the weights of the other two would silently stop being their
  // declared ratio.
  const modes =
    options.extractable === false
      ? MODE_WEIGHTS.filter((entry) => entry.value !== "extract")
      : MODE_WEIGHTS;
  const mode = weightedChoice(rng, modes);
  const metric = weightedChoice(rng, METRIC_WEIGHTS);

  switch (mode) {
    case "library": {
      const entry = weightedChoice(
        rng,
        options.library.map((palette) => ({ value: palette, weight: 1 })),
      );
      const palette = paletteFromLibrary(entry, metric);
      log.info("surprise palette: library", {
        palette: palette.id,
        entries: palette.colors.length / 3,
        metric,
      });
      return { mode: "library", palette, source: entry.name };
    }

    case "synthesized": {
      const scheme = weightedChoice(rng, SCHEME_WEIGHTS);
      const palette = synthesizePalette(rng, scheme, metric);
      log.info("surprise palette: synthesized", {
        scheme,
        entries: palette.colors.length / 3,
        metric,
      });
      return { mode: "synthesized", palette, scheme };
    }

    case "extract": {
      const method = weightedChoice(rng, EXTRACT_METHOD_WEIGHTS);
      const k = weightedChoice(rng, SIZE_WEIGHTS);
      const settings: ExtractSettings = {
        method,
        k,
        // The extractor's own seed, drawn from this surprise's seed so that a
        // k-means run is reproducible with everything else rather than being the
        // one part of the document that is not.
        seed: rng.nextSeed64(),
        maxIterations: EXTRACT_MAX_ITERATIONS,
      };
      log.info("surprise palette: extract", { method, k, metric });
      return { mode: "extract", settings, k, metric };
    }
  }
}

/**
 * A library entry as a document palette.
 *
 * The id and name are kept, which is the provenance rule the palette editor
 * already follows: a `.dork` that says `gameboy-dmg` means it.
 */
export function paletteFromLibrary(
  entry: BuiltinPalette,
  metric: ColorMetric,
): Palette {
  return { id: entry.id, name: entry.name, colors: [...entry.colors], metric };
}

/**
 * The palette an extraction produced.
 *
 * `id` is `extracted` and the name follows `ui/palette/model.ts`'s own format
 * for the same event, so a surprise-extracted palette and a hand-extracted one
 * are labelled identically — they are the same thing and the panel should not
 * imply otherwise.
 */
export function paletteFromExtraction(
  colors: readonly SrgbTriplet[],
  method: ExtractMethodId,
  metric: ColorMetric,
): Palette {
  if (colors.length < 2) {
    throw new PaletteSurpriseError(
      `the extraction produced ${colors.length} colour(s); a palette needs at least two or every pixel maps to the same entry`,
    );
  }
  const packed: number[] = [];
  for (const colour of colors) packed.push(colour[0], colour[1], colour[2]);
  return {
    id: "extracted",
    name: `Extracted · ${method} · ${colors.length}`,
    colors: packed,
    metric,
  };
}

/**
 * Build a scheme in OKLab.
 *
 * Lightness is spread evenly across the palette — that is the "even perceptual
 * lightness spacing" F-SM-05 asks for, and it is one line because OKLab is where
 * it is one line. Chroma is tapered toward both ends rather than held flat,
 * because the sRGB gamut narrows to a needle at the extremes of lightness and a
 * flat request there gets reduced to almost nothing anyway (see `oklab.ts`).
 * Hue is the scheme.
 */
export function synthesizePalette(
  rng: Pcg32,
  scheme: ColorScheme,
  metric: ColorMetric,
): Palette {
  const size = weightedChoice(rng, SIZE_WEIGHTS);
  const baseHue = rng.nextFloat(0, 360);
  const chromaPeak = rng.nextFloat(0.045, 0.2);
  // Both ends stay clear of pure black and pure white. A palette whose darkest
  // entry is 0,0,0 is a fine palette and a boring one to arrive at by accident,
  // and one whose lightest is 255,255,255 blows the highlights of every image.
  const lightLow = rng.nextFloat(0.05, 0.24);
  const lightHigh = rng.nextFloat(0.76, 0.97);
  const hues = schemeHues(rng, scheme, baseHue, size);
  const lightnesses = evenLightness(size, lightLow, lightHigh);

  const colours: SrgbTriplet[] = [];
  for (let i = 0; i < size; i += 1) {
    const t = size === 1 ? 0.5 : i / (size - 1);
    const l = lightnesses[i] ?? lightLow;
    const h = hues[i] ?? baseHue;
    const c = chromaTaper(t, chromaPeak, chromaPeak * CHROMA_END_FRACTION);
    colours.push(oklchToSrgb({ l, c, h }));
  }

  // Two entries that round to the same byte triple are one entry as far as the
  // renderer is concerned, and a palette carrying a duplicate quietly wastes a
  // slot. Removed rather than tolerated; the lightness spread makes it rare.
  const unique = dedupe(colours);
  if (unique.length < 2) {
    throw new PaletteSurpriseError(
      `the ${scheme} scheme collapsed to ${unique.length} distinct colour(s); a palette needs at least two`,
    );
  }

  const packed: number[] = [];
  for (const colour of unique) packed.push(colour[0], colour[1], colour[2]);
  return {
    id: "surprise-synth",
    name: `Surprise · ${scheme} · ${unique.length}`,
    colors: packed,
    metric,
  };
}

/**
 * Hues for one scheme.
 *
 * Every value is quantised to the sampling grid before it is used, for the
 * reason `sample.ts` gives: the angle goes through `cos` and `sin`, and rounding
 * the *input* keeps two engines from disagreeing about the last bit of the
 * output before the byte quantisation gets a chance to.
 */
function schemeHues(
  rng: Pcg32,
  scheme: ColorScheme,
  baseHue: number,
  size: number,
): readonly number[] {
  const wrap = (h: number): number => quantise(((h % 360) + 360) % 360, [0, 360]);

  switch (scheme) {
    case "mono":
      return Array.from({ length: size }, () => wrap(baseHue));

    case "analogous": {
      // A single arc the palette walks along, centred on the base hue.
      const spread = rng.nextFloat(14, 52);
      return Array.from({ length: size }, (_unused, i) => {
        const t = size === 1 ? 0.5 : i / (size - 1);
        return wrap(baseHue + spread * (t - 0.5) * 2);
      });
    }

    case "complementary": {
      const pair = [baseHue, baseHue + 180];
      return Array.from({ length: size }, (_unused, i) => wrap(pair[i % 2] ?? baseHue));
    }

    case "split-complementary": {
      const split = rng.nextFloat(18, 42);
      const trio = [baseHue, baseHue + 180 - split, baseHue + 180 + split];
      return Array.from({ length: size }, (_unused, i) => wrap(trio[i % 3] ?? baseHue));
    }

    case "triad": {
      const trio = [baseHue, baseHue + 120, baseHue + 240];
      return Array.from({ length: size }, (_unused, i) => wrap(trio[i % 3] ?? baseHue));
    }

    case "random-walk": {
      // The one scheme with no closed form: each hue is a step from the last, so
      // the palette wanders rather than sitting on a fixed figure. Steps are
      // bounded so consecutive entries stay related; unbounded steps produce
      // six unrelated colours, which is what "random palette" means when it is
      // done badly and is exactly what the other five schemes exist to avoid.
      const hues: number[] = [];
      let current = baseHue;
      for (let i = 0; i < size; i += 1) {
        hues.push(wrap(current));
        current += rng.nextFloat(-75, 75);
      }
      return hues;
    }
  }
}

function dedupe(colours: readonly SrgbTriplet[]): readonly SrgbTriplet[] {
  const seen = new Set<string>();
  const out: SrgbTriplet[] = [];
  for (const colour of colours) {
    const key = `${colour[0]},${colour[1]},${colour[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(colour);
  }
  return out;
}

/** One line describing where a palette came from, for the UI and the log. */
export function describePaletteDecision(decision: PaletteDecision): string {
  switch (decision.mode) {
    case "library":
      return `library · ${decision.source}`;
    case "synthesized":
      return `synthesized · ${decision.scheme}`;
    case "extract":
      return `extracted · ${decision.settings.method} · k=${decision.k}`;
  }
}
