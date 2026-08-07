import React from "react";

import {
  DEFAULT_BATCH_SETTINGS,
  type BatchInputFile,
  type BatchSettings,
} from "../../batch";
import type { CapabilityReport } from "../../lib/capabilities";
import type { EffectRegistry } from "../../registry";
import type { EditorSession } from "../../state";
import type { PaletteStore } from "../palette";
import { BatchPanel } from "./BatchPanel";
import "./batch.css";

/**
 * The toolbar's batch action, and the dialog it opens.
 *
 * ## Why a dialog rather than a docked panel
 *
 * `PanelId` in `app/slots.ts` is a closed union of the four names F-UI-08 gives
 * and batch is not one of them; a fifth panel is a decision about the shell's
 * layout and belongs to whoever owns it. A toolbar item is the slot that is
 * genuinely open — the same argument `ui/export` makes — and it fits: a batch
 * is an operation you set up and start, not a surface you watch while editing.
 *
 * A native `<dialog>` rather than a hand-built overlay, so the focus trap, the
 * backdrop, the inert background and the Escape key are the platform's.
 *
 * ## Escape while a run is going cancels the run
 *
 * The `cancel` event is Escape. With a run in flight the default — closing the
 * dialog — would leave a pool of GPU devices rendering two hundred images with
 * nothing on screen to stop them, so the event is intercepted and used for
 * F-BA-06's cancel instead. A second Escape closes the dialog as usual.
 *
 * ## The panel is mounted only while the dialog is open
 *
 * The queue and the settings survive a close and reopen because they live here,
 * not in the panel — a person who queued two hundred files, closed the dialog
 * to look at their stack and came back should not have to queue them again.
 */
export interface BatchButtonProps {
  readonly session: EditorSession;
  readonly registry: EffectRegistry;
  readonly report: CapabilityReport;
  readonly palette: PaletteStore;
}

export function BatchButton({
  session,
  registry,
  report,
  palette,
}: BatchButtonProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [settings, setSettings] = React.useState<BatchSettings>(DEFAULT_BATCH_SETTINGS);
  const [inputs, setInputs] = React.useState<readonly BatchInputFile[]>([]);
  const [cancelRun, setCancelRun] = React.useState<(() => void) | null>(null);
  const dialogRef = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const onRunning = React.useCallback((cancel: (() => void) | null) => {
    // Stored as a thunk: `useState` calls a function argument to derive the
    // next state, so a bare function would be invoked instead of kept.
    setCancelRun(() => cancel);
  }, []);

  return (
    <React.Fragment>
      <button
        type="button"
        className="ui-button"
        title="Apply this document's stack to many images"
        data-testid="open-batch"
        onClick={() => setOpen(true)}
      >
        batch
      </button>

      <dialog
        ref={dialogRef}
        className="bx-dialog"
        aria-label="Batch"
        onCancel={(event) => {
          if (cancelRun === null) return;
          event.preventDefault();
          cancelRun();
        }}
        onClose={() => setOpen(false)}
      >
        <header className="bx-dialog__head">
          <span className="bx-dialog__title">batch</span>
          <button
            type="button"
            className="ui-button"
            disabled={cancelRun !== null}
            title={cancelRun === null ? "Close" : "A run is going — cancel it first"}
            onClick={() => setOpen(false)}
          >
            close
          </button>
        </header>
        {open ? (
          <BatchPanel
            session={session}
            registry={registry}
            report={report}
            palette={palette}
            settings={settings}
            onSettings={setSettings}
            inputs={inputs}
            onInputs={setInputs}
            onRunning={onRunning}
          />
        ) : null}
      </dialog>
    </React.Fragment>
  );
}
