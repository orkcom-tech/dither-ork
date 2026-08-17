/**
 * Building a `.dork` document, and the two values every new one starts from.
 *
 * Nothing in here reads a clock or an RNG. A node's id is derived from the ids
 * already in the document and its seed is derived from its id, so the same
 * sequence of edits produces the same document on every machine — which is what
 * makes the determinism claim in docs/ARCHITECTURE.md true of documents the
 * application built as well as of documents Surprise Me generated.
 */

import type {
  Clock,
  DitherDocument,
  Palette,
  StackNode,
} from "../types/document";
import { DOCUMENT_SCHEMA_VERSION } from "../types/document";

/**
 * The palette a document opens with.
 *
 * Two entries, black and white, because a 1-bit dither is what every effect in
 * the catalogue does something visible to and because the two values are not a
 * claim about anything — unlike a hardware palette, which is a factual
 * specification and belongs in `dither-core` beside the other fifteen
 * (docs/API.md, `builtinPalettes`). The palette panel replaces this the moment
 * a real one is chosen or extracted.
 */
export const DEFAULT_PALETTE: Palette = {
  id: "black-white",
  name: "Black & White",
  colors: [0, 0, 0, 255, 255, 255],
  metric: "oklab",
};

/**
 * The clock a document opens with: two seconds at 24.
 *
 * A still document still needs one, because normalized time is `frame /
 * frames` and every shader that animates reads it — a document with no clock
 * would have to invent a divisor somewhere further down.
 */
export const DEFAULT_CLOCK: Clock = { frames: 48, fps: 24 };

/** An empty document: no source, no nodes, no wiring, the two defaults above. */
export function createDocument(): DitherDocument {
  return {
    schema: DOCUMENT_SCHEMA_VERSION,
    source: null,
    stack: [],
    edges: [],
    // No nodes, so nothing to point at. Every other value would be a node id
    // that is not in the document, which `decodeDocument` refuses.
    output: null,
    palette: DEFAULT_PALETTE,
    clock: DEFAULT_CLOCK,
    bindings: [],
  };
}

const NODE_ID_PATTERN = /^n(\d+)$/;

/**
 * The next free node id.
 *
 * Derived from the document rather than from a counter held beside it, because
 * undo restores an older document and a counter would then hand out an id that
 * document already contains — two nodes with one id, which the graph rejects
 * with `duplicate-node-id` at the far end of the pipeline.
 */
export function nextNodeId(document: DitherDocument): string {
  let highest = 0;
  for (const node of document.stack) {
    const match = NODE_ID_PATTERN.exec(node.id);
    if (match === null) continue;
    const index = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(index) && index > highest) highest = index;
  }
  return `n${highest + 1}`;
}

/**
 * A node's seed, derived from its id.
 *
 * Every node carries a seed and no node reads an unseeded RNG (docs/API.md,
 * section 3) — so this cannot be `Math.random()`, and it cannot be a constant
 * either, or every stochastic node in a stack would draw the same noise field
 * and two of them in a row would be indistinguishable from one.
 *
 * FNV-1a over the id: deterministic, spread out, and reproducible from the
 * document alone. Kept inside 2^31 because `StackNode.seed` is a JS number that
 * is hashed as one, and staying inside the exactly-representable integer range
 * a `u32` uniform will carry avoids a value that means one thing here and
 * another in a shader.
 */
export function seedForNodeId(nodeId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < nodeId.length; i += 1) {
    hash ^= nodeId.charCodeAt(i);
    // The FNV prime, as shifts: a 32-bit multiply in JS goes through a double
    // and loses the high bits.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 1;
}

/** A fresh stack node at its effect's declared defaults. */
export function createStackNode(
  id: string,
  effect: string,
  params: Readonly<Record<string, StackNode["params"][string]>>,
): StackNode {
  return {
    id,
    effect,
    enabled: true,
    // The identity composite (F-ST-03). A node opens showing its own result and
    // nothing else; `setNodeOpacity` and `setNodeBlend` move it from there.
    // Full opacity in normal blend is the one combination the plan skips
    // entirely rather than running as a pass that copies a buffer onto itself.
    opacity: 1,
    blend: "normal",
    params,
    seed: seedForNodeId(id),
  };
}
