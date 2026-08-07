import { describe, expect, it } from "vitest";

import { planBatch, tokenHint, type BatchPlanContext } from "./plan";
import { DEFAULT_BATCH_SETTINGS } from "./types";
import type { BatchInputFile, BatchSettings } from "./types";

function file(path: string, id = path): BatchInputFile {
  return { id, path, blob: new Blob([new Uint8Array([1])]), bytes: 1 };
}

function context(overrides: Partial<BatchPlanContext> = {}): BatchPlanContext {
  return {
    items: [file("a.png"), file("b.png")],
    settings: DEFAULT_BATCH_SETTINGS,
    presetName: "study",
    hasExtractor: true,
    stackSize: 3,
    delivery: "zip",
    ...overrides,
  };
}

function withTemplate(template: string): BatchSettings {
  return { ...DEFAULT_BATCH_SETTINGS, template };
}

describe("planBatch", () => {
  it("lets an ordinary run start", () => {
    const plan = planBatch(context());
    expect(plan.refusals).toEqual([]);
    expect(plan.names).toEqual(["a-dither.png", "b-dither.png"]);
  });

  it("refuses an empty queue", () => {
    expect(planBatch(context({ items: [] })).refusals[0]).toContain("No images");
  });

  it("refuses a template with a typo in it", () => {
    const plan = planBatch(context({ settings: withTemplate("{naem}") }));
    expect(plan.refusals.join(" ")).toContain("{naem}");
  });

  it("refuses names that would be produced twice, and says which", () => {
    const plan = planBatch(
      context({
        items: [file("holiday/beach.png", "1"), file("work/beach.png", "2")],
        settings: withTemplate("{name}"),
      }),
    );
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]).toContain("beach.png");
    expect(plan.refusals[0]).toContain("{index}");
  });

  it("accepts the same inputs once {index} disambiguates them", () => {
    const plan = planBatch(
      context({
        items: [file("holiday/beach.png", "1"), file("work/beach.png", "2")],
        settings: withTemplate("{index}-{name}"),
      }),
    );
    expect(plan.refusals).toEqual([]);
    expect(plan.names).toEqual(["1-beach.png", "2-beach.png"]);
  });

  it("cannot know the names when the template uses the output extent, and says so", () => {
    const plan = planBatch(
      context({
        items: [file("holiday/beach.png", "1"), file("work/beach.png", "2")],
        settings: withTemplate("{name}-{width}x{height}"),
      }),
    );
    expect(plan.names).toBeNull();
    // Not a refusal: the two may well come out different sizes.
    expect(plan.refusals).toEqual([]);
    expect(plan.warnings.join(" ")).toContain("{width}");
  });

  it("does not warn about extent-dependent names when the inputs are distinct", () => {
    const plan = planBatch(context({ settings: withTemplate("{name}-{width}") }));
    expect(plan.warnings).toEqual([]);
  });

  it("refuses per-image palettes with nothing to extract with", () => {
    const plan = planBatch(
      context({
        hasExtractor: false,
        settings: { ...DEFAULT_BATCH_SETTINGS, palette: "per-image" },
      }),
    );
    expect(plan.refusals.join(" ")).toContain("no extractor");
  });

  it("allows per-image palettes when there is an extractor", () => {
    const plan = planBatch(
      context({ settings: { ...DEFAULT_BATCH_SETTINGS, palette: "per-image" } }),
    );
    expect(plan.refusals).toEqual([]);
  });

  it("refuses more files than a ZIP can hold, but not a directory run", () => {
    const many = Array.from({ length: 70_000 }, (_, index) =>
      file(`image-${index}.png`, `id-${index}`),
    );
    const settings = withTemplate("{index}");
    expect(planBatch(context({ items: many, settings })).refusals.join(" ")).toContain(
      "more than",
    );
    expect(
      planBatch(context({ items: many, settings, delivery: "directory" })).refusals,
    ).toEqual([]);
  });

  it("warns about an empty stack rather than refusing it", () => {
    const plan = planBatch(context({ stackSize: 0 }));
    expect(plan.refusals).toEqual([]);
    expect(plan.warnings.join(" ")).toContain("empty");
  });
});

describe("tokenHint", () => {
  it("lists every token the template understands", () => {
    expect(tokenHint()).toContain("{name}");
    expect(tokenHint()).toContain("{index}");
    expect(tokenHint()).toContain("{preset}");
    expect(tokenHint()).toContain("{width}");
    expect(tokenHint()).toContain("{height}");
  });
});
