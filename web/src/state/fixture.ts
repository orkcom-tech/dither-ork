/**
 * A small, valid catalogue for the state tests.
 *
 * Not a mock and not a stub: these are real {@link EffectDescriptor}s that go
 * through the registry's own validator, so a test that adds a node to a
 * document is exercising the same lookup, the same defaults and the same
 * coercion the application does. Using the shipped catalogue instead would tie
 * every assertion about undo to whatever Floyd-Steinberg's parameter list
 * happens to be this week.
 *
 * It lives beside the code rather than inside one test file because the store,
 * the mutations and the serializer all need the same three effects, and three
 * copies of a descriptor is three places for one of them to drift.
 */

import type { EffectDescriptor } from "../types/registry";
import { createEffectRegistry, type EffectRegistry } from "../registry";

/** A parallel effect with a float, a bool and an enum. */
export const TEST_LEVELS: EffectDescriptor = {
  id: "test-levels",
  name: "Test Levels",
  summary: "Fixture effect, constructed by a test rather than shipped in the catalogue.",
  description:
    "Not one of the sixty-seven. It exists so this test can exercise one rule in isolation, which a real descriptor cannot do without dragging its whole parameter set along.",
  keywords: ["fixture", "test"],
  requirement: "F-PP-03",
  slot: "preprocess",
  family: "preprocess",
  execution: "gpu",
  params: [
    {
      key: "amount",
      label: "Amount",
      description:
        "Fixture control. It has a kind and a range so the test can exercise them; nothing renders it.",
      type: "float",
      animatable: true,
      legal: [0, 2],
      default: 1,
      surprise: { range: [0.5, 1.5], distribution: { kind: "uniform" }, weight: 1 },
    },
    {
      key: "invert",
      label: "Invert",
      description:
        "Fixture control. It has a kind and a range so the test can exercise them; nothing renders it.",
      type: "bool",
      animatable: false,
      default: false,
      surprise: { trueProbability: 0.3, weight: 0.5 },
    },
    {
      key: "mode",
      label: "Mode",
      description:
        "Fixture control. It has a kind and a range so the test can exercise them; nothing renders it.",
      type: "enum",
      animatable: false,
      values: [
        { value: "linear", label: "Linear" },
        { value: "log", label: "Log" },
      ],
      default: "linear",
      surprise: {
        values: [
          { value: "linear", weight: 2 },
          { value: "log", weight: 1 },
        ],
        weight: 1,
      },
    },
  ],
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: false,
};

/** A serial effect, so the tests cover both execution kinds. */
export const TEST_DIFFUSION: EffectDescriptor = {
  id: "test-diffusion",
  name: "Test Diffusion",
  summary: "Fixture effect, constructed by a test rather than shipped in the catalogue.",
  description:
    "Not one of the sixty-seven. It exists so this test can exercise one rule in isolation, which a real descriptor cannot do without dragging its whole parameter set along.",
  keywords: ["fixture", "test"],
  requirement: "F-ED-01",
  slot: "dither",
  family: "error-diffusion",
  execution: "wasm",
  params: [
    {
      key: "strength",
      label: "Strength",
      description:
        "Fixture control. It has a kind and a range so the test can exercise them; nothing renders it.",
      type: "float",
      animatable: true,
      legal: [0, 1],
      default: 1,
      surprise: { range: [0.6, 1], distribution: { kind: "uniform" }, weight: 1 },
    },
  ],
  surpriseWeight: 1,
  producesIndexMap: true,
  requiresIndexMap: false,
};

/** A postprocess effect with no parameters at all. */
export const TEST_INVERT: EffectDescriptor = {
  id: "test-invert",
  name: "Test Invert",
  summary: "Fixture effect, constructed by a test rather than shipped in the catalogue.",
  description:
    "Not one of the sixty-seven. It exists so this test can exercise one rule in isolation, which a real descriptor cannot do without dragging its whole parameter set along.",
  keywords: ["fixture", "test"],
  requirement: "F-SP-01",
  slot: "postprocess",
  family: "special",
  execution: "gpu",
  params: [],
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: false,
};

export function testRegistry(): EffectRegistry {
  return createEffectRegistry([
    { descriptor: TEST_LEVELS, module: "test/levels" },
    { descriptor: TEST_DIFFUSION, module: "test/diffusion" },
    { descriptor: TEST_INVERT, module: "test/invert" },
  ]);
}
