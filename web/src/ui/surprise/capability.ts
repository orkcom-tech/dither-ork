/**
 * Does this build render a document that carries modulator bindings?
 *
 * # Why this is a probe and not a constant
 *
 * F-SM-09 wants a random subset of parameters bound to modulators. The
 * generator for that is built and tested (`surprise/animation.ts`). Whether a
 * bound document can actually be *drawn* is a fact about other modules, and a
 * `const MODULATORS = false` here would be a second source of truth about it
 * that rots the moment they change. So this asks them, once, with a document it
 * constructs from the real catalogue.
 *
 * # What the right question turned out to be
 *
 * The obvious question — "does `buildRenderGraph` accept a document with
 * bindings?" — is the wrong one, and answering it is how this probe came to
 * report `false` for a build in which animation works.
 *
 * `state/render/graph.ts` refuses bindings **permanently and by design**. It is
 * the document -> graph compiler and a binding is not a value it can compile;
 * rendering the document with its unbound defaults would silently produce a
 * picture that is not the document. `web/src/animation/plan.ts` says so
 * explicitly and builds on it: `documentAtFrame` resolves every binding to a
 * concrete number and hands over a document carrying **none**, so that refusal
 * stays exactly as strict as it is and the animated path still passes it.
 *
 * So the capability is not "does the graph builder take bindings" — it never
 * will — it is **"does this build have a modulator that turns a binding into a
 * number the graph builder accepts"**. That is the whole path, and it is what is
 * probed here:
 *
 * - a one-node stack with no bindings must compile, or the probe itself is
 *   broken and that is thrown rather than read as "no modulators";
 * - the same stack *with* a binding is put through `planAnimation` and
 *   `documentAtFrame` at two frames, and the results compiled. If that works,
 *   bindings are renderable and the feature turns itself on. If any step throws,
 *   the UI does not offer animation and says why, in that step's own words.
 *
 * Two frames rather than one, because a modulator that resolved but never moved
 * would satisfy a single-frame probe while animating nothing.
 */

import { documentAtFrame, planAnimation, type NumericParam } from "../../animation";
import { logger } from "../../lib/log";
import type { DitherDocument } from "../../types/document";
import { DOCUMENT_SCHEMA_VERSION } from "../../types/document";
import type { EffectRegistry } from "../../registry";
import { defaultParams } from "../../registry";
import { chainOf } from "../../graph/edit";
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
  const stack = [createStackNode("n1", descriptor.id, defaultParams(descriptor))];
  const chain = chainOf(stack);
  return {
    schema: DOCUMENT_SCHEMA_VERSION,
    source: null,
    stack,
    edges: chain.edges,
    output: chain.output,
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
  const animatable = registry.require(node.effect).params.find(
    (param): param is NumericParam =>
      param.animatable &&
      (param.type === "float" || param.type === "int") &&
      // A parameter whose legal range is a single point cannot move whatever
      // the modulator does, so binding to one would make the probe answer a
      // question about the parameter instead of about the build.
      param.legal[1] > param.legal[0],
  );
  if (animatable === undefined) {
    // Every parameter of the first effect is unbindable, so this particular
    // probe cannot ask the question. Reported rather than guessed at.
    const reason = `no bindable parameter on "${node.effect}", so modulator support could not be probed`;
    log.warn("modulator support unknown", { effect: node.effect });
    return { renderable: false, reason };
  }

  // The probe's own numbers, chosen so the swing cannot be flattened by the
  // clamp. `bindingValueAt` clamps to the parameter's legal range, so a binding
  // that swings around the *authored* value — which for many effects sits at one
  // end of its range — can resolve perfectly and still produce one number on
  // every frame. That is a fact about the amount this function picked, not about
  // whether the build has modulators, and reading it as the latter is how this
  // probe previously reported "no modulators" for a build that has them.
  //
  // Centring the base and taking a quarter of the width keeps the whole swing
  // strictly inside the legal range for any parameter in the catalogue.
  const [legalMin, legalMax] = animatable.legal;
  const width = legalMax - legalMin;
  const centre = animatable.type === "int"
    ? Math.round(legalMin + width / 2)
    : legalMin + width / 2;

  const bound: DitherDocument = {
    ...base,
    stack: [{ ...node, params: { ...node.params, [animatable.key]: centre } }],
    bindings: [
      {
        nodeId: node.id,
        param: animatable.key,
        shape: "sine",
        amount: width / 4,
        cyclesPerLoop: 1,
        phase: 0,
        bipolar: true,
      },
    ],
  };

  try {
    // The real animated path, in the order the timeline and the animated export
    // both take it. `planAnimation` throws if the binding cannot be resolved —
    // an unknown shape, a parameter the catalogue will not animate — and
    // `documentAtFrame` is what produces the binding-free document the graph
    // builder takes.
    const plan = planAnimation(bound, registry);
    const first = documentAtFrame(plan, 0);
    const later = documentAtFrame(plan, Math.max(1, Math.floor(plan.clock.frames / 4)));
    buildRenderGraph(first, options);
    buildRenderGraph(later, { ...options, frame: 1 });

    // A modulator that resolves but never moves would pass every step above and
    // animate nothing, so the probe reads the value it produced rather than
    // trusting that it produced one.
    const before = first.stack[0]?.params[animatable.key];
    const after = later.stack[0]?.params[animatable.key];
    if (before === after) {
      const reason =
        `the modulator resolved but "${node.effect}.${animatable.key}" holds ` +
        `${String(before)} on every frame, so a binding would animate nothing`;
      log.warn("surprise: animation is withheld, the modulator does not move", { reason });
      return { renderable: false, reason };
    }
  } catch (error) {
    // Not swallowed: the message is what the panel shows, so the reason a person
    // sees is the failing step's own words rather than a paraphrase that drifts.
    const message = error instanceof Error ? error.message : String(error);
    log.info("surprise: animation is withheld, a bound document cannot be rendered", {
      reason: message,
    });
    return { renderable: false, reason: message };
  }

  log.info("surprise: animation is available, bound documents resolve and compile");
  return { renderable: true, reason: "" };
}
