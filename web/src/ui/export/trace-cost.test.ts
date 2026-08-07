import { describe, expect, it } from "vitest";

import { DEFAULT_TRACE_SETTINGS, type VectorTraceSettings } from "../../export";
import {
  MIN_FEATURE_FILTER_FLOOR,
  SPECK_COLLAPSING_TOLERANCE,
  TRACE_CONTOUR_WARNING_PIXELS,
  minFeatureFilters,
  modeCollapsesSpecks,
  traceCostWarning,
} from "./trace-cost";

const MEGAPIXEL = TRACE_CONTOUR_WARNING_PIXELS;

function settings(patch: Partial<VectorTraceSettings> = {}): VectorTraceSettings {
  return { ...DEFAULT_TRACE_SETTINGS, ...patch };
}

describe("minFeatureFilters", () => {
  it("treats 0 and 1 alike, because the core skips the filter below 2", () => {
    expect(minFeatureFilters(0)).toBe(false);
    expect(minFeatureFilters(1)).toBe(false);
    expect(minFeatureFilters(MIN_FEATURE_FILTER_FLOOR)).toBe(true);
  });
});

describe("modeCollapsesSpecks", () => {
  it("is false for pixel-perfect at any tolerance", () => {
    expect(modeCollapsesSpecks("pixel-perfect", 0)).toBe(false);
    expect(modeCollapsesSpecks("pixel-perfect", 8)).toBe(false);
  });

  it("needs a tolerance that can flatten a one-pixel ring", () => {
    expect(modeCollapsesSpecks("simplified", 0)).toBe(false);
    expect(modeCollapsesSpecks("simplified", SPECK_COLLAPSING_TOLERANCE - 0.01)).toBe(false);
    expect(modeCollapsesSpecks("simplified", 1)).toBe(true);
  });
});

describe("traceCostWarning", () => {
  it("warns on the combination that looks like a hang", () => {
    const warning = traceCostWarning(
      settings({ mode: "pixel-perfect", minFeatureArea: 0 }),
      MEGAPIXEL,
    );
    expect(warning).not.toBeNull();
    expect(warning?.worstCaseContours).toBe(MEGAPIXEL);
    expect(warning?.fixes).toHaveLength(2);
  });

  it("warns at a minimum feature size of 1, which filters nothing", () => {
    expect(
      traceCostWarning(settings({ mode: "pixel-perfect", minFeatureArea: 1 }), MEGAPIXEL),
    ).not.toBeNull();
  });

  it("is silent once the minimum feature size actually filters", () => {
    expect(
      traceCostWarning(
        settings({ mode: "pixel-perfect", minFeatureArea: MIN_FEATURE_FILTER_FLOOR }),
        MEGAPIXEL,
      ),
    ).toBeNull();
  });

  it("is silent in simplified mode at the default tolerance", () => {
    expect(
      traceCostWarning(settings({ mode: "simplified", tolerance: 1, minFeatureArea: 0 }), MEGAPIXEL),
    ).toBeNull();
  });

  it("still warns in simplified mode when the tolerance collapses nothing", () => {
    expect(
      traceCostWarning(settings({ mode: "simplified", tolerance: 0, minFeatureArea: 0 }), MEGAPIXEL),
    ).not.toBeNull();
  });

  it("is silent below the size where the count matters", () => {
    expect(
      traceCostWarning(settings({ mode: "pixel-perfect", minFeatureArea: 0 }), MEGAPIXEL - 1),
    ).toBeNull();
  });

  it("does not warn on a size it cannot know", () => {
    expect(traceCostWarning(settings({ minFeatureArea: 0 }), Number.NaN)).toBeNull();
  });

  it("reports one contour per pixel as the worst case", () => {
    const warning = traceCostWarning(settings({ minFeatureArea: 0 }), 4000 * 3000);
    expect(warning?.worstCaseContours).toBe(12_000_000);
    // Grouped, and grouped the same way on every machine.
    expect(warning?.mechanism).toContain("12,000,000");
  });
});
