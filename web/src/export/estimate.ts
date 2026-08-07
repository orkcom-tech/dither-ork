/**
 * F-EX-14 — the pre-export size estimate.
 *
 * ## It is measured, not modelled
 *
 * There is no formula for how large a PNG of a dither will be. Deflate's output
 * is a function of the run structure of the actual bytes, and dither noise is
 * the pathological case — docs/ARCHITECTURE.md lists "GIF compresses dither
 * noise poorly" among the known risks for precisely this reason. A model with a
 * bytes-per-pixel constant in it would be wrong by a factor of three in both
 * directions depending on the stack, and a number that is wrong by a factor of
 * three is worse than no number, because it is believed.
 *
 * So the estimate encodes the picture. Below a pixel budget it encodes all of
 * it, and the answer is not an estimate at all — it is the file size, reported
 * as exact. Above the budget it encodes a band of rows through the middle with
 * the real encoder at the real settings and multiplies by the row ratio.
 *
 * ## Two things that make the sample representative
 *
 * **The palette is the whole image's palette**, via `sliceIndexed`. A band
 * censused on its own would often find fewer colours than the image has, drop
 * to a smaller bit depth, and produce an estimate several times too small.
 *
 * **The band is centred.** The top rows of a photograph are frequently sky —
 * flat, and compressible far beyond the rest of the image.
 *
 * ## The bias is known and it is upward
 *
 * Every band carries a full set of headers: the signature, IHDR, PLTE and the
 * deflate preamble for a PNG, the tables for a JPEG. Multiplying by the row
 * ratio multiplies those too, so the estimate is high by roughly
 * `headers x (totalRows / sampledRows)` — a few kilobytes on a file of
 * megabytes. Stated here rather than corrected with a fudge factor, because a
 * correction is another number to be wrong about and the direction of the error
 * is the safe one.
 */

import { logger } from "../lib/log";
import { sliceIndexed } from "./census";
import { encodeFrame, type FrameCensus } from "./encode";
import { formatInfo } from "./settings";
import type { VectorTracer } from "./trace";
import type { ExportFrame, ExportSettings } from "./types";

const log = logger("export");

/**
 * 2^22 output pixels. At or below this the whole image is encoded and the
 * answer is exact; a 2048x2048 export takes a few hundred milliseconds, which
 * is inside what a panel can do while a slider is being let go of.
 */
export const ESTIMATE_PIXEL_BUDGET = 4_194_304;

export interface SizeEstimate {
  readonly bytes: number;
  /** True when the whole image was encoded, so this is the file size. */
  readonly exact: boolean;
  readonly sampledRows: number;
  readonly totalRows: number;
  readonly width: number;
  readonly height: number;
  readonly indexed: boolean;
  readonly paletteEntries: number;
}

export interface EstimateOptions {
  readonly signal?: AbortSignal;
  /** The frame's census, so the estimate does not recompute it per keystroke. */
  readonly census?: FrameCensus;
  /** The core's tracer. Required by, and only read by, a vector format. */
  readonly tracer?: VectorTracer;
}

/** A band of rows as a frame in its own right. */
export function sliceFrame(
  frame: ExportFrame,
  fromRow: number,
  rows: number,
): ExportFrame {
  const first = Math.max(0, Math.min(frame.height - 1, Math.trunc(fromRow)));
  const height = Math.max(1, Math.min(frame.height - first, Math.trunc(rows)));
  const stride = frame.width * 4;
  return {
    width: frame.width,
    height,
    data: frame.data.slice(first * stride, (first + height) * stride),
  };
}

export async function estimateExportSize(
  frame: ExportFrame,
  settings: ExportSettings,
  options: EstimateOptions = {},
): Promise<SizeEstimate> {
  // A vector format ignores the multiplier — it has no pixel grid to replicate
  // — so the output extent it reports is the frame's own. Multiplying here
  // would put a number on the panel that no file will ever have.
  const scale = formatInfo(settings.format).vector ? 1 : settings.scale;
  const width = frame.width * scale;
  const height = frame.height * scale;
  const signalOption = options.signal === undefined ? {} : { signal: options.signal };
  const tracerOption = options.tracer === undefined ? {} : { tracer: options.tracer };

  if (width * height <= ESTIMATE_PIXEL_BUDGET) {
    const encoded = await encodeFrame(frame, settings, {
      ...signalOption,
      ...tracerOption,
      ...(options.census === undefined ? {} : { census: options.census }),
    });
    return {
      bytes: encoded.blob.size,
      exact: true,
      sampledRows: frame.height,
      totalRows: frame.height,
      width,
      height,
      indexed: encoded.indexed,
      paletteEntries: encoded.paletteEntries,
    };
  }

  // Rows of the *source* frame whose scaled output fits the budget.
  const outputRowPixels = width * scale;
  const sampledRows = Math.max(
    1,
    Math.min(frame.height, Math.floor(ESTIMATE_PIXEL_BUDGET / outputRowPixels)),
  );
  const from = Math.floor((frame.height - sampledRows) / 2);

  const band = sliceFrame(frame, from, sampledRows);
  const bandCensus: FrameCensus | undefined =
    options.census === undefined
      ? undefined
      : {
          indexed:
            options.census.indexed === null
              ? null
              : sliceIndexed(options.census.indexed, from, sampledRows),
        };

  const encoded = await encodeFrame(band, settings, {
    ...signalOption,
    ...tracerOption,
    ...(bandCensus === undefined ? {} : { census: bandCensus }),
  });

  const bytes = Math.round(encoded.blob.size * (frame.height / sampledRows));
  log.info("size estimated from a sample", {
    format: settings.format,
    scale: settings.scale,
    sampledRows,
    totalRows: frame.height,
    sampleBytes: encoded.blob.size,
    bytes,
  });

  return {
    bytes,
    exact: false,
    sampledRows,
    totalRows: frame.height,
    width,
    height,
    indexed: encoded.indexed,
    paletteEntries: encoded.paletteEntries,
  };
}
