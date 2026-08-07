/**
 * Documents, presets and sharing, in the shell — F-DO-01 to F-DO-06.
 *
 * ```ts
 * // app/main.tsx, beside the other registrations, once the session exists:
 * registerDocumentsToolbar({
 *   store: session.store,
 *   openImageFile: (file) => session.openFile(file),
 *   storage: hasPresetStorage() ? opfsPresetStorage() : null,
 *   href: window.location.href,
 *   hash: window.location.hash,
 * });
 * ```
 *
 * **`session.store` satisfies {@link DocumentTarget} except for one method.**
 * `loadDocument(document, label)` does not exist on `DocumentStore` yet and
 * everything that replaces the open document needs it. The exact contract is on
 * {@link DocumentTarget} in `store.ts`, written for whoever owns
 * `web/src/state/`; until it lands, this module is complete and unwired.
 *
 * It registers a **toolbar item**, not a panel. `app/slots.ts` closes the panel
 * ids to the four F-UI-08 names and says a fifth is a decision rather than an
 * accident; this is a set of actions on the document, which is what the toolbar
 * already holds.
 */

import React from "react";

import { registerToolbarItem } from "../../app";
import { logger } from "../../lib/log";
import { DocumentsToolbar } from "./DocumentsToolbar";
import type { DocumentsDependencies } from "./store";

const log = logger("app");

export { DocumentsToolbar } from "./DocumentsToolbar";
export { PresetsSection, type PresetsSectionProps } from "./PresetsSection";
export {
  formatBytes,
  presetSummary,
  searchPresets,
  suggestPresetName,
  textByteLength,
} from "./model";
export type { DocumentSnapshot, DocumentTarget, DocumentsDependencies } from "./store";

/**
 * Put the document controls in the toolbar.
 *
 * `order: 3` — after open, undo/redo and the view controls, which is the order
 * the actions are reached in: you open a picture, you build something, and then
 * you save it or share it.
 */
export function registerDocumentsToolbar(deps: DocumentsDependencies): void {
  registerToolbarItem({
    id: "documents",
    side: "start",
    order: 3,
    // A closure rather than a context provider: the shell's slot takes a
    // component with no props, and the session is created outside the tree.
    component: () => React.createElement(DocumentsToolbar, { deps }),
  });
  log.info("documents toolbar registered", {
    presets: deps.storage !== null,
    incomingLink: deps.hash.length > 1,
  });
}
