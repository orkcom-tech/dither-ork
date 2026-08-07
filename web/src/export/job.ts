/**
 * One export, end to end: frame in, file out, with F-EX-13's progress and
 * cancel threaded through every stage of it.
 *
 * The rendering stage is not here. The panel renders the frame before this is
 * called — it needs one anyway for the size estimate — and reports that stage
 * itself; by the time a job starts, the picture exists and the only question is
 * what to do with it. That split is also what makes the export match the
 * estimate exactly: both encode the same frame.
 *
 * ## Cancellation
 *
 * Every stage takes the same `AbortSignal` and every long loop inside them
 * checks it. A cancel therefore stops work rather than stopping reporting,
 * which is the property docs/API.md asks of the export worker's `cancel()` and
 * which this path will hand it when animated export arrives.
 *
 * The one thing a cancel cannot interrupt is a `convertToBlob` already inside
 * the browser's JPEG encoder. That is native code with no abort surface; the
 * signal is checked on both sides of it, so the job stops as soon as it
 * returns, and no file is written.
 */

import { logger } from "../lib/log";
import { writeToDestination, type Destination } from "./destination";
import { encodeFrame, type FrameCensus } from "./encode";
import {
  overallProgress,
  stageReporter,
  throwIfCancelled,
  type ProgressListener,
} from "./progress";
import { formatBytes } from "./settings";
import type { VectorTracer } from "./trace";
import type { ExportFrame, ExportResult, ExportSettings } from "./types";

const log = logger("export");

export interface ExportJobRequest {
  readonly frame: ExportFrame;
  readonly settings: ExportSettings;
  /** The frame's census, computed once by the panel and reused. */
  readonly census?: FrameCensus;
  /** The core's tracer. Required by, and only read by, a vector format. */
  readonly tracer?: VectorTracer;
  readonly signal?: AbortSignal;
  readonly onProgress?: ProgressListener;
}

/**
 * Encode without writing anywhere.
 *
 * Used on its own by the clipboard path (F-EX-15), which has a destination of
 * its own, and by {@link runExport} for everything else.
 */
export async function encodeExport(request: ExportJobRequest): Promise<ExportResult> {
  const started = performance.now();
  throwIfCancelled(request.signal);

  const listener = request.onProgress;
  const encoded = await encodeFrame(request.frame, request.settings, {
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.census === undefined ? {} : { census: request.census }),
    ...(request.tracer === undefined ? {} : { tracer: request.tracer }),
    onScaling: stageReporter("scaling", `scaling ${request.settings.scale}x`, listener),
    onEncoding: stageReporter(
      "encoding",
      `encoding ${request.settings.format.toUpperCase()}`,
      listener,
    ),
  });

  const result: ExportResult = {
    blob: encoded.blob,
    format: request.settings.format,
    width: encoded.width,
    height: encoded.height,
    bytes: encoded.blob.size,
    indexed: encoded.indexed,
    paletteEntries: encoded.paletteEntries,
    flattened: encoded.flattened,
    trace: encoded.trace,
    ms: Math.round(performance.now() - started),
  };

  log.info("export encoded", {
    format: result.format,
    width: result.width,
    height: result.height,
    scale: request.settings.scale,
    indexed: result.indexed,
    paletteEntries: result.paletteEntries,
    flattened: result.flattened,
    bytes: result.bytes,
    size: formatBytes(result.bytes),
    ms: result.ms,
  });
  return result;
}

export interface RunExportRequest extends ExportJobRequest {
  /**
   * Where it goes. Chosen *before* the encode — `showSaveFilePicker` needs the
   * click's user activation and the encode outlives it. See `destination.ts`.
   */
  readonly destination: Destination;
}

export async function runExport(request: RunExportRequest): Promise<ExportResult> {
  const result = await encodeExport(request);
  throwIfCancelled(request.signal);

  request.onProgress?.({
    stage: "writing",
    completed: overallProgress("writing", 0),
    detail: "writing the file",
  });
  await writeToDestination(request.destination, result.blob);
  request.onProgress?.({
    stage: "writing",
    completed: 1,
    detail: `wrote ${formatBytes(result.bytes)}`,
  });
  return result;
}
