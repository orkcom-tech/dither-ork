import { describe, expect, it } from "vitest";

import {
  IDLE_INTERACTION,
  beginInteraction,
  degradedState,
  endInteraction,
  isInteracting,
  previewScaleFactor,
  requestedQuality,
} from "./quality";

describe("interaction tracking", () => {
  it("starts idle and asks for full quality", () => {
    expect(isInteracting(IDLE_INTERACTION)).toBe(false);
    expect(requestedQuality(IDLE_INTERACTION)).toBe("full");
  });

  it("degrades while any source is active", () => {
    const state = beginInteraction(IDLE_INTERACTION, "pan");
    expect(requestedQuality(state)).toBe("preview");
  });

  it("stays degraded until the last source ends", () => {
    let state = beginInteraction(IDLE_INTERACTION, "pan");
    state = beginInteraction(state, "param:blur.radius");
    state = endInteraction(state, "pan");
    expect(requestedQuality(state)).toBe("preview");
    state = endInteraction(state, "param:blur.radius");
    expect(requestedQuality(state)).toBe("full");
  });

  it("names its sources, because a stuck preview is a question about which one never ended", () => {
    const state = beginInteraction(IDLE_INTERACTION, "param:blur.radius");
    expect(state.sources).toEqual(["param:blur.radius"]);
  });

  it("is idempotent in both directions", () => {
    const once = beginInteraction(IDLE_INTERACTION, "pan");
    expect(beginInteraction(once, "pan")).toBe(once);
    expect(endInteraction(once, "zoom")).toBe(once);
  });

  it("never mutates the state it is given", () => {
    const before = beginInteraction(IDLE_INTERACTION, "pan");
    beginInteraction(before, "zoom");
    expect(before.sources).toEqual(["pan"]);
  });
});

describe("previewScaleFactor", () => {
  it("renders at full resolution when the document fits the budget at 100%", () => {
    expect(previewScaleFactor({ width: 400, height: 300 }, 1)).toBe(1);
  });

  it("drops to the zoom when zoomed out, which loses nothing that is on screen", () => {
    expect(previewScaleFactor({ width: 4000, height: 3000 }, 0.25)).toBeCloseTo(0.25, 9);
  });

  it("never exceeds full resolution when zoomed in", () => {
    expect(previewScaleFactor({ width: 400, height: 300 }, 8)).toBe(1);
  });

  it("lets the pixel budget bound a document the zoom does not", () => {
    // 64 megapixels at 100%: the zoom ceiling is 1 and the two-megapixel budget
    // is sqrt(2/64), so the budget is what actually bites.
    expect(previewScaleFactor({ width: 8000, height: 8000 }, 1)).toBeCloseTo(
      Math.sqrt(2_000_000 / (8000 * 8000)),
      9,
    );
  });

  it("takes the tighter of the two ceilings", () => {
    // Zoomed further out than the budget requires: the zoom wins.
    expect(previewScaleFactor({ width: 8000, height: 8000 }, 0.05)).toBeCloseTo(0.05, 9);
  });

  it("respects an explicit budget", () => {
    expect(previewScaleFactor({ width: 8000, height: 8000 }, 8, 250_000)).toBeCloseTo(
      Math.sqrt(250_000 / (8000 * 8000)),
      9,
    );
  });

  it("answers for a degenerate document instead of dividing by zero", () => {
    expect(previewScaleFactor({ width: 0, height: 0 }, 1)).toBe(1);
  });
});

describe("degradedState — the badge never lies about the picture", () => {
  it("is silent only when the frame is full quality at full resolution", () => {
    expect(degradedState("full", 1)).toBeNull();
  });

  it("reports a reduced-resolution frame even when it is labelled full", () => {
    const state = degradedState("full", 0.5);
    expect(state).not.toBeNull();
    expect(state?.label).toBe("PREVIEW 50%");
  });

  it("reports a preview frame rendered at full resolution", () => {
    const state = degradedState("preview", 1);
    expect(state?.label).toBe("PREVIEW");
  });

  it("says what is reduced, not just that something is", () => {
    expect(degradedState("preview", 0.25)?.detail).toContain("25%");
  });
});
