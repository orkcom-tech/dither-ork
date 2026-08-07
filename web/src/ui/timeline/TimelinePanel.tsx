import React from "react";

import { useViewport } from "../../app";
import { logger } from "../../lib/log";
import type { EffectRegistry } from "../../registry";
import type { FloatParam, IntParam } from "../../types/registry";
import { BindPicker } from "./BindPicker";
import { Ruler } from "./Ruler";
import { TrackRow } from "./TrackRow";
import { TransportBar } from "./TransportBar";
import { trackCurve, type TrackCurve } from "./evaluate";
import type { TimelineStore } from "./store";
import "./timeline.css";

const log = logger("app");

/** The interaction name a scrub or a key drag declares to the viewport (F-UI-03). */
const SCRUB_INTERACTION = "timeline-scrub";

export interface TimelinePanelProps {
  readonly store: TimelineStore;
  readonly registry: EffectRegistry;
}

/**
 * The timeline editor — F-AN-07 to F-AN-11.
 *
 * A track per bound parameter with the loop range, a playhead and per-track
 * collapse (F-AN-07); keyframes with five interpolations and a seam that closes
 * by construction (F-AN-08); play, pause, step and scrub with the preview
 * degrading visibly while it runs (F-AN-09); global speed and phase (F-AN-10);
 * per-track bypass and amount (F-AN-11).
 *
 * Everything it knows is in `store.ts`; this file is the drawing and the
 * gestures. The one thing it does that no other panel does is hand the viewport
 * to the timeline's own render pump — see `preview.ts` for why there can only be
 * one pump and why it is this one while a track exists.
 */
export function TimelinePanel({ store, registry }: TimelinePanelProps): React.ReactElement {
  const subscribe = React.useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  );
  const getSnapshot = React.useCallback(() => store.getSnapshot(), [store]);
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot);

  const viewport = useViewport();
  /**
   * The panel is the only part of the timeline inside the React tree, so it is
   * the only part that can see the viewport.
   *
   * Detaching on unmount is deliberate rather than tidiness: collapsing the
   * panel hands the viewport back to the session, and the preview goes back to
   * being the document as written. The alternative — keeping a frame from a
   * playhead nobody can see or move — is a picture with no control on screen
   * that explains it. The tracks are untouched and the frame comes back the
   * moment the panel does.
   */
  React.useEffect(() => {
    store.attachViewport(viewport);
    return () => {
      store.attachViewport(null);
    };
  }, [store, viewport]);

  const [picking, setPicking] = React.useState(false);

  const { state, document, frames, fps, plan, planError, preview } = snapshot;

  /**
   * The descriptor behind each track.
   *
   * Rebuilt when the document or the tracks move, which is also exactly when a
   * label or a legal range could have changed. A track whose descriptor is
   * missing is not drawn — the store prunes it on the same notification, so this
   * is the one render in between.
   */
  const described = React.useMemo(() => {
    const nodes = new Map(document.stack.map((node) => [node.id, node]));
    const rows: {
      readonly trackId: string;
      readonly param: FloatParam | IntParam;
      readonly effectName: string;
    }[] = [];
    for (const track of state.tracks) {
      const node = nodes.get(track.nodeId);
      if (node === undefined) continue;
      const descriptor = registry.get(node.effect);
      if (descriptor === undefined) continue;
      const param = descriptor.params.find((entry) => entry.key === track.param);
      if (param === undefined || (param.type !== "float" && param.type !== "int")) continue;
      rows.push({ trackId: track.id, param, effectName: descriptor.name });
    }
    return new Map(rows.map((row) => [row.trackId, row]));
  }, [document, state.tracks, registry]);

  /** Sampled once per plan, not once per playhead move — playback moves it 24 times a second. */
  const curves = React.useMemo(() => {
    const byTrack = new Map<string, TrackCurve>();
    if (plan === null) return byTrack;
    for (const track of state.tracks) {
      const curve = trackCurve(plan, track);
      if (curve !== null) byTrack.set(track.id, curve);
    }
    return byTrack;
  }, [plan, state.tracks]);

  const taken = React.useMemo(
    () => new Set(state.tracks.map((track) => track.id)),
    [state.tracks],
  );

  const beginScrub = (): void => viewport?.beginInteraction(SCRUB_INTERACTION);
  const endScrub = (): void => viewport?.endInteraction(SCRUB_INTERACTION);

  const canPlay = plan !== null && snapshot.hasSource;

  return (
    <div className="timeline">
      <TransportBar
        frames={frames}
        fps={fps}
        playhead={state.playhead}
        playing={state.playing}
        canPlay={canPlay}
        speed={state.speed}
        phaseOffset={state.phaseOffset}
        playback={preview.playback}
        previewScale={preview.previewScale}
        engaged={preview.engaged}
        binding={picking}
        onPlaying={(playing) => {
          log.info(playing ? "playback requested" : "pause requested", {
            at: state.playhead,
          });
          store.dispatch({ kind: "set-playing", playing });
        }}
        onStep={(delta) => store.dispatch({ kind: "step", delta })}
        onFrames={(next) => store.setClock({ frames: next, fps })}
        onFps={(next) => store.setClock({ frames, fps: next })}
        onSpeed={(speed) => store.dispatch({ kind: "set-speed", speed })}
        onPhaseOffset={(turns) => store.dispatch({ kind: "set-phase-offset", turns })}
        onBind={() => setPicking((open) => !open)}
      />

      {picking ? (
        <BindPicker
          document={document}
          registry={registry}
          taken={taken}
          onClose={() => setPicking(false)}
          onBind={(nodeId, param, kind, base, amount) => {
            log.info("parameter bound to a timeline track", { nodeId, param, kind });
            store.dispatch({ kind: "bind", nodeId, param, track: kind, base, amount });
            setPicking(false);
          }}
        />
      ) : null}

      {planError === null ? null : (
        <p className="timeline__notice timeline__notice--fail">
          <span>{planError}</span>
        </p>
      )}

      {state.refusal === null ? null : (
        <p className="timeline__notice timeline__notice--warn">
          <span>{state.refusal}</span>
        </p>
      )}

      {preview.error === null ? null : (
        <p className="timeline__notice timeline__notice--fail">
          <span>The frame at the playhead could not be rendered: {preview.error}</span>
        </p>
      )}

      {/*
        There was a notice here explaining an error banner: the session's own
        render pump used to hand `buildRenderGraph` the document as written,
        which refuses bindings, so an animated document put a failure on screen
        and this paragraph existed to say the picture was fine anyway.

        The pump now leaves an animated document to this panel — `state/
        session.ts`, `request()` — so there is no banner and nothing to explain.
        Saying "the render path refuses to draw this" beside a picture that is
        drawing correctly is worse than saying nothing, so it is gone rather
        than reworded.
      */}

      {state.tracks.length > 0 && !snapshot.hasSource ? (
        <p className="timeline__notice">
          <span>
            There is no image open, so there is nothing to play. The tracks are kept and the
            loop runs as soon as one is.
          </span>
        </p>
      ) : null}

      {/*
        Keyframe tracks are not in `.dork`. Modulator tracks are — they become
        `document.bindings` and come back on reload — so a person reasonably
        assumes both do, and finding out otherwise costs them the work. Said
        where the tracks are, and only when there is one to lose.
      */}
      {state.tracks.some((track) => track.spec.kind === "keyframe") ? (
        <p className="timeline__notice timeline__notice--warn">
          <span>
            Keyframe tracks are not saved. The document schema has no field for
            them yet, so they last for this session — modulator tracks are saved
            and come back with the document.
          </span>
        </p>
      ) : null}

      <div className="timeline__sheet">
        <div
          className="timeline__content"
          // A custom property rather than a `left`: the playhead is one element
          // over the whole sheet, and moving it is then one property write
          // instead of a re-layout of every row.
          style={
            {
              "--playhead": String(frames > 0 ? state.playhead / frames : 0),
            } as React.CSSProperties
          }
        >
          <div className="timeline__row">
            <div className="timeline__ruler-head">
              {state.tracks.length} track{state.tracks.length === 1 ? "" : "s"}
            </div>
            <Ruler
              frames={frames}
              fps={fps}
              playhead={state.playhead}
              onScrub={(frame) => store.dispatch({ kind: "set-playhead", frame })}
              onScrubStart={beginScrub}
              onScrubEnd={endScrub}
              onStep={(delta) => store.dispatch({ kind: "step", delta })}
            />
          </div>

          {state.tracks.length === 0 ? (
            <div className="timeline__empty">
              <p>
                No tracks. <b>Bind parameter</b> attaches a <b>modulator</b> — a shape that
                repeats a whole number of times per loop, so frame N is frame 0 — or a{" "}
                <b>keyframe</b> track, whose last key wraps round to its first for the same
                reason.
              </p>
              <p>
                While a track exists the timeline draws the preview itself, because the
                picture then depends on the playhead. It hands the viewport back the moment
                the last track goes.
              </p>
              <p>
                Tracks last as long as the session. <code>.dork</code> has a place for
                modulator bindings and this reads them when a document brings some, but it
                does not write them back: the render path refuses a document that carries
                bindings, so writing one would take the preview and the export button out
                together.
              </p>
            </div>
          ) : (
            state.tracks.map((track) => {
              const described_ = described.get(track.id);
              if (described_ === undefined) return null;
              return (
                <TrackRow
                  key={track.id}
                  track={track}
                  param={described_.param}
                  effectName={described_.effectName}
                  curve={curves.get(track.id) ?? null}
                  frames={frames}
                  playhead={state.playhead}
                  selected={state.selectedTrackId === track.id}
                  selectedKeyFrame={
                    state.selectedTrackId === track.id ? state.selectedKeyFrame : null
                  }
                  onSelect={() => store.dispatch({ kind: "select-track", trackId: track.id })}
                  onCollapse={(collapsed) =>
                    store.dispatch({ kind: "set-collapsed", trackId: track.id, collapsed })
                  }
                  onEnabled={(enabled) => {
                    log.info("timeline track " + (enabled ? "enabled" : "bypassed"), {
                      track: track.id,
                    });
                    store.dispatch({ kind: "set-enabled", trackId: track.id, enabled });
                  }}
                  onGain={(scale) =>
                    store.dispatch({ kind: "set-amount-scale", trackId: track.id, scale })
                  }
                  onRemove={() => {
                    log.info("timeline track removed", { track: track.id });
                    store.dispatch({ kind: "unbind", trackId: track.id });
                  }}
                  onModulator={(patch) =>
                    store.dispatch({ kind: "set-modulator", trackId: track.id, patch })
                  }
                  onAddKey={(frame) =>
                    store.dispatch({
                      kind: "add-key",
                      trackId: track.id,
                      frame,
                      // The value the track already has there, so setting a key
                      // and changing nothing else leaves the animation alone.
                      value: valueAtFrame(curves.get(track.id) ?? null, frame, frames),
                      easing: "linear",
                    })
                  }
                  onMoveKey={(from, to) =>
                    store.dispatch({ kind: "move-key", trackId: track.id, from, to })
                  }
                  onSelectKey={(frame) =>
                    store.dispatch({ kind: "select-key", trackId: track.id, frame })
                  }
                  onKeyValue={(frame, value) =>
                    store.dispatch({ kind: "set-key-value", trackId: track.id, frame, value })
                  }
                  onKeyEasing={(frame, easing) =>
                    store.dispatch({ kind: "set-key-easing", trackId: track.id, frame, easing })
                  }
                  onRemoveKey={(frame) =>
                    store.dispatch({ kind: "remove-key", trackId: track.id, frame })
                  }
                  onInteractionStart={beginScrub}
                  onInteractionEnd={endScrub}
                />
              );
            })
          )}

          <div className="timeline__playhead" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

/**
 * The value a lane is showing at a frame.
 *
 * Read off the sampled curve rather than re-evaluated, because the curve is what
 * is on screen and a key placed by clicking must land on the line the click
 * landed on. The sample nearest the frame is used; at more frames than samples
 * that is within half a sample, which is under a pixel on any lane this fits in.
 */
function valueAtFrame(curve: TrackCurve | null, frame: number, frames: number): number {
  if (curve === null || curve.values.length === 0) return 0;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < curve.frames.length; i += 1) {
    const at = curve.frames[i];
    if (at === undefined) continue;
    const distance = Math.min(Math.abs(at - frame), frames - Math.abs(at - frame));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return curve.values[bestIndex] ?? 0;
}
