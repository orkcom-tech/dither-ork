/**
 * The stack grammar, checked before anything is rendered.
 *
 * The registry validates one effect at a time; this validates a *combination* of
 * them, which is the other half of what the descriptors already declare. Two
 * rules live here, both read straight off `EffectDescriptor` and neither
 * expressible in the type system:
 *
 * - **the index map** — `requiresIndexMap` names the nodes that read one
 *   (outline F-SP-10, dilate/erode F-SP-11, and, when they arrive, hue-targeted
 *   recolour F-CO-09, index remap F-CO-10 and the SVG tracer F-EX-08), and
 *   `producesIndexMap` names the quantizers that emit one;
 * - **extents** — `resamples` names the nodes that write a different extent than
 *   they read (internal resolution F-PP-01 down, nearest upscale F-SP-14 up),
 *   and one of those may not run while an index map is live unless it carries
 *   the map with it. See "Extents" below;
 * - **exclusions** — `excludes` names effects that must not share a stack
 *   (F-SM-03: "mutually incompatible combinations are excluded by the grammar
 *   rather than filtered after the fact").
 *
 * ## Why this exists rather than a render-time error
 *
 * Every dither-slot node in the catalogue emits an index map except one. CMYK
 * halftone (F-PT-02) does not, because its output colours are ink overprints
 * rather than palette entries, so there is no index to record. Put it under an
 * outline and the stack is not renderable: the pass compiler refuses an
 * `input-index` binding with nothing to bind, and what the user sees is a
 * `ScheduleError` after they have built the thing. The information needed to
 * know that was in the descriptors the whole time. Surprise Me must not
 * *generate* that stack, and the stack editor must not let it be *built*, so
 * both call this and neither carries a copy of the rule.
 *
 * ## Extents, and why resampling an index map is not merely unimplemented
 *
 * A quantizing node leaves the pipeline carrying two things that describe the
 * same pixel grid: RGBA colour, and one palette index per pixel. A node that
 * resamples rewrites the colour onto a *different* grid. What should happen to
 * the indices?
 *
 * Nothing defensible, is the answer, and that is a fact about palette indices
 * rather than a gap in the code. An index is a **name**, not a quantity: the
 * average of index 3 and index 7 is index 5, which is some unrelated colour,
 * and no filter — box, Lanczos, bilinear — means anything applied to names.
 * **Nearest is the only rule that is even coherent**, because it copies a name
 * instead of averaging two, and even nearest only lines up with the colour when
 * the colour is resampled by nearest at the same integer factor. That is
 * exactly one node in the catalogue: nearest upscale (F-SP-14), which
 * replicates each texel into the block it now covers and carries colour and
 * index across together, and which therefore declares `producesIndexMap`.
 *
 * So the rule is not "no resampling after a quantizer". It is: **a node that
 * resamples while an index map is live must produce the map it leaves behind.**
 * Internal resolution (F-PP-01) offers box and Lanczos filters — genuine
 * interpolations — and writes no index map, so after a dither it would leave
 * indices at the old extent naming a different pixel grid than the colours
 * beside them. Losslessly wrong, and invisible until an outline or the SVG
 * tracer read them.
 *
 * `web/src/gpu/scheduler.ts` already refuses that combination, and refuses it
 * correctly — but at render time, as an error banner, after the user has built
 * the thing. The information was in the descriptors the whole time. It is the
 * same shape as the index-map rule above and it belongs in the same place.
 *
 * ## Disabled nodes
 *
 * A disabled node is not in the render (F-ST-02), so it neither produces an
 * index map nor needs one, and it is skipped by every rule here. That is the
 * only reading that matches what will actually execute: counting a disabled
 * quantizer as a producer would accept a stack that fails the moment it runs,
 * and counting a disabled consumer as a consumer would refuse one that renders
 * perfectly well.
 */

import { logger } from "../lib/log";
import type { EffectDescriptor } from "../types/registry";
import type { EffectRegistry } from "./registry";

const log = logger("app");

/**
 * The part of a stack node this cares about.
 *
 * Structural rather than the document's `StackNode` so the stack editor can
 * check a reorder it has not committed and Surprise Me can check a candidate it
 * has not finished building. A `StackNode` satisfies it as it stands.
 */
export interface StackNodeRef {
  readonly id: string;
  readonly effect: string;
  readonly enabled: boolean;
}

export type StackIssueCode =
  /** A node names an effect this build does not have. */
  | "unknown-effect"
  /** A node reads the index map with no live quantizer in front of it. */
  | "index-map-missing"
  /**
   * A node resamples colour while an index map is live, and writes no index map
   * of its own — so the two halves of the buffer would name different pixel
   * grids. See "Extents" above.
   */
  | "index-map-resampled"
  /** Two nodes the grammar declares incompatible. */
  | "excluded-combination";

export interface StackIssue {
  readonly code: StackIssueCode;
  readonly nodeId: string;
  readonly effect: string;
  /** The other node the rule is about, when the rule is about two of them. */
  readonly otherNodeId?: string;
  readonly otherEffect?: string;
  /** Names both nodes; written to be shown to a user as it stands. */
  readonly message: string;
}

export interface StackValidation {
  readonly ok: boolean;
  readonly issues: readonly StackIssue[];
}

/**
 * Check a stack against the grammar its descriptors declare.
 *
 * Reports rather than repairs, like `validateParams`: the stack editor turns
 * the issues into a refusal to drop the node, and Surprise Me discards the
 * candidate and draws again. Neither wants a stack silently rewritten under it.
 */
export function validateStack(
  registry: EffectRegistry,
  stack: readonly StackNodeRef[],
): StackValidation {
  const issues: StackIssue[] = [];

  // Resolve first. A node naming an effect this build does not have makes every
  // later verdict a guess — nothing is known about what it produces or reads —
  // so the unknown ids are reported alone rather than alongside consequences
  // invented from their absence.
  const descriptors = new Map<string, EffectDescriptor>();
  for (const node of stack) {
    const descriptor = registry.get(node.effect);
    if (descriptor === undefined) {
      issues.push({
        code: "unknown-effect",
        nodeId: node.id,
        effect: node.effect,
        message: `node ${node.id} names effect "${node.effect}", which this build does not have`,
      });
      continue;
    }
    descriptors.set(node.id, descriptor);
  }
  if (issues.length > 0) {
    log.warn("stack references unknown effects", {
      nodes: stack.length,
      unknown: issues.length,
    });
    return { ok: false, issues };
  }

  const live = stack.filter((node) => node.enabled);

  // --- the index map ----------------------------------------------------
  //
  // Walked in stack order, carrying the node that last emitted a map. A
  // dither-slot node *replaces* it: quantizing is what the slot is for, so
  // whatever indices arrived at it no longer describe the pixels leaving it.
  // That is what makes CMYK halftone clear the map rather than pass one
  // through, and it is the whole rule this module was written for.
  let producer: StackNodeRef | null = null;
  let cleared: StackNodeRef | null = null;

  for (const node of live) {
    const descriptor = descriptors.get(node.id);
    if (descriptor === undefined) continue;

    if (descriptor.requiresIndexMap && producer === null) {
      const blame = cleared;
      const blameDescriptor = blame === null ? undefined : descriptors.get(blame.id);
      issues.push({
        code: "index-map-missing",
        nodeId: node.id,
        effect: node.effect,
        ...(blame === null ? {} : { otherNodeId: blame.id, otherEffect: blame.effect }),
        message:
          blame === null || blameDescriptor === undefined
            ? `${descriptor.name} (node ${node.id}) reads the index map, and nothing in front of it quantizes — add a dither that emits one`
            : `${descriptor.name} (node ${node.id}) reads the index map, but the dither in front of it is ${blameDescriptor.name} (node ${blame.id}), which emits none`,
      });
    }

    // Extents. Checked before the producer is updated, because what matters is
    // the map that is live *as this node runs* — a resampler that writes its own
    // map (nearest upscale) is legal precisely because it replaces the one it
    // was handed rather than leaving it behind.
    if (descriptor.resamples === true && producer !== null && !descriptor.producesIndexMap) {
      const producerDescriptor = descriptors.get(producer.id);
      issues.push({
        code: "index-map-resampled",
        nodeId: node.id,
        effect: node.effect,
        otherNodeId: producer.id,
        otherEffect: producer.effect,
        message:
          producerDescriptor === undefined
            ? `${descriptor.name} (node ${node.id}) resamples the image while the index map from node ${producer.id} is still live, and writes no index map of its own`
            : `${descriptor.name} (node ${node.id}) resamples the image while the index map from ${producerDescriptor.name} (node ${producer.id}) is still live, and writes no index map of its own — palette indices cannot be interpolated, so the colours and the indices would end up naming different pixel grids. Move it in front of ${producerDescriptor.name}, or use Nearest upscale, which carries the map across.`,
      });
    }

    if (descriptor.slot === "dither") {
      producer = descriptor.producesIndexMap ? node : null;
      cleared = descriptor.producesIndexMap ? null : node;
    } else if (descriptor.producesIndexMap) {
      producer = node;
    }
  }

  // --- exclusions -------------------------------------------------------
  //
  // Reported once per pair, from the later node, so a stack with the same
  // conflict in it twice does not read as four problems.
  for (let i = 0; i < live.length; i += 1) {
    const later = live[i];
    if (later === undefined) continue;
    const laterDescriptor = descriptors.get(later.id);
    if (laterDescriptor === undefined) continue;

    for (let j = 0; j < i; j += 1) {
      const earlier = live[j];
      if (earlier === undefined) continue;
      const earlierDescriptor = descriptors.get(earlier.id);
      if (earlierDescriptor === undefined) continue;

      const excluded =
        (laterDescriptor.excludes ?? []).includes(earlier.effect) ||
        (earlierDescriptor.excludes ?? []).includes(later.effect);
      if (!excluded) continue;

      issues.push({
        code: "excluded-combination",
        nodeId: later.id,
        effect: later.effect,
        otherNodeId: earlier.id,
        otherEffect: earlier.effect,
        message: `${laterDescriptor.name} (node ${later.id}) and ${earlierDescriptor.name} (node ${earlier.id}) exclude one another; the grammar does not allow them in one stack`,
      });
    }
  }

  if (issues.length > 0) {
    log.warn("stack rejected by the grammar", {
      nodes: stack.length,
      live: live.length,
      issues: issues.length,
    });
  } else {
    log.debug("stack accepted", { nodes: stack.length, live: live.length });
  }

  return { ok: issues.length === 0, issues };
}
