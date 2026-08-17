/**
 * The adapter: a session plus a timeline, seen as an {@link AnimatedFrameSource}.
 *
 * `web/src/export/animated/` is not allowed to know that a document store, a
 * timeline or a render worker exist — it takes two interfaces written in its own
 * vocabulary (`export/animated/source.ts` and the `GifCore` in
 * `export/animated/gif.ts`). This is the one file that speaks both, and it is
 * the whole of the coupling between animated export and the rest of the app.
 * `ui/export/session.ts` is its opposite number for stills.
 *
 * ## The timeline is the source of what animates, not the document
 *
 * `DitherDocument.bindings` carries modulators and nothing else; keyframe tracks
 * (F-AN-08) have no place in the schema yet and live in `ui/timeline/model.ts`.
 * A document opened with bindings becomes tracks on the way in
 * (`TimelineStore.#adopt`), so the timeline's plan is a superset of the
 * document's — taking the plan from there is what makes an export of a
 * keyframed document possible at all, and it is why this takes the store rather
 * than reading `document.bindings` and quietly dropping half the animation.
 *
 * ## Every frame is a full render on the export lane
 *
 * `documentAtFrame` resolves the tracks for a frame into an ordinary document
 * with no bindings left in it, and that goes through the same
 * `RenderService.render` an export of a still uses: document resolution, full
 * quality, `lane: "export"` so it is never superseded and preempts the preview.
 *
 * The node cache does the rest. `DocumentRenderer` keeps every node's output
 * (`retain: { kind: "all" }`), and `graph/hash.ts` deliberately excludes the
 * frame index — so a node whose parameters did not move on this frame hashes
 * identically to the last one and is a cache hit. A stack with one animated node
 * at the end therefore costs one full render plus N cheap tails, which is the
 * whole reason an N-frame export is not N times the work.
 *
 * What this does **not** use is `graph/animate.ts`'s `renderAnimation`, which
 * additionally *pins* the invariant prefix so an LRU under budget pressure
 * cannot evict the shared upstream to hold one frame's throwaway tail. That
 * function takes a `graphForFrame` callback and delivers frames to an `onFrame`
 * callback, and neither survives `postMessage` — using it would mean moving the
 * animation planner into the worker and adding a streaming channel to a protocol
 * that is one message per call. That is a real improvement and it is not this
 * change; it is recorded in docs/ARCHITECTURE.md rather than half-built here.
 */

import {
  validateLoopSeam,
  type AnimationPlan,
  type SeamReport,
} from "../../animation";
import type {
  AnimatedFrameSource,
  AnimatedRenderRequest,
  AnimatedSubject,
  GifCore,
  GifCoreAnimation,
  GifCoreResult,
} from "../../export/animated";
import type { ExportFrame } from "../../export";
import { buildRenderGraph } from "../../state/render/graph";
import { prepareGraph } from "../../graph";
import { logger } from "../../lib/log";
import type { EditorSession } from "../../state";
import type { EffectDescriptor } from "../../types/registry";
import { isAbandoned, type RenderResult } from "../../worker";
import { documentAtFrame, type TimelinePlan } from "../timeline";
import type { TimelineStore } from "../timeline";

const log = logger("export");

export interface AnimatedExportDeps {
  readonly session: EditorSession;
  readonly timeline: TimelineStore;
}

/** Whether the caller has cancelled. A function, for the reason `session.ts` gives. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * The effect catalogue as `prepareGraph` wants it.
 *
 * Built once per seam check rather than held, because the registry is sealed at
 * boot and this runs twice per export.
 */
function effectMap(descriptors: readonly EffectDescriptor[]): ReadonlyMap<string, EffectDescriptor> {
  const map = new Map<string, EffectDescriptor>();
  for (const descriptor of descriptors) map.set(descriptor.id, descriptor);
  return map;
}

/**
 * The render worker's GIF encoder, seen as `export/animated/gif.ts`'s `GifCore`.
 *
 * The whole of the coupling, again: the encoder is a `wasm-bindgen` handle and
 * may only be held in the worker, so the export module names what it needs as an
 * interface and this is the line that joins them. Every method is a message,
 * which is why `GifCore` allows an asynchronous answer.
 */
export function gifCoreFor(session: EditorSession): GifCore {
  return {
    async createAnimation(width: number, height: number): Promise<GifCoreAnimation> {
      const handle = await session.render.gifBegin({ width, height });
      // The frame pushes are fire-and-forget from the encoder's point of view —
      // `GifCoreAnimation.pushFrame` returns void — but they must reach the
      // worker in order and must all have landed before `finish` runs. So each
      // one is chained onto the last, and `finish` awaits the chain.
      let queued: Promise<void> = Promise.resolve();

      return {
        pushFrame(indices: Uint8Array): void {
          queued = queued.then(async () => {
            const state = await session.render.gifFrame({ handle, indices });
            log.debug("gif frame accepted", {
              handle,
              frames: state.frames,
              bufferedBytes: state.bufferedBytes,
            });
          });
        },
        async finish(
          paletteRgb: Uint8Array,
          delayCentiseconds: number,
          loopForever: boolean,
          transparentIndex: number,
        ): Promise<GifCoreResult> {
          // A frame that failed to reach the worker must surface here rather
          // than as a GIF quietly missing a frame.
          await queued;
          return session.render.gifFinish({
            handle,
            paletteRgb,
            delayCentiseconds,
            loopForever,
            transparentIndex,
          });
        },
      };
    },
  };
}

/**
 * Why there is nothing to export, in the words the panel should use.
 *
 * `AnimatedFrameSource.subject()` answers `null` for three different situations
 * and the panel must not tell the person the same thing about all of them: no
 * image open, no track, and a set of tracks that could not be resolved are three
 * different problems with three different next actions. The interface in
 * `export/animated/source.ts` has one `null` and belongs to a directory that may
 * not know a timeline exists, so the distinction is drawn here instead of being
 * pushed into it.
 *
 * `null` means there is nothing wrong and the export can proceed.
 */
export function animatedBlockReason(deps: AnimatedExportDeps): string | null {
  const { session, timeline } = deps;
  if (session.store.getSnapshot().source === null) {
    return "There is no image open, so there is nothing to export.";
  }
  const snapshot = timeline.getSnapshot();
  if (snapshot.planError !== null) {
    return `This document's animation could not be resolved, so no frame of it can be rendered: ${snapshot.planError}`;
  }
  if (snapshot.plan === null) {
    return (
      "There is nothing to animate. Bind a parameter to a modulator or add a " +
      "keyframe track in the timeline — an animated file of one repeated frame " +
      "is not what this would write."
    );
  }
  return null;
}

export function animatedSourceFor(deps: AnimatedExportDeps): AnimatedFrameSource {
  const { session, timeline } = deps;

  const plan = (): TimelinePlan => {
    const found = timeline.getSnapshot().plan;
    if (found === null) {
      const why = timeline.getSnapshot().planError;
      throw new Error(
        why === null
          ? "there is nothing to animate: bind a parameter to a modulator or add a keyframe track first"
          : `the timeline could not be resolved, so there is nothing to export: ${why}`,
      );
    }
    return found;
  };

  // Memoised against the two stores' own revisions. `useSyncExternalStore`
  // compares snapshots with `Object.is`, so a subject rebuilt on every read
  // renders forever — the same contract `ui/export/session.ts` documents, and
  // React says so out loud ("the result of getSnapshot should be cached").
  let lastKey = "";
  let lastSubject: AnimatedSubject | null = null;

  const buildSubject = (): AnimatedSubject | null => {
    const snapshot = session.store.getSnapshot();
    const image = snapshot.source;
    if (image === null) return null;
    const timelineSnapshot = timeline.getSnapshot();
    // No plan means no track: the picture is the same on every frame, and an
    // animated file of one repeated frame is not what anybody asked for. The
    // panel reads this as "nothing to animate" and says so where the format
    // list would be.
    if (timelineSnapshot.plan === null) return null;

    let soloNodeName: string | null = null;
    if (snapshot.soloNodeId !== null) {
      const node = snapshot.document.stack.find((entry) => entry.id === snapshot.soloNodeId);
      soloNodeName =
        node === undefined
          ? null
          : (session.store.registry.get(node.effect)?.name ?? node.effect);
    }

    return {
      name: image.name,
      width: image.width,
      height: image.height,
      frames: timelineSnapshot.frames,
      fps: timelineSnapshot.fps,
      soloNodeName,
      // Both revisions, because either moving changes what would be exported
      // and the panel's seam check is keyed on this.
      revision: snapshot.revision * 1_000_003 + timelineSnapshot.revision,
    };
  };

  return {
    subject(): AnimatedSubject | null {
      const key = `${session.store.getSnapshot().revision}|${timeline.getSnapshot().revision}`;
      if (key !== lastKey) {
        lastKey = key;
        lastSubject = buildSubject();
      }
      return lastSubject;
    },

    /**
     * F-AN-06, before anything renders.
     *
     * Two halves, and it is worth being exact about which one does the work.
     *
     * The **per-binding analysis** is what catches a loop that does not close,
     * and it names the binding that broke it — `nodeId.param (shape)`. It also
     * reports the two things that are not errors and are worth seeing anyway: a
     * modulator with fewer than two frames per feature, and a binding whose
     * swing runs past its parameter's legal range and is flattened by the clamp.
     *
     * The **hash comparison** is a ground truth on the document -> graph half:
     * frame 0 and frame N are compiled and their output hashes compared. It is
     * cheap — no rendering at all — and it is honest to say that with today's
     * evaluators it cannot fail, because every one of them takes the frame index
     * through `loopFrame` and frame N *is* frame 0 by construction (that is
     * `cycles.ts`'s whole argument). It is here because it is the check that
     * stays correct if that ever stops being true, and because a seam report
     * whose `hashes` field is null is a report that did not look.
     */
    async validateLoop(signal?: AbortSignal): Promise<SeamReport> {
      const timelinePlan = plan();
      const snapshot = session.store.getSnapshot();
      const source = snapshot.source;
      if (source === null) throw new Error("there is no image open, so there is no loop to check");
      if (aborted(signal)) throw new DOMException("the loop check was cancelled", "AbortError");

      const effects = effectMap(session.store.registry.all());
      const hashForFrame = (frame: number): string => {
        const document = documentAtFrame(timelinePlan, frame);
        const graph = buildRenderGraph(document, {
          width: source.width,
          height: source.height,
          quality: "full",
          frame,
          solo: snapshot.soloNodeId,
        });
        if (graph === null) {
          // An empty stack has no output to hash. Constant across frames, which
          // is the answer the comparison wants.
          return "empty-stack";
        }
        return prepareGraph(graph, source.hash, document.palette, effects).outputHash;
      };

      const report = validateLoopSeam(animationPlanOf(timelinePlan), { hashForFrame });
      log.info("loop seam checked", {
        ok: report.ok,
        frames: report.frames,
        errors: report.issues.filter((issue) => issue.severity === "error").length,
        warnings: report.issues.filter((issue) => issue.severity === "warning").length,
      });
      return report;
    },

    async renderFrames(request: AnimatedRenderRequest): Promise<void> {
      const timelinePlan = plan();
      const snapshot = session.store.getSnapshot();
      if (snapshot.source === null) {
        throw new Error("there is no image open to export");
      }

      const total = timelinePlan.clock.frames;
      const wanted = request.only ?? Array.from({ length: total }, (_, index) => index);
      const started = performance.now();

      // A whole export asks for 0..N-1 in order and this changes nothing for
      // it. A *sampled* one — the size estimate takes three frames — asks for
      // 0, N/2, N-1, and for a document containing a feedback node frame N/2
      // does not exist until frames 1..N/2-1 have been rendered. So the
      // sampled case renders the run and delivers the sample: rendering fewer
      // frames and calling the result frame N/2 would be a picture the file
      // does not contain. Only the frames the caller asked for are handed over.
      const deliver = new Set(wanted);
      const ordered = timelinePlan.animation.loops
        ? wanted
        : Array.from({ length: Math.max(...wanted, -1) + 1 }, (_, index) => index);
      if (ordered.length !== wanted.length) {
        log.info("animated export renders from zero", {
          asked: wanted.length,
          rendering: ordered.length,
          why: "this document contains a feedback node, so frame N is the product of frames 0..N",
        });
      }

      for (const index of ordered) {
        if (aborted(request.signal)) {
          throw new DOMException("the animated export was cancelled", "AbortError");
        }
        const frame = await renderOne(session, timelinePlan, index, snapshot.soloNodeId, request.signal);
        if (deliver.has(index)) await request.onFrame(index, frame);
      }

      log.info("animated frames rendered", {
        frames: wanted.length,
        rendered: ordered.length,
        of: total,
        ms: Math.round(performance.now() - started),
      });
    },

    subscribe(listener: () => void): () => void {
      // Both, because the picture that would be exported is a function of the
      // document *and* of the tracks, and the two are separate stores.
      const offDocument = session.store.subscribe(listener);
      const offTimeline = timeline.subscribe(listener);
      return () => {
        offDocument();
        offTimeline();
      };
    },
  };
}

/**
 * The animation half of a timeline plan.
 *
 * `validateLoopSeam` takes an `AnimationPlan` — modulators and temporal
 * variations — and a `TimelinePlan` carries one plus its keyframe tracks. The
 * keyframes need no seam check of their own: `keyframes.ts` wraps at the seam by
 * construction, so the segment after the last key runs *through* it to the
 * first, and frame N is frame 0 for the same structural reason F-AN-03 gives
 * modulators. That is asserted in `ui/timeline/keyframes.test.ts` rather than
 * re-checked per export.
 */
function animationPlanOf(plan: TimelinePlan): AnimationPlan {
  return plan.animation;
}

async function renderOne(
  session: EditorSession,
  plan: TimelinePlan,
  index: number,
  solo: string | null,
  signal: AbortSignal | undefined,
): Promise<ExportFrame> {
  const { id, frame } = session.render.renderCancellable({
    document: documentAtFrame(plan, index),
    solo,
    // Which frame of the loop this is. Only one node reads it — feedback,
    // whose history is indexed by it — and for that node the worker refuses
    // any frame but the one it can serve, so an export that skipped a frame
    // would fail here rather than write a file with a trail that jumped.
    frame: index,
    // The document's own resolution, always. F-UI-03's reduction is a property
    // of the preview; a file rendered at 40% would be a different picture,
    // because a dither is a function of the pixel grid it ran on.
    quality: "full",
    factor: 1,
    lane: "export",
    present: "bytes",
  });

  const stop = (): void => session.render.cancel(id);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    let result: RenderResult;
    try {
      result = await frame;
    } catch (error) {
      // The worker's word is "abandoned"; export's vocabulary for the same
      // event is an `AbortError`, which the panel does not show as a failure.
      // Anything that is not our own cancellation is rethrown untouched.
      if (isAbandoned(error) && aborted(signal)) {
        throw new DOMException("the animated export was cancelled", "AbortError");
      }
      throw error;
    }
    const image = result.image;
    if (image.kind !== "bytes") {
      throw new Error("an animated export render came back as a bitmap; export encodes samples");
    }
    return { width: result.width, height: result.height, data: image.data };
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}
