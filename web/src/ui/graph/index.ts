/**
 * The node editor — step 3's user interface.
 *
 * ```ts
 * import { registerGraphPanel } from "./ui/graph";
 * registerGraphPanel({ store, registry });
 * ```
 *
 * The shell imports no panel; the panel registers itself into a slot. See
 * `web/src/app/slots.ts` for the arrangement.
 *
 * ## Why the stack panel is still there
 *
 * Because most documents are chains, most people think in chains, and the linear
 * stack is what every existing document, preset and share link *is*. The two are
 * not two models: the stack panel is a **view onto the same graph** — the same
 * store, the same nodes, the same selection — showing the document's list order
 * and saying, per row, where that node sits relative to the picture
 * (`ui/stack/graph-view.ts`). Nothing is kept in sync because there is nothing
 * to sync.
 *
 * They answer different questions and each is bad at the other's:
 *
 * - The **stack** is a list. It is where you read a document top to bottom, drag
 *   the order, set opacity and blend per node, and see twenty nodes at once in a
 *   260px column. A graph cannot do that; a graph of twenty nodes in a 260px
 *   column is unreadable.
 * - The **editor** is the wiring. It is where a second input exists at all —
 *   masking, blending two chains, displacing one picture by another — and none
 *   of those can be expressed as a position in a list, which is exactly why
 *   F-PP-08 was unbuilt for three phases.
 *
 * So neither replaces the other and neither is a mode you are put into. A person
 * who never wires anything never has to open the editor, and their document
 * behaves exactly as it did before schema 2; a person who does gets a surface
 * that was not previously possible, alongside the list rather than instead of
 * it.
 */

import React from "react";

import { registerPanel } from "../../app";
import { logger } from "../../lib/log";
import { GraphEditor } from "./GraphEditor";
import type { PanelDependencies } from "../stack/store";

const log = logger("app");

/**
 * Register the node editor into the shell's bottom strip.
 *
 * Below the viewport rather than beside it, and the reason is on
 * {@link GraphEditor}: the picture has to stay live while the graph is being
 * wired, and the bottom strip is the one region that is as wide as the window —
 * which is the axis a graph grows along.
 *
 * `order: 1` puts it under the timeline, which is registered at 0. The timeline
 * is about time and the editor is about structure; of the two, the one you scrub
 * while watching the picture belongs nearer the picture.
 */
export function registerGraphPanel(dependencies: PanelDependencies): void {
  registerPanel({
    id: "graph",
    title: "Node editor",
    region: "bottom",
    order: 1,
    component: () => React.createElement(GraphEditor, dependencies),
  });
  log.info("node editor registered", { effects: dependencies.registry.size });
}

export { GraphEditor, type GraphEditorProps } from "./GraphEditor";
export { GraphNodeCard, type GraphNodeCardProps } from "./GraphNodeCard";
export {
  COLUMN_GAP,
  NODE_HEADER_HEIGHT,
  NODE_PAD_BOTTOM,
  NODE_WIDTH,
  PORT_ROW_HEIGHT,
  ROW_GAP,
  SNAP_RADIUS,
  nodeHeight,
  portOffsetY,
} from "./metrics";
export {
  layoutGraph,
  type GraphLayout,
  type LayoutInput,
  type LayoutNode,
} from "./layout";
export {
  IDENTITY_VIEW,
  MAX_SCALE,
  MIN_SCALE,
  ZOOM_STEP,
  boundsOf,
  clampScale,
  distance,
  feedbackPath,
  fitView,
  inputPoint,
  nearest,
  outputPoint,
  panBy,
  toScreen,
  toWorld,
  wirePath,
  zoomAt,
  zoomByStep,
  type Bounds,
  type Point,
  type ViewTransform,
} from "./geometry";
export {
  IMAGE_MASK,
  ROLE_LABEL,
  ROOT_INPUT_NOTE,
  allPorts,
  buildEditorGraph,
  dropTargetAt,
  dropTargets,
  isColourRole,
  judgeDrop,
  maskAction,
  nodeAt,
  withoutEdge,
  type DropTarget,
  type EditorEdge,
  type EditorGraph,
  type EditorLoop,
  type EditorNode,
  type EditorPort,
  type MaskAction,
} from "./model";
export {
  SHORTCUTS,
  firstConnectable,
  stepSelection,
  stepTarget,
  type Direction,
  type Shortcut,
} from "./keyboard";
