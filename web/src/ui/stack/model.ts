/**
 * The stack editor's model — everything it decides that is not drawing.
 *
 * Kept out of the components for two reasons. It is testable without a DOM,
 * which is the only kind of test this repository runs (`web/vitest.config.ts`);
 * and reorder arithmetic and grammar refusal are exactly the places where a
 * plausible-looking off-by-one produces a stack that renders something the user
 * did not build.
 *
 * No effect is named anywhere in this file. Families, slots and legality all
 * come off the descriptors.
 */

import { validateStack, type StackIssue, type StackNodeRef } from "../../registry";
import type { EffectRegistry } from "../../registry";
import type { BlendMode, StackNode } from "../../types/document";
import type { EffectFamily, ExecutionKind } from "../../types/registry";
import type { NodeSlot } from "../../types/document";

/**
 * Family order in the add-node picker, and the labels shown above each group.
 *
 * A `Record` rather than a list of pairs so that adding a family to
 * `EffectFamily` fails to compile here instead of quietly producing a group
 * with no heading. The list beside it fixes the order, which the record cannot.
 */
export const FAMILY_LABEL: Record<EffectFamily, string> = {
  preprocess: "Preprocess",
  "error-diffusion": "Error diffusion",
  ordered: "Ordered",
  pattern: "Pattern",
  glitch: "Glitch",
  special: "Special",
};

export const FAMILY_ORDER = [
  "preprocess",
  "error-diffusion",
  "ordered",
  "pattern",
  "glitch",
  "special",
] as const satisfies readonly EffectFamily[];

export const SLOT_LABEL: Record<NodeSlot, string> = {
  preprocess: "pre",
  dither: "dither",
  postprocess: "post",
};

/**
 * Execution shown as what it costs rather than as what it is called: a `wasm`
 * node in the middle of a run of `gpu` nodes is a readback plus an upload, and
 * docs/ARCHITECTURE.md asks for that ceiling to be visible in the UI rather
 * than discovered by profiling.
 */
export const EXECUTION_LABEL: Record<ExecutionKind, string> = {
  wasm: "cpu",
  gpu: "gpu",
};

export const BLEND_LABEL: Record<BlendMode, string> = {
  normal: "Normal",
  multiply: "Multiply",
  screen: "Screen",
  overlay: "Overlay",
  difference: "Difference",
};

export const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "difference",
] as const satisfies readonly BlendMode[];

export function isBlendMode(value: string): value is BlendMode {
  return Object.prototype.hasOwnProperty.call(BLEND_LABEL, value);
}

// --- positions ----------------------------------------------------------

export function indexOfNode(
  stack: readonly StackNode[],
  nodeId: string | null,
): number {
  if (nodeId === null) return -1;
  return stack.findIndex((node) => node.id === nodeId);
}

export function nodeById(
  stack: readonly StackNode[],
  nodeId: string | null,
): StackNode | undefined {
  if (nodeId === null) return undefined;
  return stack.find((node) => node.id === nodeId);
}

/**
 * Where a newly added node goes.
 *
 * Directly after the selection, so adding three nodes in a row builds a chain
 * in the order they were picked. With nothing selected it goes on the end,
 * which is what an empty stack and a fresh document want.
 */
export function insertionIndex(
  stack: readonly StackNode[],
  selectedNodeId: string | null,
): number {
  const selected = indexOfNode(stack, selectedNodeId);
  return selected === -1 ? stack.length : selected + 1;
}

/** Move one element, returning a new array. `from` out of range is a no-op. */
export function moveItem<T>(
  items: readonly T[],
  from: number,
  to: number,
): readonly T[] {
  if (from < 0 || from >= items.length) return items;
  const clampedTo = to < 0 ? 0 : to > items.length - 1 ? items.length - 1 : to;
  if (clampedTo === from) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return items;
  next.splice(clampedTo, 0, moved);
  return next;
}

// --- solo ---------------------------------------------------------------

/**
 * F-ST-02's solo: the render stops *after* this node, so everything below it is
 * excluded. Not "render only this node" — a dither on its own with the tone
 * work in front of it switched off is a different picture, and the point of
 * solo is to see the stack as it is up to a chosen point.
 */
export function isExcludedBySolo(
  stack: readonly StackNode[],
  soloNodeId: string | null,
  index: number,
): boolean {
  const solo = indexOfNode(stack, soloNodeId);
  return solo !== -1 && index > solo;
}

/** The nodes that actually reach the renderer, in order. */
export function liveStack(
  stack: readonly StackNode[],
  soloNodeId: string | null,
): readonly StackNode[] {
  const solo = indexOfNode(stack, soloNodeId);
  const reached = solo === -1 ? stack : stack.slice(0, solo + 1);
  return reached.filter((node) => node.enabled);
}

// --- the grammar --------------------------------------------------------

/** The shape `validateStack` reads, from the document's nodes. */
export function stackRefs(stack: readonly StackNode[]): readonly StackNodeRef[] {
  return stack.map((node) => ({
    id: node.id,
    effect: node.effect,
    enabled: node.enabled,
  }));
}

/**
 * Identifies one grammar issue independently of its wording, so two validations
 * of two different stacks can be compared.
 */
function issueKey(issue: StackIssue): string {
  return `${issue.code} ${issue.nodeId} ${issue.otherNodeId ?? ""}`;
}

/**
 * The issues `after` has that `before` did not.
 *
 * The comparison is what makes refusal usable. A stack that is *already*
 * invalid — a document loaded from an older build, a node whose quantizer was
 * just switched off — must not have every subsequent edit refused because of a
 * problem the edit did not cause. Only a *newly introduced* issue is grounds to
 * refuse, which is the rule the picker and the reorder both apply.
 */
export function newIssues(
  before: readonly StackIssue[],
  after: readonly StackIssue[],
): readonly StackIssue[] {
  const known = new Set(before.map(issueKey));
  return after.filter((issue) => !known.has(issueKey(issue)));
}

/**
 * A union rather than `{ ok: boolean; reason?: string }` so that a caller that
 * has established the refusal has the reason without a second check. Under
 * `exactOptionalPropertyTypes` the optional-field version also cannot be built
 * from a `string | undefined` without a conditional spread at every site.
 */
export type GrammarVerdict =
  | { readonly ok: true }
  /** `reason` is written to be shown to a user as it stands. */
  | { readonly ok: false; readonly reason: string };

const ACCEPTED: GrammarVerdict = { ok: true };

/**
 * Would this candidate stack introduce a grammar problem the current one does
 * not have?
 *
 * `web/src/registry/stack.ts` states the requirement this serves: the stack
 * editor must not let an invalid combination be *built*, because the
 * alternative is a `ScheduleError` after the user has assembled the thing.
 */
export function judgeCandidate(
  registry: EffectRegistry,
  current: readonly StackNodeRef[],
  candidate: readonly StackNodeRef[],
): GrammarVerdict {
  const before = validateStack(registry, current);
  const after = validateStack(registry, candidate);
  const introduced = newIssues(before.issues, after.issues);
  const first = introduced[0];
  if (first === undefined) return ACCEPTED;
  return { ok: false, reason: first.message };
}

/**
 * The id given to the node the picker is *considering* adding.
 *
 * Reserved rather than random: a seeded id would be one more thing to seed, and
 * an id that collides with a real node would make the candidate stack a
 * different stack from the one being judged. It contains a space, which no
 * generated node id does.
 *
 * It is worded as a phrase rather than as a code because `validateStack` writes
 * the id into a message a person reads: "Outline (node being added) reads the
 * index map, and nothing in front of it quantizes".
 */
export const CANDIDATE_NODE_ID = "being added";

/** The stack that would exist if `effect` were inserted at `index`. */
export function withCandidate(
  refs: readonly StackNodeRef[],
  effect: string,
  index: number,
): readonly StackNodeRef[] {
  const clamped = index < 0 ? 0 : index > refs.length ? refs.length : index;
  const next = [...refs];
  next.splice(clamped, 0, {
    id: CANDIDATE_NODE_ID,
    effect,
    // A node is added enabled, so it is judged enabled. Judging it disabled
    // would accept every combination, since the grammar skips disabled nodes.
    enabled: true,
  });
  return next;
}
