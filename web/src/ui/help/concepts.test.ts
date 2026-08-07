/**
 * The concept texts.
 *
 * `types/registry.ts` makes a missing or unhelpful description a *validation
 * failure* rather than something discovered in the UI months later, because
 * that is what stops a newly added effect arriving undocumented. The prose in
 * this directory is the one body of descriptive text that validator cannot
 * reach, so the same rules are applied to it here.
 *
 * The rule with teeth is the last one: **no concept written here may share an id
 * with a concept the registry already declares.** F-UI-15 exists because three
 * hand-written copies drift within a release, and a "stack" concept in this file
 * beside an "index-map" concept in the registry is the exact shape of the first
 * step toward that.
 */

import { describe, expect, it } from "vitest";

import { EFFECT_CONCEPTS } from "../../types/registry";
import { UI_CONCEPTS, UI_CONCEPT_IDS, isUiConceptId } from "./concepts";

const concepts = UI_CONCEPT_IDS.map((id) => UI_CONCEPTS[id]);

describe("the concept table", () => {
  it("has an entry per id, keyed by its own id", () => {
    for (const id of UI_CONCEPT_IDS) expect(UI_CONCEPTS[id].id).toBe(id);
    expect(Object.keys(UI_CONCEPTS).length).toBe(UI_CONCEPT_IDS.length);
  });

  it("declares no id twice", () => {
    expect(new Set(UI_CONCEPT_IDS).size).toBe(UI_CONCEPT_IDS.length);
  });

  it("names nothing the registry already explains", () => {
    // The registry owns the family ideas, the index map among them. A second
    // copy here would be a second answer to the same question, and the one that
    // drifts is always the one the reader happens to open.
    for (const id of UI_CONCEPT_IDS) {
      expect(Object.prototype.hasOwnProperty.call(EFFECT_CONCEPTS, id)).toBe(false);
    }
  });
});

describe("every concept", () => {
  it("has a title, a summary and a description, none of them blank", () => {
    for (const concept of concepts) {
      expect(concept.title.trim()).not.toBe("");
      expect(concept.summary.trim()).not.toBe("");
      expect(concept.description.trim()).not.toBe("");
    }
  });

  it("has a summary that says something the title does not", () => {
    for (const concept of concepts) {
      expect(concept.summary.toLowerCase()).not.toBe(concept.title.toLowerCase());
      expect(concept.summary.length).toBeGreaterThan(concept.title.length);
    }
  });

  it("has a description that is more than its summary restated", () => {
    // The same check `validateRegistry` applies to an effect whose long form is
    // its short form under a second field name.
    for (const concept of concepts) {
      expect(concept.description).not.toBe(concept.summary);
      expect(concept.description.length).toBeGreaterThan(concept.summary.length * 2);
    }
  });

  it("keeps the summary to one line, because it is the panel's lead", () => {
    for (const concept of concepts) {
      expect(concept.summary).not.toContain("\n");
      expect(concept.summary.length).toBeLessThanOrEqual(160);
    }
  });

  it("stays short — this is hover help, not a chapter", () => {
    for (const concept of concepts) {
      expect(concept.description.length).toBeLessThanOrEqual(900);
    }
  });

  it("promises nothing", () => {
    // The project's rule is that a thing either exists or is left out. Help
    // that describes a feature in the future tense is the same lie with more
    // words.
    for (const concept of concepts) {
      const text = `${concept.summary} ${concept.description}`.toLowerCase();
      for (const phrase of ["coming soon", "not yet implemented", "todo", "will be added"]) {
        expect(text).not.toContain(phrase);
      }
    }
  });
});

describe("isUiConceptId", () => {
  it("accepts every declared id", () => {
    for (const id of UI_CONCEPT_IDS) expect(isUiConceptId(id)).toBe(true);
  });

  it("rejects an inherited property name", () => {
    expect(isUiConceptId("toString")).toBe(false);
    expect(isUiConceptId("hasOwnProperty")).toBe(false);
  });

  it("rejects an id nobody wrote", () => {
    expect(isUiConceptId("index-map")).toBe(false);
  });
});
