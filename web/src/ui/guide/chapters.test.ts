/**
 * The hand-written chapters.
 *
 * These are prose, and prose cannot be asserted. What can be asserted is the
 * part that is not prose: that every chapter the contents rail offers exists and
 * has something under it, that the facts a chapter prints are read off the build
 * rather than typed into the sentence, and that the export chapter's format
 * tables are the export module's own tables — because a second list of formats
 * is exactly the drift F-UI-15 exists to prevent, one directory over.
 */

import { describe, expect, it } from "vitest";

import { GUIDE_CHAPTERS, factsFor } from "./chapters";
import { ANIMATED_FORMATS } from "../../export/animated";
import { EXPORT_FORMATS } from "../../export";
import { discoverEffects } from "../../registry/discovery";
import { createEffectRegistry } from "../../registry/registry";

const registry = createEffectRegistry(discoverEffects());

describe("the guide's chapters", () => {
  it("gives every chapter a distinct id, a title and a lede", () => {
    const ids = GUIDE_CHAPTERS.map((chapter) => chapter.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const chapter of GUIDE_CHAPTERS) {
      expect(chapter.title.trim().length, chapter.id).toBeGreaterThan(0);
      expect(chapter.lede.trim().length, chapter.id).toBeGreaterThan(0);
      expect(chapter.paragraphs.length, chapter.id).toBeGreaterThan(0);
      for (const paragraph of chapter.paragraphs) {
        expect(paragraph.trim().length, chapter.id).toBeGreaterThan(0);
      }
    }
  });

  it("covers the ideas the requirement names", () => {
    // F-UI-14 lists what the guide has to explain. Losing one of these is the
    // failure this test exists for: the chapter is deleted, the guide still
    // renders, and nobody notices the pipeline model is no longer explained.
    expect(GUIDE_CHAPTERS.map((chapter) => chapter.id)).toEqual([
      "start",
      "stack",
      "palette",
      "light",
      "index-map",
      "animation",
      "export",
    ]);
  });

  it("gives the getting-started chapter an ordered path", () => {
    const start = GUIDE_CHAPTERS.find((chapter) => chapter.id === "start");
    expect(start?.steps?.length).toBe(4);
    for (const step of start?.steps ?? []) {
      expect(step.title.trim().length).toBeGreaterThan(0);
      expect(step.text.trim().length).toBeGreaterThan(0);
    }
  });

  it("reads its counts off the registry rather than stating them", () => {
    const stack = GUIDE_CHAPTERS.find((chapter) => chapter.id === "stack");
    expect(stack).toBeDefined();
    if (stack === undefined) return;
    const facts = factsFor(stack, registry);
    expect(facts.length).toBe(3);
    // Every count the chapter prints has to be one the registry can produce, or
    // it is a number somebody typed and will not maintain.
    const values = facts.map((fact) => fact.value).join(" ");
    for (const slot of ["preprocess", "dither", "postprocess"] as const) {
      expect(values).toContain(String(registry.bySlot(slot).length));
    }
  });

  it("names the index-map readers from the descriptors", () => {
    const chapter = GUIDE_CHAPTERS.find((entry) => entry.id === "index-map");
    expect(chapter).toBeDefined();
    if (chapter === undefined) return;
    const facts = factsFor(chapter, registry);
    const values = facts.map((fact) => fact.value).join(" | ");
    for (const effect of registry.all().filter((entry) => entry.requiresIndexMap)) {
      expect(values, effect.id).toContain(effect.name);
    }
    for (const effect of registry.bySlot("dither").filter((entry) => !entry.producesIndexMap)) {
      expect(values, effect.id).toContain(effect.name);
    }
  });

  it("counts the bindable parameters rather than claiming a number", () => {
    const chapter = GUIDE_CHAPTERS.find((entry) => entry.id === "animation");
    expect(chapter).toBeDefined();
    if (chapter === undefined) return;
    const expected = registry
      .all()
      .reduce((sum, effect) => sum + effect.params.filter((param) => param.animatable).length, 0);
    expect(factsFor(chapter, registry)[0]?.value).toContain(String(expected));
    expect(expected).toBeGreaterThan(0);
  });

  it("takes the export formats from the export module's own tables", () => {
    const chapter = GUIDE_CHAPTERS.find((entry) => entry.id === "export");
    const lists = chapter?.lists ?? [];
    expect(lists.length).toBe(2);
    expect(lists[0]?.entries.map((entry) => entry.term)).toEqual(
      EXPORT_FORMATS.map((format) => format.label),
    );
    expect(lists[0]?.entries.map((entry) => entry.detail)).toEqual(
      EXPORT_FORMATS.map((format) => format.detail),
    );
    expect(lists[1]?.entries.map((entry) => entry.term)).toEqual(
      ANIMATED_FORMATS.map((format) => format.label),
    );
    expect(lists[1]?.entries.map((entry) => entry.detail)).toEqual(
      ANIMATED_FORMATS.map((format) => format.detail),
    );
  });

  it("leaves a chapter with no facts alone rather than inventing any", () => {
    const palette = GUIDE_CHAPTERS.find((chapter) => chapter.id === "palette");
    expect(palette).toBeDefined();
    if (palette === undefined) return;
    expect(factsFor(palette, registry)).toEqual([]);
  });
});
