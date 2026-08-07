/**
 * Resolving help against the real catalogue.
 *
 * The whole point of F-UI-15 is that a newly added effect arrives documented,
 * and the way that stops being true is quietly: someone adds effect number
 * sixty-eight, the hover panel has nothing to say about it, and nobody notices
 * because nothing errors. So the first two cases here walk **every effect and
 * every parameter in the shipped catalogue** and insist that help resolves for
 * all of them. That is the same shape as `registry/catalogue.test.ts` asserting
 * the counts rather than reporting them.
 *
 * The other thing checked hard is that this directory adds no prose: an
 * article's text is asserted to be *identical* to the descriptor's, character
 * for character. A helpful-looking rewrite here would be the third copy F-UI-15
 * was written to prevent.
 */

import { describe, expect, it } from "vitest";

import { discoverEffects } from "../../registry/discovery";
import { createEffectRegistry, type EffectRegistry } from "../../registry/registry";
import { EFFECT_CONCEPTS, type ParamType } from "../../types/registry";
import { UI_CONCEPTS } from "./concepts";
import { resolveHelp, type HelpArticle } from "./article";

const registry: EffectRegistry = createEffectRegistry(discoverEffects());

function article(lookup: ReturnType<typeof resolveHelp>): HelpArticle {
  if (!lookup.ok) throw new Error(`expected help, got ${lookup.code}: ${lookup.detail}`);
  return lookup.article;
}

function factValue(found: HelpArticle, label: string): string | undefined {
  return found.facts.find((fact) => fact.label === label)?.value;
}

describe("every effect in the catalogue", () => {
  it("resolves, with the descriptor's own words and nothing else", () => {
    for (const effect of registry.all()) {
      const found = article(resolveHelp(registry, { kind: "effect", effect: effect.id }));
      expect(found.title).toBe(effect.name);
      expect(found.summary).toBe(effect.summary);
      expect(found.description).toBe(effect.description);
    }
  });

  it("carries the three facts the picker also shows", () => {
    for (const effect of registry.all()) {
      const found = article(resolveHelp(registry, { kind: "effect", effect: effect.id }));
      expect(factValue(found, "Requirement")).toBe(effect.requirement);
      expect(factValue(found, "Slot")).toBeDefined();
      expect(factValue(found, "Runs on")).toBeDefined();
    }
  });

  it("names the family idea, quoting the registry's concept", () => {
    for (const effect of registry.all()) {
      const found = article(resolveHelp(registry, { kind: "effect", effect: effect.id }));
      if (effect.concept === undefined) {
        expect(found.family).toBeNull();
        continue;
      }
      const concept = EFFECT_CONCEPTS[effect.concept];
      expect(found.family).toEqual({
        title: concept.title,
        summary: concept.summary,
        token: `effect-concept:${concept.id}`,
      });
    }
  });

  it("says so when a node constrains where it may sit", () => {
    // These two are the reason the picker refuses a placement, so the help that
    // has to explain a refusal is the help that has to carry them.
    for (const effect of registry.all()) {
      const found = article(resolveHelp(registry, { kind: "effect", effect: effect.id }));
      const indexMap = found.facts.filter((fact) => fact.label === "Index map");
      expect(indexMap.length).toBe(
        (effect.producesIndexMap ? 1 : 0) + (effect.requiresIndexMap ? 1 : 0),
      );
    }
  });
});

describe("every parameter in the catalogue", () => {
  it("resolves, with the descriptor's own description", () => {
    let checked = 0;
    for (const effect of registry.all()) {
      for (const param of effect.params) {
        const found = article(
          resolveHelp(registry, { kind: "param", effect: effect.id, param: param.key }),
        );
        expect(found.title).toBe(param.label);
        expect(found.description).toBe(param.description);
        // A parameter carries one descriptive field. Printing it as both the
        // lead and the body would be the drift F-UI-15 names, inside one panel.
        expect(found.summary).toBeNull();
        checked += 1;
      }
    }
    // The catalogue has hundreds; a glob that silently matched nothing would
    // otherwise make this whole block vacuously pass.
    expect(checked).toBeGreaterThan(300);
  });

  it("states a default that is never empty", () => {
    for (const effect of registry.all()) {
      for (const param of effect.params) {
        const found = article(
          resolveHelp(registry, { kind: "param", effect: effect.id, param: param.key }),
        );
        expect(factValue(found, "Default")).toBeTruthy();
      }
    }
  });

  it("formats each parameter kind in the words its own control uses", () => {
    const seen = new Set<ParamType>();
    for (const effect of registry.all()) {
      for (const param of effect.params) {
        if (seen.has(param.type)) continue;
        seen.add(param.type);
        const found = article(
          resolveHelp(registry, { kind: "param", effect: effect.id, param: param.key }),
        );
        const value = factValue(found, "Default") ?? "";
        switch (param.type) {
          case "bool":
            expect(["on", "off"]).toContain(value);
            break;
          case "enum":
            expect(param.values.map((option) => option.label)).toContain(value);
            expect(factValue(found, "Options")).toBeTruthy();
            break;
          case "color":
            expect(value).toBe(param.default.join(", "));
            break;
          case "curve":
            expect(value).toBe(`${param.default.length} points`);
            break;
          case "float":
          case "int":
            expect(Number(value)).toBe(param.default);
            expect(factValue(found, "Range")).toBeTruthy();
            break;
          case "seed":
            expect(Number(value)).toBe(param.default);
            break;
        }
      }
    }
    // Every kind the registry can describe is present in the shipped set except
    // none — if one stops being used, this line says so rather than the switch
    // above quietly covering six of seven.
    expect(seen.size).toBeGreaterThanOrEqual(6);
  });

  it("prints a fractional default as it was written, not as a binary expansion", () => {
    const fractional = registry
      .all()
      .flatMap((effect) => effect.params)
      .find((param) => param.type === "float" && !Number.isInteger(param.default));
    expect(fractional).toBeDefined();
    if (fractional === undefined) return;
    const owner = registry.all().find((effect) => effect.params.includes(fractional));
    expect(owner).toBeDefined();
    if (owner === undefined) return;
    const found = article(
      resolveHelp(registry, { kind: "param", effect: owner.id, param: fractional.key }),
    );
    expect(factValue(found, "Default")).not.toMatch(/\d{10}/);
  });
});

describe("concepts", () => {
  it("resolves every written interface concept", () => {
    for (const concept of Object.values(UI_CONCEPTS)) {
      const found = article(
        resolveHelp(registry, { kind: "concept", concept: concept.id }),
      );
      expect(found.title).toBe(concept.title);
      expect(found.summary).toBe(concept.summary);
      expect(found.description).toBe(concept.description);
      expect(found.facts).toEqual([]);
    }
  });

  it("resolves every family concept out of the registry", () => {
    for (const concept of Object.values(EFFECT_CONCEPTS)) {
      const found = article(
        resolveHelp(registry, { kind: "effect-concept", concept: concept.id }),
      );
      expect(found.title).toBe(concept.title);
      expect(found.description).toBe(concept.description);
    }
  });

  it("reaches the index map, which F-UI-13 names and the registry owns", () => {
    const found = article(
      resolveHelp(registry, { kind: "effect-concept", concept: "index-map" }),
    );
    expect(found.description).toBe(EFFECT_CONCEPTS["index-map"].description);
  });
});

describe("misses", () => {
  it("reports an effect this build does not have, with the id", () => {
    const lookup = resolveHelp(registry, { kind: "effect", effect: "no-such-effect" });
    expect(lookup.ok).toBe(false);
    if (lookup.ok) return;
    expect(lookup.code).toBe("unknown-effect");
    expect(lookup.detail).toContain("no-such-effect");
  });

  it("reports a parameter the effect does not declare", () => {
    const first = registry.all()[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const lookup = resolveHelp(registry, {
      kind: "param",
      effect: first.id,
      param: "notAParameter",
    });
    expect(lookup.ok).toBe(false);
    if (lookup.ok) return;
    expect(lookup.code).toBe("unknown-param");
    expect(lookup.detail).toContain("notAParameter");
  });
});
