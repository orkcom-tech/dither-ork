/**
 * What the timeline panel is handed, and the one place its three sources of
 * truth are joined.
 *
 * Three things have to agree and only one of them is owned here:
 *
 * - The **document** owns the clock (F-AN-01) and the parameters a track moves
 *   around. It is `state/store.ts`'s, and the timeline edits it only through
 *   `setClock` — one undoable step, like every other command.
 * - The **tracks** are owned here (`model.ts` says why they cannot live in the
 *   document yet).
 * - The **picture** is owned by `preview.ts`, which is the render pump while a
 *   track exists.
 *
 * This class is what keeps them consistent: a node deleted from the stack takes
 * its tracks with it, a shortened clock drops the keys that fell outside the
 * loop, and a document arriving with bindings — a `.dork`, a shared link —
 * becomes tracks so that it can be seen at all.
 *
 * ## The snapshot's identity changes exactly when its content does
 *
 * `useSyncExternalStore` compares snapshots with `Object.is`, so a store that
 * rebuilt its snapshot on every read would render forever. Same contract the
 * document store documents, same reason.
 *
 * ## The plan is rebuilt only when something it depends on moves
 *
 * Playback dispatches a playhead change up to `fps` times a second. Rebuilding
 * the animation plan on each one would resolve every binding and walk every
 * descriptor sixty times a second for an answer that cannot have changed —
 * `buildTimelinePlan` depends on the document, the tracks and the two global
 * timing controls, and on nothing else. Those four are compared by identity,
 * which works because `reduce` returns the same array when an edit changed
 * nothing.
 */

import { logger } from "../../lib/log";
import type { EffectRegistry } from "../../registry";
import type { EditorSession } from "../../state";
import type { Binding, Clock, DitherDocument } from "../../types/document";
import type { Viewport } from "../../viewport";
import { buildTimelinePlan, type TimelinePlan } from "./evaluate";
import {
  EMPTY_TIMELINE,
  modulatorBindings,
  reduce,
  survivingTrackIds,
  type TimelineAction,
  type TimelineState,
} from "./model";
import {
  IDLE_PREVIEW_STATUS,
  TimelinePreview,
  type PreviewStatus,
} from "./preview";

const log = logger("app");

export interface TimelineSnapshot {
  readonly state: TimelineState;
  readonly document: DitherDocument;
  /** The document's clock, unpacked because every lane needs both numbers. */
  readonly frames: number;
  readonly fps: number;
  /** `null` when a track cannot be resolved; `planError` then says why. */
  readonly plan: TimelinePlan | null;
  readonly planError: string | null;
  readonly hasSource: boolean;
  readonly preview: PreviewStatus;
  /** Increments on every change. */
  readonly revision: number;
}

export interface TimelineStoreOptions {
  readonly session: EditorSession;
  readonly registry: EffectRegistry;
  /** Overridden only by a harness; the panel builds the real one. */
  readonly preview?: TimelinePreview;
}

export class TimelineStore {
  readonly #session: EditorSession;
  readonly #registry: EffectRegistry;
  readonly #preview: TimelinePreview;
  readonly #listeners = new Set<() => void>();
  readonly #offDocument: () => void;
  readonly #offPreview: () => void;

  #state: TimelineState = EMPTY_TIMELINE;
  #plan: TimelinePlan | null = null;
  #planError: string | null = null;
  #revision = 0;
  #snapshot: TimelineSnapshot;
  #disposed = false;

  /** The four inputs the plan is a function of, held for the identity check. */
  #planDocument: DitherDocument | null = null;
  #planTracks: TimelineState["tracks"] | null = null;
  #planSpeed = -1;
  #planPhase = Number.NaN;

  /** The document's binding list as it was last adopted. */
  #adopted: readonly Binding[] | null = null;
  /** The tracks array as it was last written to the document. */
  #publishedTracks: TimelineState["tracks"] | null = null;
  #clock: Clock;

  constructor(options: TimelineStoreOptions) {
    this.#session = options.session;
    this.#registry = options.registry;
    this.#preview = options.preview ?? new TimelinePreview({ session: options.session });

    const document = this.#session.store.document;
    this.#clock = document.clock;
    this.#adopt(document.bindings, "startup");
    this.#recompute("startup");
    this.#snapshot = this.#build();

    this.#preview.onPlayhead((frame) => {
      this.dispatch({ kind: "set-playhead", frame });
    });
    this.#offDocument = this.#session.store.subscribe(() => this.#onDocument());
    this.#offPreview = this.#preview.subscribe(() => this.#changed());

    log.info("timeline store ready", { frames: document.clock.frames, fps: document.clock.fps });
  }

  // --- reading ----------------------------------------------------------

  readonly getSnapshot = (): TimelineSnapshot => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  get preview(): TimelinePreview {
    return this.#preview;
  }

  // --- writing ----------------------------------------------------------

  readonly dispatch = (action: TimelineAction): void => {
    if (this.#disposed) return;
    const frames = this.#session.store.document.clock.frames;
    const next = reduce(this.#state, action, frames);
    if (next === this.#state) return;
    this.#state = next;
    this.#publish(action);
    this.#recompute(action.kind);
    this.#changed();
  };

  /**
   * The loop range (F-AN-01, F-AN-07) — one undoable document edit.
   *
   * The clock is a document field, so it goes through the document store like
   * every other document edit and not into the timeline's own state; a second
   * copy here is a second copy that can disagree.
   */
  setClock(clock: Clock): void {
    if (this.#disposed) return;
    const current = this.#session.store.document.clock;
    if (current.frames === clock.frames && current.fps === clock.fps) return;
    log.info("loop range changed", { frames: clock.frames, fps: clock.fps });
    this.#session.store.setClock(clock);
  }

  /** Point the preview at the shell's viewport, or at nothing. */
  attachViewport(viewport: Viewport | null): void {
    this.#preview.attachViewport(viewport);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#offDocument();
    this.#offPreview();
    this.#preview.onPlayhead(null);
    this.#preview.dispose();
    this.#listeners.clear();
    log.info("timeline store disposed");
  }

  // --- keeping the three in step ----------------------------------------

  #onDocument(): void {
    if (this.#disposed) return;
    const document = this.#session.store.document;

    // A document that arrives carrying bindings — opened, shared, undone to —
    // becomes tracks. It is the one direction that works today, and it is what
    // makes such a document renderable: `state/render/graph.ts` refuses it, and
    // the preview pump here does not, because it resolves the bindings first.
    if (document.bindings !== this.#adopted) {
      this.#adopt(document.bindings, "document");
    }

    if (
      document.clock.frames !== this.#clock.frames ||
      document.clock.fps !== this.#clock.fps
    ) {
      this.#clock = document.clock;
      log.info("timeline follows a new loop range", {
        frames: document.clock.frames,
        fps: document.clock.fps,
      });
      const next = reduce(this.#state, { kind: "clock-changed" }, document.clock.frames);
      if (next !== this.#state) this.#state = next;
    }

    // A track is a reference to a node, not a value that can survive without
    // one — the same answer `surprise/animation.ts` gives for locked bindings.
    const keep = survivingTrackIds(this.#state.tracks, document, this.#registry);
    if (keep.size !== this.#state.tracks.length) {
      const next = reduce(this.#state, { kind: "prune", keep }, document.clock.frames);
      if (next !== this.#state) {
        log.info("timeline tracks dropped: their target is no longer in the document", {
          was: this.#state.tracks.length,
          kept: next.tracks.length,
        });
        this.#state = next;
      }
    }

    this.#recompute("document");
    this.#changed();
  }

  /**
   * Write the modulator tracks back into the document — the other direction.
   *
   * Without this the timeline is a one-way street: a document that arrives with
   * bindings becomes tracks, but a track a person makes here never becomes a
   * binding, so saving a `.dork`, autosaving or copying a share link silently
   * loses the whole animation. `document.bindings` is the schema's field for
   * exactly this and `state/mutations.ts` already validates what goes in it.
   *
   * ## Why this does not loop
   *
   * `#onDocument` adopts `document.bindings` whenever the array is not the one
   * it last adopted, and `mutate.setBindings` keeps the array it is given by
   * identity. So the array is claimed as adopted **before** it is handed over,
   * and the notification that comes back finds `document.bindings ===
   * this.#adopted` and does nothing.
   *
   * ## Why it is guarded on the tracks array
   *
   * `reduce` returns the same array when an edit changed no track, and playback
   * dispatches `set-playhead` up to `fps` times a second. Publishing on every
   * dispatch would put a document commit — and an autosave, and a history
   * entry — behind every frame of playback.
   *
   * ## Keyframe tracks are not written, and are not silently dropped either
   *
   * `.dork` has no field for them (`model.ts` says why). They stay in this
   * store, which means they survive an edit and do not survive a save. That is
   * a real limitation and it is stated in README.md and docs/API.md rather than
   * papered over here.
   */
  #publish(action: TimelineAction): void {
    if (this.#state.tracks === this.#publishedTracks) return;
    this.#publishedTracks = this.#state.tracks;

    const bindings = modulatorBindings(this.#state.tracks);
    const current = this.#session.store.document.bindings;
    if (bindings.length === 0 && current.length === 0) return;

    // Claimed before the store is told, so the notification it sends does not
    // read this back as a document that arrived carrying bindings.
    this.#adopted = bindings;
    const continuous = action.kind === "set-modulator" || action.kind === "set-amount-scale";
    try {
      this.#session.store.setBindings(bindings, { continuous });
    } catch (error) {
      // `mutate.setBindings` refuses a binding whose node is gone or whose
      // cycle count is not an integer. Neither is reachable through the panel —
      // pruning removes an orphaned track and the field refuses a fraction — so
      // this is a defect rather than a state, and it is reported as one instead
      // of leaving the document and the tracks disagreeing in silence.
      const message = error instanceof Error ? error.message : String(error);
      log.error("the timeline's tracks could not be written to the document", {
        action: action.kind,
        bindings: bindings.length,
        error: message,
      });
      this.#adopted = current;
      this.#publishedTracks = null;
    }
  }

  #adopt(bindings: readonly Binding[], reason: string): boolean {
    this.#adopted = bindings;
    if (bindings.length === 0) {
      // Still recorded: an empty document is one whose tracks and bindings
      // agree, and the next dispatch should publish because it changed
      // something, not because this never caught up.
      this.#publishedTracks = this.#state.tracks;
      return false;
    }
    const frames = this.#session.store.document.clock.frames;
    const next = reduce(this.#state, { kind: "adopt-bindings", bindings }, frames);
    this.#publishedTracks = next.tracks;
    if (next === this.#state) return false;
    log.info("timeline adopted the document's bindings as tracks", {
      bindings: bindings.length,
      reason,
    });
    this.#state = next;
    return true;
  }

  /**
   * Rebuild the plan if one of its four inputs moved, then tell the preview.
   *
   * A plan that cannot be built is `null` with a message rather than a throw:
   * the person editing may be halfway through choosing the numbers, and the
   * panel shows the reason where the track is.
   */
  #recompute(reason: string): void {
    const document = this.#session.store.document;
    const stale =
      document !== this.#planDocument ||
      this.#state.tracks !== this.#planTracks ||
      this.#state.speed !== this.#planSpeed ||
      !Object.is(this.#state.phaseOffset, this.#planPhase);

    if (stale) {
      this.#planDocument = document;
      this.#planTracks = this.#state.tracks;
      this.#planSpeed = this.#state.speed;
      this.#planPhase = this.#state.phaseOffset;

      if (this.#state.tracks.length === 0) {
        this.#plan = null;
        this.#planError = null;
      } else {
        try {
          this.#plan = buildTimelinePlan({
            document,
            registry: this.#registry,
            tracks: this.#state.tracks,
            speed: this.#state.speed,
            phaseOffset: this.#state.phaseOffset,
          });
          this.#planError = null;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.error("the timeline plan could not be built", { reason, error: message });
          this.#plan = null;
          this.#planError = message;
        }
      }
      this.#preview.setPlan(this.#plan);
    }

    // Playback with nothing to play would leave a transport button saying it is
    // running while every frame is the same picture, so the flag is put back
    // rather than left to lie.
    if (this.#state.playing && this.#plan === null) {
      log.info("playback stopped: there is no track to play");
      this.#state = { ...this.#state, playing: false };
    }
    this.#preview.setFrame(this.#state.playhead);
    this.#preview.setPlaying(this.#state.playing);
  }

  #changed(): void {
    if (this.#disposed) return;
    this.#revision += 1;
    this.#snapshot = this.#build();
    for (const listener of this.#listeners) listener();
  }

  #build(): TimelineSnapshot {
    const document = this.#session.store.document;
    return {
      state: this.#state,
      document,
      frames: document.clock.frames,
      fps: document.clock.fps,
      plan: this.#plan,
      planError: this.#planError,
      hasSource: this.#session.store.getSnapshot().source !== null,
      preview: this.#disposed ? IDLE_PREVIEW_STATUS : this.#preview.getStatus(),
      revision: this.#revision,
    };
  }
}
