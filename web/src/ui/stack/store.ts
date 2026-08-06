/**
 * What the stack editor and the properties panel are handed.
 *
 * This file used to declare its own `DocumentStore` and `DocumentSnapshot` —
 * the smallest set of reads and writes these two panels perform, written down
 * so the panels could be built before the store existed. That store now exists,
 * in `web/src/state/`, and the interface's own note said what to do at this
 * point: import it from the store instead. So that is what this is.
 *
 * Keeping the two would have meant an adapter in the middle, and an adapter
 * between an interface and its only implementation is a place for them to
 * disagree — which is exactly what it was: the panels asked for `select`,
 * `setEnabled`, `setParam` and a snapshot with a top-level `stack`, and the
 * store offers `selectNode`, `setNodeEnabled`, `setNodeParam` and a snapshot
 * carrying the whole document. One of those two vocabularies had to go, and the
 * one that survives is the store's, because the store is what the renderer, the
 * autosave and the `.dork` writer all speak.
 *
 * Three properties the implementation has and the type cannot state, kept here
 * because they are what a panel author has to know:
 *
 * - **`getSnapshot()` is referentially stable.** Both panels read it through
 *   `useSyncExternalStore`, which compares snapshots with `Object.is` and will
 *   loop forever on a freshly built object. The identity changes exactly when
 *   the content does.
 * - **Every mutator is a single undoable step** (F-ST-04), unless it opts into
 *   coalescing with `{ continuous: true }` — which is what a pointer-driven
 *   control passes, so a drag is one step rather than sixty.
 * - **`addNode` and `duplicateNode` return the id they created.** The panel
 *   selects it, and a caller that had to search the new stack would guess wrong
 *   the moment the same effect appears twice (F-ST-07).
 */

import type { EffectRegistry } from "../../registry";
import type { CommitOptions, DocumentSnapshot, DocumentStore } from "../../state";

export type { CommitOptions, DocumentSnapshot, DocumentStore };

/**
 * What a panel is handed when it is registered into the shell.
 *
 * The shell's slot takes a component with no props (`web/src/app/slots.ts`), so
 * these arrive by closure at registration time rather than through the tree.
 * That is deliberate: a React context would need a provider somewhere in the
 * shell, which is a file neither panel owns, and a panel whose provider is
 * missing would fail at render rather than at wiring.
 */
export interface PanelDependencies {
  readonly store: DocumentStore;
  readonly registry: EffectRegistry;
}
