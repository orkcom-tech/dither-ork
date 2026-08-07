import { describe, expect, it } from "vitest";

import { patternNode, plainNode, testDocument, testRegistry } from "../../animation/fixture";
import type { DitherDocument } from "../../types/document";
import {
  CURVE_SAMPLES,
  buildTimelinePlan,
  documentAtFrame,
  keyframeTrackValueAt,
  shapeValue,
  trackCurve,
} from "./evaluate";
import { EMPTY_TIMELINE, reduce, trackId, type TimelineAction, type Track } from "./model";

const registry = testRegistry();
const document: DitherDocument = testDocument([plainNode("plain"), patternNode("pattern")]);
const N = document.clock.frames;

function tracks(...actions: readonly TimelineAction[]): readonly Track[] {
  let state = EMPTY_TIMELINE;
  for (const action of actions) state = reduce(state, action, N);
  return state.tracks;
}

function plan(list: readonly Track[], speed = 1, phaseOffset = 0) {
  return buildTimelinePlan({ document, registry, tracks: list, speed, phaseOffset });
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

function paramAt(built: ReturnType<typeof plan>, frame: number, node: string, key: string): unknown {
  const at = documentAtFrame(built, frame);
  return at.stack.find((entry) => entry.id === node)?.params[key];
}

describe("the document a frame renders", () => {
  it("carries no bindings, which is what the renderer accepts", () => {
    const built = plan(tracks(bindGain));
    expect(documentAtFrame(built, 0).bindings).toEqual([]);
    expect(documentAtFrame(built, 17).bindings).toEqual([]);
  });

  it("resolves a modulator through the animation core", () => {
    const built = plan(tracks(bindGain));
    // A bipolar sine at phase 0 is 0 at frame 0 and swings by `amount`.
    expect(paramAt(built, 0, "plain", "gain")).toBe(1);
    const quarter = paramAt(built, Math.round(N / 4), "plain", "gain");
    expect(typeof quarter).toBe("number");
    expect(quarter as number).toBeGreaterThan(1);
  });

  it("F-AN-08 and F-AN-03: frame N is frame 0, field for field", () => {
    const list = tracks(
      bindGain,
      { kind: "set-modulator", trackId: trackId("plain", "gain"), patch: { cyclesPerLoop: 3, shape: "smooth-noise" } },
      bindSpread,
      { kind: "add-key", trackId: trackId("pattern", "spread"), frame: 19, value: 1.75, easing: "ease-in-out" },
      { kind: "add-key", trackId: trackId("pattern", "spread"), frame: 37, value: 0.25, easing: "hold" },
    );
    const built = plan(list);
    expect(documentAtFrame(built, N)).toEqual(documentAtFrame(built, 0));
    expect(documentAtFrame(built, N * 3)).toEqual(documentAtFrame(built, 0));
    // And scrubbing backwards lands in the same place.
    expect(documentAtFrame(built, -N)).toEqual(documentAtFrame(built, 0));
  });

  it("returns a node nothing drives by identity", () => {
    const built = plan(tracks(bindGain));
    const source = document.stack.find((node) => node.id === "pattern");
    const rendered = documentAtFrame(built, 5).stack.find((node) => node.id === "pattern");
    expect(rendered).toBe(source);
  });

  it("leaves the document alone when every track is bypassed", () => {
    const list = tracks(
      bindGain,
      { kind: "set-enabled", trackId: trackId("plain", "gain"), enabled: false },
    );
    const built = plan(list);
    expect(built.animation.bindings).toHaveLength(0);
    expect(paramAt(built, 12, "plain", "gain")).toBe(1);
  });
});

describe("a keyframe track", () => {
  const list = tracks(
    bindSpread,
    { kind: "add-key", trackId: trackId("pattern", "spread"), frame: 30, value: 2, easing: "linear" },
  );

  it("writes the keyed value", () => {
    const built = plan(list);
    expect(paramAt(built, 0, "pattern", "spread")).toBe(1);
    expect(paramAt(built, 30, "pattern", "spread")).toBe(2);
    expect(paramAt(built, 15, "pattern", "spread")).toBeCloseTo(1.5, 12);
  });

  it("F-AN-11: the track amount scales the deviation from the authored value", () => {
    const halved = tracks(
      bindSpread,
      { kind: "add-key", trackId: trackId("pattern", "spread"), frame: 30, value: 2, easing: "linear" },
      { kind: "set-amount-scale", trackId: trackId("pattern", "spread"), scale: 0.5 },
    );
    expect(paramAt(plan(halved), 30, "pattern", "spread")).toBe(1.5);

    const off = tracks(
      bindSpread,
      { kind: "add-key", trackId: trackId("pattern", "spread"), frame: 30, value: 2, easing: "linear" },
      { kind: "set-amount-scale", trackId: trackId("pattern", "spread"), scale: 0 },
    );
    // At amount 0 the track is the identity — the parameter sits where the
    // properties panel shows it.
    expect(paramAt(plan(off), 30, "pattern", "spread")).toBe(1);
  });

  it("clamps to the parameter's legal range", () => {
    const wild = tracks(
      bindSpread,
      { kind: "add-key", trackId: trackId("pattern", "spread"), frame: 30, value: 99, easing: "linear" },
    );
    // `spread` is legal over [0, 2].
    expect(paramAt(plan(wild), 30, "pattern", "spread")).toBe(2);
  });

  it("rounds an int parameter before clamping it, like the modulator does", () => {
    const ints = tracks(
      { kind: "bind", nodeId: "pattern", param: "cells", track: "keyframe", base: 4, amount: 0 },
      { kind: "add-key", trackId: trackId("pattern", "cells"), frame: 30, value: 9, easing: "linear" },
    );
    const built = plan(ints);
    const value = paramAt(built, 15, "pattern", "cells");
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBe(7);
  });
});

describe("shapeValue", () => {
  const float = { type: "float", legal: [0, 1] } as never;
  it("collapses -0 so two documents that render the same picture hash the same", () => {
    expect(Object.is(shapeValue(float, -0), 0)).toBe(true);
  });
});

describe("refusals", () => {
  it("refuses a track on a parameter the effect does not declare", () => {
    const bad: Track = {
      id: "plain::nope",
      nodeId: "plain",
      param: "nope",
      enabled: true,
      amountScale: 1,
      collapsed: false,
      spec: { kind: "keyframe", keys: [{ frame: 0, value: 1, easing: "linear" }] },
    };
    expect(() => plan([bad])).toThrow(/declares no parameter/);
  });

  it("refuses a track whose node is not in the stack", () => {
    const orphan: Track = {
      id: "ghost::gain",
      nodeId: "ghost",
      param: "gain",
      enabled: true,
      amountScale: 1,
      collapsed: false,
      spec: { kind: "keyframe", keys: [{ frame: 0, value: 1, easing: "linear" }] },
    };
    expect(() => plan([orphan])).toThrow(/not in the stack/);
  });
});

describe("F-AN-10 — the two global controls", () => {
  it("multiplies every modulator's cycles per loop and still closes", () => {
    const list = tracks(bindGain);
    const built = plan(list, 4);
    expect(built.animation.bindings[0]?.spec.cycles).toBe(4);
    expect(documentAtFrame(built, N)).toEqual(documentAtFrame(built, 0));
  });

  it("moves where the loop starts without changing whether it closes", () => {
    const list = tracks(bindGain);
    const shifted = plan(list, 1, 0.25);
    expect(paramAt(shifted, 0, "plain", "gain")).not.toBe(paramAt(plan(list), 0, "plain", "gain"));
    expect(documentAtFrame(shifted, N)).toEqual(documentAtFrame(shifted, 0));
  });
});

describe("trackCurve", () => {
  it("samples the value the render will use, capped so a long loop stays cheap", () => {
    const list = tracks(bindGain);
    const built = plan(list);
    const track = list[0];
    if (track === undefined) throw new Error("no track");
    const curve = trackCurve(built, track);
    expect(curve).not.toBeNull();
    expect(curve?.values.length).toBe(Math.min(N, CURVE_SAMPLES));
    expect(curve?.base).toBe(1);
    // Every sample is a value the parameter could actually hold.
    for (const value of curve?.values ?? []) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(4);
    }
  });

  it("agrees with the document the frame renders", () => {
    const list = tracks(bindGain);
    const built = plan(list);
    const track = list[0];
    if (track === undefined) throw new Error("no track");
    const curve = trackCurve(built, track);
    const frame = curve?.frames[7] ?? 0;
    expect(curve?.values[7]).toBe(paramAt(built, frame, "plain", "gain"));
  });
});

describe("keyframeTrackValueAt", () => {
  it("is null for a track with no keys, so nothing is invented", () => {
    const built = plan(tracks(bindSpread));
    const resolved = built.keyframes[0];
    if (resolved === undefined) throw new Error("no resolved track");
    expect(keyframeTrackValueAt({ ...resolved, keys: [] }, built.clock, 0)).toBeNull();
  });
});
