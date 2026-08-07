import { describe, expect, it } from "vitest";

import { patternNode, plainNode, testDocument, testRegistry } from "../../animation/fixture";
import type { Binding } from "../../types/document";
import {
  EMPTY_TIMELINE,
  MAX_AMOUNT_SCALE,
  findTrack,
  isBindableParam,
  liveKeyframeTracks,
  modulatorBindings,
  reduce,
  survivingTrackIds,
  trackId,
  type TimelineAction,
  type TimelineState,
} from "./model";

const N = 60;

function apply(state: TimelineState, ...actions: readonly TimelineAction[]): TimelineState {
  let current = state;
  for (const action of actions) current = reduce(current, action, N);
  return current;
}

const bindGain: TimelineAction = {
  kind: "bind",
  nodeId: "plain",
  param: "gain",
  track: "modulator",
  base: 1,
  amount: 0.5,
};

const bindSpread: TimelineAction = {
  kind: "bind",
  nodeId: "pattern",
  param: "spread",
  track: "keyframe",
  base: 1,
  amount: 0,
};

describe("track identity", () => {
  it("is derived from the target, so two tracks on one parameter cannot exist", () => {
    expect(trackId("n1", "gain")).toBe("n1::gain");
    const state = apply(EMPTY_TIMELINE, bindGain, bindGain);
    expect(state.tracks).toHaveLength(1);
    expect(state.refusal).toMatch(/already has a track/);
  });

  it("mints no id from a clock or a random source", () => {
    const first = apply(EMPTY_TIMELINE, bindGain).tracks[0]?.id;
    const second = apply(EMPTY_TIMELINE, bindGain).tracks[0]?.id;
    expect(first).toBe(second);
  });
});

describe("binding a parameter", () => {
  it("starts a modulator track at the amount it was given", () => {
    const track = apply(EMPTY_TIMELINE, bindGain).tracks[0];
    expect(track?.spec).toEqual({
      kind: "modulator",
      shape: "sine",
      amount: 0.5,
      cyclesPerLoop: 1,
      phase: 0,
      bipolar: true,
    });
  });

  it("starts a keyframe track with one key on the playhead holding the authored value", () => {
    const state = apply(EMPTY_TIMELINE, { kind: "set-playhead", frame: 12 }, bindSpread);
    const track = state.tracks[0];
    expect(track?.spec).toEqual({
      kind: "keyframe",
      keys: [{ frame: 12, value: 1, easing: "linear" }],
    });
    // One key is a constant, so a new track changes nothing until a second one.
    expect(state.selectedKeyFrame).toBe(12);
  });
});

describe("F-AN-03 is enforced at the edit, not at the render", () => {
  it("refuses a fractional cycles-per-loop rather than rounding it", () => {
    const bound = apply(EMPTY_TIMELINE, bindGain);
    const id = trackId("plain", "gain");
    const next = reduce(
      bound,
      { kind: "set-modulator", trackId: id, patch: { cyclesPerLoop: 2.5 } },
      N,
    );
    expect(next.refusal).toMatch(/whole number/);
    const track = findTrack(next, id);
    expect(track?.spec.kind === "modulator" ? track.spec.cyclesPerLoop : null).toBe(1);
  });

  it("refuses a fractional global speed for the same reason", () => {
    const next = reduce(EMPTY_TIMELINE, { kind: "set-speed", speed: 0.5 }, N);
    expect(next.speed).toBe(1);
    expect(next.refusal).toMatch(/whole number/);
  });

  it("takes a whole speed", () => {
    expect(reduce(EMPTY_TIMELINE, { kind: "set-speed", speed: 3 }, N).speed).toBe(3);
  });
});

describe("F-AN-11 — bypass and per-track amount", () => {
  it("folds the track amount into the binding the plan sees", () => {
    const state = apply(
      EMPTY_TIMELINE,
      bindGain,
      { kind: "set-amount-scale", trackId: trackId("plain", "gain"), scale: 0.5 },
    );
    expect(modulatorBindings(state.tracks)[0]?.amount).toBe(0.25);
  });

  it("leaves a bypassed track out of the plan entirely", () => {
    const state = apply(
      EMPTY_TIMELINE,
      bindGain,
      { kind: "set-enabled", trackId: trackId("plain", "gain"), enabled: false },
    );
    expect(modulatorBindings(state.tracks)).toHaveLength(0);
    // Bypassed, not deleted: the numbers are still there.
    expect(state.tracks).toHaveLength(1);
  });

  it("keeps a bypassed keyframe track out of the live set", () => {
    const state = apply(
      EMPTY_TIMELINE,
      bindSpread,
      { kind: "set-enabled", trackId: trackId("pattern", "spread"), enabled: false },
    );
    expect(liveKeyframeTracks(state.tracks)).toHaveLength(0);
  });

  it("refuses an amount outside the range the control offers", () => {
    const state = apply(EMPTY_TIMELINE, bindGain);
    const next = reduce(
      state,
      { kind: "set-amount-scale", trackId: trackId("plain", "gain"), scale: MAX_AMOUNT_SCALE + 1 },
      N,
    );
    expect(next.refusal).toMatch(/must be between/);
    expect(next.tracks[0]?.amountScale).toBe(1);
  });
});

describe("the playhead", () => {
  it("wraps in both directions", () => {
    expect(reduce(EMPTY_TIMELINE, { kind: "set-playhead", frame: 61 }, N).playhead).toBe(1);
    expect(reduce(EMPTY_TIMELINE, { kind: "step", delta: -1 }, N).playhead).toBe(59);
  });

  it("stops playback when it is stepped, so the two do not both move it", () => {
    const playing = reduce(EMPTY_TIMELINE, { kind: "set-playing", playing: true }, N);
    expect(reduce(playing, { kind: "step", delta: 1 }, N).playing).toBe(false);
  });
});

describe("keyframe editing through the reducer", () => {
  const bound = apply(EMPTY_TIMELINE, bindSpread);
  const id = trackId("pattern", "spread");

  it("keeps the last key rather than emptying the track", () => {
    const next = reduce(bound, { kind: "remove-key", trackId: id, frame: 0 }, N);
    expect(next.refusal).toMatch(/at least one key/);
  });

  it("refuses a key on a modulator track", () => {
    const both = apply(bound, bindGain);
    const next = reduce(
      both,
      { kind: "add-key", trackId: trackId("plain", "gain"), frame: 5, value: 1, easing: "linear" },
      N,
    );
    expect(next.refusal).toMatch(/carries a modulator/);
  });

  it("adds, moves and deletes", () => {
    const three = apply(
      bound,
      { kind: "add-key", trackId: id, frame: 20, value: 2, easing: "hold" },
      { kind: "add-key", trackId: id, frame: 40, value: 0, easing: "linear" },
    );
    const track = findTrack(three, id);
    expect(track?.spec.kind === "keyframe" ? track.spec.keys.length : 0).toBe(3);

    const moved = reduce(three, { kind: "move-key", trackId: id, from: 20, to: 25 }, N);
    const movedTrack = findTrack(moved, id);
    expect(
      movedTrack?.spec.kind === "keyframe" ? movedTrack.spec.keys.map((k) => k.frame) : [],
    ).toEqual([0, 25, 40]);

    const deleted = reduce(moved, { kind: "remove-key", trackId: id, frame: 25 }, N);
    const deletedTrack = findTrack(deleted, id);
    expect(
      deletedTrack?.spec.kind === "keyframe" ? deletedTrack.spec.keys.map((k) => k.frame) : [],
    ).toEqual([0, 40]);
  });
});

describe("following the document", () => {
  it("adopts a document's bindings as tracks", () => {
    const bindings: readonly Binding[] = [
      {
        nodeId: "plain",
        param: "gain",
        shape: "triangle",
        amount: 0.75,
        cyclesPerLoop: 2,
        phase: 0.25,
        bipolar: false,
      },
    ];
    const state = reduce(EMPTY_TIMELINE, { kind: "adopt-bindings", bindings }, N);
    expect(state.tracks).toHaveLength(1);
    expect(state.tracks[0]?.spec).toEqual({
      kind: "modulator",
      shape: "triangle",
      amount: 0.75,
      cyclesPerLoop: 2,
      phase: 0.25,
      bipolar: false,
    });
  });

  it("keeps keyframe tracks the incoming bindings do not claim", () => {
    const withKeys = apply(EMPTY_TIMELINE, bindSpread);
    const state = reduce(
      withKeys,
      {
        kind: "adopt-bindings",
        bindings: [
          {
            nodeId: "plain",
            param: "gain",
            shape: "sine",
            amount: 1,
            cyclesPerLoop: 1,
            phase: 0,
            bipolar: true,
          },
        ],
      },
      N,
    );
    expect(state.tracks.map((track) => track.id).sort()).toEqual([
      "pattern::spread",
      "plain::gain",
    ]);
  });

  it("drops a track whose node has left the stack", () => {
    const registry = testRegistry();
    const state = apply(EMPTY_TIMELINE, bindGain, bindSpread);
    const document = testDocument([patternNode("pattern")]);
    const keep = survivingTrackIds(state.tracks, document, registry);
    expect([...keep]).toEqual(["pattern::spread"]);
    const pruned = reduce(state, { kind: "prune", keep }, N);
    expect(pruned.tracks.map((track) => track.id)).toEqual(["pattern::spread"]);
  });

  it("drops keys a shortened loop no longer contains", () => {
    const state = apply(
      EMPTY_TIMELINE,
      bindSpread,
      { kind: "add-key", trackId: trackId("pattern", "spread"), frame: 40, value: 2, easing: "linear" },
    );
    const shortened = reduce(state, { kind: "clock-changed" }, 24);
    const track = findTrack(shortened, trackId("pattern", "spread"));
    expect(track?.spec.kind === "keyframe" ? track.spec.keys.map((k) => k.frame) : []).toEqual([0]);
  });

  it("leaves a track whose parameter is still there", () => {
    const registry = testRegistry();
    const state = apply(EMPTY_TIMELINE, bindGain);
    const document = testDocument([plainNode("plain")]);
    expect(survivingTrackIds(state.tracks, document, registry).size).toBe(1);
  });
});

describe("isBindableParam", () => {
  it("takes the registry's own declaration rather than second-guessing it", () => {
    const registry = testRegistry();
    const pattern = registry.get("test-pattern");
    const bindable = (pattern?.params ?? []).filter(isBindableParam).map((param) => param.key);
    // `shape` is an enum and declares `animatable: false`; the seed-typed
    // parameters on the other fixture are excluded for the same reason.
    expect(bindable).not.toContain("shape");
    expect(bindable).toContain("spread");
    expect(bindable).toContain("cells");
  });
});
