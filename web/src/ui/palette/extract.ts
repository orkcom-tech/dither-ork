/**
 * Automatic palette extraction — F-CO-02 — and the half of F-CO-05 that makes
 * it usable: **locked swatches survive re-extraction**.
 *
 * Nothing in this file touches WASM. The three algorithms live in the core and
 * are reached through `core.ts`; what is here is the settings a person chooses,
 * the rules for when extraction can run at all, and the merge that puts an
 * extraction's colours around the swatches the user has pinned.
 *
 * The merge rule, stated once because everything else follows from it: **a
 * locked swatch keeps its position, and the extraction fills the rest in
 * order.** So `k` is asked of the core as `k - locked`, not as `k` followed by
 * a discard — asking for the full `k` and then throwing away whichever
 * extracted colours sit near a locked one means the clustering spent entries on
 * regions the palette already covers, and the discard rule would be an invented
 * constant in the middle of a user-visible result.
 */

import type { SrgbTriplet } from "../../types/document";
import type { CpuColorSurface } from "../../types/graph";
import { clampByte, linearToByte } from "./color";
import type { Swatch } from "./model";

export type ExtractMethodId = "median-cut" | "wu" | "kmeans";

export const EXTRACT_METHODS: readonly ExtractMethodId[] = ["median-cut", "wu", "kmeans"];

export function methodLabel(method: ExtractMethodId): string {
  switch (method) {
    case "median-cut":
      return "median cut";
    case "wu":
      return "wu";
    case "kmeans":
      return "k-means";
  }
}

/** The core accepts 1..=65536; this is the ceiling the editor offers. */
export const K_RANGE = { min: 2, max: 256 } as const;

export interface ExtractSettings {
  readonly method: ExtractMethodId;
  readonly k: number;
  /**
   * Explicit 64-bit seed. Only k-means draws from it today, and it is recorded
   * for all three so that a later change adding a stochastic step cannot
   * quietly become unseeded.
   */
  readonly seed: bigint;
  /** Lloyd ceiling. Ignored by the single-pass methods. */
  readonly maxIterations: number;
}

export const DEFAULT_EXTRACT_SETTINGS: ExtractSettings = {
  // Wu, k = 16, seed 0, 64 iterations — the core's own defaults, so the editor
  // opening on them means the first extraction a user runs is the documented one.
  method: "wu",
  k: 16,
  seed: 0n,
  maxIterations: 64,
};

/**
 * What the core reported about the last extraction, plus what the editor did
 * with it. Surfaced in the panel rather than only logged: a palette that comes
 * back shorter than the `k` that was asked for has a reason, and
 * `occupiedBins` is that reason.
 */
export interface ExtractionReport {
  readonly method: ExtractMethodId;
  readonly requestedK: number;
  /** Entries actually asked of the core: `requestedK` less the locked swatches. */
  readonly askedOfCore: number;
  readonly lockedKept: number;
  readonly paletteLen: number;
  /** Occupied histogram bins — the ceiling on palette size for this image. */
  readonly occupiedBins: number;
  readonly iterations: number;
  readonly emptyClusterRepairs: number;
  readonly emptyClustersDropped: number;
  readonly ms: number;
  readonly sourceName: string;
}

/**
 * The loaded image, as the palette system needs it.
 *
 * **Structurally a subset of `io/source.ts`'s `SourceImage`**, so integration
 * is `paletteStore.setSource(image)` with no adapter in between. Declared here
 * rather than imported from `io/` because this directory must not depend on the
 * decoder to be testable, and because a narrower type states exactly what the
 * palette system reads and nothing more.
 *
 * The surface is linear light, planar `f32` — the form the whole application
 * holds a decoded image in. {@link sourceToSrgbBytes} is what turns it into the
 * interleaved 8-bit sRGB the WASM extractor takes.
 */
export interface PaletteSource {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Linear light, planar `f32`, unassociated alpha. */
  readonly surface: CpuColorSurface;
}

/**
 * Encode a linear-light planar source into the interleaved 8-bit sRGB RGBA
 * that `extractPalette` takes, mirroring `encode_srgb` in `core/…/color.rs`.
 *
 * There is a round trip here and it is worth naming: the source was decoded
 * from 8-bit sRGB to linear light on load, this puts it back, and the core
 * decodes it to linear light again to cluster in. The core's own round-trip
 * test bounds that at under one code value, and the alternative — an extractor
 * that takes planar `f32` — is a change to the WASM boundary, which is not this
 * directory's to make. It is reported for the round.
 *
 * Alpha is not gamma-encoded; only the colour channels carry a transfer
 * function. Encoding alpha through one is a classic and invisible error.
 */
export function sourceToSrgbBytes(source: PaletteSource): Uint8Array {
  const pixels = source.width * source.height;
  const { r, g, b, a } = source.surface;
  if (r.length < pixels || g.length < pixels || b.length < pixels || a.length < pixels) {
    throw new RangeError(
      `source "${source.name}" is ${source.width}x${source.height} (${pixels} px) but its planes hold ${r.length}/${g.length}/${b.length}/${a.length}`,
    );
  }

  const out = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    const at = i * 4;
    out[at] = linearToByte(r[i] ?? 0);
    out[at + 1] = linearToByte(g[i] ?? 0);
    out[at + 2] = linearToByte(b[i] ?? 0);
    out[at + 3] = clampByte((a[i] ?? 1) * 255);
  }
  return out;
}

export function lockedCount(swatches: readonly Swatch[]): number {
  return swatches.reduce((n, s) => (s.locked ? n + 1 : n), 0);
}

/**
 * Whether extraction can run, and why not when it cannot.
 *
 * The locked-swatch bound is a refusal rather than a clamp: with `k` at or
 * below the number of pinned colours there is nothing left for the extraction
 * to produce, and running it anyway would silently delete every unlocked
 * swatch and call the result an extraction.
 */
export function canExtract(
  swatches: readonly Swatch[],
  settings: ExtractSettings,
  source: PaletteSource | null,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (source === null) return { ok: false, reason: "open an image first" };
  if (source.width === 0 || source.height === 0) {
    return { ok: false, reason: "the source image has no pixels" };
  }
  if (!Number.isInteger(settings.k) || settings.k < K_RANGE.min || settings.k > K_RANGE.max) {
    return { ok: false, reason: `k must be a whole number in ${K_RANGE.min}..${K_RANGE.max}` };
  }
  const locked = lockedCount(swatches);
  if (locked >= settings.k) {
    return {
      ok: false,
      reason: `${locked} swatches are locked; raise k above ${locked} or unlock some`,
    };
  }
  if (settings.maxIterations < 1) {
    return { ok: false, reason: "max iterations must be at least 1" };
  }
  return { ok: true };
}

/** How many entries to ask the core for, given what is locked. */
export function entriesToExtract(
  swatches: readonly Swatch[],
  settings: ExtractSettings,
): number {
  return settings.k - lockedCount(swatches);
}

/**
 * Put an extraction's colours around the locked swatches.
 *
 * Locked swatches hold their index; unlocked positions take the extracted
 * colours in order; if the extraction came back short — which it can, since the
 * core returns fewer entries than `k` when the image has fewer distinguishable
 * colours — the palette shrinks rather than being padded with a colour nothing
 * chose.
 *
 * Populations travel with the colours they were counted for and are cleared for
 * locked swatches, whose counts belong to whichever extraction produced them
 * and do not describe this image.
 */
export function mergeLocked(
  previous: readonly Swatch[],
  extracted: readonly SrgbTriplet[],
  populations: readonly number[],
): Swatch[] {
  const total = lockedCount(previous) + extracted.length;
  const out: Swatch[] = [];
  let next = 0;

  for (let i = 0; i < Math.max(total, previous.length); i += 1) {
    const prior = previous[i];
    if (prior !== undefined && prior.locked) {
      // A locked swatch keeps its colour and its lock; its population came from
      // an earlier extraction and says nothing about this one.
      out.push({ rgb: prior.rgb, locked: true, population: null });
      continue;
    }
    const colour = extracted[next];
    if (colour === undefined) continue;
    out.push({ rgb: colour, locked: false, population: populations[next] ?? null });
    next += 1;
  }

  // The loop places every extracted colour by construction: it runs
  // `max(locked + extracted, previous)` times, of which exactly `locked` are
  // consumed by locked swatches, leaving at least `extracted` positions. The
  // test `places every extracted colour` is what holds that true.
  return out;
}
