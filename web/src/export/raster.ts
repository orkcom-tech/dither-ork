/**
 * Frame to raster: the two things that happen to the pixels before an encoder
 * ever sees them, in the only order they can happen in.
 *
 * **Scale first, then flatten.** Both orders produce the same picture — pixel
 * replication commutes with a per-pixel composite — but flattening first would
 * do the composite on the small buffer and then replicate the results, which is
 * cheaper. It is still the wrong order, because the flatten is conditional on
 * the *format* and the scale is not: doing the cheap thing here would mean the
 * scaled buffer for a PNG and the scaled buffer for a JPEG are produced by two
 * different code paths, and the whole point of this file is that there is one.
 *
 * The cost is real and small: the flatten only runs on a frame that has
 * transparency and only for a format that cannot carry it, and its inner loop
 * is a table lookup.
 */

import type { ExportFrame, ExportRaster, ExportSettings } from "./types";
import { formatInfo } from "./settings";
import { EXPORT_MATTE, flattenOntoMatte, isFullyOpaque } from "./flatten";
import { scaleNearest } from "./scale";

export interface PrepareRasterOptions {
  readonly signal?: AbortSignal;
  /** 0..1 of the scaling stage. */
  readonly onProgress?: (fraction: number) => void;
}

export async function prepareRaster(
  frame: ExportFrame,
  settings: ExportSettings,
  options: PrepareRasterOptions = {},
): Promise<ExportRaster> {
  const scaled = await scaleNearest(frame, settings.scale, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onProgress: (fraction) => options.onProgress?.(fraction * 0.8),
  });

  const info = formatInfo(settings.format);
  if (info.alpha) {
    // The container carries alpha, so nothing is composited and the buffer is
    // handed on exactly as the scale produced it. `isFullyOpaque` still runs so
    // the UI can say whether there is transparency in the file at all.
    options.onProgress?.(1);
    return {
      width: scaled.width,
      height: scaled.height,
      data: scaled.data,
      flattened: false,
      hadTransparency: !isFullyOpaque(scaled.data),
    };
  }

  const flattened = await flattenOntoMatte(scaled.data, EXPORT_MATTE, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onProgress: (fraction) => options.onProgress?.(0.8 + fraction * 0.2),
  });

  return {
    width: scaled.width,
    height: scaled.height,
    data: flattened.data,
    // Here the two differ, which is why `ExportRaster` carries both: a PNG of
    // the same frame reports transparency and no flatten.
    flattened: flattened.hadTransparency,
    hadTransparency: flattened.hadTransparency,
  };
}
