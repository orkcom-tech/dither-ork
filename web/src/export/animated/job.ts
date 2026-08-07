/**
 * One animated export, end to end: a loop in, a file out, with F-EX-13's
 * per-frame progress and a cancel that stops the work threaded through every
 * stage of it.
 *
 * ```ts
 * const result = await runAnimatedExport({
 *   source, settings, destination, gif: core, onProgress,
 * });
 * ```
 *
 * ## The seam is checked before anything renders — F-AN-06
 *
 * This is the first thing the job does and it is not optional. A loop whose
 * frame `N` is not frame `0` visibly jumps every time it repeats, and the jump
 * is the sort of thing that is noticed after the file has been sent somewhere.
 * The check is a hash comparison of two prepared graphs — no rendering at all —
 * so refusing costs milliseconds and exporting a broken loop costs minutes.
 *
 * Warnings do not stop it. A hold that does not divide the frame count, a
 * modulator sampled below Nyquist, a binding that clips: each of those is a loop
 * that closes and looks like something the person may well have chosen. They are
 * carried into {@link AnimatedResult.notes} and shown, not enforced.
 *
 * ## Cancellation
 *
 * Every stage takes the same `AbortSignal`, every long loop inside them checks
 * it, and the render itself is abandoned rather than merely ignored — the
 * signal reaches `graph/render.ts`, which checks it before each plan step. So a
 * cancel stops work rather than stopping reporting, which is what F-EX-13 asks
 * for and what a 60-frame export makes worth having.
 *
 * The one thing a cancel cannot interrupt is a `convertToBlob` already inside
 * the browser's WebP encoder, or a `VideoEncoder.flush` already running. Both
 * are native code with no abort surface; the signal is checked on both sides,
 * so the job stops as soon as they return and no file is written.
 */

import { logger } from "../../lib/log";
import { writeToDestination, type Destination } from "../destination";
import { baseName } from "../filename";
import { formatBytes } from "../settings";
import { createApngEncoder } from "./apng";
import { createGifEncoder, type GifCore } from "./gif";
import {
  animatedProgress,
  throwIfCancelled,
  type AnimatedProgressListener,
} from "./progress";
import { createPngSequenceEncoder, createSpriteSheetEncoder } from "./sequence";
import { animatedFormatInfo } from "./settings";
import { LoopSeamError, type AnimatedFrameSource } from "./source";
import type {
  AnimatedEncoder,
  AnimatedResult,
  AnimatedSettings,
  AnimatedTiming,
} from "./types";
import { createVideoEncoder } from "./video";
import { createAnimatedWebpEncoder } from "./webp";

const log = logger("export");

export interface AnimatedJobRequest {
  readonly source: AnimatedFrameSource;
  readonly settings: AnimatedSettings;
  /**
   * The core's GIF encoder. Required by, and only read by, the GIF format.
   *
   * Absent rather than optional-with-a-default because there is no default: the
   * encoder lives in WASM and this module is not allowed to import it. Asking
   * for a GIF without one is a wiring mistake and is thrown as one — the same
   * arrangement `export/encode.ts` has with the SVG tracer.
   */
  readonly gif?: GifCore;
  readonly signal?: AbortSignal;
  readonly onProgress?: AnimatedProgressListener;
}

/**
 * The name the file is offered under.
 *
 * The still module's rules, with the frame count in the middle: the `-dither`
 * marker so a picker never opens pre-filled with the source image's own name,
 * and `@4x` for the multiplier because that is the convention every asset
 * pipeline already uses. `-60f` is added because two exports of one document at
 * different loop lengths are two different files.
 */
export function animatedFileName(
  sourceName: string | null,
  settings: AnimatedSettings,
  frames: number,
): string {
  const scale = settings.scale > 1 ? `@${settings.scale}x` : "";
  const info = animatedFormatInfo(settings.format);
  const suffix = info.id === "sprite-sheet" ? "-sheet" : "";
  return `${baseName(sourceName)}-dither-${frames}f${scale}${suffix}.${info.extension}`;
}

/** The encoder a format needs, and the refusal when its dependency is missing. */
export function createAnimatedEncoder(
  settings: AnimatedSettings,
  timing: AnimatedTiming,
  request: { readonly gif?: GifCore; readonly signal?: AbortSignal; readonly baseName?: string },
): AnimatedEncoder {
  const signalOption = request.signal === undefined ? {} : { signal: request.signal };

  switch (settings.format) {
    case "gif": {
      if (request.gif === undefined) {
        throw new Error(
          "an animated GIF needs the core's encoder, and none was supplied to the job",
        );
      }
      return createGifEncoder({ core: request.gif, settings, timing, ...signalOption });
    }
    case "apng":
      return createApngEncoder({ settings, timing, ...signalOption });
    case "webp":
      return createAnimatedWebpEncoder({ settings, timing, ...signalOption });
    case "webm":
    case "mp4":
      return createVideoEncoder({ settings, timing, ...signalOption });
    case "png-sequence":
      return createPngSequenceEncoder({
        settings,
        timing,
        baseName: request.baseName ?? "frame",
        ...signalOption,
      });
    case "sprite-sheet":
      return createSpriteSheetEncoder({ settings, timing, ...signalOption });
  }
}

/**
 * Encode without writing anywhere.
 *
 * Used on its own by the size estimate, and by {@link runAnimatedExport} for
 * everything else.
 */
export async function encodeAnimation(request: AnimatedJobRequest): Promise<AnimatedResult> {
  const started = performance.now();
  throwIfCancelled(request.signal);

  const subject = request.source.subject();
  if (subject === null) {
    throw new Error("there is no image open, so there is nothing to export");
  }
  const timing: AnimatedTiming = { frames: subject.frames, fps: subject.fps };
  const listener = request.onProgress;

  listener?.({
    stage: "validating",
    completed: animatedProgress("validating", 0),
    detail: "checking that the loop closes",
    frame: 0,
    frames: timing.frames,
  });
  const seam = await request.source.validateLoop(request.signal);
  if (!seam.ok) {
    log.warn("animated export refused: the loop does not close", {
      frames: seam.frames,
      errors: seam.issues.filter((issue) => issue.severity === "error").length,
    });
    throw new LoopSeamError(seam);
  }
  throwIfCancelled(request.signal);

  const encoder = createAnimatedEncoder(request.settings, timing, {
    ...(request.gif === undefined ? {} : { gif: request.gif }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    baseName: baseName(subject.name),
  });

  let delivered = 0;
  await request.source.renderFrames({
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    onFrame: async (index, frame) => {
      throwIfCancelled(request.signal);
      await encoder.addFrame(frame, index);
      delivered += 1;
      // The requirement's word is per-frame, and this is it: a fraction and the
      // two numbers a person actually reads.
      listener?.({
        stage: "rendering",
        completed: animatedProgress("rendering", delivered / Math.max(1, timing.frames)),
        detail: `frame ${delivered} of ${timing.frames}`,
        frame: delivered,
        frames: timing.frames,
      });
    },
  });

  listener?.({
    stage: "encoding",
    completed: animatedProgress("encoding", 0),
    detail: `assembling the ${animatedFormatInfo(request.settings.format).label}`,
    frame: delivered,
    frames: timing.frames,
  });
  const result = await encoder.finish();
  listener?.({
    stage: "encoding",
    completed: animatedProgress("encoding", 1),
    detail: `assembled ${formatBytes(result.bytes)}`,
    frame: delivered,
    frames: timing.frames,
  });

  // The warnings the seam check found are things a person should see beside the
  // file, not only while editing: a loop that closes and hitches is still a loop
  // that hitches, and the export is the last moment anyone looks.
  const warnings = seam.issues
    .filter((issue) => issue.severity === "warning")
    .map((issue) => issue.message);
  const withSeam: AnimatedResult = {
    ...result,
    notes: [...result.notes, ...warnings],
    ms: Math.round(performance.now() - started),
  };

  log.info("animated export encoded", {
    format: withSeam.format,
    width: withSeam.width,
    height: withSeam.height,
    frames: withSeam.frames,
    fps: withSeam.fps,
    playbackFps: Math.round(withSeam.playbackFps * 100) / 100,
    scale: request.settings.scale,
    indexed: withSeam.indexed,
    paletteEntries: withSeam.paletteEntries,
    bytes: withSeam.bytes,
    size: formatBytes(withSeam.bytes),
    bytesPerFrame: Math.round(withSeam.bytes / Math.max(1, withSeam.frames)),
    ms: withSeam.ms,
  });
  return withSeam;
}

export interface RunAnimatedExportRequest extends AnimatedJobRequest {
  /**
   * Where it goes. Chosen *before* the encode — `showSaveFilePicker` needs the
   * click's user activation and an animated encode outlives it by a long way.
   */
  readonly destination: Destination;
}

export async function runAnimatedExport(
  request: RunAnimatedExportRequest,
): Promise<AnimatedResult> {
  const result = await encodeAnimation(request);
  throwIfCancelled(request.signal);

  const subject = request.source.subject();
  request.onProgress?.({
    stage: "writing",
    completed: animatedProgress("writing", 0),
    detail: "writing the file",
    frame: result.frames,
    frames: subject?.frames ?? result.frames,
  });
  await writeToDestination(request.destination, result.blob);
  request.onProgress?.({
    stage: "writing",
    completed: 1,
    detail: `wrote ${formatBytes(result.bytes)}`,
    frame: result.frames,
    frames: subject?.frames ?? result.frames,
  });
  return result;
}
