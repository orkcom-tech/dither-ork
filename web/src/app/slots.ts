/**
 * The slots — how the rest of the UI gets into the shell.
 *
 * The shell is written before the panels that live in it, and those panels are
 * written in parallel by people who must not have to edit a shared file to be
 * seen. So the shell imports nothing from them: a panel module calls
 * {@link registerPanel} and the shell picks it up. This is the same arrangement
 * the effect catalogue already uses — one file per effect, discovered rather
 * than listed — and it is here for the same reason: two contributions written
 * at the same time cannot conflict if neither has to touch a third file.
 *
 * Three rules the registries enforce rather than document:
 *
 * - **A region with nothing registered into it does not exist.** No empty box,
 *   no "coming soon" — the shell lays out what is actually there. That is what
 *   makes the slots fillable one at a time.
 * - **A duplicate registration throws.** Two modules claiming `properties`
 *   means one of them is silently invisible, which is exactly the failure the
 *   registry exists to prevent.
 * - **Registration is observable.** A panel registered after the first render —
 *   by a lazily imported module, or from the console while debugging — appears
 *   without a reload.
 *
 * Panel ids are a closed union because F-UI-08 names the four panels the
 * application has. A fifth is a decision, not an accident, and adding one
 * should be a line here.
 *
 * **The fifth is `graph`, the node editor**, added with multi-input. It is not a
 * variant of the stack panel and does not replace it: the stack is the
 * document's list — order, opacity, blend, twenty rows at a glance — and the
 * editor is its **wiring**, which is a second image edge per node and therefore
 * a thing no list can express. Both read the same store and the same selection.
 * The argument in full is in `ui/graph/index.ts`.
 */

import type { ComponentType } from "react";

import { logger } from "../lib/log";
import type { PanelRegion } from "./layout";

const log = logger("app");

export const PANEL_IDS = ["stack", "properties", "palette", "timeline", "graph"] as const;
export type PanelId = (typeof PANEL_IDS)[number];

export interface PanelDefinition {
  readonly id: PanelId;
  /** Shown in the panel header and on the collapsed rail. */
  readonly title: string;
  readonly region: PanelRegion;
  /** Position within the region, ascending. Ties fall back to registration order. */
  readonly order: number;
  /** The panel's content. It is mounted inside a scrolling body. */
  readonly component: ComponentType;
}

export interface ToolbarItemDefinition {
  readonly id: string;
  /** `start` sits next to the wordmark; `end` sits with the theme control. */
  readonly side: "start" | "end";
  readonly order: number;
  readonly component: ComponentType;
}

export class DuplicateSlotError extends Error {
  readonly slotId: string;

  constructor(kind: string, slotId: string) {
    super(`a ${kind} is already registered under id "${slotId}"`);
    this.name = "DuplicateSlotError";
    this.slotId = slotId;
  }
}

export interface SlotRegistry<T extends { readonly id: string; readonly order: number }> {
  register(definition: T): void;
  /** Everything registered, ordered. */
  all(): readonly T[];
  subscribe(listener: () => void): () => void;
}

/**
 * Build an independent registry. The application uses the two module-level
 * ones below; this is exported so the behaviour can be tested without a shared
 * mutable singleton, which is the only kind of test-only backdoor this file
 * needs and it is not one.
 */
export function createSlotRegistry<
  T extends { readonly id: string; readonly order: number },
>(kind: string): SlotRegistry<T> {
  const entries: T[] = [];
  const listeners = new Set<() => void>();
  // Rebuilt on every change, handed out by reference: `useSyncExternalStore`
  // compares snapshots with `Object.is` and would loop forever on a fresh array.
  let snapshot: readonly T[] = [];

  return {
    register(definition: T): void {
      if (entries.some((entry) => entry.id === definition.id)) {
        const error = new DuplicateSlotError(kind, definition.id);
        log.error(error.message, { kind, id: definition.id });
        throw error;
      }
      entries.push(definition);
      entries.sort((a, b) => a.order - b.order);
      snapshot = [...entries];
      log.info(`${kind} registered`, { id: definition.id, order: definition.order });
      for (const listener of listeners) listener();
    },
    all(): readonly T[] {
      return snapshot;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const panelSlots: SlotRegistry<PanelDefinition> =
  createSlotRegistry<PanelDefinition>("panel");
export const toolbarSlots: SlotRegistry<ToolbarItemDefinition> =
  createSlotRegistry<ToolbarItemDefinition>("toolbar item");

/** Register a panel. Call it at module scope from the panel's own module. */
export function registerPanel(definition: PanelDefinition): void {
  panelSlots.register(definition);
}

/** Register a toolbar action — open, export, surprise me. */
export function registerToolbarItem(definition: ToolbarItemDefinition): void {
  toolbarSlots.register(definition);
}

export function panelsInRegion(
  panels: readonly PanelDefinition[],
  region: PanelRegion,
): readonly PanelDefinition[] {
  return panels.filter((panel) => panel.region === region);
}

export function toolbarItemsOnSide(
  items: readonly ToolbarItemDefinition[],
  side: "start" | "end",
): readonly ToolbarItemDefinition[] {
  return items.filter((item) => item.side === side);
}
