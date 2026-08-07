import React from "react";

import {
  DEFAULT_EXPORT_SETTINGS,
  type ExportImageSource,
  type ExportSettings,
  type VectorTracer,
} from "../../export";
import { ExportPanel } from "./ExportPanel";
import "./export.css";

/**
 * The toolbar's export action, and the dialog it opens.
 *
 * ## Why a dialog rather than a docked panel
 *
 * The shell's panel ids are a closed union of the four F-UI-08 names
 * (`app/slots.ts`), and export is not one of them — adding a fifth is a
 * decision about the layout that belongs to whoever owns the shell. A toolbar
 * item is the slot that is genuinely open, and it happens to be the better fit:
 * export is an action taken once, not a surface that is watched, and a modal
 * dialog also means the document cannot move underneath a size estimate that
 * was measured from a particular frame.
 *
 * A native `<dialog>` rather than a hand-built overlay: the focus trap, the
 * backdrop, the inert background and the Escape key are the platform's and are
 * correct, which is four things not to get subtly wrong.
 *
 * ## Escape while an export is running cancels the export
 *
 * The dialog's `cancel` event is Escape. With a job in flight the default —
 * closing the dialog — would leave an encode running with nothing on screen to
 * stop it, so the event is intercepted and used for F-EX-13's cancel instead. A
 * second Escape, once the job has stopped, closes the dialog as usual.
 *
 * ## The panel is mounted only while the dialog is open
 *
 * Opening it is what renders the frame the estimate and the export both use.
 * Unmounting is what aborts that render if the dialog is closed mid-flight —
 * the panel's effects own an `AbortController` each, and React's cleanup is the
 * cancel path.
 */
export interface ExportButtonProps {
  readonly source: ExportImageSource;
  /** The core's SVG tracer (F-EX-08). */
  readonly tracer: VectorTracer;
}

export function ExportButton({ source, tracer }: ExportButtonProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [settings, setSettings] = React.useState<ExportSettings>(DEFAULT_EXPORT_SETTINGS);
  const [cancelJob, setCancelJob] = React.useState<(() => void) | null>(null);
  const dialogRef = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const onSettings = React.useCallback((next: ExportSettings) => {
    setSettings(next);
  }, []);

  const onRunning = React.useCallback((cancel: (() => void) | null) => {
    // Stored as a thunk: `useState` calls a function argument to derive the
    // next state, so a bare function would be invoked instead of kept.
    setCancelJob(() => cancel);
  }, []);

  return (
    <React.Fragment>
      <button
        type="button"
        className="ui-button"
        title="Export the picture as PNG, JPEG, WebP or SVG"
        data-testid="open-export"
        onClick={() => setOpen(true)}
      >
        export
      </button>

      <dialog
        ref={dialogRef}
        className="xp-dialog"
        aria-label="Export"
        onCancel={(event) => {
          if (cancelJob === null) return;
          event.preventDefault();
          cancelJob();
        }}
        onClose={() => setOpen(false)}
      >
        <header className="xp-dialog__head">
          <span className="xp-dialog__title">export</span>
          <button
            type="button"
            className="ui-button"
            disabled={cancelJob !== null}
            title={
              cancelJob === null
                ? "Close"
                : "An export is running — cancel it first"
            }
            onClick={() => setOpen(false)}
          >
            close
          </button>
        </header>
        {open ? (
          <ExportPanel
            source={source}
            tracer={tracer}
            settings={settings}
            onSettings={onSettings}
            onRunning={onRunning}
          />
        ) : null}
      </dialog>
    </React.Fragment>
  );
}
