import { describe, expect, it } from "vitest";

import {
  DEFAULT_LAYOUT,
  MIN_CENTRE,
  MIN_PANEL_PX,
  RAIL_SIZE,
  REGION_LIMITS,
  clampRegionSize,
  panelState,
  regionExtent,
  regionState,
  resizeAdjacentPanels,
  resizeRegion,
  setPanelCollapsed,
  setRegionCollapsed,
  togglePanel,
  toggleRegion,
} from "./layout";

describe("clampRegionSize", () => {
  it("holds a region between its own limits", () => {
    expect(clampRegionSize("left", 10)).toBe(REGION_LIMITS.left.min);
    expect(clampRegionSize("left", 10_000)).toBe(REGION_LIMITS.left.max);
    expect(clampRegionSize("left", 300)).toBe(300);
  });

  it("leaves the viewport a usable width on a small window", () => {
    // 600px of window, 280 reserved for the centre: 320 is the most the left
    // column may take, well below its own 520 maximum.
    expect(clampRegionSize("left", 500, 600)).toBe(600 - MIN_CENTRE);
  });

  it("never clamps below the region minimum, even on a window too small for both", () => {
    expect(clampRegionSize("left", 400, 300)).toBe(REGION_LIMITS.left.min);
  });

  it("falls back to the initial size for a non-finite drag", () => {
    expect(clampRegionSize("right", Number.NaN)).toBe(REGION_LIMITS.right.initial);
  });
});

describe("region state", () => {
  it("resizes and clamps in one step", () => {
    const next = resizeRegion(DEFAULT_LAYOUT, "left", 10_000);
    expect(regionState(next, "left").size).toBe(REGION_LIMITS.left.max);
  });

  it("leaves the other regions untouched", () => {
    const next = resizeRegion(DEFAULT_LAYOUT, "left", 300);
    expect(next.regions.right).toBe(DEFAULT_LAYOUT.regions.right);
    expect(next.regions.bottom).toBe(DEFAULT_LAYOUT.regions.bottom);
  });

  it("expands a collapsed region that is dragged", () => {
    const collapsed = setRegionCollapsed(DEFAULT_LAYOUT, "left", true);
    const dragged = resizeRegion(collapsed, "left", 300);
    expect(regionState(dragged, "left").collapsed).toBe(false);
    expect(regionState(dragged, "left").size).toBe(300);
  });

  it("toggles collapse both ways", () => {
    const collapsed = toggleRegion(DEFAULT_LAYOUT, "right");
    expect(regionState(collapsed, "right").collapsed).toBe(true);
    expect(regionState(toggleRegion(collapsed, "right"), "right").collapsed).toBe(false);
  });

  it("remembers the size across a collapse, so expanding restores it", () => {
    const sized = resizeRegion(DEFAULT_LAYOUT, "right", 400);
    const round = toggleRegion(toggleRegion(sized, "right"), "right");
    expect(regionState(round, "right").size).toBe(400);
  });

  it("returns the same object when nothing changes", () => {
    expect(setRegionCollapsed(DEFAULT_LAYOUT, "left", false)).toBe(DEFAULT_LAYOUT);
  });

  it("never mutates the layout it is given", () => {
    resizeRegion(DEFAULT_LAYOUT, "left", 400);
    expect(DEFAULT_LAYOUT.regions.left.size).toBe(REGION_LIMITS.left.initial);
  });
});

describe("regionExtent", () => {
  it("is zero for a region nothing has registered into", () => {
    expect(regionExtent(DEFAULT_LAYOUT, "left", false)).toBe(0);
  });

  it("is the rail when collapsed", () => {
    const collapsed = toggleRegion(DEFAULT_LAYOUT, "left");
    expect(regionExtent(collapsed, "left", true)).toBe(RAIL_SIZE);
  });

  it("is the size when open", () => {
    expect(regionExtent(DEFAULT_LAYOUT, "left", true)).toBe(REGION_LIMITS.left.initial);
  });
});

describe("panel state", () => {
  it("defaults every panel to open with an equal share", () => {
    expect(panelState(DEFAULT_LAYOUT, "never-seen")).toEqual({
      collapsed: false,
      weight: 1,
    });
  });

  it("collapses and expands one panel without touching its siblings", () => {
    const collapsed = setPanelCollapsed(DEFAULT_LAYOUT, "properties", true);
    expect(panelState(collapsed, "properties").collapsed).toBe(true);
    expect(panelState(collapsed, "palette").collapsed).toBe(false);
    expect(panelState(togglePanel(collapsed, "properties"), "properties").collapsed).toBe(
      false,
    );
  });
});

describe("resizeAdjacentPanels", () => {
  it("splits the pair's combined weight by the pixel ratio the drag implies", () => {
    const next = resizeAdjacentPanels(DEFAULT_LAYOUT, "properties", "palette", 300, 100);
    expect(panelState(next, "properties").weight).toBeCloseTo(1.5, 9);
    expect(panelState(next, "palette").weight).toBeCloseTo(0.5, 9);
  });

  it("preserves the pair's combined weight, so panels elsewhere do not move", () => {
    const next = resizeAdjacentPanels(DEFAULT_LAYOUT, "properties", "palette", 313, 87);
    const total =
      panelState(next, "properties").weight + panelState(next, "palette").weight;
    expect(total).toBeCloseTo(2, 9);
  });

  it("holds both sides above the panel minimum", () => {
    const next = resizeAdjacentPanels(DEFAULT_LAYOUT, "properties", "palette", 400, 0);
    const total = 400;
    const paletteShare = panelState(next, "palette").weight / 2;
    expect(paletteShare * total).toBeGreaterThanOrEqual(MIN_PANEL_PX - 1e-9);
  });

  it("ignores a degenerate drag rather than dividing by zero", () => {
    expect(resizeAdjacentPanels(DEFAULT_LAYOUT, "a", "b", 0, 0)).toBe(DEFAULT_LAYOUT);
  });

  it("cannot force one side past the middle when the region is tiny", () => {
    // 100px for two panels that each want 96: the only stable answer is half
    // each, rather than a minimum that cannot be satisfied twice.
    const next = resizeAdjacentPanels(DEFAULT_LAYOUT, "a", "b", 100, 0);
    expect(panelState(next, "a").weight).toBeCloseTo(1, 9);
    expect(panelState(next, "b").weight).toBeCloseTo(1, 9);
  });
});
