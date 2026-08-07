/**
 * F-EX-14 for a loop — the pre-export size estimate.
 *
 * ## It is measured, and for an animation that matters more, not less
 *
 * `export/estimate.ts` argues that there is no formula for how large a PNG of a
 * dither will be: deflate's output is a function of the run structure of the
 * actual bytes, and dither noise is the pathological case. Everything about that
 * is worse here. docs/ARCHITECTURE.md lists "GIF compresses dither noise poorly"
 * among the known technical risks, because LZW needs repeated runs and a dither
 * has none — the same picture that costs 40 kB as an indexed PNG can cost 200 kB
 * as one GIF frame. A bytes-per-pixel constant would be wrong by a factor of
 * five in both directions depending on the stack, and a number wrong by a factor
 * of five is worse than no number, because it is believed.
 *
 * So the estimate encodes real frames with the real encoder at the real
 * settings, and multiplies. Nothing is modelled.
 *
 * ## Which frames, and why the sample is spread
 *
 * Three frames by default, evenly spaced across the loop rather than the first
 * three. An animation's first frames are frequently its quietest — a modulator
 * starting at zero, a scroll that has not moved — and a sample taken from them
 * would be an estimate of the cheapest part of the file. Spreading it catches
 * the middle of every cycle.
 *
 * ## The bias is known, and it is not always the same direction
 *
 * Two effects pull against each other and both are stated rather than corrected
 * with a fudge factor, because a correction is one more number to be wrong
 * about:
 *
 * - **Upward, from headers.** Every sample carries the file's fixed overhead —
 *   the colour table, the container's own boxes — and multiplying by the frame
 *   ratio multiplies those too. A few kilobytes on a file of megabytes.
 * - **Downward, from inter-frame coding.** GIF and APNG crop a frame to what
 *   changed and a video codec sends only the difference, so frames after a
 *   keyframe are cheaper than the ones sampled. For a dither this is close to
 *   nothing — every pixel moves — and for a document with a still background it
 *   is most of the file, which is exactly when the estimate reads high.
 *
 * {@link AnimatedSizeEstimate.exact} is true only when every frame was encoded,
 * and then it is not an estimate at all: it is the file size.
 */

import { logger } from "../../lib/log";
import { formatBytes } from "../settings";
import { throwIfCancelled } from "../progress";
import { createAnimatedEncoder, type AnimatedJobRequest } from "./job";
import { animatedFormatInfo } from "./settings";
import type { AnimatedTiming } from "./types";

const log = logger("export");

/**
 * Frames encoded when the loop is longer than that.
 *
 * Three: enough to see one keyframe and two deltas in a video, and to average
 * the LZW cost of two different parts of a cycle, without the estimate costing
 * more than a tenth of the export it is estimating.
 */
export const ESTIMATE_SAMPLE_FRAMES = 3;

/**
 * Loops encoded in full rather than sampled.
 *
 * At or below this the whole thing is encoded and the answer is exact. Eight
 * frames of a modest document is well inside what a panel can do while a control
 * is being let go of, and short loops are exactly where a ratio-based estimate
 * is least trustworthy.
 */
export const ESTIMATE_EXACT_FRAMES = 8;

export interface AnimatedSizeEstimate {
  readonly bytes: number;
  /** True when every frame was encoded, so this is the file size. */
  readonly exact: boolean;
  readonly sampledFrames: number;
  readonly totalFrames: number;
  readonly width: number;
  readonly height: number;
  readonly indexed: boolean;
  readonly paletteEntries: number;
  /** Bytes per frame in the sample — the number that says whether GIF is viable. */
  readonly bytesPerFrame: number;
  /** What the sample cost, so a panel can decide whether to re-run it on a drag. */
  readonly ms: number;
}

/**
 * The frame indices sampled for a loop of `frames`.
 *
 * Evenly spaced and always including frame 0, because frame 0 is the one every
 * format writes in full — a sample without it would miss the keyframe every
 * later frame is a delta against.
 */
export function estimateSampleFrames(frames: number, sample: number): readonly number[] {
  const total = Math.max(1, Math.trunc(frames));
  const wanted = Math.max(1, Math.min(total, Math.trunc(sample)));
  if (wanted >= total) return Array.from({ length: total }, (_, index) => index);
  const step = total / wanted;
  const chosen: number[] = [];
  for (let i = 0; i < wanted; i += 1) {
    const at = Math.min(total - 1, Math.floor(i * step));
    if (!chosen.includes(at)) chosen.push(at);
  }
  return chosen;
}

export interface AnimatedEstimateOptions {
  /** Frames to encode when the loop is longer than {@link ESTIMATE_EXACT_FRAMES}. */
  readonly sample?: number;
}

/**
 * Encode a sample of the loop and scale the answer.
 *
 * Runs the whole real path — the same encoder, the same settings, the same
 * palette census — over the sampled frames. The seam check is *not* run: an
 * estimate is something a panel shows while a document is being edited, and
 * refusing to produce one because a modulator is halfway through being typed
 * would leave the panel with nothing to say. The export runs it, and that is
 * where refusing belongs.
 */
export async function estimateAnimatedSize(
  request: AnimatedJobRequest,
  options: AnimatedEstimateOptions = {},
): Promise<AnimatedSizeEstimate> {
  const started = performance.now();
  throwIfCancelled(request.signal);

  const subject = request.source.subject();
  if (subject === null) {
    throw new Error("there is no image open, so there is nothing to estimate");
  }

  const total = Math.max(1, subject.frames);
  const exact = total <= ESTIMATE_EXACT_FRAMES;
  const indices =
    exact ? null : estimateSampleFrames(total, options.sample ?? ESTIMATE_SAMPLE_FRAMES);

  // The encoder is told the sample's own length, not the loop's: a GIF of three
  // frames must declare three, and a sprite sheet must lay out three cells or it
  // allocates a grid the sample cannot fill.
  const sampled = indices?.length ?? total;
  const timing: AnimatedTiming = { frames: sampled, fps: subject.fps };
  const encoder = createAnimatedEncoder(request.settings, timing, {
    ...(request.gif === undefined ? {} : { gif: request.gif }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    baseName: "frame",
  });

  // The encoder numbers its own frames from zero. The loop indices are what the
  // *source* renders; the encoder must see a contiguous run or a sprite sheet
  // would place frame 30 in cell 30 of a three-cell grid.
  let position = 0;
  await request.source.renderFrames({
    ...(indices === null ? {} : { only: indices }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    onFrame: async (_index, frame) => {
      throwIfCancelled(request.signal);
      await encoder.addFrame(frame, position);
      position += 1;
    },
  });

  const result = await encoder.finish();
  const bytesPerFrame = result.bytes / Math.max(1, result.frames);
  const bytes = exact ? result.bytes : Math.round(bytesPerFrame * total);
  const ms = Math.round(performance.now() - started);

  log.info("animated size estimated", {
    format: request.settings.format,
    label: animatedFormatInfo(request.settings.format).label,
    exact,
    sampledFrames: result.frames,
    totalFrames: total,
    bytes,
    size: formatBytes(bytes),
    bytesPerFrame: Math.round(bytesPerFrame),
    ms,
  });

  return {
    bytes,
    exact,
    sampledFrames: result.frames,
    totalFrames: total,
    width: result.width,
    height: result.height,
    indexed: result.indexed,
    paletteEntries: result.paletteEntries,
    bytesPerFrame: Math.round(bytesPerFrame),
    ms,
  };
}
