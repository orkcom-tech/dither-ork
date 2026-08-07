/**
 * Animated export — the loop leaves the browser.
 *
 * F-EX-04 GIF with the document's own colours as the global table and no second
 * quantization, F-EX-05 APNG and animated WebP, F-EX-06 a PNG sequence as a ZIP
 * and a sprite sheet with a configurable column count, F-EX-07 MP4 and WebM
 * through WebCodecs' `VideoEncoder`, F-EX-13 per-frame progress and a cancel
 * that stops the work, F-EX-14 a measured size estimate, and F-AN-06's loop-seam
 * check as the gate all of it goes through.
 *
 * ```ts
 * const settings = clampAnimatedSettings(current, width, height, frames);
 * const name = animatedFileName(subject.name, settings, subject.frames);
 * const destination = await chooseDestination(name, "png");
 * if (destination !== null) {
 *   await runAnimatedExport({ source, settings, destination, gif: core, onProgress });
 * }
 * ```
 *
 * ## Five decisions this module rests on, each argued where it is made
 *
 * - **The palette is the loop's own colours** (`palette.ts`). Not the document's
 *   palette read out of the graph, because a postprocess node writes over the
 *   top of it; and never a fresh quantization, because that would dither a
 *   dither.
 * - **GIF is Rust and nothing else is** (`gif.ts`, `dither-core/src/encode.rs`).
 *   LZW is a serial dictionary loop no platform exposes. APNG and the sequence
 *   are deflate, which every platform ships natively and which
 *   `export/zlib.ts` already records as a thing this repository will not
 *   reimplement.
 * - **An APNG frame is a PNG frame** (`apng.ts`). The still encoder writes it
 *   and this module relabels the `IDAT`, so the animated and still outputs of
 *   one frame cannot disagree.
 * - **An animated WebP frame is a still WebP frame** (`webp.ts`). The browser's
 *   own encoder produces every byte of image data; only the container is
 *   assembled here.
 * - **A video is coded chunks plus a muxer** (`video.ts`, `mp4.ts`, `webm.ts`).
 *   No ffmpeg, no decoder — which is exactly what dropping video *input* buys.
 *
 * ## What is not here
 *
 * Nothing is stubbed. Every format listed above writes a real file; a format
 * this browser cannot encode is refused by name, with the reason and the
 * alternative, rather than silently substituted.
 *
 * The one thing this module cannot do for itself is reach the WASM core: `gif.ts`
 * declares {@link GifCore} and the adapter that satisfies it from the render
 * worker's `dither-wasm` instance lives outside this directory, exactly as
 * `export/trace.ts` declares `VectorTracer` and `ui/export/session.ts` satisfies
 * it. Two calls: `new GifAnimation(w, h)` for `createAnimation`, and the
 * instance's own `pushFrame`/`finish`, whose names and shapes already match.
 */

export type {
  AnimatedCarrier,
  AnimatedEncoder,
  AnimatedFormat,
  AnimatedFormatInfo,
  AnimatedResult,
  AnimatedSettings,
  AnimatedTiming,
  LoopPalette,
  VideoCodec,
  VideoCodecInfo,
} from "./types";

export type { CodedFrame, MuxedTrack } from "./video-types";

export {
  ANIMATED_FORMATS,
  DEFAULT_ANIMATED_SETTINGS,
  MAX_ANIMATED_FRAME_PIXELS,
  MAX_ANIMATED_SCALE,
  MAX_BITRATE_KBPS,
  MAX_LOOP_INDEX_BYTES,
  MAX_SHEET_COLUMNS,
  MIN_BITRATE_KBPS,
  VIDEO_CODECS,
  animatedExtent,
  animatedFormatInfo,
  clampAnimatedSettings,
  codecsFor,
  isAnimatedFormat,
  isVideoCodec,
  maxAnimatedScaleFor,
  sheetGrid,
  videoCodecInfo,
} from "./settings";

export {
  ANIMATED_STAGES,
  ANIMATED_STAGE_WEIGHTS,
  ExportCancelledError,
  animatedProgress,
  isCancellation,
  shouldYield,
  throwIfCancelled,
  yieldToHost,
  type AnimatedProgress,
  type AnimatedProgressListener,
  type AnimatedStage,
} from "./progress";

export {
  LoopSeamError,
  type AnimatedFrameSource,
  type AnimatedRenderRequest,
  type AnimatedSubject,
} from "./source";

export {
  LoopPaletteBuilder,
  paletteAsRgbTriplets,
  replicateIndices,
  type FrameIndexResult,
  type PixelSource,
} from "./palette";

export {
  GifPaletteError,
  MAX_GIF_FPS,
  MIN_GIF_DELAY,
  createGifEncoder,
  gifDelayFor,
  gifPlaybackFps,
  type GifCore,
  type GifCoreAnimation,
  type GifCoreResult,
} from "./gif";

export {
  apngDelayFor,
  changedRect,
  createApngEncoder,
  crop,
  extractIdat,
  type ApngDelay,
  type Rect,
} from "./apng";

export {
  createAnimatedWebpEncoder,
  imageChunksOf,
  riffChunk,
  riffFile,
  webpDurationFor,
} from "./webp";

export { createPngSequenceEncoder, createSpriteSheetEncoder, sequenceEntryName } from "./sequence";

export { muxWebm, vint } from "./webm";
export { box, muxMp4 } from "./mp4";

export {
  VideoEncoderUnavailableError,
  createVideoEncoder,
  probeVideoCodec,
  videoEncodingAvailable,
  type VideoSupport,
} from "./video";

export {
  animatedFileName,
  createAnimatedEncoder,
  encodeAnimation,
  runAnimatedExport,
  type AnimatedJobRequest,
  type RunAnimatedExportRequest,
} from "./job";

export {
  ESTIMATE_EXACT_FRAMES,
  ESTIMATE_SAMPLE_FRAMES,
  estimateAnimatedSize,
  estimateSampleFrames,
  type AnimatedEstimateOptions,
  type AnimatedSizeEstimate,
} from "./estimate";
