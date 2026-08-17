/**
 * The stack editor — F-ST-01, 02, 03 and 08.
 *
 * Wiring it into the application is one call, from wherever the document store
 * is created:
 *
 * ```ts
 * import { registerStackPanel } from "./ui/stack";
 * registerStackPanel({ store, registry });
 * ```
 *
 * The shell imports no panel; the panel registers itself into a slot. See
 * `web/src/app/slots.ts` for the arrangement and `./store.ts` for the exact
 * store contract this panel needs.
 */

import React from "react";

import { registerPanel } from "../../app";
import { logger } from "../../lib/log";
import { StackPanel } from "./StackPanel";
import type { PanelDependencies } from "./store";

const log = logger("app");

/**
 * Register the stack editor into the shell's left region.
 *
 * Call once. A second call is a duplicate slot registration and the shell
 * throws, which is what stops one of two panels from being silently invisible.
 */
export function registerStackPanel(dependencies: PanelDependencies): void {
  registerPanel({
    id: "stack",
    title: "Stack",
    region: "left",
    order: 0,
    // A closure rather than a context provider: the shell's slot takes a
    // component with no props, and the store is created outside the tree.
    component: () => React.createElement(StackPanel, dependencies),
  });
  log.info("stack editor registered", { effects: dependencies.registry.size });
}

export { StackPanel, type StackPanelProps } from "./StackPanel";
export { StackRow, type StackRowProps } from "./StackRow";
export { AddNodePicker, type AddNodePickerProps } from "./AddNodePicker";
export {
  BLEND_LABEL,
  BLEND_MODES,
  CANDIDATE_NODE_ID,
  EXECUTION_COST,
  EXECUTION_LABEL,
  FAMILY_LABEL,
  FAMILY_ORDER,
  SLOT_LABEL,
  indexOfNode,
  insertionIndex,
  isBlendMode,
  isExcludedBySolo,
  judgeCandidate,
  liveStack,
  moveItem,
  newIssues,
  nodeById,
  stackRefs,
  withCandidate,
  type GrammarVerdict,
} from "./model";
export {
  describeRows,
  shapeNote,
  type GraphView,
  type GraphViewInput,
  type RowNote,
  type RowPlacement,
} from "./graph-view";
export {
  buildPicker,
  firstAvailable,
  flatten,
  stepHighlight,
  type PickerEntry,
  type PickerGroup,
  type PickerModel,
  type PickerRequest,
} from "./picker";
export type {
  DocumentSnapshot,
  DocumentStore,
  PanelDependencies,
} from "./store";
