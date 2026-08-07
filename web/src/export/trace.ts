/**
 * F-EX-08, F-EX-09, F-EX-10 — the vector half of export.
 *
 * The tracing itself is in `core/crates/dither-core/src/trace.rs` and reaches
 * the browser through `dither-wasm`. This file is the contract between the two:
 * what export needs done, in export's own vocabulary, plus the pure conversions
 * either side of it. The adapter that satisfies {@link VectorTracer} from the
 * editor session's core lives in `web/src/ui/export/session.ts`, which is the
 * same arrangement {@link ExportImageSource} already uses and for the same
 * reason — nothing in this directory may know that a `DitherCore`, a document
 * store or a renderer exist.
 *
 * ## What is traced is the finished picture, not the graph's index map
 *
 * The render graph carries an index map after a quantizing node, and it is
 * tempting to trace that. `census.ts` argues at length why the frame's own
 * colours are the only correct answer for PNG, and every word of it applies
 * here: a stack can put an emboss after the dither, and tracing the quantizer's
 * map would produce a drawing of a picture nobody has seen. So the tracer is
 * given the same {@link IndexedImage} the indexed-PNG path is given, and one
 * `<g>` comes out per colour that is actually in the file.
 *
 * The consequence is worth stating plainly: **a frame with more than 256
 * distinct colours cannot be traced.** There is no vector representation of a
 * continuous-tone image that is not a quantization, and quantizing at export
 * time would be a second dither the document never asked for. The panel says so
 * and offers PNG; it does not silently posterize.
 *
 * ## Alpha
 *
 * The tracer's palette is RGB triplets: an SVG layer is a fill colour, and
 * there is nowhere in a one-colour-per-group document for a per-pixel coverage
 * value to live. So a palette entry that is not fully opaque is composited onto
 * the export matte first, through the same linear-light table JPEG's flatten
 * uses — {@link flattenPaletteOntoMatte} is that call, applied to the palette
 * rather than to the pixels, which is identical in result and 256 times cheaper
 * because a palette entry is one colour however many pixels wear it.
 */

import { flattenOntoMatte, EXPORT_MATTE } from "./flatten";
import type { SrgbTriplet } from "../types/document";
import type {
  Bytes,
  IndexedImage,
  TraceMode,
  VectorTraceReport,
  VectorTraceSettings,
} from "./types";

/** A traced document and what producing it did. */
export interface TracedDocument {
  /**
   * The complete SVG document. Every coordinate is an integer pixel corner, so
   * adjacent colours share their boundary exactly and there is no seam.
   */
  readonly svg: string;
  readonly report: VectorTraceReport;
}

/**
 * What export asks of the core to produce a vector file.
 *
 * Synchronous, because the core's tracer is: it is a single WASM call over a
 * buffer that is already in memory. The stage is reported around it rather than
 * inside it, which is the same position `encodeWithCanvas` is in.
 */
export interface VectorTracer {
  trace(
    indices: Uint16Array,
    width: number,
    height: number,
    paletteRgb: Uint8Array,
    settings: VectorTraceSettings,
  ): TracedDocument;
}

export const TRACE_MODES: readonly TraceMode[] = ["pixel-perfect", "simplified"];

export const TRACE_MODE_LABEL: Record<TraceMode, string> = {
  "pixel-perfect": "Pixel perfect",
  simplified: "Simplified",
};

export const TRACE_MODE_DETAIL: Record<TraceMode, string> = {
  "pixel-perfect":
    "The exact pixel staircase. Rasterized at 1:1 it reproduces the picture cell " +
    "for cell, and every dot of a dither becomes its own square.",
  simplified:
    "Douglas-Peucker over that staircase. Vertices are dropped, never moved, so " +
    "the outline still sits on the pixel grid — it just has fewer corners.",
};

/** The largest tolerance offered. Past this a dither is a smear, not a shape. */
export const MAX_TRACE_TOLERANCE = 8;
/** The largest minimum feature area offered, in pixels. */
export const MAX_MIN_FEATURE_AREA = 4096;
/** The largest stroke width offered, in pixel units. */
export const MAX_STROKE_WIDTH = 16;

export const DEFAULT_TRACE_SETTINGS: VectorTraceSettings = {
  mode: "pixel-perfect",
  // Carried rather than zero so that switching the mode on does not immediately
  // produce a no-op — the same reason the core's own `TraceOptions` does it.
  tolerance: 1,
  minFeatureArea: 0,
  strokeOnly: false,
  strokeWidth: 1,
};

export function isTraceMode(value: string): value is TraceMode {
  return TRACE_MODES.includes(value as TraceMode);
}

/**
 * Put trace settings inside the range the core will accept.
 *
 * The core throws on a negative tolerance or a non-positive stroke width, and a
 * throw out of a WASM call is a rejected export rather than a refused control.
 * Clamping here means the panel cannot express a value the core refuses.
 */
export function clampTraceSettings(settings: VectorTraceSettings): VectorTraceSettings {
  const tolerance = clamp(settings.tolerance, 0, MAX_TRACE_TOLERANCE);
  const minFeatureArea = Math.round(clamp(settings.minFeatureArea, 0, MAX_MIN_FEATURE_AREA));
  const strokeWidth = clamp(settings.strokeWidth, 0.1, MAX_STROKE_WIDTH);
  if (
    tolerance === settings.tolerance &&
    minFeatureArea === settings.minFeatureArea &&
    strokeWidth === settings.strokeWidth
  ) {
    return settings;
  }
  return { ...settings, tolerance, minFeatureArea, strokeWidth };
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return value < low ? low : value > high ? high : value;
}

/**
 * The census's one-byte indices as the boundary's `Uint16Array`.
 *
 * A widening copy rather than a cast: `census.ts` allocates `Uint8Array`
 * because a PNG palette holds at most 256 entries, and the tracer's boundary
 * takes `u16` because an index map is not a PNG palette. The copy is the honest
 * cost of the two being different types, and it is one pass over one byte per
 * pixel.
 */
export function widenIndices(indices: Uint8Array): Uint16Array {
  const out = new Uint16Array(indices.length);
  out.set(indices);
  return out;
}

/**
 * RGBA palette entries as the packed sRGB triplets the boundary takes.
 *
 * Non-opaque entries are composited onto `matte` first — see the note at the
 * top about why that happens here and not per pixel. Returns the triplets and
 * whether anything was actually composited, because the panel states it.
 */
export async function paletteAsRgb(
  palette: Bytes,
  matte: SrgbTriplet = EXPORT_MATTE,
): Promise<{ readonly rgb: Uint8Array; readonly flattened: boolean }> {
  // A copy, because `flattenOntoMatte` works in place and the caller's palette
  // is also what the indexed-PNG path would write.
  const copy = new Uint8Array(palette) as Bytes;
  const { hadTransparency } = await flattenOntoMatte(copy, matte);

  const count = Math.floor(copy.length / 4);
  const rgb = new Uint8Array(count * 3);
  for (let entry = 0; entry < count; entry += 1) {
    rgb[entry * 3] = copy[entry * 4] ?? 0;
    rgb[entry * 3 + 1] = copy[entry * 4 + 1] ?? 0;
    rgb[entry * 3 + 2] = copy[entry * 4 + 2] ?? 0;
  }
  return { rgb, flattened: hadTransparency };
}

/** Trace an indexed frame. The one call the rest of export makes. */
export async function traceIndexedImage(
  tracer: VectorTracer,
  image: IndexedImage,
  settings: VectorTraceSettings,
): Promise<{ readonly traced: TracedDocument; readonly flattened: boolean }> {
  const { rgb, flattened } = await paletteAsRgb(image.palette);
  const traced = tracer.trace(
    widenIndices(image.indices),
    image.width,
    image.height,
    rgb,
    clampTraceSettings(settings),
  );
  return { traced, flattened };
}

/**
 * The sentence the panel puts under a finished trace.
 *
 * Every clause is conditional on the thing it describes having happened, so a
 * pixel-perfect trace with no minimum feature size gets one short line rather
 * than a row of zeroes.
 */
export function traceReportSummary(report: VectorTraceReport, pixels: number): string {
  const parts = [
    `${report.layers} layer${report.layers === 1 ? "" : "s"}`,
    `${report.contours} contour${report.contours === 1 ? "" : "s"}`,
    `${report.points} points`,
  ];
  if (report.regionsDropped > 0) {
    parts.push(`${report.regionsDropped} regions removed as too small`);
  }
  if (report.holesFilled > 0) parts.push(`${report.holesFilled} holes filled`);
  if (report.contoursDropped > 0) {
    parts.push(`${report.contoursDropped} contours collapsed by the tolerance`);
  }
  if (report.uncoveredPixels > 0 && pixels > 0) {
    const percent = (report.uncoveredPixels / pixels) * 100;
    parts.push(
      `${percent < 0.1 ? "<0.1" : percent.toFixed(1)}% of the picture is left bare`,
    );
  }
  return parts.join(", ") + ".";
}
