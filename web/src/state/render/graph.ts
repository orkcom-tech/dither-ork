/**
 * A document compiled to a render graph.
 *
 * The stack is a list and the graph is a DAG, so this is where the edges are
 * invented: node *i* reads node *i-1*, and node 0 reads nothing, which
 * `prepareGraph` reads as "this node is a root and takes the decoded source".
 * Writing the edges out rather than leaving the graph to assume a chain is what
 * lets node groups (F-ST-05) and masking (F-PP-08) arrive later as more edges
 * instead of as a second engine.
 *
 * Pure — no device, no registry, no clock. It is the whole of the document ->
 * graph half of the render path and it is tested without any of them.
 *
 * ## Solo (F-ST-02)
 *
 * Solo is not a flag on a node; it is the graph's `output` pointing at an
 * earlier node. Everything after it is then simply not reachable from the
 * output, and `planRender`'s backwards walk never visits it — so soloing costs
 * nothing and un-soloing is free, because the nodes below still hold their
 * cache entries.
 *
 * ## What is refused
 *
 * A document carrying **modulator bindings** is refused rather than rendered
 * without them. Bindings resolve to concrete parameter values per frame, and
 * the modulator shapes (F-CL/F-MO) are not implemented in this build; rendering
 * the document with its unbound defaults would produce a picture that is not
 * the document, and would do it silently.
 */

import type { DitherDocument } from "../../types/document";
import type { GraphNode, NodeInput, RenderGraph, RenderQuality } from "../../types/graph";
import { DocumentError } from "../errors";

export interface BuildGraphOptions {
  /** Working resolution. The source's own size for a full-quality render. */
  readonly width: number;
  readonly height: number;
  readonly quality: RenderQuality;
  readonly frame: number;
  /**
   * Render up to and including this node (F-ST-02). Absent renders the whole
   * stack.
   */
  readonly solo?: string | null;
}

/**
 * Compile a document.
 *
 * `null` when there is nothing to render — an empty stack, or a stack whose
 * every node is disabled ahead of the solo point. The caller shows the source
 * itself in that case, which is what an image with no effects on it looks like;
 * a graph with no nodes would have no output to point at.
 */
export function buildRenderGraph(
  document: DitherDocument,
  options: BuildGraphOptions,
): RenderGraph | null {
  if (document.bindings.length > 0) {
    throw new DocumentError(
      "invalid-value",
      `this document has ${document.bindings.length} modulator binding(s), and no modulator ` +
        `is implemented in this build. It is refused rather than rendered as though the ` +
        `bindings were not there.`,
      { bindings: document.bindings.length },
    );
  }

  const solo = options.solo ?? null;
  if (solo !== null && !document.stack.some((node) => node.id === solo)) {
    throw new DocumentError("unknown-node", `cannot solo "${solo}"; it is not in the stack`, {
      nodeId: solo,
    });
  }

  const stack =
    solo === null
      ? document.stack
      : document.stack.slice(0, document.stack.findIndex((node) => node.id === solo) + 1);

  if (stack.length === 0) return null;

  const nodes: GraphNode[] = [];
  let previous: string | null = null;
  for (const node of stack) {
    const inputs: readonly NodeInput[] =
      previous === null ? [] : [{ port: "in", from: { nodeId: previous, port: "out" } }];
    nodes.push({
      id: node.id,
      effect: node.effect,
      enabled: node.enabled,
      opacity: node.opacity,
      blend: node.blend,
      params: node.params,
      seed: node.seed,
      inputs,
    });
    // Every node is wired, including a disabled one: `prepareGraph` resolves a
    // disabled node's edge past it, so the chain stays intact and toggling a
    // node in the middle does not rebuild the graph.
    previous = node.id;
  }

  const last = nodes[nodes.length - 1];
  if (last === undefined) return null;

  return {
    nodes,
    output: { nodeId: last.id, port: "out" },
    width: options.width,
    height: options.height,
    quality: options.quality,
    frame: options.frame,
  };
}
