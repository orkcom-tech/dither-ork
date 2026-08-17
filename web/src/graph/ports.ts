/**
 * A node's ports: what it may be wired to, and in what order.
 *
 * One module answers this for everybody — the topology walk, the hash, the
 * validator, the migration and the editor — because the answer is not simply
 * `descriptor.inputs`. Three things are folded in, and each was a bug waiting
 * to be written three times:
 *
 * - **Absent means one image input.** 71 of the 74 effects declare nothing, and
 *   a reader that checks the field sees `undefined` and concludes they take no
 *   picture at all.
 * - **Every node gets a `mask` port.** Masking is spatially-varying opacity and
 *   opacity is a property of every node (F-ST-03, F-PP-08), so the port is
 *   appended here rather than declared 74 times — which is also what stops one
 *   effect quietly becoming unmaskable by forgetting it.
 * - **A resampling node gets no `mask` port.** A mask is applied by the
 *   composite, and `graph/plan.ts` already refuses a composite on a node that
 *   writes a different extent than it reads: there is no pixel-for-pixel
 *   correspondence for the coverage to be *of*. Refusing the port is the same
 *   rule stated where the editor can see it, so the connection cannot be drawn
 *   rather than failing when the plan is built.
 *
 * ## Order, and why it is load-bearing
 *
 * `ContentHashInput.inputs` is "the hashes of this node's inputs, in port
 * order". Port order is therefore part of what a document's picture depends on,
 * and it has to be a property of the *code* rather than of however a document
 * happened to list its edges — otherwise two documents that are the same graph
 * hash differently and neither can reuse the other's cache. The order is:
 * declared ports in declaration order, then `mask`. It is stated once, here.
 */

import type { EffectDescriptor, InputPortDescriptor, InputRole } from "../types/registry";
import {
  MASK_INPUT_PORT,
  PRIMARY_INPUT_PORT,
  inputPortsOf,
} from "../types/registry";

/**
 * The universal mask port.
 *
 * Not declared by any effect — `types/registry.ts` refuses one that tries — so
 * that "every node is maskable" is a fact about the graph rather than a
 * convention 74 descriptors are each trusted to follow.
 */
export const MASK_PORT: InputPortDescriptor = {
  key: MASK_INPUT_PORT,
  label: "Mask",
  role: "mask",
  description:
    "A picture read as coverage: where it is bright this node shows through, where it is dark the input passes untouched. Spatially-varying opacity, not a second layer.",
  required: false,
};

/**
 * Every port this node may be wired to, in evaluation order.
 *
 * Pure and cheap; callers in a loop cache it themselves rather than this
 * memoizing, because a memo keyed on a descriptor object is a leak in a module
 * that outlives every registry it is handed.
 */
export function portsOf(descriptor: EffectDescriptor): readonly InputPortDescriptor[] {
  const declared = inputPortsOf(descriptor);
  // See the header: a mask is a composite, and a resampling node has no common
  // pixel grid with its own input to composite against.
  if (descriptor.resamples === true) return declared;
  return [...declared, MASK_PORT];
}

/** The port keys, in evaluation order. What the hash means by "port order". */
export function portOrder(descriptor: EffectDescriptor): readonly string[] {
  return portsOf(descriptor).map((port) => port.key);
}

/** One port by key, or `undefined` when this node has no such port. */
export function portOf(
  descriptor: EffectDescriptor,
  key: string,
): InputPortDescriptor | undefined {
  return portsOf(descriptor).find((port) => port.key === key);
}

/**
 * Whether an edge into this port is a **feedback edge**: it reads the
 * producer's previous frame.
 *
 * The single predicate the cycle rule turns on. Everything else about feedback
 * — the cache exclusion, the non-looping document, the frames-in-order
 * requirement — is downstream of the effect declaring `readsFeedback`; this is
 * downstream of the *port*, so a reader looking at one edge can tell whether it
 * closes a loop legally without resolving the node's descriptor twice.
 */
export function isFeedbackRole(role: InputRole): boolean {
  return role === "feedback";
}

/**
 * The feedback edges a node has by construction, if any.
 *
 * **Derived, never saved.** A node whose effect declares a `feedback` port
 * reads its own previous output, and where that output comes from is a fact
 * about the effect rather than a choice the document makes — the frame store in
 * `gpu/feedback.ts` is keyed by node id and records that node's own composited
 * result. Saving the edge would put the same fact in two places and let a
 * document disagree with its catalogue about whether a node loops.
 *
 * That is also the limit, stated plainly: **a feedback edge's producer is
 * always the consumer itself.** A general delay edge — node B reading node A's
 * previous frame — is not expressible, because nothing records A's history. The
 * validator refuses one rather than accepting an edge the renderer would have
 * to invent pixels for.
 */
export function derivedFeedbackPorts(
  descriptor: EffectDescriptor,
): readonly InputPortDescriptor[] {
  return inputPortsOf(descriptor).filter((port) => isFeedbackRole(port.role));
}

/** True when this node's picture arrives on an edge rather than from the source. */
export function isPrimaryPort(key: string): boolean {
  return key === PRIMARY_INPUT_PORT;
}
