/**
 * The palette system's one door to the WASM core.
 *
 * Everything the palette UI knows about hardware palettes and about extraction
 * comes through here, and nothing here computes anything: the fifteen palettes
 * are the core's table (F-CO-04) and the three extractors are the core's
 * algorithms (F-CO-02). A palette list or a clustering written in TypeScript
 * would be a second answer to a question the renderer already answers, and the
 * copy that drifts is always the one the picture is not made from.
 *
 * Two rules from docs/API.md, section 1, are obeyed literally because breaking
 * either is a leak rather than an error:
 *
 * - **Every getter copies out of WASM memory.** Each is read exactly once and
 *   the result is held. `ExtractedPalette.indices` is deliberately *not* read —
 *   it is one `u16` per source pixel, and the palette editor has no use for it.
 * - **A handle owns linear memory until `free()`.** Every handle taken here is
 *   released in a `finally`, including on the failure path.
 *
 * The module is initialised lazily and once. `__wbg_init` returns the existing
 * instance when it already has one, so another part of the app initialising the
 * same package is not a conflict.
 */

import type { SrgbTriplet } from "../../types/document";
import { logger } from "../../lib/log";
import type { ExtractMethodId, ExtractSettings, PaletteSource } from "./extract";
import { sourceToSrgbBytes } from "./extract";
import type { BuiltinPalette } from "./library";

const log = logger("wasm");

type CoreModule = typeof import("../../wasm/pkg/dither_wasm.js");

let pending: Promise<CoreModule> | null = null;

/** Load and initialise the core. Idempotent; the second caller awaits the first. */
export async function loadCore(): Promise<CoreModule> {
  if (pending === null) {
    pending = (async (): Promise<CoreModule> => {
      const module = await import("../../wasm/pkg/dither_wasm.js");
      await module.default();
      log.info("core initialised for the palette system", { version: module.version() });
      return module;
    })();
  }
  return pending;
}

/** The built-in hardware palettes, in the core's catalogue order (F-CO-04). */
export async function fetchBuiltinPalettes(): Promise<readonly BuiltinPalette[]> {
  const core = await loadCore();
  const started = performance.now();
  const handles = core.builtinPalettes();
  const palettes: BuiltinPalette[] = [];
  try {
    for (const handle of handles) {
      palettes.push({
        id: handle.id,
        name: handle.name,
        colors: Array.from(handle.srgb),
      });
    }
  } finally {
    for (const handle of handles) handle.free();
  }
  log.info("built-in palette library read", {
    palettes: palettes.length,
    ms: Math.round((performance.now() - started) * 100) / 100,
  });
  return palettes;
}

/** What the core reported about one extraction. */
export interface CoreExtraction {
  readonly colors: readonly SrgbTriplet[];
  readonly populations: readonly number[];
  readonly paletteLen: number;
  readonly occupiedBins: number;
  readonly iterations: number;
  readonly emptyClusterRepairs: number;
  readonly emptyClustersDropped: number;
  readonly ms: number;
}

/**
 * The core's own enum member, never a bare ordinal.
 *
 * `ExtractMethod` is a real TypeScript enum on the generated boundary, and
 * since TS 5.0 a plain `number` is not assignable to one. That is the right
 * refusal: the ordinals are an append-only wire format shared with the Rust
 * side, and a hand-written `1` here would keep compiling after someone inserts
 * a method in the middle.
 */
type CoreExtractMethod = CoreModule["ExtractMethod"][keyof CoreModule["ExtractMethod"]];

function coreMethod(core: CoreModule, method: ExtractMethodId): CoreExtractMethod {
  switch (method) {
    case "median-cut":
      return core.ExtractMethod.MedianCut;
    case "wu":
      return core.ExtractMethod.Wu;
    case "kmeans":
      return core.ExtractMethod.KMeans;
  }
}

/**
 * Run one extraction (F-CO-02).
 *
 * `entries` is what the core is asked for, which is `k` less the locked
 * swatches — see `entriesToExtract` in `extract.ts` for why the subtraction
 * happens before the call rather than as a discard afterwards.
 */
export async function extractFromSource(
  source: PaletteSource,
  settings: ExtractSettings,
  entries: number,
): Promise<CoreExtraction> {
  const core = await loadCore();
  const started = performance.now();

  // The one conversion this file performs, and it is a re-encode rather than a
  // computation: the application holds the source in linear light and the WASM
  // extractor takes 8-bit sRGB. Timed separately because on a large image it is
  // a real cost and it must be attributable rather than buried in "extraction
  // took two seconds".
  const encodeStarted = performance.now();
  const rgba = sourceToSrgbBytes(source);
  const encodeMs = Math.round((performance.now() - encodeStarted) * 100) / 100;

  const options = new core.ExtractOptions();
  // Named off the function rather than off the class, because the class has a
  // private constructor on the generated boundary and `InstanceType` cannot
  // reach through one.
  let result: ReturnType<CoreModule["extractPalette"]> | null = null;
  try {
    options.method = coreMethod(core, settings.method);
    options.k = entries;
    options.seed = settings.seed;
    options.maxIterations = settings.maxIterations;

    result = core.extractPalette(rgba, source.width, source.height, options);

    const srgb = result.srgb;
    const populations = Array.from(result.populations);
    const colors: SrgbTriplet[] = [];
    for (let i = 0; i + 2 < srgb.length; i += 3) {
      colors.push([srgb[i] ?? 0, srgb[i + 1] ?? 0, srgb[i + 2] ?? 0]);
    }

    const extraction: CoreExtraction = {
      colors,
      populations,
      paletteLen: result.paletteLen,
      occupiedBins: result.occupiedBins,
      iterations: result.iterations,
      emptyClusterRepairs: result.emptyClusterRepairs,
      emptyClustersDropped: result.emptyClustersDropped,
      ms: Math.round((performance.now() - started) * 100) / 100,
    };

    log.info("palette extracted", {
      method: settings.method,
      asked: entries,
      got: extraction.paletteLen,
      occupiedBins: extraction.occupiedBins,
      iterations: extraction.iterations,
      repairs: extraction.emptyClusterRepairs,
      dropped: extraction.emptyClustersDropped,
      pixels: source.width * source.height,
      encodeMs,
      ms: extraction.ms,
    });
    return extraction;
  } finally {
    options.free();
    if (result !== null) result.free();
  }
}
