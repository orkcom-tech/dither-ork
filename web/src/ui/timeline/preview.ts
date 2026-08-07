/**
 * F-AN-09 — live playback, and who owns the preview while it runs.
 *
 * ## The timeline takes the viewport rather than fighting for it
 *
 * `state/session.ts` has a render pump of its own: it subscribes to the document
 * store and to the viewport's `request` event, renders `store.document`, and
 * hands the frame over. That pump is right for a still document and wrong for an
 * animated one for a reason that is not a matter of taste — it renders the
 * document **as written**, and an animated document's picture is a function of a
 * playhead the store does not have.
 *
 * Two pumps writing to one viewport would race: every frame either produced
 * would be superseded by the other at an interval nobody controls, and the
 * picture on screen would be whichever render happened to finish last. So there
 * is exactly one pump at a time. When the timeline has a track it calls
 * `session.attachViewport(null)` — the session's own documented way of being
 * pointed at nothing — and becomes the pump; when the last track goes it hands
 * the viewport back with `session.attachViewport(viewport)`, which re-renders
 * the document and re-sets the before/after reference on its own.
 *
 * That hand-off is also what makes an animated document *renderable at all*
 * today. `state/render/graph.ts` refuses a document that carries modulator
 * bindings; the frames this file sends carry none, because `evaluate.ts`
 * resolves every track into concrete parameter values first.
 *
 * ## Drop, never queue
 *
 * At most one render is in flight and at most one frame is wanted. A tick that
 * arrives while a render is running **replaces** the wanted frame instead of
 * queueing behind it, and the replaced frame is counted as dropped. A queue
 * would spend the GPU on frames whose moment has passed and make every
 * subsequent frame later still — and the playhead would drift away from the
 * picture, which is the one thing a timeline may not do.
 *
 * The count is not swallowed: {@link PreviewStatus} carries it, the transport bar
 * states it, and the log records the transitions.
 *
 * ## Degradation is the real mechanism, not a claim
 *
 * Playback declares an interaction on the viewport (`beginInteraction`), which
 * is the same adaptive-preview path a slider drag uses (F-UI-03). The viewport
 * answers with a quality and a fraction of document resolution; this pump sends
 * both to the worker, which resamples the source and runs the whole graph at
 * that extent. So the frame really is smaller, the viewport's badge is
 * describing something that happened, and the transport bar's reading agrees
 * with it.
 */

import { logger } from "../../lib/log";
import type { EditorSession } from "../../state";
import type { FrameQuality, Viewport } from "../../viewport";
import { isAbandoned } from "../../worker";
import { documentAtFrame, type TimelinePlan } from "./evaluate";
import {
  IDLE_REPORT,
  PlaybackMeter,
  frameAtElapsed,
  type PlaybackReport,
} from "./playback";

const log = logger("app");

/** What the transport bar and the panel read off the preview. */
export interface PreviewStatus {
  /** Whether the timeline is the pump — true exactly while it has a track. */
  readonly engaged: boolean;
  readonly playing: boolean;
  /** The frame last handed to the viewport, or `null` before the first one. */
  readonly presentedFrame: number | null;
  /** Fraction of document resolution the last frame was rendered at. */
  readonly previewScale: number;
  readonly quality: FrameQuality;
  readonly playback: PlaybackReport;
  /** The last render failure, cleared the moment a frame arrives. */
  readonly error: string | null;
}

export const IDLE_PREVIEW_STATUS: PreviewStatus = {
  engaged: false,
  playing: false,
  presentedFrame: null,
  previewScale: 1,
  quality: "full",
  playback: IDLE_REPORT,
  error: null,
};

export interface TimelinePreviewOptions {
  readonly session: EditorSession;
  /** Monotonic clock. Injected so playback can be driven by hand. */
  readonly now?: () => number;
  /** Frame scheduler. Injected for the same reason. */
  readonly schedule?: (callback: () => void) => number;
  readonly cancel?: (handle: number) => void;
}

export class TimelinePreview {
  readonly #session: EditorSession;
  readonly #now: () => number;
  readonly #schedule: (callback: () => void) => number;
  readonly #cancel: (handle: number) => void;
  readonly #meter = new PlaybackMeter();
  readonly #listeners = new Set<() => void>();

  #onPlayhead: ((frame: number) => void) | null = null;

  #viewport: Viewport | null = null;
  #owned = false;
  #offRequest: (() => void) | null = null;

  #plan: TimelinePlan | null = null;
  #frame = 0;
  #playing = false;
  #disposed = false;

  /** What the viewport last asked for (F-UI-03). Full until it says otherwise. */
  #quality: FrameQuality = "full";
  #factor = 1;

  /** At most one render in flight, at most one frame wanted. */
  #inFlight = false;
  #wanted: number | null = null;
  #generation = 0;

  #playStartedAt = 0;
  #playStartFrame = 0;
  #loopHandle = 0;

  #status: PreviewStatus = IDLE_PREVIEW_STATUS;

  constructor(options: TimelinePreviewOptions) {
    this.#session = options.session;
    this.#now = options.now ?? ((): number => performance.now());
    this.#schedule =
      options.schedule ?? ((callback): number => requestAnimationFrame(callback));
    this.#cancel = options.cancel ?? ((handle): void => cancelAnimationFrame(handle));
  }

  // --- reading ----------------------------------------------------------

  readonly getStatus = (): PreviewStatus => this.#status;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Called on every frame the transport advances to, so the store's playhead and
   * the picture stay one fact rather than two that drift.
   */
  onPlayhead(listener: ((frame: number) => void) | null): void {
    this.#onPlayhead = listener;
  }

  // --- wiring -----------------------------------------------------------

  /**
   * Point the preview at the shell's viewport, or at nothing.
   *
   * Called from the panel, which is the only part of the timeline inside the
   * React tree and therefore the only part that can see the viewport. React
   * mounts effects twice in development, so this has to survive
   * attach/detach/attach — it does, because ownership is re-derived every time
   * rather than assumed.
   */
  attachViewport(viewport: Viewport | null): void {
    if (this.#viewport === viewport) return;
    this.#release();
    this.#viewport = viewport;
    log.info("timeline preview viewport " + (viewport === null ? "detached" : "attached"));
    this.#syncOwnership("viewport");
  }

  /**
   * The plan the preview renders from, or `null` when there is nothing to
   * animate — no tracks, or a plan that could not be built.
   */
  setPlan(plan: TimelinePlan | null): void {
    this.#plan = plan;
    this.#syncOwnership("plan");
    if (this.#owned) this.#request(this.#frame, "plan");
  }

  /** Move the playhead. A scrub, a step, or the transport's own tick. */
  setFrame(frame: number): void {
    if (this.#frame === frame) return;
    this.#frame = frame;
    if (this.#owned) this.#request(frame, "playhead");
  }

  setPlaying(playing: boolean): void {
    if (this.#playing === playing) return;
    this.#playing = playing;
    if (playing) this.#startLoop();
    else this.#stopLoop();
    this.#publish();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#stopLoop();
    // Released *before* the flag is set, so the viewport goes back to the
    // session rather than being left with nothing drawing to it. A disposed
    // timeline is a timeline that is not there, and the picture then belongs to
    // the session again.
    this.#release();
    this.#disposed = true;
    this.#viewport = null;
    this.#listeners.clear();
    log.info("timeline preview disposed");
  }

  // --- ownership --------------------------------------------------------

  /**
   * Whether the timeline should be the pump right now.
   *
   * A plan with no tracks renders the same picture on every frame, so the
   * session's pump is already correct and taking the viewport from it would add
   * a hand-off nobody could see. One track is the whole condition.
   */
  #shouldOwn(): boolean {
    if (this.#viewport === null || this.#disposed) return false;
    const plan = this.#plan;
    if (plan === null) return false;
    return plan.animation.bindings.length > 0 || plan.keyframes.length > 0;
  }

  #syncOwnership(reason: string): void {
    const want = this.#shouldOwn();
    if (want !== this.#owned) {
      if (want) this.#take(reason);
      else this.#release();
    }
    this.#publish();
  }

  #take(reason: string): void {
    const viewport = this.#viewport;
    if (viewport === null) return;
    this.#owned = true;
    // The session stops drawing. This is its own documented way of being
    // pointed at nothing, and it releases the `request` subscription the session
    // held, so the one installed below becomes the only listener that renders.
    this.#session.attachViewport(null);
    this.#offRequest = viewport.on("request", (wanted) => {
      const moved =
        wanted.quality !== this.#quality || Math.abs(wanted.factor - this.#factor) > 1e-6;
      this.#quality = wanted.quality;
      this.#factor = wanted.factor;
      if (!moved) return;
      log.info("timeline preview resolution changed", {
        quality: this.#quality,
        factor: Math.round(this.#factor * 1000) / 1000,
        reason: wanted.reason,
      });
      this.#request(this.#frame, `quality:${wanted.reason}`);
    });
    log.info("timeline owns the preview", { reason });
    this.#request(this.#frame, "engage");
    if (this.#playing) this.#startLoop();
  }

  #release(): void {
    if (!this.#owned) return;
    this.#owned = false;
    this.#stopLoop();
    this.#offRequest?.();
    this.#offRequest = null;
    // Anything still in flight is for a viewport this no longer drives.
    this.#generation += 1;
    this.#inFlight = false;
    this.#wanted = null;
    const viewport = this.#viewport;
    if (viewport !== null && !this.#disposed) {
      viewport.endInteraction("playback");
      // Handing it back re-renders the document and re-sets the before/after
      // reference; the session does both on attach.
      this.#session.attachViewport(viewport);
    }
    log.info("timeline released the preview");
  }

  // --- the render pump --------------------------------------------------

  #request(frame: number, reason: string): void {
    if (!this.#owned || this.#disposed) return;
    if (this.#plan === null) return;
    if (this.#session.store.getSnapshot().source === null) return;

    if (this.#inFlight) {
      // The frame that was waiting never gets rendered. That is the drop, and it
      // is counted rather than absorbed.
      if (this.#wanted !== null && this.#wanted !== frame) {
        this.#meter.note(false, this.#now());
      }
      this.#wanted = frame;
      return;
    }
    void this.#renderNow(frame, reason);
  }

  async #renderNow(frame: number, reason: string): Promise<void> {
    const plan = this.#plan;
    if (plan === null || this.#viewport === null) return;

    const snapshot = this.#session.store.getSnapshot();
    if (snapshot.source === null) return;

    this.#inFlight = true;
    const mine = this.#generation;

    try {
      const result = await this.#session.render.render({
        document: documentAtFrame(plan, frame),
        solo: snapshot.soloNodeId,
        quality: this.#quality,
        factor: this.#factor,
        lane: "preview",
        present: "bitmap",
      });

      const image = result.image;
      if (image.kind !== "bitmap") {
        throw new Error("a timeline preview came back as raw bytes; the viewport takes bitmaps");
      }

      const target = this.#viewport;
      if (mine !== this.#generation || this.#disposed || !this.#owned || target === null) {
        // Nobody can take ownership of it, so it is closed rather than leaked:
        // an `ImageBitmap` holds GPU memory the JS heap does not account for.
        image.bitmap.close();
        log.debug("timeline frame discarded", { frame, reason });
        return;
      }

      target.setFrame({
        image: image.bitmap,
        documentWidth: result.documentWidth,
        documentHeight: result.documentHeight,
        quality: result.quality,
        correlationId: result.correlationId,
      });
      this.#meter.note(true, this.#now());
      this.#status = {
        ...this.#status,
        presentedFrame: frame,
        previewScale: result.documentWidth > 0 ? result.width / result.documentWidth : 1,
        quality: result.quality,
        error: null,
      };
      this.#publish();
    } catch (error) {
      if (this.#disposed) return;
      if (isAbandoned(error)) {
        // Ordinary: an export preempted this, or a newer frame replaced it.
        log.debug("timeline frame abandoned", { frame, reason });
      } else {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        log.error("timeline frame failed", { frame, reason, error: wrapped.message });
        this.#status = { ...this.#status, error: wrapped.message };
        this.#publish();
      }
    } finally {
      this.#inFlight = false;
      const next = this.#wanted;
      this.#wanted = null;
      if (next !== null && this.#owned && !this.#disposed) {
        void this.#renderNow(next, "pump");
      }
    }
  }

  // --- the transport ----------------------------------------------------

  #startLoop(): void {
    if (!this.#owned || this.#disposed) return;
    if (this.#loopHandle !== 0) return;
    this.#meter.reset();
    this.#playStartedAt = this.#now();
    this.#playStartFrame = this.#frame;
    this.#viewport?.beginInteraction("playback");
    log.info("playback started", { from: this.#frame });
    this.#tick();
  }

  #stopLoop(): void {
    if (this.#loopHandle !== 0) {
      this.#cancel(this.#loopHandle);
      this.#loopHandle = 0;
      log.info("playback stopped", { at: this.#frame });
    }
    this.#viewport?.endInteraction("playback");
    this.#meter.reset();
  }

  #tick = (): void => {
    this.#loopHandle = 0;
    if (!this.#playing || !this.#owned || this.#disposed) return;
    const plan = this.#plan;
    if (plan === null) return;

    const frame = frameAtElapsed(
      this.#playStartFrame,
      this.#now() - this.#playStartedAt,
      plan.clock.fps,
      plan.clock.frames,
    );
    if (frame !== this.#frame) {
      this.#frame = frame;
      this.#onPlayhead?.(frame);
      this.#request(frame, "playback");
    }
    this.#publish();
    this.#loopHandle = this.#schedule(this.#tick);
  };

  // --- notification -----------------------------------------------------

  #publish(): void {
    const playback = this.#playing
      ? this.#meter.report(this.#now(), this.#plan?.clock.fps ?? 0)
      : IDLE_REPORT;
    const next: PreviewStatus = {
      ...this.#status,
      engaged: this.#owned,
      playing: this.#playing,
      playback,
    };
    if (samePreviewStatus(next, this.#status)) return;
    this.#status = next;
    for (const listener of this.#listeners) listener();
  }
}

/**
 * Whether two statuses would show the same thing.
 *
 * Compared field by field rather than by identity because `#publish` rebuilds
 * the object on every animation frame, and `useSyncExternalStore` compares
 * snapshots with `Object.is` — a fresh object every tick would re-render the
 * whole panel sixty times a second to show the same numbers.
 */
export function samePreviewStatus(a: PreviewStatus, b: PreviewStatus): boolean {
  return (
    a.engaged === b.engaged &&
    a.playing === b.playing &&
    a.presentedFrame === b.presentedFrame &&
    a.previewScale === b.previewScale &&
    a.quality === b.quality &&
    a.error === b.error &&
    a.playback.presented === b.playback.presented &&
    a.playback.dropped === b.playback.dropped &&
    a.playback.behind === b.playback.behind
  );
}
