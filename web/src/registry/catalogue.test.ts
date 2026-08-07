/**
 * The real catalogue, against the real validator.
 *
 * `registry.test.ts` next door checks the validator with constructed
 * descriptors — that it rejects a missing surprise range, an inverted bound, a
 * duplicate id. This file checks the opposite direction: that the sixty-odd
 * descriptors actually in `web/src/effects/` pass it.
 *
 * That distinction matters because the two fail differently. A broken validator
 * is caught by unit tests. A broken *descriptor* is caught only by running the
 * validator over the shipped set, and until this file existed the first thing
 * that did so was the browser at startup — which is far too late, since a
 * catalogue that does not validate makes the app refuse to start.
 *
 * The counts below are asserted rather than merely reported. An effect that
 * disappears because a file was renamed to something the glob no longer matches
 * is invisible in every other way: nothing errors, the app starts, and the
 * stack panel is simply one row shorter.
 */

import { describe, expect, it } from "vitest";

import { discoverEffects } from "./discovery";
import { createEffectRegistry } from "./registry";
import { validateRegistry } from "../types/registry";
import type { EffectFamily, ExecutionKind } from "../types/registry";
import type { NodeSlot } from "../types/document";

/**
 * What the build is expected to contain, from docs/ARCHITECTURE.md.
 *
 * **One** of the spec's named effects is deliberately absent, and the gap is
 * recorded where the decision was made rather than here: F-GL-06 (JPEG glitch,
 * which needs an encoder the pipeline does not have, and therefore an execution
 * kind that does not exist). F-SP-14 (nearest-neighbour upscale) was the second
 * such gap and is now built — as the other half of the F-PP-01 pair rather than
 * as a resampling stage outside the stack, which is what closed it.
 *
 * The `preprocess` family is the tone-and-noise front of the stack (F-PP) and
 * is now complete bar one: F-PP-01 through 06 are here, and F-PP-07 arrives as
 * an `ordered` dither because a user-supplied threshold map *is* one. F-PP-08,
 * the mask input, is the single F-PP requirement with no descriptor: it is a
 * second image edge on the graph rather than a pass, and the graph has no
 * second edge yet.
 */
const EXPECTED_BY_FAMILY: Readonly<Record<EffectFamily, number>> = {
  preprocess: 6,
  "error-diffusion": 15,
  ordered: 6,
  pattern: 8,
  glitch: 16,
  special: 16,
};

const EXPECTED_BY_EXECUTION: Readonly<Record<ExecutionKind, number>> = {
  wasm: 15,
  gpu: 52,
};

const EXPECTED_BY_SLOT: Readonly<Record<NodeSlot, number>> = {
  preprocess: 18,
  dither: 29,
  postprocess: 20,
};

const EXPECTED_TOTAL = 67;

/**
 * Every WGSL file the build ships, keyed by the effect id it is named for.
 *
 * A leading underscore marks a shader that is **not** an effect and therefore
 * has no id to be named for. There is one: `_composite.wgsl`, the per-node
 * opacity and blend program (F-ST-03), which belongs to the GPU layer rather
 * than to the catalogue. The prefix is the whole convention — it keeps the
 * "every shader is claimed" check below strict for the 52 that are effects
 * instead of turning it into a list of exceptions.
 */
const SHADER_IDS: ReadonlySet<string> = new Set(
  Object.keys(import.meta.glob("../shaders/*.wgsl", { eager: true, query: "?raw" }))
    .map((path) => path.replace(/^.*\//, "").replace(/\.wgsl$/, ""))
    .filter((id) => !id.startsWith("_")),
);

describe("the shipped catalogue", () => {
  const discovered = discoverEffects();
  const effects = discovered.map((entry) => entry.descriptor);

  it("passes the validator that gates startup", () => {
    const validation = validateRegistry(effects);
    // Named individually: "expected true, got false" on a sixty-effect
    // catalogue is not a message anybody can act on.
    expect(
      validation.issues.map(
        (issue) =>
          `${issue.effect}${issue.param === undefined ? "" : `.${issue.param}`}: ${issue.code} — ${issue.message}`,
      ),
    ).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it("seals", () => {
    expect(() => createEffectRegistry(discovered)).not.toThrow();
  });

  it("holds every effect the build order says it holds", () => {
    const registry = createEffectRegistry(discovered);
    expect(registry.size).toBe(EXPECTED_TOTAL);

    for (const [family, count] of Object.entries(EXPECTED_BY_FAMILY)) {
      expect(
        registry.byFamily(family as EffectFamily).length,
        `family ${family}`,
      ).toBe(count);
    }
    for (const [kind, count] of Object.entries(EXPECTED_BY_EXECUTION)) {
      expect(
        registry.byExecution(kind as ExecutionKind).length,
        `execution ${kind}`,
      ).toBe(count);
    }
    for (const [slot, count] of Object.entries(EXPECTED_BY_SLOT)) {
      expect(registry.bySlot(slot as NodeSlot).length, `slot ${slot}`).toBe(count);
    }
  });

  it("implements each requirement exactly once", () => {
    const seen = new Map<string, string[]>();
    for (const effect of effects) {
      seen.set(effect.requirement, [...(seen.get(effect.requirement) ?? []), effect.id]);
    }
    const duplicated = [...seen.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([requirement, ids]) => `${requirement}: ${ids.join(", ")}`);
    expect(duplicated).toEqual([]);
  });

  it("gives every parallel effect a shader named after its id", () => {
    // The pass compiler takes WGSL from whoever constructs the effect, so a
    // missing file is a build error rather than something to discover. What this
    // catches is the other direction: an effect whose shader is named for an
    // older id, which compiles and then cannot be found by anyone reading the
    // directory.
    const missing = effects
      .filter((effect) => effect.execution === "gpu" && !SHADER_IDS.has(effect.id))
      .map((effect) => effect.id);
    expect(missing).toEqual([]);
  });

  it("ships no shader that no effect claims", () => {
    const claimed = new Set(effects.map((effect) => effect.id));
    const orphans = [...SHADER_IDS].filter((id) => !claimed.has(id));
    expect(orphans).toEqual([]);
  });

  it("puts every quantizer in the dither slot", () => {
    // Producing an index map without reading one is what quantizing *is*, and a
    // quantizer is by definition the primary node of a stack. Producing one
    // while also reading one is a different thing — outline and dilate/erode
    // rewrite the map they were handed, and they belong downstream of the node
    // that made it, which is where the validator's own index-map rule puts them.
    const misplaced = effects
      .filter(
        (effect) =>
          effect.producesIndexMap && !effect.requiresIndexMap && effect.slot !== "dither",
      )
      .map((effect) => `${effect.id} (${effect.slot})`);
    expect(misplaced).toEqual([]);
  });

  it("keeps every index-map rewriter downstream of a quantizer", () => {
    const misplaced = effects
      .filter((effect) => effect.requiresIndexMap && effect.slot !== "postprocess")
      .map((effect) => `${effect.id} (${effect.slot})`);
    expect(misplaced).toEqual([]);
  });
});
