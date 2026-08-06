import { describe, expect, it } from "vitest";

import {
  MAX_SCALE,
  MIN_SCALE,
  ZOOM_LADDER,
  centreView,
  clampScale,
  clampView,
  deviceExactScale,
  fitScale,
  fitView,
  formatZoom,
  imageRect,
  imageToView,
  isPixelExact,
  panBy,
  snapScale,
  stepZoom,
  viewToImage,
  zoomAt,
} from "./view";

describe("the zoom ladder", () => {
  it("is strictly increasing and spans the scale limits", () => {
    for (let i = 1; i < ZOOM_LADDER.length; i += 1) {
      const previous = ZOOM_LADDER[i - 1];
      const current = ZOOM_LADDER[i];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      expect(current as number).toBeGreaterThan(previous as number);
    }
    expect(ZOOM_LADDER[0]).toBe(MIN_SCALE);
    expect(ZOOM_LADDER[ZOOM_LADDER.length - 1]).toBe(MAX_SCALE);
  });

  it("is integers above 100% and their reciprocals below — the whole point of F-UI-02", () => {
    for (const rung of ZOOM_LADDER) {
      const whole = rung >= 1 ? rung : 1 / rung;
      expect(Math.abs(whole - Math.round(whole))).toBeLessThan(1e-9);
    }
  });
});

describe("clampScale", () => {
  it("bounds both ends", () => {
    expect(clampScale(1e6)).toBe(MAX_SCALE);
    expect(clampScale(1e-6)).toBe(MIN_SCALE);
    expect(clampScale(3)).toBe(3);
  });

  it("refuses to propagate a non-finite scale", () => {
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(MAX_SCALE);
  });
});

describe("snapScale", () => {
  it("pulls a near miss onto the rung", () => {
    expect(snapScale(1.02)).toBe(1);
    expect(snapScale(0.98)).toBe(1);
    expect(snapScale(7.8)).toBe(8);
  });

  it("leaves a scale that is genuinely between rungs alone", () => {
    expect(snapScale(1.5)).toBe(1.5);
    expect(snapScale(9.5)).toBe(9.5);
  });

  it("snaps proportionally, not absolutely — 6% either side of any rung", () => {
    // 1/32 and 32 are three orders of magnitude apart; the same relative miss
    // has to snap at both, which an absolute tolerance could not do.
    expect(snapScale(MIN_SCALE * 1.03)).toBe(MIN_SCALE);
    expect(snapScale(MAX_SCALE * 0.97)).toBe(MAX_SCALE);
  });
});

describe("stepZoom", () => {
  it("moves one rung at a time from a rung", () => {
    expect(stepZoom(1, 1)).toBe(2);
    expect(stepZoom(1, -1)).toBe(1 / 2);
    expect(stepZoom(4, 1)).toBe(6);
  });

  it("lands on the next rung from between rungs", () => {
    expect(stepZoom(1.5, 1)).toBe(2);
    expect(stepZoom(1.5, -1)).toBe(1);
  });

  it("saturates instead of leaving the range", () => {
    expect(stepZoom(MAX_SCALE, 1)).toBe(MAX_SCALE);
    expect(stepZoom(MIN_SCALE, -1)).toBe(MIN_SCALE);
  });
});

describe("deviceExactScale — F-UI-01", () => {
  it("quantizes so a source pixel covers whole device pixels above 100%", () => {
    expect(deviceExactScale(1.3, 2)).toBe(1.5);
    expect(deviceExactScale(3.2, 2)).toBe(3);
    expect(isPixelExact(deviceExactScale(1.3, 2), 2)).toBe(true);
    expect(isPixelExact(deviceExactScale(7.77, 3), 3)).toBe(true);
  });

  it("leaves an integer zoom untouched at any pixel ratio", () => {
    for (const dpr of [1, 1.5, 2, 3]) {
      expect(deviceExactScale(4, dpr)).toBe(4);
    }
  });

  it("never quantizes below 100%, where there is no exactness to keep", () => {
    expect(deviceExactScale(0.37, 2)).toBe(0.37);
    expect(isPixelExact(0.5, 2)).toBe(false);
  });

  it("never drops below 100% while magnifying", () => {
    expect(deviceExactScale(1, 1)).toBe(1);
    expect(deviceExactScale(1.01, 1)).toBe(1);
  });
});

describe("fitScale and fitView", () => {
  it("fits the constraining axis", () => {
    expect(fitScale({ width: 100, height: 50 }, { width: 200, height: 200 })).toBe(2);
    expect(fitScale({ width: 50, height: 100 }, { width: 200, height: 200 })).toBe(2);
  });

  it("honours padding on both sides", () => {
    expect(
      fitScale({ width: 100, height: 100 }, { width: 220, height: 220 }, 10),
    ).toBe(2);
  });

  it("centres what it fits", () => {
    const view = fitView({ width: 100, height: 100 }, { width: 400, height: 200 });
    expect(view.scale).toBe(2);
    expect(view.x).toBe(100);
    expect(view.y).toBe(0);
  });

  it("returns a usable scale for a degenerate document rather than dividing by zero", () => {
    expect(fitScale({ width: 0, height: 0 }, { width: 100, height: 100 })).toBe(1);
  });

  it("clamps a fit that would exceed the zoom range", () => {
    expect(fitScale({ width: 1, height: 1 }, { width: 4000, height: 4000 })).toBe(
      MAX_SCALE,
    );
  });
});

describe("zoomAt", () => {
  it("holds the anchor point still", () => {
    const view = centreView({ width: 100, height: 100 }, { width: 300, height: 300 }, 1);
    const anchor = { x: 220, y: 80 };
    const before = viewToImage(view, anchor);
    const after = viewToImage(zoomAt(view, 4, anchor), anchor);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
  });

  it("clamps the scale it is given", () => {
    const view = { scale: 1, x: 0, y: 0 };
    expect(zoomAt(view, 1e9, { x: 0, y: 0 }).scale).toBe(MAX_SCALE);
  });
});

describe("coordinate round trip", () => {
  it("image -> view -> image is the identity", () => {
    const view = { scale: 2.5, x: -33, y: 71 };
    const point = { x: 17, y: 129 };
    const back = viewToImage(view, imageToView(view, point));
    expect(back.x).toBeCloseTo(point.x, 10);
    expect(back.y).toBeCloseTo(point.y, 10);
  });
});

describe("clampView", () => {
  it("leaves a view that is already on screen alone", () => {
    const view = { scale: 1, x: 10, y: 10 };
    expect(clampView(view, { width: 100, height: 100 }, { width: 300, height: 300 })).toEqual(
      view,
    );
  });

  it("keeps a sliver of the image reachable when panned off the left", () => {
    const clamped = clampView(
      { scale: 1, x: -5000, y: 0 },
      { width: 100, height: 100 },
      { width: 300, height: 300 },
      48,
    );
    // 48 CSS pixels of a 100px-wide image must remain: origin at 48 - 100.
    expect(clamped.x).toBe(-52);
  });

  it("keeps a sliver reachable when panned off the right", () => {
    const clamped = clampView(
      { scale: 1, x: 5000, y: 0 },
      { width: 100, height: 100 },
      { width: 300, height: 300 },
      48,
    );
    expect(clamped.x).toBe(252);
  });

  it("never demands more margin than the image has", () => {
    // A 10x10 image at 100% is smaller than the 48px margin; asking for 48 of
    // it would make every position illegal.
    const clamped = clampView(
      { scale: 1, x: -5000, y: -5000 },
      { width: 10, height: 10 },
      { width: 300, height: 300 },
      48,
    );
    expect(clamped.x).toBe(0);
    expect(clamped.y).toBe(0);
  });
});

describe("panBy and imageRect", () => {
  it("translates without touching the scale", () => {
    const view = panBy({ scale: 3, x: 5, y: 7 }, -2, 4);
    expect(view).toEqual({ scale: 3, x: 3, y: 11 });
  });

  it("reports the image rectangle in view space", () => {
    expect(imageRect({ scale: 2, x: 10, y: 20 }, { width: 30, height: 40 })).toEqual({
      x: 10,
      y: 20,
      width: 60,
      height: 80,
    });
  });
});

describe("formatZoom", () => {
  it("is whole percentages at and above 100%", () => {
    expect(formatZoom(1)).toBe("100%");
    expect(formatZoom(8)).toBe("800%");
  });

  it("keeps one decimal below 100%, where a rounded 33% would read as exact", () => {
    expect(formatZoom(1 / 3)).toBe("33.3%");
    expect(formatZoom(0.5)).toBe("50%");
  });
});
