/**
 * The export surface — F-EX-01, 02, 03, 12, 13, 14 and 15, as a toolbar action
 * and a dialog.
 *
 * Wiring it into the application is one call, from wherever the session is
 * created:
 *
 * ```ts
 * import { registerExportControls } from "./ui/export";
 * registerExportControls(session);
 * ```
 *
 * The shell imports no panel and no toolbar item; each registers itself into a
 * slot (`web/src/app/slots.ts`). This is registered as a **toolbar item** rather
 * than a panel because `PanelId` is a closed union of the four names F-UI-08
 * gives, and export is not one of them — a fifth panel is a decision about the
 * shell's layout and belongs to whoever owns it. See `ExportButton.tsx` for why
 * a dialog is the right shape anyway.
 *
 * Everything below the UI lives in `web/src/export/`, which knows nothing about
 * React, the document store or the renderer; `session.ts` here is the single
 * adapter between the two, and it is the whole of the coupling.
 */

import React from "react";

import { registerToolbarItem } from "../../app";
import { logger } from "../../lib/log";
import type { EditorSession } from "../../state";
import { ExportButton } from "./ExportButton";
import { exportSourceFor, vectorTracerFor } from "./session";

const log = logger("export");

/**
 * Register the export action into the toolbar.
 *
 * Call once. A second call is a duplicate slot registration and the shell
 * throws, which is what stops one of two registrations from being silently
 * invisible.
 */
export function registerExportControls(session: EditorSession): void {
  const source = exportSourceFor(session);
  const tracer = vectorTracerFor(session);
  registerToolbarItem({
    id: "export",
    side: "start",
    // Last of the start group: open, history, view, documents, then export —
    // the order a person moves through them, and export is the end of the trip.
    // `documents` claims 3; a tie would resolve by registration order, which is
    // a fact about `main.tsx` rather than a decision, so they are kept distinct.
    order: 4,
    // A closure rather than a context provider: the shell's slot takes a
    // component with no props, and the session is created outside the tree.
    component: () => React.createElement(ExportButton, { source, tracer }),
  });
  log.info("export registered");
}

export { ExportButton, type ExportButtonProps } from "./ExportButton";
export { ExportPanel, type ExportPanelProps } from "./ExportPanel";
export { exportSourceFor, vectorTracerFor } from "./session";
