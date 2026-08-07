/**
 * Alpha, and the one format that has none.
 *
 * F-IN-03 says alpha is carried through the whole stack and never silently
 * composited onto white, and every layer up to this one honours it. JPEG has no
 * alpha channel, so an export to JPEG is the single point in the application
 * where transparency has to go somewhere. The requirement's word is "silently",
 * and the answer here has three parts:
 *
 * 1. **It only happens for a format that cannot carry alpha.** PNG and WebP
 *    both can, and both keep it.
 * 2. **It only happens when there is transparency to lose.** A fully opaque
 *    frame — which is nearly every frame, since most sources are opaque and the
 *    pipeline preserves that — is passed through untouched and reports
 *    `flattened: false`, so the UI says nothing.
 * 3. **When it does happen the UI says so before the export runs**, naming the
 *    matte. That is the difference between this and the browser's own
 *    behaviour, which composites onto whatever the canvas happened to be
 *    initialised with and tells nobody.
 *
 * ## The composite is done in linear light
 *
 * Compositing in gamma space is the same mistake as diffusing error in gamma
 * space (docs/ARCHITECTURE.md, "Colour"): the result is too dark at the edges
 * of an antialiased shape, by an amount that reads as a style rather than as a
 * bug. So the source is decoded through the same exact 256-entry table
 * `io/linear.ts` uses, blended, and re-encoded through the same transfer.
 *
 * ## Why the matte is black
 *
 * A matte has to be *some* colour and there is no neutral one. Black is chosen
 * because it is what unassociated alpha times coverage already means — a pixel
 * at a=0 contributes nothing, and over black that is exactly what it looks like
 * — and because a white matte is the specific default F-IN-03 names as the
 * thing not to do quietly. It is a constant rather than a control on purpose:
 * one more control on the export panel, to serve the intersection of "chose
 * JPEG" and "has transparency", is not worth the panel space, and a person who
 * needs a different backdrop has a compositing step available upstream.
 */

import type { SrgbTriplet } from "../types/document";
import type { Bytes } from "./types";
import { linearOfSrgbByte } from "../io";
import { linearToSrgb } from "../gpu/resources";
import { shouldYield, throwIfCancelled, yieldToHost } from "./progress";

/** The colour transparency is flattened onto, stated in the UI whenever it runs. */
export const EXPORT_MATTE: SrgbTriplet = [0, 0, 0];

export interface FlattenOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number) => void;
}

export interface FlattenResult {
  readonly data: Bytes;
  /**
   * True when at least one pixel was not fully opaque — which is the same thing
   * as "the composite ran", since an opaque buffer is returned untouched. One
   * field rather than two, because a second could only ever restate this.
   */
  readonly hadTransparency: boolean;
}

/**
 * Composited results for one matte channel, indexed by `source * 256 + alpha`.
 *
 * 65536 entries, built once per distinct matte channel value. The alternative is
 * two `pow` calls per channel per pixel, which at the 33-megapixel ceiling is
 * two hundred million of them — several seconds of the main thread for an
 * answer that has only 65536 possible values.
 */
const COMPOSITE_TABLES = new Map<number, Uint8Array>();

function compositeTable(matteByte: number): Uint8Array {
  const cached = COMPOSITE_TABLES.get(matteByte);
  if (cached !== undefined) return cached;

  const matteLinear = linearOfSrgbByte(matteByte);
  const table = new Uint8Array(256 * 256);
  for (let source = 0; source < 256; source += 1) {
    const sourceLinear = linearOfSrgbByte(source);
    for (let alpha = 0; alpha < 256; alpha += 1) {
      const coverage = alpha / 255;
      const blended = sourceLinear * coverage + matteLinear * (1 - coverage);
      table[source * 256 + alpha] = Math.round(
        linearToSrgb(blended <= 0 ? 0 : blended >= 1 ? 1 : blended) * 255,
      );
    }
  }
  COMPOSITE_TABLES.set(matteByte, table);
  return table;
}

/** True when every pixel is fully opaque. Cheap, and the usual answer. */
export function isFullyOpaque(data: Uint8Array | Uint8ClampedArray): boolean {
  for (let at = 3; at < data.length; at += 4) {
    if ((data[at] ?? 0) !== 255) return false;
  }
  return true;
}

/**
 * Composite unassociated RGBA over an opaque matte, in place.
 *
 * In place because the buffer it is handed is the scaled copy this module's
 * caller has just made and nobody else holds — see the note in `scale.ts` about
 * why a scale of 1 still copies.
 */
export async function flattenOntoMatte(
  data: Bytes,
  matte: SrgbTriplet = EXPORT_MATTE,
  options: FlattenOptions = {},
): Promise<FlattenResult> {
  if (isFullyOpaque(data)) {
    options.onProgress?.(1);
    return { data, hadTransparency: false };
  }

  const tableR = compositeTable(matte[0]);
  const tableG = compositeTable(matte[1]);
  const tableB = compositeTable(matte[2]);
  const pixels = Math.floor(data.length / 4);
  let mark = performance.now();

  for (let i = 0; i < pixels; i += 1) {
    const at = i * 4;
    const alpha = data[at + 3] ?? 0;
    if (alpha !== 255) {
      data[at] = tableR[(data[at] ?? 0) * 256 + alpha] ?? 0;
      data[at + 1] = tableG[(data[at + 1] ?? 0) * 256 + alpha] ?? 0;
      data[at + 2] = tableB[(data[at + 2] ?? 0) * 256 + alpha] ?? 0;
      data[at + 3] = 255;
    }

    if (shouldYield(mark)) {
      throwIfCancelled(options.signal);
      options.onProgress?.(i / pixels);
      await yieldToHost();
      mark = performance.now();
    }
  }

  options.onProgress?.(1);
  return { data, hadTransparency: true };
}
