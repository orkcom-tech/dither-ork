/**
 * The starter set, against the real catalogue — F-DO-04.
 *
 * This is the file that makes the starter set honest. Every other test in this
 * directory runs against `state/fixture.ts`'s three constructed effects, which
 * is right for a codec; a shipped preset is a claim about *this build's*
 * catalogue and can only be checked against it.
 *
 * Three ways a starter preset can be wrong, and all three are failures here
 * rather than in the browser:
 *
 * - **It names an effect that is gone.** A rename in `web/src/effects/` is
 *   invisible to a library entry until somebody clicks it.
 * - **Its order breaks the stack grammar.** "Outlined flats" reads an index map;
 *   put the outline in front of the dither and the render fails with a schedule
 *   error after the click, not before it.
 * - **It does not survive being written down.** A preset ships as data and is
 *   read back by the same decoder an imported file goes through.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../../lib/log";
import { discoverEffects } from "../../registry/discovery";
import { createEffectRegistry } from "../../registry/registry";
import { validateStack } from "../../registry/stack";
import { encodeDorkFile } from "./dork";
import { decodePresetFile, encodePresetFile } from "./preset";
import { STARTER_PRESETS, buildStarterPresets } from "./starter";

setLevel("error");

const registry = createEffectRegistry(discoverEffects());
const presets = buildStarterPresets(registry);

describe("the starter set", () => {
  it("builds one preset per declared spec", () => {
    expect(presets.length).toBe(STARTER_PRESETS.length);
    expect(presets.map((preset) => preset.id)).toEqual(
      STARTER_PRESETS.map((spec) => spec.id),
    );
  });

  it("names only effects this build has", () => {
    const missing = STARTER_PRESETS.flatMap((spec) =>
      spec.effects.filter((effect) => !registry.has(effect)).map((effect) => `${spec.id}: ${effect}`),
    );
    expect(missing).toEqual([]);
  });

  it("passes the stack grammar every one of them will be rendered through", () => {
    for (const preset of presets) {
      const validation = validateStack(registry, preset.document.stack);
      expect(
        validation.issues.map((issue) => `${preset.id}: ${issue.message}`),
        preset.id,
      ).toEqual([]);
    }
  });

  it("carries every node at its effect's declared defaults", () => {
    // Not a restatement of the builder: the point is that no value in
    // `starter.ts` is a second opinion about what an effect should open at.
    for (const preset of presets) {
      for (const node of preset.document.stack) {
        const descriptor = registry.require(node.effect);
        for (const param of descriptor.params) {
          expect(node.params[param.key], `${preset.id}/${node.effect}.${param.key}`).toEqual(
            param.default,
          );
        }
      }
    }
  });

  it("carries no picture and no picture reference", () => {
    for (const preset of presets) {
      expect(preset.document.source, preset.id).toBeNull();
    }
  });

  it("is marked as shipped, so the library refuses to rename or delete it", () => {
    for (const preset of presets) expect(preset.builtin, preset.id).toBe(true);
  });

  it("says what each one demonstrates", () => {
    // The note is the whole justification for shipping a *starter* set rather
    // than a curated one: it tells the reader what they are looking at.
    for (const spec of STARTER_PRESETS) {
      expect(spec.note.length, spec.id).toBeGreaterThan(40);
    }
  });

  it("covers distinct families rather than six of the same thing", () => {
    const families = new Set(
      presets.flatMap((preset) =>
        preset.document.stack.map((node) => registry.require(node.effect).family),
      ),
    );
    // Error diffusion, ordered, pattern, preprocess, special and glitch — the
    // six the catalogue has.
    expect([...families].sort()).toEqual([
      "error-diffusion",
      "glitch",
      "ordered",
      "pattern",
      "preprocess",
      "special",
    ]);
  });

  it("survives being written down and read back", () => {
    const text = encodePresetFile(presets);
    const back = decodePresetFile(text, registry);
    expect(back.length).toBe(presets.length);
    for (const [index, preset] of back.entries()) {
      const original = presets[index];
      expect(original).toBeDefined();
      if (original === undefined) continue;
      expect(preset.name).toBe(original.name);
      expect(encodeDorkFile(preset.document)).toBe(encodeDorkFile(original.document));
    }
  });

  it("is deterministic — two builds produce the same bytes", () => {
    // No clock read and no RNG anywhere in the set, which is what lets the
    // library's own tests assert on whole files.
    expect(encodePresetFile(buildStarterPresets(registry))).toBe(encodePresetFile(presets));
  });
});
