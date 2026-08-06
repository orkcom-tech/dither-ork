/**
 * Every way a document changes, as pure functions.
 *
 * One rule holds the file together: **a mutation takes a document and returns a
 * new one, and never touches the one it was given.** That is what makes undo a
 * stack of snapshots rather than a stack of inverse operations (see
 * `history.ts`), and it is what lets every one of these be tested with three
 * lines and no store, no registry loading, no renderer and no browser.
 *
 * The second rule is that **an invalid document is never produced**. A node id
 * that is not in the stack, an effect the registry does not have, a parameter
 * key the effect does not declare, an insertion index outside the stack — each
 * throws {@link DocumentError} naming what was asked for. The alternative is a
 * mutation that quietly does nothing, and a UI built on that is one where a
 * click sometimes has no effect and nobody can say why.
 *
 * Parameter values go through the registry's own `coerceParams`, so a value
 * outside its legal range is clamped to the descriptor's bound and the
 * adjustment is logged. That is the same path a loaded document takes, which is
 * the point: there is no second opinion about what a legal parameter is.
 *
 * ## What is deliberately absent
 *
 * **Per-node opacity and blend (F-ST-03).** They are in the schema, they round
 * trip, and nothing here changes them — neither backend implements compositing,
 * and a control that moves nothing is worse than a missing one. See
 * `render/gpu-backend.ts`, which refuses a node carrying a non-identity
 * composite rather than ignoring it.
 */

import type {
  Binding,
  Clock,
  DitherDocument,
  Palette,
  ParameterValue,
  SourceRef,
  StackNode,
} from "../types/document";
import type { EffectRegistry } from "../registry";
import { coerceParams, defaultParams } from "../registry";
import { SEED_RANGE } from "../types/registry";
import { logger } from "../lib/log";
import { createStackNode, nextNodeId } from "./document";
import { DocumentError } from "./errors";

const log = logger("app");

function indexOfNode(document: DitherDocument, nodeId: string): number {
  const index = document.stack.findIndex((node) => node.id === nodeId);
  if (index < 0) {
    throw new DocumentError(
      "unknown-node",
      `no node "${nodeId}" in the stack`,
      { nodeId, stack: document.stack.length },
    );
  }
  return index;
}

/** The node, for a caller that has already decided it must exist. */
export function requireNode(document: DitherDocument, nodeId: string): StackNode {
  const node = document.stack[indexOfNode(document, nodeId)];
  if (node === undefined) throw new DocumentError("unknown-node", `no node "${nodeId}"`);
  return node;
}

function withStack(
  document: DitherDocument,
  stack: readonly StackNode[],
): DitherDocument {
  return { ...document, stack };
}

/**
 * Add an effect to the stack (F-ST-01).
 *
 * `index` is where it lands; the end is the default because that is where a
 * new node is expected when nothing is selected. Parameters open at the
 * descriptor's declared defaults, which is what the properties panel then
 * shows.
 */
export function addNode(
  document: DitherDocument,
  registry: EffectRegistry,
  effectId: string,
  index?: number,
): { readonly document: DitherDocument; readonly nodeId: string } {
  const descriptor = registry.get(effectId);
  if (descriptor === undefined) {
    throw new DocumentError(
      "unknown-effect",
      `no effect "${effectId}" in this build's catalogue`,
      { effectId },
    );
  }

  const at = clampInsertIndex(document, index);
  const nodeId = nextNodeId(document);
  const node = createStackNode(nodeId, effectId, defaultParams(descriptor));

  const stack = [...document.stack];
  stack.splice(at, 0, node);
  log.info("node added", { nodeId, effect: effectId, at, stack: stack.length });
  return { document: withStack(document, stack), nodeId };
}

function clampInsertIndex(document: DitherDocument, index?: number): number {
  if (index === undefined) return document.stack.length;
  if (!Number.isInteger(index) || index < 0 || index > document.stack.length) {
    throw new DocumentError(
      "bad-index",
      `cannot insert at ${index}; the stack has ${document.stack.length} node(s)`,
      { index, stack: document.stack.length },
    );
  }
  return index;
}

/**
 * Remove a node, and every binding that referenced it.
 *
 * Leaving the bindings behind would leave modulators pointed at a node that no
 * longer exists — invisible until the animation path resolves them, and then
 * reported against a node id nobody can find.
 */
export function removeNode(document: DitherDocument, nodeId: string): DitherDocument {
  const at = indexOfNode(document, nodeId);
  const stack = [...document.stack];
  stack.splice(at, 1);
  const bindings = document.bindings.filter((binding) => binding.nodeId !== nodeId);
  log.info("node removed", {
    nodeId,
    at,
    stack: stack.length,
    bindingsDropped: document.bindings.length - bindings.length,
  });
  return { ...document, stack, bindings };
}

/**
 * Duplicate a node directly after itself (F-ST-01, F-ST-07).
 *
 * The copy keeps the original's **seed**, so it renders identically where it
 * stands rather than being the same effect with a different accident in it.
 * Its bindings are copied too — a duplicate of an animated node that does not
 * animate is not a duplicate.
 */
export function duplicateNode(
  document: DitherDocument,
  nodeId: string,
): { readonly document: DitherDocument; readonly nodeId: string } {
  const at = indexOfNode(document, nodeId);
  const original = document.stack[at];
  if (original === undefined) throw new DocumentError("unknown-node", `no node "${nodeId}"`);

  const copyId = nextNodeId(document);
  const copy: StackNode = { ...original, id: copyId };
  const stack = [...document.stack];
  stack.splice(at + 1, 0, copy);

  const copiedBindings = document.bindings
    .filter((binding) => binding.nodeId === nodeId)
    .map((binding) => ({ ...binding, nodeId: copyId }));

  log.info("node duplicated", {
    from: nodeId,
    nodeId: copyId,
    at: at + 1,
    bindings: copiedBindings.length,
  });
  return {
    document: {
      ...document,
      stack,
      bindings: [...document.bindings, ...copiedBindings],
    },
    nodeId: copyId,
  };
}

/**
 * Move a node to a new position (F-ST-01).
 *
 * `to` is the index the node ends up at in the resulting stack, which is what a
 * drop target reports and what makes moving a node down by one an increment
 * rather than a special case.
 */
export function moveNode(
  document: DitherDocument,
  nodeId: string,
  to: number,
): DitherDocument {
  const from = indexOfNode(document, nodeId);
  if (!Number.isInteger(to) || to < 0 || to >= document.stack.length) {
    throw new DocumentError(
      "bad-index",
      `cannot move "${nodeId}" to ${to}; the stack has ${document.stack.length} node(s)`,
      { nodeId, to, stack: document.stack.length },
    );
  }
  if (from === to) return document;

  const stack = [...document.stack];
  const [moved] = stack.splice(from, 1);
  if (moved === undefined) throw new DocumentError("unknown-node", `no node "${nodeId}"`);
  stack.splice(to, 0, moved);
  log.info("node moved", { nodeId, from, to });
  return withStack(document, stack);
}

/** Per-node enable toggle (F-ST-02). */
export function setNodeEnabled(
  document: DitherDocument,
  nodeId: string,
  enabled: boolean,
): DitherDocument {
  const at = indexOfNode(document, nodeId);
  const node = document.stack[at];
  if (node === undefined) throw new DocumentError("unknown-node", `no node "${nodeId}"`);
  if (node.enabled === enabled) return document;

  const stack = [...document.stack];
  stack[at] = { ...node, enabled };
  log.info("node " + (enabled ? "enabled" : "disabled"), { nodeId });
  return withStack(document, stack);
}

/**
 * Set a node's own seed.
 *
 * Not a parameter — it is the node's field, read by every stochastic effect and
 * by the content hash, which is why redrawing it changes the picture and why it
 * has to be a document mutation rather than something the UI holds. The range
 * is the 32-bit unsigned integers `SEED_RANGE` declares and a `u32` uniform
 * carries; anything else is refused rather than truncated on its way into a
 * shader, where the truncation would be invisible.
 */
export function setNodeSeed(
  document: DitherDocument,
  nodeId: string,
  seed: number,
): DitherDocument {
  const at = indexOfNode(document, nodeId);
  const node = document.stack[at];
  if (node === undefined) throw new DocumentError("unknown-node", `no node "${nodeId}"`);
  if (!Number.isInteger(seed) || seed < SEED_RANGE[0] || seed > SEED_RANGE[1]) {
    throw new DocumentError(
      "invalid-value",
      `seed ${seed} is outside ${SEED_RANGE[0]}..${SEED_RANGE[1]}; a node seed is a 32-bit unsigned integer`,
      { nodeId, seed },
    );
  }
  if (node.seed === seed) return document;

  const stack = [...document.stack];
  stack[at] = { ...node, seed };
  log.info("node seed set", { nodeId, seed });
  return withStack(document, stack);
}

/**
 * Set one parameter.
 *
 * The whole set is re-coerced against the descriptor rather than the one value
 * being checked, because that is the same call a loaded document goes through
 * and two paths would be two opinions about what is legal. A value outside its
 * range comes back clamped, with the adjustment logged by the registry.
 */
export function setNodeParam(
  document: DitherDocument,
  registry: EffectRegistry,
  nodeId: string,
  key: string,
  value: ParameterValue,
): DitherDocument {
  const at = indexOfNode(document, nodeId);
  const node = document.stack[at];
  if (node === undefined) throw new DocumentError("unknown-node", `no node "${nodeId}"`);

  const descriptor = registry.get(node.effect);
  if (descriptor === undefined) {
    throw new DocumentError(
      "unknown-effect",
      `node "${nodeId}" names effect "${node.effect}", which this build does not have`,
      { nodeId, effect: node.effect },
    );
  }
  if (!descriptor.params.some((param) => param.key === key)) {
    throw new DocumentError(
      "unknown-param",
      `"${node.effect}" declares no parameter "${key}"`,
      { nodeId, effect: node.effect, key },
    );
  }

  const coerced = coerceParams(descriptor, { ...node.params, [key]: value });
  const stack = [...document.stack];
  stack[at] = { ...node, params: coerced.values };
  return withStack(document, stack);
}

/** Replace the whole palette (F-CO-*, and an undo step like any other). */
export function setPalette(document: DitherDocument, palette: Palette): DitherDocument {
  if (palette.colors.length === 0 || palette.colors.length % 3 !== 0) {
    throw new DocumentError(
      "invalid-value",
      `palette "${palette.id}" has ${palette.colors.length} colour components; expected a non-empty multiple of 3`,
      { palette: palette.id, components: palette.colors.length },
    );
  }
  for (const [index, component] of palette.colors.entries()) {
    if (!Number.isInteger(component) || component < 0 || component > 255) {
      throw new DocumentError(
        "invalid-value",
        `palette "${palette.id}" component ${index} is ${component}; packed sRGB triplets are integers in 0..255`,
        { palette: palette.id, index, component },
      );
    }
  }
  log.info("palette set", {
    palette: palette.id,
    entries: palette.colors.length / 3,
    metric: palette.metric,
  });
  return { ...document, palette };
}

/** Set the clock. `frames` bounds normalized time, so both fields are checked. */
export function setClock(document: DitherDocument, clock: Clock): DitherDocument {
  if (!Number.isInteger(clock.frames) || clock.frames < 1) {
    throw new DocumentError(
      "invalid-value",
      `frame count ${clock.frames} is not a positive integer; normalized time is frame / frames`,
      { frames: clock.frames },
    );
  }
  if (!Number.isFinite(clock.fps) || clock.fps <= 0) {
    throw new DocumentError("invalid-value", `fps ${clock.fps} is not positive`, {
      fps: clock.fps,
    });
  }
  return { ...document, clock };
}

/** Point the document at a source image. */
export function setSource(
  document: DitherDocument,
  source: SourceRef | null,
): DitherDocument {
  return { ...document, source };
}

/**
 * Replace the modulator bindings.
 *
 * `cyclesPerLoop` being an integer is the single constraint that makes frame N
 * equal frame 0, so the loop closes without a crossfade — it is checked here
 * rather than trusted, because the failure it prevents shows up only in an
 * exported animation, as a jump at the seam.
 */
export function setBindings(
  document: DitherDocument,
  bindings: readonly Binding[],
): DitherDocument {
  for (const binding of bindings) {
    if (!document.stack.some((node) => node.id === binding.nodeId)) {
      throw new DocumentError(
        "unknown-node",
        `binding targets node "${binding.nodeId}", which is not in the stack`,
        { nodeId: binding.nodeId, param: binding.param },
      );
    }
    if (!Number.isInteger(binding.cyclesPerLoop)) {
      throw new DocumentError(
        "invalid-value",
        `binding on ${binding.nodeId}.${binding.param} has cyclesPerLoop ${binding.cyclesPerLoop}; it must be an integer or the loop does not close`,
        { nodeId: binding.nodeId, param: binding.param, cyclesPerLoop: binding.cyclesPerLoop },
      );
    }
  }
  log.info("bindings set", { bindings: bindings.length });
  return { ...document, bindings };
}
