/**
 * What an animated export needs from the rest of the application.
 *
 * The same arrangement `export/source.ts` uses, for the same reason: nothing in
 * this directory may know that a document store, a renderer or a session
 * exists, so what it needs is written here in its own vocabulary and an adapter
 * elsewhere satisfies it.
 *
 * ## The one type imported from outside export/
 *
 * `SeamReport` comes from `web/src/animation/seam.ts`, as a *type*, and it is
 * imported rather than restated on purpose. F-AN-06's report is the artefact the
 * export gate acts on and the UI shows; a second structurally-identical
 * declaration here would be a copy that drifts, and the first symptom of the
 * drift would be an export refusing for a reason the panel cannot render.
 * `animation/` is pure — a clock, some arithmetic and a registry contract read
 * type-only — so nothing about a browser, a device or a store comes with it,
 * and being a type-only import it does not exist at run time at all.
 *
 * ## Rendering is a callback, not an array
 *
 * `renderFrames` hands each frame over as it is produced and takes it back when
 * the call returns, because that is exactly what `graph/animate.ts` does: the
 * buffer it delivers belongs to the node cache and the next frame may evict it.
 * A source that returned `ExportFrame[]` would be a source that had already
 * decided a 60-frame loop fits in memory four times over.
 */

import type { SeamReport } from "../../animation";
import type { ExportFrame } from "../types";

export interface AnimatedSubject {
  /** The open image's file name, for the default export name. */
  readonly name: string | null;
  /** Document resolution — one frame's size before the scale multiplier. */
  readonly width: number;
  readonly height: number;
  /** F-AN-01's `N`. */
  readonly frames: number;
  readonly fps: number;
  /**
   * The effect name of the solo point (F-ST-02), when one is set.
   *
   * A solo point is part of what is on screen and is therefore part of the
   * export, exactly as it is for a still. The panel says so out loud.
   */
  readonly soloNodeName: string | null;
  /** Increments whenever the document, its clock or its source changes. */
  readonly revision: number;
}

export interface AnimatedRenderRequest {
  /**
   * Receives each finished frame, in order, and is awaited before the next
   * frame starts. The buffer is valid only for the duration of the call.
   *
   * The index is the frame's position **in the loop**, not its position in this
   * call — so a sampled render reports 0, 30 and 59 rather than 0, 1 and 2, and
   * an encoder that stamps a timestamp from it stays correct.
   */
  readonly onFrame: (index: number, frame: ExportFrame) => Promise<void>;
  /**
   * Render only these frames, in this order, instead of the whole loop.
   *
   * The pre-export size estimate is the caller: it needs three real frames
   * through the real encoder, not thirty. Absent means the whole loop, which is
   * what an export asks for.
   */
  readonly only?: readonly number[];
  readonly signal?: AbortSignal;
}

export interface AnimatedFrameSource {
  /** What is open, or `null` before an image has been opened. */
  subject(): AnimatedSubject | null;
  /**
   * F-AN-06 — hash frame 0 against frame N and report what would break
   * periodicity.
   *
   * Called before anything renders. The implementation prepares two graphs and
   * compares their output hashes, which costs no rendering at all.
   */
  validateLoop(signal?: AbortSignal): Promise<SeamReport>;
  /** Render the loop. Rejects when no image is open or the document is refused. */
  renderFrames(request: AnimatedRenderRequest): Promise<void>;
  /** Notified when {@link subject} would return something different. */
  subscribe(listener: () => void): () => void;
}

/**
 * The loop does not close, so nothing was exported.
 *
 * Carries the report rather than only a message: the panel lists every issue
 * with the binding that caused it, which is the half of F-AN-06 that says
 * "report which binding broke periodicity". A thrown string could not.
 */
export class LoopSeamError extends Error {
  readonly report: SeamReport;

  constructor(report: SeamReport) {
    const errors = report.issues.filter((issue) => issue.severity === "error");
    const named = errors.map((issue) => issue.source).join(", ");
    super(
      `this loop does not close, so it was not exported: ${errors.length} problem(s)` +
        (named.length > 0 ? ` in ${named}` : "") +
        `. Frame ${report.frames} would not be frame 0, and the animation would ` +
        `visibly jump every time it repeated.`,
    );
    this.name = "LoopSeamError";
    this.report = report;
  }
}
