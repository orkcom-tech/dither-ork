import { describe, expect, it } from "vitest";

import {
  IDENTITY_VIEW,
  MAX_SCALE,
  MIN_SCALE,
  ZOOM_STEP,
  boundsOf,
  clampScale,
  fitView,
  inputPoint,
  nearest,
  outputPoint,
  panBy,
  toScreen,
  toWorld,
  wirePath,
  zoomAt,
  zoomByStep,
  type Point,
} from "./geometry";
import { NODE_WIDTH, portOffsetY } from "./metrics";

const CANVAS = { width: 800, height: 400 };

describe("view transform", () => {
  it("round-trips a point through both directions", () => {
    const view = { x: 37, y: -12, scale: 1.7 };
    const world: Point = { x: 123, y: 45 };
    const back = toWorld(view, toScreen(view, world));
    expect(back.x).toBeCloseTo(world.x, 9);
    expect(back.y).toBeCloseTo(world.y, 9);
  });

  it("keeps the world point under the cursor while zooming", () => {
    // The whole of what makes wheel-zoom feel like zooming rather than like the
    // graph running away.
    const view = { x: 20, y: 30, scale: 1 };
    const anchor: Point = { x: 300, y: 150 };
    const before = toWorld(view, anchor);
    const after = toWorld(zoomAt(view, anchor, ZOOM_STEP), anchor);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it("does not drift when zoomed at a limit", () => {
    // Solving the offset against an unclamped scale and clamping afterwards is
    // what makes a view creep every time it is zoomed while already at the stop.
    const view = zoomAt(IDENTITY_VIEW, { x: 100, y: 100 }, 100);
    expect(view.scale).toBe(MAX_SCALE);
    const again = zoomAt(view, { x: 100, y: 100 }, 100);
    expect(again).toBe(view);
  });

  it("steps in and out back to exactly where it started", () => {
    const view = { x: 5, y: 9, scale: 1 };
    const there = zoomByStep(view, 1, CANVAS);
    const back = zoomByStep(there, -1, CANVAS);
    expect(back.scale).toBeCloseTo(view.scale, 9);
    expect(back.x).toBeCloseTo(view.x, 9);
    expect(back.y).toBeCloseTo(view.y, 9);
  });

  it("clamps the scale to the readable range", () => {
    expect(clampScale(0.001)).toBe(MIN_SCALE);
    expect(clampScale(50)).toBe(MAX_SCALE);
    expect(clampScale(Number.NaN)).toBe(1);
  });

  it("pans by screen pixels without touching the scale", () => {
    const view = panBy({ x: 1, y: 2, scale: 1.5 }, 10, -4);
    expect(view).toEqual({ x: 11, y: -2, scale: 1.5 });
  });
});

describe("fit", () => {
  it("centres the content", () => {
    const content = { x: 0, y: 0, width: 400, height: 200 };
    const view = fitView(content, CANVAS, 0);
    const topLeft = toScreen(view, { x: 0, y: 0 });
    const bottomRight = toScreen(view, { x: 400, y: 200 });
    expect(topLeft.x + bottomRight.x).toBeCloseTo(CANVAS.width, 6);
    expect(topLeft.y + bottomRight.y).toBeCloseTo(CANVAS.height, 6);
  });

  it("never zooms past life size", () => {
    // A two-node document blown up to fill a wide panel reads as a mistake: the
    // point of "fit" is to find the graph, not to magnify it.
    const view = fitView({ x: 0, y: 0, width: 20, height: 10 }, CANVAS, 0);
    expect(view.scale).toBe(1);
  });

  it("shrinks to fit content larger than the canvas", () => {
    const view = fitView({ x: 0, y: 0, width: 4000, height: 200 }, CANVAS, 0);
    expect(view.scale).toBeLessThan(1);
    expect(view.scale).toBeGreaterThanOrEqual(MIN_SCALE);
  });

  it("returns the fallback when the canvas has not been measured yet", () => {
    const fallback = { x: 3, y: 4, scale: 1.1 };
    expect(fitView({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 }, 8, fallback)).toBe(
      fallback,
    );
  });
});

describe("ports and wires", () => {
  it("puts the output on the right edge of the first port row", () => {
    const node = { x: 100, y: 50 };
    expect(outputPoint(node)).toEqual({ x: 100 + NODE_WIDTH, y: 50 + portOffsetY(0) });
  });

  it("puts each input on the left edge of its own row", () => {
    const node = { x: 0, y: 0 };
    expect(inputPoint(node, 0).y).toBeLessThan(inputPoint(node, 1).y);
    expect(inputPoint(node, 2).x).toBe(0);
  });

  it("draws a wire that starts and ends exactly on its two points", () => {
    const path = wirePath({ x: 0, y: 0 }, { x: 200, y: 60 });
    expect(path.startsWith("M 0 0 C")).toBe(true);
    expect(path.endsWith("200 60")).toBe(true);
  });
});

describe("snapping", () => {
  const points = [
    { id: "a", at: { x: 0, y: 0 } },
    { id: "b", at: { x: 20, y: 0 } },
    { id: "c", at: { x: 200, y: 0 } },
  ];
  const pointOf = (candidate: { readonly at: Point }): Point => candidate.at;

  it("takes the nearest candidate inside the radius", () => {
    const hit = nearest(points, pointOf, { x: 14, y: 0 }, 30);
    expect(hit?.candidate.id).toBe("b");
    expect(hit?.distance).toBe(6);
  });

  it("is forgiving: a point near no candidate exactly still lands on one", () => {
    // The point of the radius. A person aiming a wire is aiming at a label, not
    // at a nine-pixel dot.
    expect(nearest(points, pointOf, { x: 0, y: 25 }, 30)?.candidate.id).toBe("a");
  });

  it("gives nothing when everything is out of reach", () => {
    expect(nearest(points, pointOf, { x: 100, y: 100 }, 30)).toBeNull();
  });

  it("gives nothing when there are no candidates", () => {
    expect(nearest([], pointOf, { x: 0, y: 0 }, 30)).toBeNull();
  });
});

describe("bounds", () => {
  it("covers every card", () => {
    const bounds = boundsOf([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 50, y: -20, width: 10, height: 10 },
    ]);
    expect(bounds).toEqual({ x: 0, y: -20, width: 60, height: 30 });
  });

  it("is empty for no cards", () => {
    expect(boundsOf([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});
