/**
 * Fixtures for the animation tests.
 *
 * Three descriptors, one per **lever** the temporal modes drive, built through
 * the real `createEffectRegistry` so they pass the real validator: a fixture
 * that would be rejected at startup is not a fixture, it is a second definition
 * of what an effect is.
 *
 * They are deliberately small and hand-written rather than imported from
 * `web/src/effects/`. The tests here are about the animation model, and pulling
 * in the catalogue would make every one of them depend on sixty-seven shader
 * files. The one thing that genuinely has to agree with the catalogue — the
 * three pattern parameter keys — is pinned against the shipped registry in
 * `catalogue.test.ts`, which is the file that fails when somebody renames one.
 */

import type {
  Binding,
  Clock,
  DitherDocument,
  Palette,
  StackNode,
} from "../types/document";
import type { EffectDescriptor } from "../types/registry";
import { DOCUMENT_SCHEMA_VERSION } from "../types/document";
import { createEffectRegistry, type EffectRegistry } from "../registry/registry";
import { PATTERN_OFFSET_X, PATTERN_OFFSET_Y, PATTERN_ROTATION } from "./temporal";

/** An ordered dither: it has the pattern offset and rotation levers, and no seed. */
export const PATTERN_EFFECT: EffectDescriptor = {
  id: "test-pattern",
  name: "Test pattern",
  requirement: "F-OD-01",
  slot: "dither",
  family: "ordered",
  execution: "gpu",
  surpriseWeight: 1,
  producesIndexMap: true,
  requiresIndexMap: false,
  params: [
    {
      key: PATTERN_OFFSET_X,
      label: "Offset X",
      type: "float",
      animatable: true,
      legal: [-1024, 1024],
      default: 0,
      surprise: { range: [-8, 8], distribution: { kind: "uniform" }, weight: 1 },
    },
    {
      key: PATTERN_OFFSET_Y,
      label: "Offset Y",
      type: "float",
      animatable: true,
      legal: [-1024, 1024],
      default: 0,
      surprise: { range: [-8, 8], distribution: { kind: "uniform" }, weight: 1 },
    },
    {
      key: PATTERN_ROTATION,
      label: "Tile rotation",
      type: "float",
      animatable: true,
      legal: [-1, 1],
      default: 0,
      surprise: { range: [-0.25, 0.25], distribution: { kind: "uniform" }, weight: 1 },
    },
    {
      key: "spread",
      label: "Spread",
      type: "float",
      animatable: true,
      legal: [0, 2],
      default: 1,
      surprise: { range: [0.4, 1.2], distribution: { kind: "uniform" }, weight: 1 },
    },
    {
      key: "cells",
      label: "Cells",
      type: "int",
      animatable: true,
      legal: [1, 16],
      default: 4,
      surprise: { range: [2, 8], distribution: { kind: "uniform" }, weight: 1 },
    },
    {
      key: "shape",
      label: "Shape",
      type: "enum",
      animatable: false,
      values: [
        { value: "round", label: "Round" },
        { value: "square", label: "Square" },
      ],
      default: "round",
      surprise: { values: [{ value: "round", weight: 1 }], weight: 1 },
    },
  ],
};

/** A stochastic effect: it declares a seed, so it has the seed lever. */
export const SEEDED_EFFECT: EffectDescriptor = {
  id: "test-seeded",
  name: "Test seeded",
  requirement: "F-SP-01",
  slot: "preprocess",
  family: "special",
  execution: "gpu",
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: false,
  params: [
    {
      key: "seed",
      label: "Seed",
      type: "seed",
      animatable: false,
      default: 1234,
      surprise: { weight: 1 },
    },
    {
      key: "second",
      label: "Second seed",
      type: "seed",
      animatable: false,
      default: 99,
      surprise: { weight: 1 },
    },
    {
      key: "amount",
      label: "Amount",
      type: "float",
      animatable: true,
      legal: [0, 1],
      default: 0.5,
      surprise: { range: [0.1, 0.9], distribution: { kind: "uniform" }, weight: 1 },
    },
  ],
};

/**
 * An error-diffusion effect with no seed parameter.
 *
 * It still has the seed lever, because the diffusion kernels take
 * `StackNode.seed` for their threshold jitter — the one entry in
 * `SEEDED_FAMILIES`.
 */
export const DIFFUSION_EFFECT: EffectDescriptor = {
  id: "test-diffusion",
  name: "Test diffusion",
  requirement: "F-ED-01",
  slot: "dither",
  family: "error-diffusion",
  execution: "wasm",
  surpriseWeight: 1,
  producesIndexMap: true,
  requiresIndexMap: false,
  params: [
    {
      key: "strength",
      label: "Diffusion strength",
      type: "float",
      animatable: true,
      legal: [0, 1],
      default: 1,
      surprise: { range: [0.5, 1], distribution: { kind: "uniform" }, weight: 1 },
    },
    {
      key: "serpentine",
      label: "Serpentine",
      type: "bool",
      animatable: false,
      default: true,
      surprise: { trueProbability: 0.9, weight: 1 },
    },
  ],
};

/** A "plain" effect: no seed, no pattern. It supports only `static`. */
export const PLAIN_EFFECT: EffectDescriptor = {
  id: "test-plain",
  name: "Test plain",
  requirement: "F-PP-02",
  slot: "preprocess",
  family: "preprocess",
  execution: "gpu",
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: false,
  params: [
    {
      key: "gain",
      label: "Gain",
      type: "float",
      animatable: true,
      legal: [0, 4],
      default: 1,
      surprise: { range: [0.5, 2], distribution: { kind: "uniform" }, weight: 1 },
    },
  ],
};

export const TEST_EFFECTS: readonly EffectDescriptor[] = [
  PATTERN_EFFECT,
  SEEDED_EFFECT,
  DIFFUSION_EFFECT,
  PLAIN_EFFECT,
];

export function testRegistry(
  descriptors: readonly EffectDescriptor[] = TEST_EFFECTS,
): EffectRegistry {
  return createEffectRegistry(
    descriptors.map((descriptor) => ({ descriptor, module: `fixture/${descriptor.id}` })),
  );
}

export const TEST_PALETTE: Palette = {
  id: "test",
  name: "Test",
  colors: [0, 0, 0, 255, 255, 255],
  metric: "oklab",
};

export function node(
  id: string,
  effect: string,
  params: Record<string, StackNode["params"][string]>,
  seed = 7,
): StackNode {
  return { id, effect, enabled: true, opacity: 1, blend: "normal", params, seed };
}

export function patternNode(id = "pattern", seed = 7): StackNode {
  return node(
    id,
    PATTERN_EFFECT.id,
    { [PATTERN_OFFSET_X]: 0, [PATTERN_OFFSET_Y]: 0, [PATTERN_ROTATION]: 0, spread: 1, cells: 4, shape: "round" },
    seed,
  );
}

export function seededNode(id = "seeded", seed = 11): StackNode {
  return node(id, SEEDED_EFFECT.id, { seed: 1234, second: 99, amount: 0.5 }, seed);
}

export function diffusionNode(id = "diffusion", seed = 13): StackNode {
  return node(id, DIFFUSION_EFFECT.id, { strength: 1, serpentine: true }, seed);
}

export function plainNode(id = "plain", seed = 17): StackNode {
  return node(id, PLAIN_EFFECT.id, { gain: 1 }, seed);
}

export function binding(overrides: Partial<Binding> & Pick<Binding, "nodeId" | "param">): Binding {
  return {
    shape: "sine",
    amount: 0.25,
    cyclesPerLoop: 1,
    phase: 0,
    bipolar: true,
    ...overrides,
  };
}

export function testDocument(
  stack: readonly StackNode[],
  bindings: readonly Binding[] = [],
  clock: Clock = { frames: 60, fps: 30 },
): DitherDocument {
  return {
    schema: DOCUMENT_SCHEMA_VERSION,
    source: null,
    stack,
    palette: TEST_PALETTE,
    clock,
    bindings,
  };
}
