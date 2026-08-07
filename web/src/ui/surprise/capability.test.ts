/**
 * The modulator probe.
 *
 * This is the test that keeps `ui/surprise` honest about F-SM-09. The generator
 * for random animation is built and tested; the *renderer* refuses a document
 * that carries bindings, so the feature is withheld until it does not. The
 * probe is what decides that, by asking the real `buildRenderGraph` rather than
 * by reading a constant somebody has to remember to change.
 *
 * **When the modulator core lands, the second test below starts failing.** That
 * is the point: it is the tripwire that says the feature can be turned on, and
 * it names what to do in its own message. Nothing in `ui/surprise/` needs
 * editing — the probe flips, the animation lock appears, and this expectation is
 * inverted.
 */

import { describe, expect, it } from "vitest";

import { discoverEffects } from "../../registry/discovery";
import { createEffectRegistry, type EffectRegistry } from "../../registry/registry";
import { probeModulatorSupport } from "./capability";

const registry: EffectRegistry = createEffectRegistry(discoverEffects());

describe("probeModulatorSupport", () => {
  it("answers without throwing, against the real catalogue and the real graph builder", () => {
    const support = probeModulatorSupport(registry);
    expect(typeof support.renderable).toBe("boolean");
    // A verdict of "no" always carries the renderer's own words for why, so the
    // panel shows the reason rather than a paraphrase that can drift from it.
    if (!support.renderable) expect(support.reason.length).toBeGreaterThan(0);
    else expect(support.reason).toBe("");
  });

  it("reports that this build does not render bindings, and says so in the renderer's words", () => {
    const support = probeModulatorSupport(registry);
    // If this fails, the modulator core has landed. That is good news and the
    // change is small: invert this expectation, and F-SM-09 turns itself on
    // through the probe with no other edit.
    expect(
      support.renderable,
      "buildRenderGraph now accepts bindings — invert this expectation and Surprise Me will start animating",
    ).toBe(false);
    expect(support.reason).toContain("modulator");
  });

  it("is a probe of the graph builder, not of a constant", () => {
    // Two calls with the same catalogue give the same answer, and the answer
    // came from `buildRenderGraph` — which is what the message proves: nothing
    // in this directory writes that sentence.
    const first = probeModulatorSupport(registry);
    const second = probeModulatorSupport(registry);
    expect(first).toEqual(second);
    expect(first.reason).toContain("refused rather than rendered");
  });

  it("throws rather than reporting 'no modulators' when nothing at all compiles", () => {
    const empty = createEffectRegistry([]);
    expect(() => probeModulatorSupport(empty)).toThrow(/catalogue is empty/);
  });
});
