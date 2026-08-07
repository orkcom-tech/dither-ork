/**
 * Placement — F-UI-13's "never cover the control it describes, and stay inside
 * the viewport near screen edges".
 *
 * Both clauses are absolutes, so they are tested as absolutes: the last two
 * cases sweep an anchor across every position in a viewport, at several sizes,
 * and assert the two invariants at all of them. A placement rule that is right
 * in the middle of the window and wrong in a corner is the normal way this goes
 * wrong, and a handful of hand-picked positions would not find it.
 */

import { describe, expect, it } from "vitest";

import {
  HELP_GAP,
  HELP_MARGIN,
  intersects,
  placeHelp,
  type Rect,
  type Size,
} from "./placement";

const VIEWPORT: Size = { width: 1280, height: 800 };
const PANEL: Size = { width: 336, height: 220 };

function placedRect(anchor: Rect, panel: Size = PANEL, viewport: Size = VIEWPORT): Rect {
  const placement = placeHelp({ anchor, panel, viewport });
  return {
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
  };
}

describe("side choice", () => {
  it("goes below when there is room", () => {
    expect(placeHelp({ anchor: { x: 400, y: 100, width: 200, height: 24 }, panel: PANEL, viewport: VIEWPORT }).side).toBe("below");
  });

  it("flips above when the control is near the bottom", () => {
    expect(placeHelp({ anchor: { x: 400, y: 740, width: 200, height: 24 }, panel: PANEL, viewport: VIEWPORT }).side).toBe("above");
  });

  it("goes to the side when the control spans the height of the window", () => {
    // A tall control — a stack panel header row does this at small window
    // heights — leaves no room above or below.
    const placement = placeHelp({
      anchor: { x: 20, y: 40, width: 180, height: 700 },
      panel: PANEL,
      viewport: VIEWPORT,
    });
    expect(placement.side).toBe("right");
  });

  it("goes left when the control is against the right edge with no vertical room", () => {
    const placement = placeHelp({
      anchor: { x: 1080, y: 40, width: 180, height: 700 },
      panel: PANEL,
      viewport: VIEWPORT,
    });
    expect(placement.side).toBe("left");
  });
});

describe("the gap", () => {
  it("leaves exactly the gap below", () => {
    const anchor: Rect = { x: 400, y: 100, width: 200, height: 24 };
    expect(placeHelp({ anchor, panel: PANEL, viewport: VIEWPORT }).y).toBe(
      anchor.y + anchor.height + HELP_GAP,
    );
  });

  it("leaves exactly the gap above", () => {
    const anchor: Rect = { x: 400, y: 740, width: 200, height: 24 };
    const placement = placeHelp({ anchor, panel: PANEL, viewport: VIEWPORT });
    expect(placement.y + placement.height).toBe(anchor.y - HELP_GAP);
  });
});

describe("staying inside the viewport", () => {
  it("slides left rather than running off the right edge", () => {
    const rect = placedRect({ x: 1200, y: 100, width: 60, height: 24 });
    expect(rect.x + rect.width).toBeLessThanOrEqual(VIEWPORT.width - HELP_MARGIN);
  });

  it("does not slide past the left margin", () => {
    const rect = placedRect({ x: 2, y: 100, width: 60, height: 24 });
    expect(rect.x).toBeGreaterThanOrEqual(HELP_MARGIN);
  });

  it("clamps its height to the room that exists, so long text scrolls", () => {
    const tall: Size = { width: 336, height: 4000 };
    const placement = placeHelp({
      anchor: { x: 400, y: 300, width: 200, height: 24 },
      panel: tall,
      viewport: VIEWPORT,
    });
    expect(placement.height).toBeLessThan(tall.height);
    expect(placement.y + placement.height).toBeLessThanOrEqual(
      VIEWPORT.height - HELP_MARGIN,
    );
  });

  it("narrows to the window when the window is narrower than the panel", () => {
    const narrow: Size = { width: 300, height: 800 };
    const rect = placedRect({ x: 10, y: 10, width: 100, height: 24 }, PANEL, narrow);
    expect(rect.width).toBeLessThanOrEqual(narrow.width - HELP_MARGIN * 2);
  });
});

describe("the two invariants, everywhere", () => {
  const anchors: Rect[] = [];
  for (let x = 0; x <= VIEWPORT.width; x += 64) {
    for (let y = 0; y <= VIEWPORT.height; y += 64) {
      anchors.push({ x, y, width: 180, height: 26 });
      anchors.push({ x, y, width: 24, height: 24 });
      anchors.push({ x, y, width: 420, height: 300 });
    }
  }

  it("never covers the control it describes", () => {
    for (const anchor of anchors) {
      expect(intersects(placedRect(anchor), anchor)).toBe(false);
    }
  });

  it("never leaves the viewport", () => {
    for (const anchor of anchors) {
      const rect = placedRect(anchor);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(VIEWPORT.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(VIEWPORT.height);
    }
  });

  it("holds at tablet width too, which F-UI-10 makes a supported size", () => {
    const tablet: Size = { width: 768, height: 1024 };
    for (let x = 0; x <= tablet.width; x += 48) {
      for (let y = 0; y <= tablet.height; y += 48) {
        const anchor: Rect = { x, y, width: 200, height: 28 };
        const rect = placedRect(anchor, PANEL, tablet);
        expect(intersects(rect, anchor)).toBe(false);
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(tablet.width);
        expect(rect.y + rect.height).toBeLessThanOrEqual(tablet.height);
      }
    }
  });
});

describe("intersects", () => {
  it("is false for rectangles that merely touch", () => {
    expect(
      intersects({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 }),
    ).toBe(false);
  });

  it("is true for an overlap of one pixel", () => {
    expect(
      intersects({ x: 0, y: 0, width: 11, height: 10 }, { x: 10, y: 0, width: 10, height: 10 }),
    ).toBe(true);
  });
});
