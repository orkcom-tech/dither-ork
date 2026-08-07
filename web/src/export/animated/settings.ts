/**
 * The animated format table, the codec table, the defaults, and the ceilings.
 *
 * Pure arithmetic over a settings object and an extent, so the whole file is
 * tested without a browser, a device or an image — the same arrangement
 * `export/settings.ts` uses and for the same reason.
 *
 * ## The scale ceiling is derived from the loop, not from one frame
 *
 * The still module computes a per-frame ceiling from the memory a single raster
 * and its filter copy need. An animation multiplies the second term by the
 * frame count for GIF, whose index maps are all held until the colour table is
 * known, so {@link maxAnimatedScaleFor} takes the frame count as well. A
 * 60-frame loop is not allowed the 16x a still is, and the control simply does
 * not offer it rather than offering it and then failing.
 */

import type {
  AnimatedFormat,
  AnimatedFormatInfo,
  AnimatedSettings,
  VideoCodec,
  VideoCodecInfo,
} from "./types";

/**
 * 2^25 pixels per frame — the same ceiling `export/settings.ts` sets on a still,
 * and for the same reason: above it a tab is one allocation from being killed.
 */
export const MAX_ANIMATED_FRAME_PIXELS = 33_554_432;

/**
 * 2^28 bytes of palette index map across the whole loop.
 *
 * The GIF path is the one that holds every frame at once, at one byte a pixel.
 * 256 MiB is half the core's own ceiling, so the JS side refuses first and can
 * say which control to move; the core's guard stays as the thing that catches a
 * caller that did not check.
 */
export const MAX_LOOP_INDEX_BYTES = 268_435_456;

/** The largest multiplier offered whatever the arithmetic says. */
export const MAX_ANIMATED_SCALE = 8;

/** The largest sprite sheet column count offered. */
export const MAX_SHEET_COLUMNS = 64;

/** Video bitrate bounds, in kilobits per second. */
export const MIN_BITRATE_KBPS = 100;
export const MAX_BITRATE_KBPS = 200_000;

export const ANIMATED_FORMATS: readonly AnimatedFormatInfo[] = [
  {
    id: "gif",
    label: "GIF",
    mime: "image/gif",
    extension: "gif",
    carrier: "palette",
    alpha: true,
    lossy: false,
    plays: true,
    loops: true,
    detail:
      "The document's own colours become the global colour table directly — " +
      "there is no second quantization, so a dither is never dithered again. " +
      "It compresses dither noise badly: LZW needs repeated runs and a dither " +
      "has none. Expect roughly the size of one PNG of the picture per frame; " +
      "the export reports what it actually came to.",
  },
  {
    id: "apng",
    label: "APNG",
    mime: "image/apng",
    extension: "png",
    carrier: "lossless",
    alpha: true,
    lossy: false,
    plays: true,
    loops: true,
    detail:
      "Lossless with full alpha, and indexed automatically when the loop has " +
      "256 colours or fewer — which for a dither is most of the size. Every " +
      "target browser plays it; some older image viewers show only frame one.",
  },
  {
    id: "webp",
    label: "WebP (animated)",
    mime: "image/webp",
    extension: "webp",
    carrier: "browser",
    alpha: true,
    lossy: true,
    plays: true,
    loops: true,
    detail:
      "Each frame is encoded by the browser's own WebP encoder and the frames " +
      "are assembled into one animation here. Lossy, with alpha; usually much " +
      "smaller than the GIF of the same loop.",
  },
  {
    id: "webm",
    label: "WebM",
    mime: "video/webm",
    extension: "webm",
    carrier: "video",
    // The alpha channel a WebM *can* carry needs a second coded stream per
    // frame, which `VideoEncoder` does not produce. Stated as false so the
    // panel warns before the export rather than after it.
    alpha: false,
    lossy: true,
    plays: true,
    loops: false,
    detail:
      "VP9 or VP8 through the browser's video encoder. By far the smallest of " +
      "the moving formats and the only one whose size you set directly. It has " +
      "no alpha here and no loop flag — a player decides whether to repeat.",
  },
  {
    id: "mp4",
    label: "MP4",
    mime: "video/mp4",
    extension: "mp4",
    carrier: "video",
    alpha: false,
    lossy: true,
    plays: true,
    loops: false,
    detail:
      "H.264 or AV1 in an ISO base media container. The format everything " +
      "plays. Dither noise is expensive for a video codec too — it is exactly " +
      "the high-frequency detail the transform is built to throw away — so " +
      "give it a generous bitrate or it will smear.",
  },
  {
    id: "png-sequence",
    label: "PNG sequence (ZIP)",
    mime: "application/zip",
    extension: "zip",
    carrier: "lossless",
    alpha: true,
    lossy: false,
    plays: false,
    loops: false,
    detail:
      "One numbered PNG per frame in a ZIP, each written by the same encoder " +
      "the still export uses and therefore indexed when the frame is. The " +
      "output to hand to another tool.",
  },
  {
    id: "sprite-sheet",
    label: "Sprite sheet (PNG)",
    mime: "image/png",
    extension: "png",
    carrier: "lossless",
    alpha: true,
    lossy: false,
    plays: false,
    loops: false,
    detail:
      "Every frame tiled into one PNG at a column count you choose. Indexed " +
      "when the loop is, which is what makes a sheet of a dither smaller than " +
      "the frames that went into it.",
  },
];

export const VIDEO_CODECS: readonly VideoCodecInfo[] = [
  {
    id: "avc",
    label: "H.264",
    // Baseline profile, level 5.0 — the widest-playing configuration there is,
    // and the level is high enough for 4K at 30 fps.
    codec: "avc1.420032",
    container: "mp4",
    detail: "Plays everywhere. The safe choice, and the largest of the four.",
  },
  {
    id: "av1",
    label: "AV1",
    // Main profile, level 5.1, 8-bit.
    codec: "av01.0.08M.08",
    container: "mp4",
    detail:
      "Much smaller than H.264 at the same quality, and much slower to encode. " +
      "Not every browser can write it; the control says which.",
  },
  {
    id: "vp9",
    label: "VP9",
    codec: "vp09.00.10.08",
    container: "webm",
    detail: "The default for WebM. Small, and every target browser encodes it.",
  },
  {
    id: "vp8",
    label: "VP8",
    codec: "vp8",
    container: "webm",
    detail: "Older and faster than VP9, and larger. Useful when VP9 is refused.",
  },
];

export const DEFAULT_ANIMATED_SETTINGS: AnimatedSettings = {
  format: "gif",
  // 92 for the same reason the still default is 92: the top of the range buys
  // a size nobody expects for a difference nobody sees.
  quality: 92,
  scale: 1,
  loop: true,
  columns: 8,
  codec: "vp9",
  // 8 Mb/s. High for the resolutions this application produces, deliberately:
  // a dither is the worst case for a video codec, and a default that smears is
  // a default that gets blamed on the dither.
  bitrateKbps: 8000,
};

export function animatedFormatInfo(format: AnimatedFormat): AnimatedFormatInfo {
  const found = ANIMATED_FORMATS.find((entry) => entry.id === format);
  if (found === undefined) {
    // Unreachable through the union, reachable through a restored setting.
    throw new RangeError(`"${format}" is not an animated export format`);
  }
  return found;
}

export function isAnimatedFormat(value: string): value is AnimatedFormat {
  return ANIMATED_FORMATS.some((entry) => entry.id === value);
}

export function videoCodecInfo(codec: VideoCodec): VideoCodecInfo {
  const found = VIDEO_CODECS.find((entry) => entry.id === codec);
  if (found === undefined) throw new RangeError(`"${codec}" is not a video codec`);
  return found;
}

export function isVideoCodec(value: string): value is VideoCodec {
  return VIDEO_CODECS.some((entry) => entry.id === value);
}

/** The codecs that belong in a container. */
export function codecsFor(format: AnimatedFormat): readonly VideoCodecInfo[] {
  if (format !== "mp4" && format !== "webm") return [];
  return VIDEO_CODECS.filter((entry) => entry.container === format);
}

/**
 * The largest multiplier this loop can be exported at, in this format.
 *
 * Two ceilings, and the smaller wins. Every format pays the per-frame one; GIF
 * additionally pays a whole-loop one, because its index maps are all live at
 * once until the colour table is known.
 *
 * Always at least 1: a loop already above the ceiling still exports at its own
 * size, for the reason the still module gives — it is on screen, so the memory
 * is already spent.
 */
export function maxAnimatedScaleFor(
  width: number,
  height: number,
  frames: number,
  format: AnimatedFormat,
): number {
  const pixels = width * height;
  if (pixels <= 0 || frames <= 0) return 1;

  const byFrame = Math.floor(Math.sqrt(MAX_ANIMATED_FRAME_PIXELS / pixels));
  let limit = Math.min(MAX_ANIMATED_SCALE, byFrame);

  if (animatedFormatInfo(format).carrier === "palette") {
    const byLoop = Math.floor(Math.sqrt(MAX_LOOP_INDEX_BYTES / (pixels * frames)));
    limit = Math.min(limit, byLoop);
  }
  return Math.max(1, limit);
}

/**
 * Put a settings object inside its own legal range.
 *
 * Clamps rather than throws, for the same reason the still one does: there is
 * nothing a person did wrong when they scaled a short loop by 8 and then made
 * the loop four times longer.
 *
 * The codec is *switched*, not clamped, when the format changes container —
 * a WebM cannot hold H.264 — and the panel shows the new one rather than
 * exporting something other than what the control says.
 */
export function clampAnimatedSettings(
  settings: AnimatedSettings,
  width: number,
  height: number,
  frames: number,
): AnimatedSettings {
  const maxScale = maxAnimatedScaleFor(width, height, frames, settings.format);
  const scale = Math.max(1, Math.min(maxScale, Math.trunc(settings.scale)));
  const quality = Math.max(1, Math.min(100, Math.round(settings.quality)));
  const columns = Math.max(
    1,
    Math.min(MAX_SHEET_COLUMNS, Math.max(1, frames), Math.trunc(settings.columns)),
  );
  const bitrateKbps = Math.max(
    MIN_BITRATE_KBPS,
    Math.min(MAX_BITRATE_KBPS, Math.round(settings.bitrateKbps)),
  );

  const allowed = codecsFor(settings.format);
  const codec =
    allowed.length === 0 || allowed.some((entry) => entry.id === settings.codec) ?
      settings.codec
    : (allowed[0]?.id ?? settings.codec);

  if (
    scale === settings.scale &&
    quality === settings.quality &&
    columns === settings.columns &&
    bitrateKbps === settings.bitrateKbps &&
    codec === settings.codec
  ) {
    return settings;
  }
  return { ...settings, scale, quality, columns, bitrateKbps, codec };
}

/** The output extent for a scale multiplier. */
export function animatedExtent(
  width: number,
  height: number,
  settings: AnimatedSettings,
  frames: number,
): { readonly width: number; readonly height: number } {
  const w = width * settings.scale;
  const h = height * settings.scale;
  if (settings.format !== "sprite-sheet") return { width: w, height: h };
  const columns = Math.max(1, Math.min(settings.columns, Math.max(1, frames)));
  const rows = Math.ceil(frames / columns);
  return { width: w * columns, height: h * rows };
}

/**
 * The number of rows a sheet of `frames` at `columns` columns needs.
 *
 * Separate from {@link animatedExtent} because the sheet's own encoder needs the
 * grid rather than the pixels, and two places computing `ceil(frames/columns)`
 * is one place too many for a number that decides where every frame lands.
 */
export function sheetGrid(
  frames: number,
  columns: number,
): { readonly columns: number; readonly rows: number } {
  const wide = Math.max(1, Math.min(Math.trunc(columns), Math.max(1, frames)));
  return { columns: wide, rows: Math.ceil(Math.max(1, frames) / wide) };
}
