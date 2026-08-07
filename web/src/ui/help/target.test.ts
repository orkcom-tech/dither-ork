/**
 * The `data-help` token grammar.
 *
 * The token is the only contract between a call site and this directory, and a
 * malformed one is silent by nature — the panel simply never opens. So every
 * refusal is checked by code here, and the round trip is checked in both
 * directions so that `helpFor` cannot start emitting something `parseHelpToken`
 * will not read back.
 */

import { describe, expect, it } from "vitest";

import { EFFECT_CONCEPTS } from "../../types/registry";
import { UI_CONCEPT_IDS } from "./concepts";
import {
  helpFor,
  helpToken,
  isEffectConceptId,
  parseHelpToken,
  type HelpTarget,
} from "./target";

function parsed(token: string): HelpTarget {
  const result = parseHelpToken(token);
  if (!result.ok) throw new Error(`expected "${token}" to parse, got ${result.code}`);
  return result.target;
}

describe("parseHelpToken", () => {
  it("reads an effect", () => {
    expect(parsed("effect:floyd-steinberg")).toEqual({
      kind: "effect",
      effect: "floyd-steinberg",
    });
  });

  it("splits a parameter at the first dot, so a kebab-case effect id survives", () => {
    expect(parsed("param:cmyk-halftone.cellSize")).toEqual({
      kind: "param",
      effect: "cmyk-halftone",
      param: "cellSize",
    });
  });

  it("reads a written concept", () => {
    expect(parsed("concept:stack")).toEqual({ kind: "concept", concept: "stack" });
  });

  it("reads a registry family concept", () => {
    expect(parsed("effect-concept:index-map")).toEqual({
      kind: "effect-concept",
      concept: "index-map",
    });
  });

  it("tolerates surrounding whitespace, which JSX formatting can introduce", () => {
    expect(parsed("  effect:invert \n")).toEqual({ kind: "effect", effect: "invert" });
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["floyd-steinberg", "unknown-kind"],
    ["node:blur", "unknown-kind"],
    ["effect:", "missing-id"],
    ["param:", "missing-id"],
    ["param:blur", "malformed-param"],
    ["param:.radius", "malformed-param"],
    ["param:blur.", "malformed-param"],
    ["concept:", "missing-id"],
    ["concept:the-vibes", "unknown-concept"],
    ["effect-concept:stack", "unknown-concept"],
  ])("refuses %o as %s", (token, code) => {
    const result = parseHelpToken(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code);
  });

  it("does not check effect ids — that is the registry's answer, not the string's", () => {
    // A token naming an effect no build has is well-formed. `article.ts`
    // reports it against the sealed catalogue, with the id in the message.
    expect(parsed("effect:no-such-effect")).toEqual({
      kind: "effect",
      effect: "no-such-effect",
    });
  });
});

describe("helpToken", () => {
  const targets: readonly HelpTarget[] = [
    { kind: "effect", effect: "atkinson" },
    { kind: "param", effect: "atkinson", param: "strength" },
    ...UI_CONCEPT_IDS.map((concept): HelpTarget => ({ kind: "concept", concept })),
    ...Object.keys(EFFECT_CONCEPTS).map(
      (concept): HelpTarget => ({
        kind: "effect-concept",
        // Safe: the keys of EFFECT_CONCEPTS are exactly `EffectConcept`.
        concept: concept as never,
      }),
    ),
  ];

  it("round-trips every target through the parser", () => {
    for (const target of targets) {
      expect(parsed(helpToken(target))).toEqual(target);
    }
  });

  it("is what helpFor puts in the attribute", () => {
    const target: HelpTarget = { kind: "param", effect: "blur", param: "radius" };
    expect(helpFor(target)).toEqual({ "data-help": helpToken(target) });
  });
});

describe("isEffectConceptId", () => {
  it("accepts every concept the registry declares", () => {
    for (const id of Object.keys(EFFECT_CONCEPTS)) expect(isEffectConceptId(id)).toBe(true);
  });

  it("rejects an inherited property name", () => {
    // The lookup is a `hasOwnProperty` call rather than `in`, so nothing on
    // Object.prototype can be mistaken for a concept.
    expect(isEffectConceptId("toString")).toBe(false);
    expect(isEffectConceptId("constructor")).toBe(false);
  });
});
