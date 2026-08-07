/**
 * The batch surface — F-BA-01 through F-BA-06, as a toolbar action and a dialog.
 *
 * Wiring it into the application is one call, from wherever the session is
 * created:
 *
 * ```ts
 * import { registerBatchControls } from "./ui/batch";
 * registerBatchControls({ session, registry, report, palette: paletteStore });
 * ```
 *
 * The shell imports no panel and no toolbar item; each registers itself into a
 * slot (`web/src/app/slots.ts`). This is a **toolbar item** rather than a panel
 * because `PanelId` is a closed union of the four names F-UI-08 gives and batch
 * is not one of them — see `BatchButton.tsx` for why a dialog is the right shape
 * anyway.
 *
 * Everything below the UI lives in `web/src/batch/`, which knows nothing about
 * React, the document store, the palette editor or the renderer; `session.ts`
 * here is the single adapter between the two, and it is the whole of the
 * coupling.
 */

import React from "react";

import { registerToolbarItem } from "../../app";
import type { CapabilityReport } from "../../lib/capabilities";
import { logger } from "../../lib/log";
import type { EffectRegistry } from "../../registry";
import type { EditorSession } from "../../state";
import type { PaletteStore } from "../palette";
import type { TimelineStore } from "../timeline";
import { BatchButton } from "./BatchButton";

const log = logger("batch");

export interface BatchControlsDependencies {
  readonly session: EditorSession;
  readonly registry: EffectRegistry;
  /**
   * The startup capability report.
   *
   * Needed rather than re-probed: `RenderService.create` reads its WebGPU
   * verdict, and running `checkCapabilities()` a second time would request
   * another adapter for no reason. It is also what
   * {@link batchInputCapability} and {@link batchDeliveryCapability} restate at
   * the point where the missing API changes what the buttons do.
   */
  readonly report: CapabilityReport;
  /** The palette editor's store — F-BA-04's per-image mode reads its settings. */
  readonly palette: PaletteStore;
  /**
   * The timeline, because the recipe a batch applies is one *frame* of the
   * document and the playhead is what says which. Without it an animated
   * document fails every item in the queue: `document.bindings` is non-empty and
   * `buildRenderGraph` refuses it. See `frameDocument` in `ui/timeline`.
   */
  readonly timeline: TimelineStore;
}

/**
 * Register the batch action into the toolbar.
 *
 * Call once. A second call is a duplicate slot registration and the shell
 * throws, which is what stops one of two registrations from being silently
 * invisible.
 */
export function registerBatchControls(deps: BatchControlsDependencies): void {
  registerToolbarItem({
    id: "batch",
    side: "start",
    // After export, which claims 4: you make one picture right and then apply
    // it to the folder, which is the order the two are reached in.
    order: 5,
    // A closure rather than a context provider: the shell's slot takes a
    // component with no props, and the session is created outside the tree.
    component: () =>
      React.createElement(BatchButton, {
        session: deps.session,
        registry: deps.registry,
        report: deps.report,
        palette: deps.palette,
        timeline: deps.timeline,
      }),
  });
  log.info("batch registered");
}

export { BatchButton, type BatchButtonProps } from "./BatchButton";
export { BatchPanel, type BatchPanelProps } from "./BatchPanel";
export { QueueList, type QueueListProps } from "./QueueList";
export {
  batchDecoderFor,
  batchPaletteExtractorFor,
  poolFor,
  presetNameFor,
} from "./session";
