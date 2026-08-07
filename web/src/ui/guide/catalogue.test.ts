/**
 * The guide's catalogue, against the catalogue it documents.
 *
 * The requirement being tested is F-UI-15's sharp end: *the guide's effect
 * catalogue is generated from the registry, never hand-maintained*. A test that
 * only checked the shape of the output would pass just as happily against sixty-
 * seven hand-written entries, so what is checked here is the property that
 * distinguishes the two — every effect appears, exactly once, carrying **the
 * descriptor's own strings**, and an effect the test invents appears without
 * this directory being edited.
 */

import { describe, expect, it } from "vitest";

import { buildCatalogue, catalogueFor, describeControl } from "./catalogue";
import { discoverEffects } from "../../registry/discovery";
import { createEffectRegistry } from "../../registry/registry";
import { EFFECT_CONCEPTS } from "../../types/registry";
import type {
  EffectConcept,
  EffectDescriptor,
  ParamDescriptor,
} from "../../types/registry";

const discovered = discoverEffects();
const effects = discovered.map((entry) => entry.descriptor);
const registry = createEffectRegistry(discovered);

/** A descriptor the catalogue has never seen, to prove nothing is hand-listed. */
const INVENTED: EffectDescriptor = {
  id: "invented-effect",
  name: "Invented effect",
  summary: "Does something no shipped effect does, so it cannot be confused with one.",
  description: "The long form, distinct from the summary so both can be told apart in a test.",
  keywords: ["invented"],
  concept: "glitch",
  requirement: "F-GL-99",
  slot: "postprocess",
  family: "glitch",
  execution: "gpu",
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: false,
  params: [
    {
      key: "amount",
      label: "Amount",
      type: "float",
      animatable: true,
      description: "How far the invented thing goes.",
      legal: [0, 1],
      default: 0.5,
      surprise: { range: [0, 1], distribution: { kind: "uniform" }, weight: 1 },
    },
  ],
};

describe("the generated catalogue", () => {
  const catalogue = buildCatalogue(effects);
  const printed = catalogue.sections.flatMap((section) => section.effects);

  it("prints every effect in the build exactly once", () => {
    const ids = printed.map((effect) => effect.id).sort();
    expect(ids).toEqual(effects.map((effect) => effect.id).sort());
    expect(catalogue.effects).toBe(registry.size);
  });

  it("prints the descriptor's own words and not a copy of them", () => {
    // The point of the requirement. If any of these ever diverge, the guide has
    // grown a second source of descriptive text.
    for (const effect of effects) {
      const entry = printed.find((candidate) => candidate.id === effect.id);
      expect(entry, effect.id).toBeDefined();
      expect(entry?.name).toBe(effect.name);
      expect(entry?.summary).toBe(effect.summary);
      expect(entry?.description).toBe(effect.description);
      expect(entry?.requirement).toBe(effect.requirement);
      expect(entry?.controls.map((control) => control.description)).toEqual(
        effect.params.map((param) => param.description),
      );
    }
  });

  it("documents every control of every effect", () => {
    const declared = effects.reduce((sum, effect) => sum + effect.params.length, 0);
    expect(catalogue.controls).toBe(declared);
    expect(declared).toBeGreaterThan(0);
    for (const effect of printed) {
      for (const control of effect.controls) {
        expect(control.description.trim().length, `${effect.id}.${control.key}`).toBeGreaterThan(0);
        expect(control.detail.trim().length, `${effect.id}.${control.key}`).toBeGreaterThan(0);
      }
    }
  });

  it("heads each section with the concept text, not with words of its own", () => {
    for (const section of catalogue.sections) {
      if (section.concept === null) continue;
      const concept = EFFECT_CONCEPTS[section.concept];
      expect(section.title).toBe(concept.title);
      expect(section.summary).toBe(concept.summary);
      expect(section.description).toBe(concept.description);
      for (const effect of section.effects) {
        const descriptor = effects.find((candidate) => candidate.id === effect.id);
        expect(descriptor?.concept, effect.id).toBe(section.concept);
      }
    }
  });

  it("orders sections the way the concept table declares them", () => {
    const declared = Object.values(EFFECT_CONCEPTS).map((concept) => concept.id);
    const printedOrder = catalogue.sections
      .map((section) => section.concept)
      .filter((concept): concept is EffectConcept => concept !== null);
    expect(printedOrder).toEqual(declared.filter((id) => printedOrder.includes(id)));
  });

  it("files the shipped catalogue entirely under concepts", () => {
    // The unfiled section is a safety net, not a category. Anything in it is a
    // descriptor missing its concept.
    expect(catalogue.sections.filter((section) => section.concept === null)).toEqual([]);
  });

  it("prints an effect it has never heard of", () => {
    // The whole requirement in one assertion: nothing in this directory lists
    // effects, so an effect that did not exist when the guide was written is
    // documented by the guide.
    const grown = buildCatalogue([...effects, INVENTED]);
    const entry = grown.sections
      .flatMap((section) => section.effects)
      .find((effect) => effect.id === INVENTED.id);
    expect(entry?.summary).toBe(INVENTED.summary);
    expect(entry?.controls[0]?.description).toBe("How far the invented thing goes.");
    expect(grown.effects).toBe(catalogue.effects + 1);
  });

  it("shows an effect with no concept rather than dropping it", () => {
    const { concept: _concept, ...withoutConcept } = INVENTED;
    const grown = buildCatalogue([withoutConcept]);
    expect(grown.effects).toBe(1);
    const last = grown.sections[grown.sections.length - 1];
    expect(last?.concept).toBeNull();
    expect(last?.effects.map((effect) => effect.id)).toEqual([INVENTED.id]);
  });

  it("drops no section and invents none when the input is empty", () => {
    const empty = buildCatalogue([]);
    expect(empty.sections).toEqual([]);
    expect(empty.effects).toBe(0);
    expect(empty.controls).toBe(0);
  });
});

describe("control detail", () => {
  const detailOf = (param: ParamDescriptor): string => describeControl(param);

  it("states bounds and default for a number", () => {
    const float = effects
      .flatMap((effect) => effect.params)
      .find((param): param is Extract<ParamDescriptor, { type: "float" }> => param.type === "float");
    expect(float).toBeDefined();
    if (float === undefined) return;
    expect(detailOf(float)).toBe(
      `${float.legal[0]} to ${float.legal[1]}, default ${float.default}`,
    );
  });

  it("names enum options by their labels", () => {
    const value = detailOf({
      key: "shape",
      label: "Shape",
      type: "enum",
      animatable: false,
      description: "Which figure the screen draws.",
      values: [
        { value: "round", label: "round" },
        { value: "square", label: "square" },
      ],
      default: "square",
      surprise: { values: [{ value: "round", weight: 1 }], weight: 1 },
    });
    expect(value).toBe("round · square — default square");
  });

  it("writes a colour as hex", () => {
    const value = detailOf({
      key: "tint",
      label: "Tint",
      type: "color",
      animatable: false,
      description: "The colour the leak is made of.",
      default: [255, 0, 10],
      surprise: { lightness: [0, 1], chroma: [0, 0.3], hue: [0, 359], weight: 1 },
    });
    expect(value).toBe("a colour, default #ff000a");
  });

  it("says a seed has no better value", () => {
    const value = detailOf({
      key: "seed",
      label: "Seed",
      type: "seed",
      animatable: false,
      description: "Redraws the same effect differently.",
      default: 7,
      surprise: { weight: 1 },
    });
    expect(value).toContain("default 7");
  });
});

describe("the catalogue view", () => {
  it("shows the whole catalogue when nothing is typed", () => {
    const view = catalogueFor(registry, "   ");
    expect(view.catalogue.effects).toBe(registry.size);
    expect(view.miss).toBeNull();
    expect(view.total).toBe(registry.size);
  });

  it("narrows to what a query matches", () => {
    const view = catalogueFor(registry, "glow");
    expect(view.miss).toBeNull();
    expect(view.catalogue.effects).toBeGreaterThan(0);
    expect(view.catalogue.effects).toBeLessThan(registry.size);
  });

  it("reports why a query found nothing instead of showing an empty page", () => {
    const view = catalogueFor(registry, "unknown pleasures");
    expect(view.catalogue.effects).toBe(0);
    expect(view.miss).not.toBeNull();
    // The registry's own explanation — a specified feature this build does not
    // have — reaches the guide unchanged.
    expect(view.miss?.kind).toBe("unbuilt");
  });
});
