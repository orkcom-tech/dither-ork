/**
 * The timeline's state, and every edit that can happen to it — F-AN-07, 08, 09,
 * 10 and 11.
 *
 * Pure and immutable, with no React, no DOM and no clock. Everything that
 * decides *what a track is and what an edit does to it* is here and is tested;
 * the components draw rectangles and dispatch these actions.
 *
 * ## One track per parameter, and the id says so
 *
 * A track's id is `nodeId::param`. That is not a shortcut around generating one:
 * it is the uniqueness rule, spelled as a value. `animation/binding.ts` refuses
 * a document in which two bindings drive one parameter — "whichever won would be
 * an accident of order" — and the same argument applies to a keyframe track
 * sitting on a parameter a modulator already drives. Deriving the id from the
 * target makes that collision *unrepresentable* rather than checked, and it
 * keeps every id a pure function of the document, so nothing here reads a clock
 * or a random source to mint one.
 *
 * ## Why the tracks are not written into the document
 *
 * `state/render/graph.ts` **refuses** a document that carries modulator
 * bindings, by name and with a message: nothing downstream of it resolves one,
 * so rendering the document as written would produce a picture that is not the
 * document. Export, autosave and the session's own render pump all hand
 * `store.document` straight to that function. Writing a track into
 * `document.bindings` from here would therefore not animate anything — it would
 * take the export button and the preview out at the same time.
 *
 * So the timeline holds its tracks itself and resolves them per frame into a
 * document that carries **no** bindings, which is exactly what
 * `animation/plan.ts` produces and exactly what the renderer accepts. The
 * precedent is in that file: temporal variations are a plan option rather than a
 * document field "because `.dork` has no place for them yet". This is the same
 * position, and the way out is the same one — a schema that carries them and a
 * render path that resolves them, neither of which is in this directory.
 *
 * The consequence is stated where a user can see it, in the panel: tracks last
 * as long as the session. Bindings that arrive **in** a document (a `.dork`, a
 * shared link) are adopted as tracks, which is the one direction that works
 * today and is what makes such a document renderable at all.
 *
 * ## Enable and amount are a mixer, not the document
 *
 * F-AN-11's per-track bypass and per-track amount are live controls over how
 * much of a track reaches the picture, in the same category as solo in
 * `state/store.ts` — "a way of *looking* at a document rather than part of one".
 * A bypassed track keeps its numbers; a track at amount 0 is the identity and
 * the parameter sits at the value the properties panel shows.
 */

import type { Binding, DitherDocument, ModulatorShape } from "../../types/document";
import type { EffectRegistry } from "../../registry";
import type { ParamDescriptor } from "../../types/registry";
import { MAX_CYCLES_PER_LOOP, MAX_GLOBAL_SPEED, isCyclesPerLoop, isGlobalSpeed } from "../../animation";
import {
  addKey,
  keysWithinLoop,
  moveKey,
  removeKey,
  setKeyEasing,
  setKeyValue,
  wrapFrame,
  type Easing,
  type Keyframe,
} from "./keyframes";

/** How much of a track reaches the picture (F-AN-11). */
export const MAX_AMOUNT_SCALE = 4;

/** The two kinds of track F-AN-07 and F-AN-08 put on the sheet. */
export type TrackKind = "modulator" | "keyframe";

/** A modulator track — the document's `Binding` fields, minus its target. */
export interface ModulatorSpec {
  readonly kind: "modulator";
  readonly shape: ModulatorShape;
  readonly amount: number;
  readonly cyclesPerLoop: number;
  readonly phase: number;
  readonly bipolar: boolean;
}

export interface KeyframeSpec {
  readonly kind: "keyframe";
  readonly keys: readonly Keyframe[];
}

export interface Track {
  /** `nodeId::param`. See the note at the top of the file. */
  readonly id: string;
  readonly nodeId: string;
  readonly param: string;
  /** F-AN-11 — bypass. A bypassed track leaves the parameter where it is authored. */
  readonly enabled: boolean;
  /** F-AN-11 — the track's gain, `[0, MAX_AMOUNT_SCALE]`. 1 is the track as written. */
  readonly amountScale: number;
  /** F-AN-07 — whether the row shows its controls. */
  readonly collapsed: boolean;
  readonly spec: ModulatorSpec | KeyframeSpec;
}

export interface TimelineState {
  readonly tracks: readonly Track[];
  /** Where the playhead is, always in `[0, frames)`. */
  readonly playhead: number;
  readonly playing: boolean;
  /** F-AN-10 — multiplies every modulator's cycles-per-loop. A positive integer. */
  readonly speed: number;
  /** F-AN-10 — turns added to every modulator's phase. */
  readonly phaseOffset: number;
  readonly selectedTrackId: string | null;
  /** The key the keyframe editor is pointed at, as a frame index. */
  readonly selectedKeyFrame: number | null;
  /**
   * The last edit that was refused, kept until the next one succeeds.
   *
   * A refusal rather than a silent clamp: rounding 2.5 cycles to 3 would give a
   * loop that closes and an animation nobody asked for, which is the argument
   * `animation/cycles.ts` makes at length.
   */
  readonly refusal: string | null;
}

export const EMPTY_TIMELINE: TimelineState = {
  tracks: [],
  playhead: 0,
  playing: false,
  speed: 1,
  phaseOffset: 0,
  selectedTrackId: null,
  selectedKeyFrame: null,
  refusal: null,
};

export function trackId(nodeId: string, param: string): string {
  return `${nodeId}::${param}`;
}

export function findTrack(
  state: TimelineState,
  id: string | null,
): Track | undefined {
  if (id === null) return undefined;
  return state.tracks.find((track) => track.id === id);
}

/** Whether a modulator or a keyframe track may drive this parameter (F-AN-02). */
export function isBindableParam(param: ParamDescriptor): boolean {
  return param.animatable && (param.type === "float" || param.type === "int");
}

/** The default modulator a newly bound parameter gets. */
export function defaultModulator(): ModulatorSpec {
  return {
    kind: "modulator",
    shape: "sine",
    // Read as parameter units, like `animation/binding.ts` evaluates it:
    // `value = base + amount * unit`. Set from the parameter's own range at the
    // call site, because 0.25 means something different on a `[0, 1]` opacity
    // and on a `[-180, 180]` screen angle.
    amount: 0,
    cyclesPerLoop: 1,
    phase: 0,
    bipolar: true,
  };
}

// --- actions ------------------------------------------------------------

export type TimelineAction =
  /** Replace every modulator track from a document's bindings. */
  | { readonly kind: "adopt-bindings"; readonly bindings: readonly Binding[] }
  | {
      readonly kind: "bind";
      readonly nodeId: string;
      readonly param: string;
      readonly track: TrackKind;
      /** The parameter's authored value — the first key of a keyframe track. */
      readonly base: number;
      /** Modulator amount for a new modulator track, in parameter units. */
      readonly amount: number;
    }
  | { readonly kind: "unbind"; readonly trackId: string }
  | { readonly kind: "prune"; readonly keep: ReadonlySet<string> }
  | {
      readonly kind: "set-modulator";
      readonly trackId: string;
      readonly patch: Partial<Omit<ModulatorSpec, "kind">>;
    }
  | { readonly kind: "set-enabled"; readonly trackId: string; readonly enabled: boolean }
  | { readonly kind: "set-amount-scale"; readonly trackId: string; readonly scale: number }
  | { readonly kind: "set-collapsed"; readonly trackId: string; readonly collapsed: boolean }
  | { readonly kind: "select-track"; readonly trackId: string | null }
  | { readonly kind: "select-key"; readonly trackId: string; readonly frame: number | null }
  | {
      readonly kind: "add-key";
      readonly trackId: string;
      readonly frame: number;
      readonly value: number;
      readonly easing: Easing;
    }
  | { readonly kind: "move-key"; readonly trackId: string; readonly from: number; readonly to: number }
  | { readonly kind: "remove-key"; readonly trackId: string; readonly frame: number }
  | { readonly kind: "set-key-value"; readonly trackId: string; readonly frame: number; readonly value: number }
  | { readonly kind: "set-key-easing"; readonly trackId: string; readonly frame: number; readonly easing: Easing }
  | { readonly kind: "set-playhead"; readonly frame: number }
  | { readonly kind: "step"; readonly delta: number }
  | { readonly kind: "set-playing"; readonly playing: boolean }
  | { readonly kind: "set-speed"; readonly speed: number }
  | { readonly kind: "set-phase-offset"; readonly turns: number }
  /** The clock changed under the tracks; drop keys the loop no longer contains. */
  | { readonly kind: "clock-changed" };

function refuse(state: TimelineState, reason: string): TimelineState {
  if (state.refusal === reason) return state;
  return { ...state, refusal: reason };
}

/**
 * Replace one track, or refuse the edit.
 *
 * The callback returns the new track, the same track when the edit is a no-op,
 * or a string, which is a refusal and reaches the panel as one. Written with an
 * index lookup rather than by assigning into a closure from inside `map`,
 * because a variable a nested function writes is a variable TypeScript's
 * control-flow analysis has to give up on.
 */
function withTrack(
  state: TimelineState,
  id: string,
  change: (track: Track) => Track | string,
): TimelineState {
  const index = state.tracks.findIndex((track) => track.id === id);
  const current = state.tracks[index];
  if (current === undefined) return state;

  const next = change(current);
  if (typeof next === "string") return refuse(state, next);
  if (next === current) return state;

  const tracks = [...state.tracks];
  tracks[index] = next;
  return { ...state, tracks, refusal: null };
}

function withKeys(
  state: TimelineState,
  id: string,
  change: (keys: readonly Keyframe[]) => readonly Keyframe[],
): TimelineState {
  return withTrack(state, id, (track) => {
    if (track.spec.kind !== "keyframe") {
      return `"${track.param}" carries a modulator, not keyframes; the two cannot share a parameter`;
    }
    const keys = change(track.spec.keys);
    if (keys === track.spec.keys) return track;
    return { ...track, spec: { kind: "keyframe", keys } };
  });
}

/**
 * Apply one edit.
 *
 * `frames` is the document's frame count, which every frame index is wrapped
 * into. It is a parameter rather than a field of the state because the clock
 * lives in the document and there must not be a second copy of it here that can
 * disagree.
 */
export function reduce(
  state: TimelineState,
  action: TimelineAction,
  frames: number,
): TimelineState {
  switch (action.kind) {
    case "adopt-bindings": {
      const keyframeTracks = state.tracks.filter((track) => track.spec.kind === "keyframe");
      const taken = new Set<string>();
      const adopted: Track[] = [];
      for (const binding of action.bindings) {
        const id = trackId(binding.nodeId, binding.param);
        if (taken.has(id)) continue;
        taken.add(id);
        adopted.push({
          id,
          nodeId: binding.nodeId,
          param: binding.param,
          enabled: true,
          amountScale: 1,
          collapsed: true,
          spec: {
            kind: "modulator",
            shape: binding.shape,
            amount: binding.amount,
            cyclesPerLoop: binding.cyclesPerLoop,
            phase: binding.phase,
            bipolar: binding.bipolar,
          },
        });
      }
      // A keyframe track on a parameter the incoming document modulates is
      // dropped rather than silently ignored downstream: one track per
      // parameter is the rule the id encodes.
      const kept = keyframeTracks.filter((track) => !taken.has(track.id));
      const tracks = [...adopted, ...kept];
      // Playing must imply there is something to play. Adopting a document with
      // no bindings — Surprise Me with animation off is the usual way to get
      // one — used to leave the transport running over an empty track list: the
      // clock kept advancing and the render pump kept redrawing frame t, so a
      // freshly generated document was overwritten a moment after it appeared
      // and the whole generator looked broken. The pause control was no help
      // because the panel renders its empty state at zero tracks, so there was
      // nothing left to press.
      const playing = tracks.length === 0 ? false : state.playing;
      return { ...state, tracks, playing, refusal: null };
    }

    case "bind": {
      const id = trackId(action.nodeId, action.param);
      if (state.tracks.some((track) => track.id === id)) {
        return refuse(
          state,
          `"${action.param}" already has a track; one parameter carries one track, because two ` +
            `would disagree and whichever won would be an accident of order`,
        );
      }
      const spec: ModulatorSpec | KeyframeSpec =
        action.track === "modulator"
          ? { ...defaultModulator(), amount: action.amount }
          : {
              kind: "keyframe",
              // One key, on the frame the playhead is on, holding the value the
              // parameter already has. A new track therefore changes nothing
              // until a second key is set — it is the identity, visibly.
              keys: [
                {
                  frame: wrapFrame(state.playhead, frames),
                  value: action.base,
                  easing: "linear",
                },
              ],
            };
      const track: Track = {
        id,
        nodeId: action.nodeId,
        param: action.param,
        enabled: true,
        amountScale: 1,
        collapsed: false,
        spec,
      };
      return {
        ...state,
        tracks: [...state.tracks, track],
        selectedTrackId: id,
        selectedKeyFrame: action.track === "keyframe" ? wrapFrame(state.playhead, frames) : null,
        refusal: null,
      };
    }

    case "unbind": {
      const tracks = state.tracks.filter((track) => track.id !== action.trackId);
      if (tracks.length === state.tracks.length) return state;
      return {
        ...state,
        tracks,
        selectedTrackId: state.selectedTrackId === action.trackId ? null : state.selectedTrackId,
        selectedKeyFrame: state.selectedTrackId === action.trackId ? null : state.selectedKeyFrame,
        refusal: null,
      };
    }

    case "prune": {
      const tracks = state.tracks.filter((track) => action.keep.has(track.id));
      if (tracks.length === state.tracks.length) return state;
      const selected =
        state.selectedTrackId !== null && !action.keep.has(state.selectedTrackId)
          ? null
          : state.selectedTrackId;
      return {
        ...state,
        tracks,
        selectedTrackId: selected,
        selectedKeyFrame: selected === null ? null : state.selectedKeyFrame,
      };
    }

    case "set-modulator":
      return withTrack(state, action.trackId, (track) => {
        if (track.spec.kind !== "modulator") {
          return `"${track.param}" carries keyframes, not a modulator`;
        }
        const patch = action.patch;
        const cycles = patch.cyclesPerLoop ?? track.spec.cyclesPerLoop;
        if (!isCyclesPerLoop(cycles)) {
          return (
            `cycles per loop is ${String(cycles)}; it must be a whole number from 1 to ` +
            `${MAX_CYCLES_PER_LOOP}. An integer count is what makes frame N equal frame 0 (F-AN-03), ` +
            `so a fractional one is refused rather than rounded to one that closes.`
          );
        }
        const amount = patch.amount ?? track.spec.amount;
        const phase = patch.phase ?? track.spec.phase;
        if (!Number.isFinite(amount)) {
          return `amount is ${String(amount)}; a modulator field must be a finite number`;
        }
        if (!Number.isFinite(phase)) {
          return `phase is ${String(phase)}; a modulator field must be a finite number`;
        }
        const spec: ModulatorSpec = {
          kind: "modulator",
          shape: patch.shape ?? track.spec.shape,
          amount,
          cyclesPerLoop: cycles,
          phase,
          bipolar: patch.bipolar ?? track.spec.bipolar,
        };
        const same =
          spec.shape === track.spec.shape &&
          spec.amount === track.spec.amount &&
          spec.cyclesPerLoop === track.spec.cyclesPerLoop &&
          spec.phase === track.spec.phase &&
          spec.bipolar === track.spec.bipolar;
        return same ? track : { ...track, spec };
      });

    case "set-enabled":
      return withTrack(state, action.trackId, (track) =>
        track.enabled === action.enabled ? track : { ...track, enabled: action.enabled },
      );

    case "set-amount-scale":
      return withTrack(state, action.trackId, (track) => {
        if (!Number.isFinite(action.scale) || action.scale < 0 || action.scale > MAX_AMOUNT_SCALE) {
          return `track amount is ${String(action.scale)}; it must be between 0 and ${MAX_AMOUNT_SCALE}`;
        }
        return track.amountScale === action.scale ? track : { ...track, amountScale: action.scale };
      });

    case "set-collapsed":
      return withTrack(state, action.trackId, (track) =>
        track.collapsed === action.collapsed ? track : { ...track, collapsed: action.collapsed },
      );

    case "select-track":
      if (state.selectedTrackId === action.trackId) return state;
      return { ...state, selectedTrackId: action.trackId, selectedKeyFrame: null };

    case "select-key": {
      const frame = action.frame === null ? null : wrapFrame(action.frame, frames);
      if (state.selectedTrackId === action.trackId && state.selectedKeyFrame === frame) {
        return state;
      }
      return { ...state, selectedTrackId: action.trackId, selectedKeyFrame: frame };
    }

    case "add-key": {
      const frame = wrapFrame(action.frame, frames);
      if (!Number.isFinite(action.value)) {
        return refuse(state, `a keyframe value must be a finite number; it was ${String(action.value)}`);
      }
      const next = withKeys(state, action.trackId, (keys) =>
        addKey(keys, { frame, value: action.value, easing: action.easing }, frames),
      );
      if (next === state) return state;
      return { ...next, selectedTrackId: action.trackId, selectedKeyFrame: frame };
    }

    case "move-key": {
      const to = wrapFrame(action.to, frames);
      const next = withKeys(state, action.trackId, (keys) =>
        moveKey(keys, action.from, to, frames),
      );
      if (next === state) return state;
      return { ...next, selectedTrackId: action.trackId, selectedKeyFrame: to };
    }

    case "remove-key": {
      const frame = wrapFrame(action.frame, frames);
      const track = findTrack(state, action.trackId);
      if (track !== undefined && track.spec.kind === "keyframe" && track.spec.keys.length <= 1) {
        return refuse(
          state,
          `a keyframe track keeps at least one key — remove the track itself to stop it driving ` +
            `"${track.param}"`,
        );
      }
      const next = withKeys(state, action.trackId, (keys) => removeKey(keys, frame, frames));
      if (next === state) return state;
      return {
        ...next,
        selectedKeyFrame: state.selectedKeyFrame === frame ? null : state.selectedKeyFrame,
      };
    }

    case "set-key-value":
      if (!Number.isFinite(action.value)) {
        return refuse(state, `a keyframe value must be a finite number; it was ${String(action.value)}`);
      }
      return withKeys(state, action.trackId, (keys) =>
        setKeyValue(keys, action.frame, action.value, frames),
      );

    case "set-key-easing":
      return withKeys(state, action.trackId, (keys) =>
        setKeyEasing(keys, action.frame, action.easing, frames),
      );

    case "set-playhead": {
      const frame = wrapFrame(action.frame, frames);
      if (frame === state.playhead) return state;
      return { ...state, playhead: frame };
    }

    case "step": {
      if (!Number.isSafeInteger(action.delta)) return state;
      const frame = wrapFrame(state.playhead + action.delta, frames);
      if (frame === state.playhead) return state;
      // Stepping stops playback: the two are different ways of moving the
      // playhead and running both leaves it somewhere neither one asked for.
      return { ...state, playhead: frame, playing: false };
    }

    case "set-playing":
      if (state.playing === action.playing) return state;
      // The same invariant from the other side: nothing to play, nothing to
      // start. Silent rather than a refusal — the transport is not reachable at
      // zero tracks, so arriving here means a caller asked on the user's behalf,
      // and telling them a control they never touched was rejected is noise.
      if (action.playing && state.tracks.length === 0) return state;
      return { ...state, playing: action.playing };

    case "set-speed":
      if (!isGlobalSpeed(action.speed)) {
        return refuse(
          state,
          `global speed is ${String(action.speed)}; it must be a whole number from 1 to ` +
            `${MAX_GLOBAL_SPEED}. It multiplies every track's cycles-per-loop, so a fractional ` +
            `speed would take every track out of F-AN-03 at once. To run a loop slower, raise ` +
            `the frame count.`,
        );
      }
      if (state.speed === action.speed) return state;
      return { ...state, speed: action.speed, refusal: null };

    case "set-phase-offset": {
      if (!Number.isFinite(action.turns)) {
        return refuse(state, `phase offset is ${String(action.turns)}; it must be a finite number`);
      }
      if (state.phaseOffset === action.turns) return state;
      return { ...state, phaseOffset: action.turns, refusal: null };
    }

    case "clock-changed": {
      const playhead = wrapFrame(state.playhead, frames);
      let changed = playhead !== state.playhead;
      const tracks = state.tracks.map((track) => {
        if (track.spec.kind !== "keyframe") return track;
        const keys = keysWithinLoop(track.spec.keys, frames);
        if (keys.length === track.spec.keys.length) return track;
        changed = true;
        // A track whose every key fell outside the new loop would evaluate to
        // nothing; it keeps one key, on the last frame that exists, so the
        // parameter stays where the track last put it rather than jumping.
        const survivors =
          keys.length > 0
            ? keys
            : [{ frame: frames - 1, value: lastValue(track.spec.keys), easing: "linear" as const }];
        return { ...track, spec: { kind: "keyframe" as const, keys: survivors } };
      });
      if (!changed) return state;
      const selectedKeyFrame =
        state.selectedKeyFrame !== null && state.selectedKeyFrame >= frames
          ? null
          : state.selectedKeyFrame;
      return { ...state, tracks, playhead, selectedKeyFrame };
    }
  }
}

function lastValue(keys: readonly Keyframe[]): number {
  const last = keys[keys.length - 1];
  return last === undefined ? 0 : last.value;
}

/**
 * The modulator tracks, as the `Binding` list `animation/plan.ts` takes.
 *
 * Bypassed tracks are left out entirely rather than emitted with amount 0: a
 * binding that resolves is a binding the seam validator and the swing report
 * have to talk about, and a bypassed track is not part of the animation.
 * F-AN-11's amount scaling is folded into `amount` here, which is where
 * `value = base + amount * unit` reads it.
 *
 * Exported because it is also the shape a `.dork` would carry, the day
 * `state/render/graph.ts` resolves bindings instead of refusing them: this
 * function is the whole of what would then be written into the document.
 */
export function modulatorBindings(tracks: readonly Track[]): readonly Binding[] {
  const bindings: Binding[] = [];
  for (const track of tracks) {
    if (!track.enabled) continue;
    if (track.spec.kind !== "modulator") continue;
    bindings.push({
      nodeId: track.nodeId,
      param: track.param,
      shape: track.spec.shape,
      amount: track.spec.amount * track.amountScale,
      cyclesPerLoop: track.spec.cyclesPerLoop,
      phase: track.spec.phase,
      bipolar: track.spec.bipolar,
    });
  }
  return bindings;
}

/** The keyframe tracks that are switched on, in sheet order. */
export function liveKeyframeTracks(tracks: readonly Track[]): readonly Track[] {
  return tracks.filter((track) => track.enabled && track.spec.kind === "keyframe");
}

/**
 * Track ids whose target still exists in a document.
 *
 * A node deleted from the stack takes its tracks with it — the same answer
 * `surprise/animation.ts` gives for locked bindings, and for the same reason: a
 * track is a reference to a node, not a value that can survive without one.
 */
export function survivingTrackIds(
  tracks: readonly Track[],
  document: DitherDocument,
  registry: EffectRegistry,
): ReadonlySet<string> {
  const nodes = new Map(document.stack.map((node) => [node.id, node]));
  const keep = new Set<string>();
  for (const track of tracks) {
    const node = nodes.get(track.nodeId);
    if (node === undefined) continue;
    const descriptor = registry.get(node.effect);
    if (descriptor === undefined) continue;
    const param = descriptor.params.find((entry) => entry.key === track.param);
    if (param === undefined || !isBindableParam(param)) continue;
    keep.add(track.id);
  }
  return keep;
}
