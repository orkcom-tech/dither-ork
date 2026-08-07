/**
 * The modulator probe.
 *
 * This is the test that keeps `ui/surprise` honest about F-SM-09. It asks the
 * real catalogue, the real `planAnimation` and the real `buildRenderGraph`
 * rather than reading a constant somebody has to remember to change.
 *
 * ## This file was a tripwire and the wire has been tripped
 *
 * It used to assert `renderable === false`, and said in its own message that the
 * day the modulator core landed the expectation should be inverted and F-SM-09
 * would turn itself on. The core has landed — `web/src/animation/` — so the
 * expectations below are the inverted ones.
 *
 * The subtlety that came with it, and the reason the probe itself changed: the
 * old probe asked whether `buildRenderGraph` accepts a document carrying
 * bindings. It does not, it never will, and that is deliberate — `animation/
 * plan.ts` resolves bindings to concrete numbers and hands over a document with
 * none, precisely so that refusal can stay as strict as it is. Asking the graph
 * builder directly therefore reported "no modulators" for a build in which
 * animation works. The capability is the whole path, and that is what is
 * asserted here.
 */

import { describe, expect, it } from "vitest";

import { discoverEffects } from "../../registry/discovery";
import { createEffectRegistry, type EffectRegistry } from "../../registry/registry";
import { buildRenderGraph } from "../../state/render/graph";
import { DEFAULT_CLOCK, DEFAULT_PALETTE, createStackNode } from "../../state/document";
import { DOCUMENT_SCHEMA_VERSION, type DitherDocument } from "../../types/document";
import { defaultParams } from "../../registry";
import { probeModulatorSupport } from "./capability";

const registry: EffectRegistry = createEffectRegistry(discoverEffects());

describe("probeModulatorSupport", () => {
  it("answers without throwing, against the real catalogue and the real animated path", () => {
    const support = probeModulatorSupport(registry);
    expect(typeof support.renderable).toBe("boolean");
    // A verdict of "no" always carries the failing step's own words for why, so
    // the panel shows the reason rather than a paraphrase that can drift.
    if (!support.renderable) expect(support.reason.length).toBeGreaterThan(0);
    else expect(support.reason).toBe("");
  });

  it("reports that this build renders bindings, because the modulator core is here", () => {
    const support = probeModulatorSupport(registry);
    expect(
      support.renderable,
      "a bound document no longer resolves and compiles — Surprise Me has stopped animating, " +
        "and the reason is in support.reason",
    ).toBe(true);
    expect(support.reason).toBe("");
  });

  it("is a probe of the real modules, not of a constant", () => {
    const first = probeModulatorSupport(registry);
    const second = probeModulatorSupport(registry);
    expect(first).toEqual(second);
  });

  it("does not claim the graph builder itself takes bindings", () => {
    // The distinction the probe exists to make. If this ever stops throwing,
    // `state/render/graph.ts` has quietly started rendering documents with
    // unresolved bindings — which is the silent-wrong-picture failure the whole
    // arrangement is built to prevent.
    const descriptor = registry.all()[0];
    if (descriptor === undefined) throw new Error("the catalogue is empty");
    const node = createStackNode("n1", descriptor.id, defaultParams(descriptor));
    const animatable = descriptor.params.find(
      (param) => param.animatable && (param.type === "float" || param.type === "int"),
    );
    if (animatable === undefined) throw new Error("no bindable parameter to build the case with");

    const bound: DitherDocument = {
      schema: DOCUMENT_SCHEMA_VERSION,
      source: null,
      stack: [node],
      palette: DEFAULT_PALETTE,
      clock: DEFAULT_CLOCK,
      bindings: [
        {
          nodeId: node.id,
          param: animatable.key,
          shape: "sine",
          amount: 0.25,
          cyclesPerLoop: 1,
          phase: 0,
          bipolar: true,
        },
      ],
    };

    expect(() =>
      buildRenderGraph(bound, { width: 4, height: 4, quality: "full", frame: 0 }),
    ).toThrow(/binding/);
  });

  it("throws rather than reporting 'no modulators' when nothing at all compiles", () => {
    const empty = createEffectRegistry([]);
    expect(() => probeModulatorSupport(empty)).toThrow(/catalogue is empty/);
  });
});
