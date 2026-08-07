/**
 * Export — the point at which a picture leaves the browser.
 *
 * F-EX-01 PNG (indexed when the output is indexed), F-EX-02 JPEG with quality,
 * F-EX-03 WebP, F-EX-08 SVG traced from the picture with F-EX-09's two output
 * modes and F-EX-10's minimum feature size and stroke output, F-EX-12 an
 * integer nearest-neighbour scale independent of preview zoom, F-EX-13 progress
 * with a cancel that stops work, F-EX-14 a pre-export size estimate, F-EX-15
 * copy to the clipboard.
 *
 * ```ts
 * const frame = await source.renderFrame();          // the picture on screen
 * const census = { indexed: await indexImage(frame.width, frame.height, frame.data) };
 * const estimate = await estimateExportSize(frame, settings, { census });
 * const destination = await chooseDestination(exportFileName(name, settings), settings.format);
 * if (destination !== null) {
 *   await runExport({ frame, settings, census, destination, onProgress });
 * }
 * ```
 *
 * Three decisions this module rests on, each argued where it is made:
 *
 * - **The frame is the preview's frame** (`source.ts`). Preview and export do
 *   not merely share a graph, they share a render, so a file cannot disagree
 *   with the picture it came from.
 * - **"Indexed" is a fact about the finished pixels, not about the graph**
 *   (`census.ts`). The graph's index map describes the frame at the quantizer,
 *   and anything after it writes over the top.
 * - **PNG is written here; JPEG and WebP are the browser's; SVG is the Rust
 *   core's** (`png.ts`, `bitmap.ts`, `trace.ts`). No browser will write a
 *   palette PNG, nobody should write a JPEG encoder, and the contour tracer is
 *   a thousand lines of Rust that has no business being rewritten in TS.
 *
 * What is *not* here, and is left out rather than stubbed: animated export
 * (F-EX-04 through F-EX-07), the PNG sequence, and F-EX-11's vector
 * simplification budget. They need an encoder that does not exist yet. The
 * progress and cancellation path they will land on does exist, and is the
 * reason it is built for a still that finishes in a second.
 */

export type {
  ExportFormat,
  ExportFormatInfo,
  ExportFrame,
  ExportRaster,
  ExportResult,
  ExportSettings,
  IndexedImage,
  TraceMode,
  VectorTraceReport,
  VectorTraceSettings,
} from "./types";

export {
  DEFAULT_TRACE_SETTINGS,
  MAX_MIN_FEATURE_AREA,
  MAX_STROKE_WIDTH,
  MAX_TRACE_TOLERANCE,
  TRACE_MODES,
  TRACE_MODE_DETAIL,
  TRACE_MODE_LABEL,
  clampTraceSettings,
  isTraceMode,
  paletteAsRgb,
  traceIndexedImage,
  traceReportSummary,
  widenIndices,
  type TracedDocument,
  type VectorTracer,
} from "./trace";

export {
  DEFAULT_EXPORT_SETTINGS,
  EXPORT_FORMATS,
  MAX_EXPORT_PIXELS,
  MAX_SCALE_MULTIPLIER,
  clampSettings,
  formatBytes,
  formatInfo,
  isExportFormat,
  maxScaleFor,
  outputExtent,
} from "./settings";

export {
  EXPORT_STAGES,
  ExportCancelledError,
  STAGE_WEIGHTS,
  isCancellation,
  overallProgress,
  shouldYield,
  stageReporter,
  throwIfCancelled,
  yieldToHost,
  type ExportProgress,
  type ExportStage,
  type ProgressListener,
} from "./progress";

export { crc32, crc32Final, crc32Of } from "./crc32";
export { deflate, inflate, type DeflateOptions } from "./zlib";

export {
  MAX_PALETTE_ENTRIES,
  bitDepthFor,
  indexImage,
  scaleIndices,
  sliceIndexed,
  type CensusOptions,
} from "./census";

export {
  FILTER_AVERAGE,
  FILTER_NONE,
  FILTER_PAETH,
  FILTER_SUB,
  FILTER_UP,
  encodePng,
  indexedRowBytes,
  type EncodePngOptions,
  type PngImage,
} from "./png";

export { scaleNearest, type ScaleOptions, type ScaledImage } from "./scale";
export {
  EXPORT_MATTE,
  flattenOntoMatte,
  isFullyOpaque,
  type FlattenOptions,
  type FlattenResult,
} from "./flatten";
export { prepareRaster, type PrepareRasterOptions } from "./raster";

export {
  ExportEncoderError,
  canvasEncoderSupport,
  encodeWithCanvas,
  type CanvasEncodeOptions,
} from "./bitmap";

export {
  encodeFrame,
  type EncodeFrameOptions,
  type EncodedFrame,
  type FrameCensus,
} from "./encode";

export {
  ESTIMATE_PIXEL_BUDGET,
  estimateExportSize,
  sliceFrame,
  type EstimateOptions,
  type SizeEstimate,
} from "./estimate";

export { UNTITLED_BASE, baseName, exportFileName } from "./filename";

export {
  chooseDestination,
  chooseDestinationForType,
  deliveryCapability,
  writeToDestination,
  type DeliveryCapability,
  type DeliveryKind,
  type Destination,
  type DestinationType,
} from "./destination";

export {
  CLIPBOARD_MIME,
  clipboardCapability,
  copyImageToClipboard,
  type ClipboardCapability,
} from "./clipboard";

export { encodeExport, runExport, type ExportJobRequest, type RunExportRequest } from "./job";

export type { ExportImageSource, ExportSubject } from "./source";
