/**
 * One frame, one settings object, one blob.
 *
 * This is the only place that knows which of the four formats is written by
 * which encoder — PNG here, JPEG and WebP by the browser, SVG by the Rust
 * tracer — and the only place F-EX-01's "indexed when the output is indexed"
 * turns from a fact about the pixels into a fact about the file.
 *
 * The census earns its keep twice over: it is what makes an indexed PNG
 * possible and it is *also* the tracer's input, because "one layer per colour"
 * and "one palette entry per colour" are the same question asked of the same
 * finished frame. An SVG export therefore agrees with the PNG export beside it
 * by construction, rather than by two code paths being kept in step.
 *
 * ## The census runs on the frame, not on the scaled raster
 *
 * Nearest-neighbour replication cannot invent a colour, so the set of distinct
 * RGBA values in a 4x export is exactly the set in the frame it came from.
 * Censusing the frame therefore gives the same answer as censusing the raster,
 * over sixteen times fewer pixels — and it means an indexed export never has to
 * build the scaled RGBA buffer at all: `scaleIndices` replicates the index map
 * instead, at a quarter of the bytes.
 *
 * That is also what makes the pre-export estimate (F-EX-14) cheap and honest.
 * The census depends on the frame alone, so the panel computes it once and every
 * later change of format, quality or scale reuses it.
 */

import { logger } from "../lib/log";
import { encodeWithCanvas } from "./bitmap";
import { MAX_PALETTE_ENTRIES, indexImage, scaleIndices } from "./census";
import { encodePng } from "./png";
import { prepareRaster } from "./raster";
import { formatInfo } from "./settings";
import { traceIndexedImage, type VectorTracer } from "./trace";
import type {
  ExportFrame,
  ExportSettings,
  IndexedImage,
  VectorTraceReport,
} from "./types";
import { throwIfCancelled } from "./progress";

const log = logger("export");

/**
 * The census of one frame.
 *
 * A wrapper rather than a bare `IndexedImage | null` because the absence of a
 * census and a census that came back "this is not indexed" are different states
 * and a caller has to be able to say which it means.
 */
export interface FrameCensus {
  readonly indexed: IndexedImage | null;
}

export interface EncodeFrameOptions {
  readonly signal?: AbortSignal;
  /** A census of this exact frame. Computed here when absent. */
  readonly census?: FrameCensus;
  /**
   * The core's tracer. Required by, and only read by, the vector formats.
   *
   * Absent rather than optional-with-a-default because there is no default: the
   * tracer lives in WASM and this module is not allowed to import it. Asking
   * for SVG without one is a wiring mistake and is thrown as one.
   */
  readonly tracer?: VectorTracer;
  /** 0..1 of the scaling stage. */
  readonly onScaling?: (fraction: number) => void;
  /** 0..1 of the encoding stage. */
  readonly onEncoding?: (fraction: number) => void;
}

export interface EncodedFrame {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
  readonly indexed: boolean;
  readonly paletteEntries: number;
  readonly flattened: boolean;
  readonly hadTransparency: boolean;
  /** Set by a vector encode, `null` by a raster one. */
  readonly trace: VectorTraceReport | null;
}

/** The share of a PNG encode spent taking the census, when one is not supplied. */
const CENSUS_SHARE = 0.2;

export async function encodeFrame(
  frame: ExportFrame,
  settings: ExportSettings,
  options: EncodeFrameOptions = {},
): Promise<EncodedFrame> {
  throwIfCancelled(options.signal);
  const info = formatInfo(settings.format);
  const signalOption = options.signal === undefined ? {} : { signal: options.signal };

  if (settings.format === "svg") {
    if (options.tracer === undefined) {
      throw new Error(
        "an SVG export needs the core's tracer, and none was supplied to encodeFrame",
      );
    }
    const census =
      options.census ??
      ({
        indexed: await indexImage(frame.width, frame.height, frame.data, {
          ...signalOption,
          onProgress: (fraction) => options.onEncoding?.(fraction * CENSUS_SHARE),
        }),
      } satisfies FrameCensus);

    if (census.indexed === null) {
      // Stated, not worked around. Quantizing here would be a second dither the
      // document never asked for — see the note at the top of `trace.ts`.
      throw new Error(
        `this picture has more than ${MAX_PALETTE_ENTRIES} distinct colours, so it ` +
          `cannot be traced to SVG. Put a quantizing node in the stack, or export PNG.`,
      );
    }

    // The multiplier is not applied: a vector document has no pixel grid to
    // replicate. `formatInfo(settings.format).vector` is what the panel reads
    // to hide the control, and this is the same fact on the encode side.
    options.onScaling?.(1);
    const { traced, flattened } = await traceIndexedImage(
      options.tracer,
      census.indexed,
      settings.trace,
    );
    options.onEncoding?.(1);
    throwIfCancelled(options.signal);

    log.info("svg traced", {
      layers: traced.report.layers,
      contours: traced.report.contours,
      points: traced.report.points,
      regionsDropped: traced.report.regionsDropped,
      uncoveredPixels: traced.report.uncoveredPixels,
      chars: traced.svg.length,
    });

    return {
      blob: new Blob([traced.svg], { type: info.mime }),
      width: census.indexed.width,
      height: census.indexed.height,
      indexed: true,
      paletteEntries: census.indexed.count,
      flattened,
      hadTransparency: census.indexed.transparentEntries > 0,
      trace: traced.report,
    };
  }

  if (settings.format === "png") {
    const census =
      options.census ??
      ({
        indexed: await indexImage(frame.width, frame.height, frame.data, {
          ...signalOption,
          onProgress: (fraction) => options.onEncoding?.(fraction * CENSUS_SHARE),
        }),
      } satisfies FrameCensus);
    const censusShare = options.census === undefined ? CENSUS_SHARE : 0;

    if (census.indexed !== null) {
      const scaled = scaleIndices(census.indexed, settings.scale);
      options.onScaling?.(1);
      log.info("png will be indexed", {
        entries: scaled.count,
        bitDepth: scaled.bitDepth,
        width: scaled.width,
        height: scaled.height,
      });
      const bytes = await encodePng(
        { kind: "indexed", image: scaled },
        {
          ...signalOption,
          onProgress: (fraction) =>
            options.onEncoding?.(censusShare + (1 - censusShare) * fraction),
        },
      );
      return {
        // `new Blob([bytes])` copies, so the encoder's buffer is released with
        // the job rather than pinned for the life of the blob.
        blob: new Blob([bytes], { type: info.mime }),
        width: scaled.width,
        height: scaled.height,
        indexed: true,
        paletteEntries: scaled.count,
        flattened: false,
        hadTransparency: scaled.transparentEntries > 0,
        trace: null,
      };
    }

    const raster = await prepareRaster(frame, settings, {
      ...signalOption,
      ...(options.onScaling === undefined ? {} : { onProgress: options.onScaling }),
    });
    const bytes = await encodePng(
      {
        kind: "rgba",
        width: raster.width,
        height: raster.height,
        data: raster.data,
      },
      {
        ...signalOption,
        onProgress: (fraction) =>
          options.onEncoding?.(censusShare + (1 - censusShare) * fraction),
      },
    );
    return {
      blob: new Blob([bytes], { type: info.mime }),
      width: raster.width,
      height: raster.height,
      indexed: false,
      paletteEntries: 0,
      flattened: raster.flattened,
      hadTransparency: raster.hadTransparency,
      trace: null,
    };
  }

  const raster = await prepareRaster(frame, settings, {
    ...signalOption,
    ...(options.onScaling === undefined ? {} : { onProgress: options.onScaling }),
  });
  options.onEncoding?.(0);
  const blob = await encodeWithCanvas(raster, info.mime, {
    ...signalOption,
    quality: settings.quality,
  });
  options.onEncoding?.(1);
  return {
    blob,
    width: raster.width,
    height: raster.height,
    indexed: false,
    paletteEntries: 0,
    flattened: raster.flattened,
    hadTransparency: raster.hadTransparency,
    trace: null,
  };
}
