/**
 * The format table, the defaults, and the two ceilings the scale control obeys.
 *
 * All of it is pure arithmetic over a settings object and an extent, so the
 * whole file is tested without a browser, a device or an image — the same
 * arrangement `io/limits.ts` uses and for the same reason.
 *
 * ## The scale ceiling is derived, not declared
 *
 * F-EX-12's multiplier is unbounded in principle and very much bounded in
 * practice: the raster is 4 bytes a pixel, the PNG filter pass needs a second
 * copy of it, and both are ordinary JS heap. So the control's own maximum is
 * computed from the frame it would scale ({@link maxScaleFor}) rather than
 * being a constant the UI then has to clamp against. A control that cannot be
 * moved past the limit never has to refuse, and never silently produces
 * something smaller than the number on it.
 */

import { DEFAULT_TRACE_SETTINGS, clampTraceSettings } from "./trace";
import type { ExportFormat, ExportFormatInfo, ExportSettings } from "./types";

/**
 * 2^25 pixels — 128 MiB as 8-bit RGBA, and the PNG path holds a second buffer
 * of the same size while it filters. Above that a browser tab is one allocation
 * away from being killed, and a killed tab loses the document as well as the
 * export.
 */
export const MAX_EXPORT_PIXELS = 33_554_432;

/**
 * The largest multiplier offered whatever the arithmetic says.
 *
 * A 16x nearest-neighbour blow-up is already past the point where the result is
 * about the picture rather than about the pixels, and a stepper with sixty
 * positions is a stepper nobody reads.
 */
export const MAX_SCALE_MULTIPLIER = 16;

export const EXPORT_FORMATS: readonly ExportFormatInfo[] = [
  {
    id: "png",
    label: "PNG",
    mime: "image/png",
    extension: "png",
    alpha: true,
    lossy: false,
    vector: false,
    detail:
      "Lossless. Written here rather than by the browser, so an output with 256 " +
      "colours or fewer comes out as an indexed PNG — which is what the format is " +
      "for and is several times smaller than RGBA for a dither.",
  },
  {
    id: "jpeg",
    label: "JPEG",
    mime: "image/jpeg",
    extension: "jpg",
    alpha: false,
    lossy: true,
    vector: false,
    detail:
      "Lossy, and it has no alpha channel. Dither noise is the worst case for a " +
      "DCT — expect ringing around the dots at anything below the top of the " +
      "quality range.",
  },
  {
    id: "webp",
    label: "WebP",
    mime: "image/webp",
    extension: "webp",
    alpha: true,
    lossy: true,
    vector: false,
    detail:
      "Lossy, with alpha. Encoded by the browser; quality 100 is still lossy " +
      "here, because the canvas API exposes no lossless WebP mode.",
  },
  {
    id: "svg",
    label: "SVG",
    mime: "image/svg+xml",
    extension: "svg",
    // Not an alpha channel in the raster sense: an SVG layer is a fill colour,
    // so a palette entry that is not opaque is composited onto the matte first.
    // `alpha: false` is what makes the panel say that before the export runs.
    alpha: false,
    lossy: false,
    vector: true,
    detail:
      "Vector, traced from the picture: one <g> per colour, marked as a layer, " +
      "which is what a cutter or an embroidery machine understands. It needs a " +
      "picture of 256 colours or fewer — there is no vector form of a " +
      "continuous-tone image that is not a second quantization.",
  },
];

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  format: "png",
  // 92 rather than 100: the top of the range switches most encoders into a
  // near-lossless mode whose files are enormous for a gain nothing can see, and
  // a default that produces a surprising file size is a default that gets
  // blamed on the application.
  quality: 92,
  scale: 1,
  trace: DEFAULT_TRACE_SETTINGS,
};

export function formatInfo(format: ExportFormat): ExportFormatInfo {
  const found = EXPORT_FORMATS.find((entry) => entry.id === format);
  if (found === undefined) {
    // Unreachable through the union, reachable through a restored setting.
    throw new RangeError(`"${format}" is not an export format`);
  }
  return found;
}

export function isExportFormat(value: string): value is ExportFormat {
  return EXPORT_FORMATS.some((entry) => entry.id === value);
}

/**
 * The largest multiplier this frame can be exported at.
 *
 * Always at least 1: a frame already above the ceiling still exports at its own
 * size, because refusing to export what is on screen would be worse than the
 * memory pressure — and it is on screen, so the memory is already spent.
 */
export function maxScaleFor(width: number, height: number): number {
  const pixels = width * height;
  if (pixels <= 0) return 1;
  const byArea = Math.floor(Math.sqrt(MAX_EXPORT_PIXELS / pixels));
  return Math.max(1, Math.min(MAX_SCALE_MULTIPLIER, byArea));
}

/** The output extent for a scale multiplier. */
export function outputExtent(
  width: number,
  height: number,
  scale: number,
): { readonly width: number; readonly height: number } {
  return { width: width * scale, height: height * scale };
}

/**
 * Put a settings object inside its own legal range.
 *
 * Called when a frame changes size, which can move the scale ceiling under a
 * setting that was legal a moment ago. It clamps rather than throws because
 * there is nothing a person did wrong: they scaled a small image by 8 and then
 * opened a large one.
 */
export function clampSettings(
  settings: ExportSettings,
  width: number,
  height: number,
): ExportSettings {
  const maxScale = maxScaleFor(width, height);
  const scale = Math.max(1, Math.min(maxScale, Math.trunc(settings.scale)));
  const quality = Math.max(1, Math.min(100, Math.round(settings.quality)));
  const trace = clampTraceSettings(settings.trace);
  if (scale === settings.scale && quality === settings.quality && trace === settings.trace) {
    return settings;
  }
  return { ...settings, scale, quality, trace };
}

/** Bytes as a person reads them. Used by the estimate and by the result line. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
