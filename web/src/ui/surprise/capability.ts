/**
 * Does this build render a document that carries modulator bindings?
 *
 * # Why this is a probe and not a constant
 *
 * F-SM-09 wants a random subset of parameters bound to modulators. The
 * generator for that is built and tested (`surprise/animation.ts`). The
 * *renderer* is not: `state/render/graph.ts` throws on a document with bindings,
 * because resolving one needs a modulator and this build has none — and it says
 * so out loud rather than rendering the document as though the bindings were not
 * there.
 *
 * So a surprise that produced bindings today would produce a document that
 * cannot be drawn. That is the failure this project treats as worse than a
 * missing feature: a control wired to nothing. The precedent is the opacity and
 * blend sliders, which were removed rather than shipped inert and came back when
 * the compositor was real.
 *
 * The obvious way to hold that line is a `const MODULATORS = false` and a
 * comment. That constant is a second source of truth about a fact the renderer
 * already knows, and it rots the day the modulator core lands — the animation
 * agent has no reason to look in `ui/surprise/` for a flag. So instead this
 * **asks the real `buildRenderGraph`**, once, with a document it constructs from
 * the real catalogue:
 *
 * - a one-node stack with no bindings must compile, or the probe itself is
 *   broken and that is thrown rather than read as "no modulators";
 * - the same stack *with* a binding either compiles, in which case bindings are
 *   renderable and the feature turns itself on, or it does not, in which case
 *   the UI does not offer animation and says why.
 *
 * When the modulator core lands, nothing here is edited. The refusal in
 * `graph.ts` goes, this returns true, and the animation lock appears.
 */

import { logger } from "../../lib/log";
import type { DitherDocument } from "../../types/document";
import { DOCUMENT_SCHEMA_VERSION } from "../../types/document";
import type { EffectRegistry } from "../../registry";
import { defaultParams } from "../../registry";
import { DEFAULT_CLOCK, DEFAULT_PALETTE, createStackNode } from "../../state/document";
// The pure leaf of `state/render/`, which the barrel deliberately does not
// re-export: it is document -> graph and nothing else, with no device, no
// registry and no worker behind it. `state/render/graph.test.ts` imports it the
// same way, for the same reason.
import { buildRenderGraph } from "../../state/render/graph";

const log = logger("app");

export interface ModulatorSupport {
  /** True when `buildRenderGraph` accepts a document carrying a binding. */
  readonly renderable: boolean;
  /** One sentence, ready to show. Empty when {@link renderable} is true. */
  readonly reason: string;
}

/** The probe document: one real effect from the catalogue, at its defaults. */
function probeDocument(registry: EffectRegistry): DitherDocument {
  const descriptor = registry.all()[0];
  if (descriptor === undefined) {
    throw new Error("the effect catalogue is empty; nothing can be probed against it");
  }
  return {
    schema: DOCUMENT_SCHEMA_VERSION,
    source: null,
    stack: [createStackNode("n1", descriptor.id, defaultParams(descriptor))],
    palette: DEFAULT_PALETTE,
    clock: DEFAULT_CLOCK,
    bindings: [],
  };
}

/**
 * Ask the renderer whether it takes bindings.
 *
 * @throws when a binding-free document does not compile. That is not "no
 * modulators" — it is the graph builder refusing something trivially valid, and
 * reading it as a missing feature would hide a real failure behind a disabled
 * checkbox.
 */
export function probeModulatorSupport(registry: EffectRegistry): ModulatorSupport {
  // Announced before it runs, and this line earns its place. A refusal from
  // `buildRenderGraph` is logged at error level by `DocumentError`'s
  // constructor, so a probe that expects one puts a red line in the console with
  // no user action behind it — which reads as a boot failure. Sandwiched between
  // this line and the verdict below, the same three lines read as what they are:
  // a question, the renderer's answer, and what was decided.
  log.info("surprise: probing whether this build renders modulator bindings");

  const base = probeDocument(registry);
  const options = { width: 4, height: 4, quality: "full", frame: 0 } as const;

  // The control: without this, a graph builder that refused *everything* would
  // read as "modulators are not implemented".
  buildRenderGraph(base, options);

  const node = base.stack[0];
  if (node === undefined) throw new Error("the probe document lost its node");
  const animatable = registry
    .require(node.effect)
    .params.find((param) => param.animatable && (param.type === "float" || param.type === "int"));
  if (animatable === undefined) {
    // Every parameter of the first effect is unbindable, so this particular
    // probe cannot ask the question. Reported rather than guessed at.
    const reason = `no bindable parameter on "${node.effect}", so modulator support could not be probed`;
    log.warn("modulator support unknown", { effect: node.effect });
    return { renderable: false, reason };
  }

  const bound: DitherDocument = {
    ...base,
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

  try {
    buildRenderGraph(bound, options);
  } catch (error) {
    // Not swallowed: the message is what the panel shows, so the reason a person
    // sees is the renderer's own words rather than a paraphrase that can drift.
    const message = error instanceof Error ? error.message : String(error);
    log.info("surprise: animation is withheld, the renderer refuses bindings", {
      reason: message,
    });
    return { renderable: false, reason: message };
  }

  log.info("surprise: animation is available, the renderer accepts bindings");
  return { renderable: true, reason: "" };
}
