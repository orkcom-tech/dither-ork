/**
 * The timeline editor — F-AN-07, 08, 09, 10 and 11.
 *
 * Wiring it into the application is one call, from wherever the session is
 * created:
 *
 * ```ts
 * import { registerTimelinePanel } from "./ui/timeline";
 * registerTimelinePanel({ session, registry });
 * ```
 *
 * The shell imports no panel; this one registers itself into the `timeline`
 * slot, which `web/src/app/slots.ts` already names. It takes the whole session
 * rather than just the document store, because unlike the other three panels it
 * needs to **draw**: while a track exists the picture is a function of the
 * playhead, which the document store does not have, so the timeline becomes the
 * render pump and hands the viewport back when the last track goes. The argument
 * is in `preview.ts`.
 *
 * ## What lives where
 *
 * - `keyframes.ts` — F-AN-08's five interpolations and the wrap that makes frame
 *   N frame 0. Pure, no clock.
 * - `model.ts` — the tracks and every edit to them. Pure.
 * - `evaluate.ts` — tracks plus a frame index become a document with no bindings
 *   in it. Modulators go through `web/src/animation/` and are not re-implemented.
 * - `playback.ts` — the transport's arithmetic, and the only place a timestamp
 *   appears. Pure, with the clock injected.
 * - `preview.ts` — the render pump, viewport ownership and the drop policy.
 * - `store.ts` — the one place the document, the tracks and the picture are kept
 *   in step.
 *
 * The first four are unit-tested without a DOM, which is what `vitest.config.ts`
 * asks of anything that can be.
 */

import React from "react";

import { registerPanel } from "../../app";
import { logger } from "../../lib/log";
import type { EffectRegistry } from "../../registry";
import type { EditorSession } from "../../state";
import type { DitherDocument } from "../../types/document";
import { TimelinePanel } from "./TimelinePanel";
import { documentAtFrame } from "./evaluate";
import { TimelineStore } from "./store";

const log = logger("app");

export interface TimelineDependencies {
  readonly session: EditorSession;
  readonly registry: EffectRegistry;
}

/**
 * Register the timeline into the shell's bottom region.
 *
 * Call once. A second call is a duplicate slot registration and the shell
 * throws, which is what stops one of two panels from being silently invisible.
 *
 * Returns the store so the caller can dispose it with the session. The panel
 * itself attaches and detaches the viewport as it mounts, so there is nothing
 * else to wire.
 */
export function registerTimelinePanel(
  dependencies: TimelineDependencies,
): TimelineStore {
  const store = new TimelineStore({
    session: dependencies.session,
    registry: dependencies.registry,
  });
  registerPanel({
    id: "timeline",
    title: "Timeline",
    region: "bottom",
    order: 0,
    // A closure rather than a context provider: the shell's slot takes a
    // component with no props, and the session is created outside the tree.
    component: () =>
      React.createElement(TimelinePanel, { store, registry: dependencies.registry }),
  });
  log.info("timeline registered");
  return store;
}

export { TimelinePanel, type TimelinePanelProps } from "./TimelinePanel";
export { TransportBar, type TransportBarProps } from "./TransportBar";
export { TrackRow, type TrackRowProps } from "./TrackRow";
export { Ruler, frameAtOffset, tickStep, type RulerProps } from "./Ruler";
export { Lane, curvePath, laneRange, type LaneProps } from "./Lane";
export {
  BindPicker,
  bindCandidates,
  defaultAmountFor,
  type BindCandidate,
  type BindPickerProps,
} from "./BindPicker";
export { FloatEntry, IntEntry, type FloatEntryProps, type IntEntryProps } from "./fields";

export {
  EASINGS,
  EASING_LABEL,
  addKey,
  easeUnit,
  isEasing,
  keyframeExtremes,
  keyframeValueAt,
  keysWithinLoop,
  moveKey,
  removeKey,
  setKeyEasing,
  setKeyValue,
  sortKeys,
  wrapFrame,
  type Easing,
  type Keyframe,
} from "./keyframes";

export {
  EMPTY_TIMELINE,
  MAX_AMOUNT_SCALE,
  defaultModulator,
  findTrack,
  isBindableParam,
  liveKeyframeTracks,
  modulatorBindings,
  reduce,
  survivingTrackIds,
  trackId,
  type KeyframeSpec,
  type ModulatorSpec,
  type TimelineAction,
  type TimelineState,
  type Track,
  type TrackKind,
} from "./model";

export {
  CURVE_SAMPLES,
  buildTimelinePlan,
  documentAtFrame,
  keyframeTrackValueAt,
  shapeValue,
  trackCurve,
  type ResolvedKeyframeTrack,
  type TimelinePlan,
  type TimelinePlanRequest,
  type TrackCurve,
} from "./evaluate";

export {
  IDLE_REPORT,
  KEEPING_UP,
  METER_WINDOW_MS,
  PlaybackMeter,
  describePlayback,
  frameAtElapsed,
  loopsElapsed,
  type PlaybackReport,
} from "./playback";

export {
  IDLE_PREVIEW_STATUS,
  TimelinePreview,
  samePreviewStatus,
  type PreviewStatus,
  type TimelinePreviewOptions,
} from "./preview";

export {
  TimelineStore,
  type TimelineSnapshot,
  type TimelineStoreOptions,
} from "./store";

/**
 * The document to render when only one frame of it is wanted.
 *
 * **The frame at the playhead**, when the document is animated. Every consumer
 * outside the timeline that renders "the document" needs this rather than
 * `store.document`: once a track is written back to `document.bindings`,
 * `buildRenderGraph` refuses the raw document, and the honest answer to "make
 * one picture of this" is the one on screen.
 *
 * Two consumers take it — the still export (`ui/export/session.ts`) and batch
 * (`ui/batch/BatchPanel.tsx`) — and anything that renders a single frame of a
 * document in future is a third. It lives here because the timeline owns the
 * playhead and the plan, and because three copies of this decision would be
 * three chances to make a different one.
 *
 * Throws when tracks exist but cannot be resolved: there is no frame then, and
 * the message names the binding at fault rather than leaving `buildRenderGraph`
 * to answer with an instruction addressed to a programmer.
 */
export function frameDocument(
  timeline: TimelineStore,
  fallback: DitherDocument,
): DitherDocument {
  const snapshot = timeline.getSnapshot();
  if (snapshot.plan !== null) return documentAtFrame(snapshot.plan, snapshot.state.playhead);
  if (snapshot.planError !== null) {
    throw new Error(
      `this document's animation could not be resolved, so there is no frame of it to ` +
        `render: ${snapshot.planError}`,
    );
  }
  return fallback;
}
