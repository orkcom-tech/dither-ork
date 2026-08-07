/**
 * The animation model against the **real** catalogue.
 *
 * `temporal.ts` restates three parameter keys — `offsetX`, `offsetY`,
 * `tileRotation` — because a lever has to be identified by something, and the
 * animation module has no business importing a compute pass to find out. That
 * restatement is the one place this module can silently drift from the effects
 * it drives: rename `ORDERED_PARAM.offsetX` in `gpu/effects/ordered.ts` and
 * nothing breaks, nothing errors, and six of the nine temporal modes quietly
 * stop being offered on every dither in the build.
 *
 * So the keys are checked against the shipped descriptors here, along with the
 * property that matters more than any of them: **every mode is offerable on
 * something.** A mode no effect in the catalogue supports is a control wired to
 * nothing, and it should fail a test rather than an eye.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { setLevel } from "../lib/log";
import { discoverEffects } from "../registry/discovery";
import { createEffectRegistry } from "../registry/registry";
import type { EffectDescriptor } from "../types/registry";
import {
  PATTERN_OFFSET_X,
  PATTERN_OFFSET_Y,
  PATTERN_ROTATION,
  SEEDED_FAMILIES,
  TEMPORAL_MODES,
  supportsLever,
  temporalLever,
  temporalModesFor,
  seedParams,
} from "./temporal";

beforeAll(() => setLevel("error"));

const registry = createEffectRegistry(discoverEffects());
const catalogue = registry.all();

function param(descriptor: EffectDescriptor, key: string) {
  return descriptor.params.find((candidate) => candidate.key === key);
}

describe("the pattern parameter keys", () => {
  it("are declared by every ordered dither, as animatable floats", () => {
    const ordered = registry.byFamily("ordered");
    expect(ordered.length).toBeGreaterThan(0);
    for (const descriptor of ordered) {
      for (const key of [PATTERN_OFFSET_X, PATTERN_OFFSET_Y, PATTERN_ROTATION]) {
        const declared = param(descriptor, key);
        expect(declared, `${descriptor.id} declares ${key}`).toBeDefined();
        expect(declared?.type, `${descriptor.id}.${key} is a float`).toBe("float");
        expect(declared?.animatable, `${descriptor.id}.${key} is animatable`).toBe(true);
      }
    }
  });

  it("gives tileRotation a legal range that can hold a whole turn", () => {
    // The rotation modes wrap into [0, 1) because a turn is a circle; a legal
    // range narrower than that would have the wrap undone by the clamp.
    for (const descriptor of registry.byFamily("ordered")) {
      const rotation = param(descriptor, PATTERN_ROTATION);
      expect(rotation?.type).toBe("float");
      if (rotation?.type !== "float") continue;
      expect(rotation.legal[0]).toBeLessThanOrEqual(0);
      expect(rotation.legal[1]).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("levers over the shipped catalogue", () => {
  it("offers every mode on at least one effect", () => {
    for (const mode of TEMPORAL_MODES) {
      const lever = temporalLever(mode);
      const supported =
        lever === null ?
          catalogue
        : catalogue.filter((descriptor) => supportsLever(descriptor, lever));
      expect(supported.length, `${mode} is offerable somewhere`).toBeGreaterThan(0);
    }
  });

  it("gives every ordered dither the two pattern levers", () => {
    for (const descriptor of registry.byFamily("ordered")) {
      expect(supportsLever(descriptor, "pattern-offset"), descriptor.id).toBe(true);
      expect(supportsLever(descriptor, "pattern-rotation"), descriptor.id).toBe(true);
    }
  });

  it("gives every error-diffusion effect the seed lever, though none declares a seed", () => {
    const diffusion = registry.byFamily("error-diffusion");
    expect(diffusion.length).toBeGreaterThan(0);
    for (const descriptor of diffusion) {
      expect(supportsLever(descriptor, "seed"), descriptor.id).toBe(true);
    }
    expect(SEEDED_FAMILIES).toContain("error-diffusion");
  });

  it("gives the seed lever to every effect that declares a seed parameter", () => {
    const seeded = catalogue.filter((descriptor) => seedParams(descriptor).length > 0);
    expect(seeded.length).toBeGreaterThan(0);
    for (const descriptor of seeded) {
      expect(supportsLever(descriptor, "seed"), descriptor.id).toBe(true);
    }
  });

  it("offers static, and only static, to an effect with neither a seed nor a pattern", () => {
    const plain = catalogue.filter(
      (descriptor) =>
        !supportsLever(descriptor, "seed") &&
        !supportsLever(descriptor, "pattern-offset") &&
        !supportsLever(descriptor, "pattern-rotation"),
    );
    // There are plenty — a blur has no pattern and no randomness — and the point
    // is that they are offered nothing that would not move them.
    expect(plain.length).toBeGreaterThan(0);
    for (const descriptor of plain) {
      expect(temporalModesFor(descriptor), descriptor.id).toEqual(["static"]);
    }
  });

  it("offers at least static to every effect in the catalogue", () => {
    for (const descriptor of catalogue) {
      expect(temporalModesFor(descriptor)).toContain("static");
    }
  });
});

describe("what a modulator may drive in the shipped catalogue", () => {
  it("finds animatable parameters, and none of them is a seed or an enum", () => {
    let animatable = 0;
    for (const descriptor of catalogue) {
      for (const declared of descriptor.params) {
        if (!declared.animatable) continue;
        animatable += 1;
        // A modulator produces a continuous number. Anything it can be attached
        // to has to be one, and `binding.ts` refuses the rest — this asserts the
        // catalogue never asks it to.
        expect(
          ["float", "int"],
          `${descriptor.id}.${declared.key} is animatable and a ${declared.type}`,
        ).toContain(declared.type);
      }
    }
    expect(animatable).toBeGreaterThan(0);
  });
});
