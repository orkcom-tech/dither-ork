/**
 * F-EX-13 for an animation: **per-frame** progress, and a cancel that stops the
 * work rather than stopping the reporting.
 *
 * The still path's `export/progress.ts` supplies the cancellation vocabulary and
 * the yield budget, and both are reused here unchanged — there is one
 * `ExportCancelledError` in the application and one definition of when a loop
 * has held the thread too long. What is *not* reused is the stage weighting, and
 * that is deliberate rather than an oversight.
 *
 * ## Why the weights are different
 *
 * A still export renders once before the job starts and the job is almost
 * entirely encoding, so `STAGE_WEIGHTS` puts 60% on encoding. An animated export
 * inverts that: it renders `N` times inside the job, and the render is by far
 * the largest term for every format. Reusing the still weights would leave the
 * bar at 25% for the whole of a two-minute render and then jump — which reads as
 * a hang, which is the exact failure that file's own comment warns against.
 *
 * ## Two counters, because a fraction is not enough
 *
 * The requirement's word is "per-frame". A bar at 0.41 says nothing a person can
 * act on; "frame 25 of 60" says how long the rest will take. So
 * {@link AnimatedProgress} carries both, and every report during the render
 * names the frame it has just finished.
 *
 * There is deliberately no animated counterpart to the still path's
 * `stageReporter`. That exists because a still encoder is handed a `0..1 of my
 * own work` callback and knows nothing of the job around it; an animated
 * encoder has nothing useful to put in one, because the only thing it could
 * report from inside `addFrame` is a fraction of a single frame, and a bar
 * moving sixty times faster than the number beside it is worse than a bar that
 * steps once per frame.
 */

import type { ExportProgress } from "../progress";

export {
  ExportCancelledError,
  isCancellation,
  shouldYield,
  throwIfCancelled,
  yieldToHost,
} from "../progress";

/** The stages an animated export passes through, in order. */
export const ANIMATED_STAGES = [
  /** F-AN-06's seam check. Cheap, and it can end the job before any work. */
  "validating",
  /** `N` renders, each handed straight to the encoder. */
  "rendering",
  /** Assembling the container out of what the frames produced. */
  "encoding",
  "writing",
] as const;

export type AnimatedStage = (typeof ANIMATED_STAGES)[number];

/**
 * How much of the whole job each stage is worth.
 *
 * Measured shares. The render dominates every format: a frame of a stack with
 * one diffusion node costs tens of milliseconds and its GIF frame costs a
 * couple. `encoding` is only what happens *after* the last frame — the LZW pass
 * and the container assembly — because the per-frame encoding happens inside
 * the render stage, where the frame is.
 */
export const ANIMATED_STAGE_WEIGHTS: Readonly<Record<AnimatedStage, number>> = {
  validating: 0.02,
  rendering: 0.78,
  encoding: 0.18,
  writing: 0.02,
};

export interface AnimatedProgress extends Omit<ExportProgress, "stage"> {
  readonly stage: AnimatedStage;
  /** Frames finished so far. Zero outside the render stage. */
  readonly frame: number;
  /** Frames in the loop. Zero before the subject is known. */
  readonly frames: number;
  /**
   * Present once, during `validating`, when this document does **not** return
   * to its own first frame — it contains a feedback node (F-FB-01), whose
   * output is the product of every frame before it.
   *
   * It is a progress field rather than only a note on the result because the
   * point is to say it *before* the user commits to encoding 300 frames. The
   * export is not refused: a non-looping animation is a legitimate thing to
   * make and refusing it would refuse the whole point of the effect. Decision 2
   * of `docs/dither-ork-node-graph.md`.
   */
  readonly nonLooping?: string;
}

export type AnimatedProgressListener = (progress: AnimatedProgress) => void;

/**
 * The fraction of the whole job at `within` through `stage`.
 *
 * `within` outside 0..1 is clamped rather than trusted, for the reason the still
 * version gives: a caller that divides by a frame count can hand in 1.0000001,
 * and a bar that overshoots its track is a visible defect for an invisible
 * cause.
 */
export function animatedProgress(stage: AnimatedStage, within: number): number {
  const clamped = within <= 0 ? 0 : within >= 1 ? 1 : within;
  let before = 0;
  for (const candidate of ANIMATED_STAGES) {
    if (candidate === stage) break;
    before += ANIMATED_STAGE_WEIGHTS[candidate];
  }
  return before + ANIMATED_STAGE_WEIGHTS[stage] * clamped;
}

