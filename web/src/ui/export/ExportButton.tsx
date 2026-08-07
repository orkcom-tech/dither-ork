import React from "react";

import {
  DEFAULT_EXPORT_SETTINGS,
  type ExportImageSource,
  type ExportSettings,
  type VectorTracer,
} from "../../export";
import {
  DEFAULT_ANIMATED_SETTINGS,
  type AnimatedFrameSource,
  type AnimatedSettings,
  type GifCore,
} from "../../export/animated";
import { AnimatedExportPanel } from "./AnimatedExportPanel";
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
  /** The document as a loop (F-EX-04, 05, 06). */
  readonly animated: AnimatedFrameSource;
  /** The core's GIF encoder, which only the animated GIF format reads. */
  readonly gif: GifCore;
  /** Why the loop cannot be exported, or `null`. See `AnimatedExportPanelProps`. */
  readonly animatedBlockReason: () => string | null;
}

/**
 * Still or animated.
 *
 * One dialog with a switch rather than two toolbar buttons: it is one action —
 * "write this out" — and which of the two a person wants depends on whether the
 * document has a track, which is not something a toolbar can show. The switch
 * also puts the two side by side, which is where the answer to "why is the
 * animated one greyed out" belongs.
 */
type ExportMode = "still" | "animated";

export function ExportButton({
  source,
  tracer,
  animated,
  gif,
  animatedBlockReason,
}: ExportButtonProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<ExportMode>("still");
  const [settings, setSettings] = React.useState<ExportSettings>(DEFAULT_EXPORT_SETTINGS);
  const [animatedSettings, setAnimatedSettings] =
    React.useState<AnimatedSettings>(DEFAULT_ANIMATED_SETTINGS);
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

  const onAnimatedSettings = React.useCallback((next: AnimatedSettings) => {
    setAnimatedSettings(next);
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
        title="Export the picture as PNG, JPEG, WebP or SVG, or the loop as GIF, APNG, WebP, video or a sequence"
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
          <div className="xp__group">
            <button
              type="button"
              className="ui-button"
              aria-pressed={mode === "still"}
              disabled={cancelJob !== null}
              title="One picture — PNG, JPEG, WebP or SVG"
              data-testid="export-mode-still"
              onClick={() => setMode("still")}
            >
              still
            </button>
            <button
              type="button"
              className="ui-button"
              aria-pressed={mode === "animated"}
              disabled={cancelJob !== null}
              title="The whole loop — GIF, APNG, animated WebP, video or a frame sequence"
              data-testid="export-mode-animated"
              onClick={() => setMode("animated")}
            >
              animated
            </button>
          </div>
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
        {open && mode === "still" ? (
          <ExportPanel
            source={source}
            tracer={tracer}
            settings={settings}
            onSettings={onSettings}
            onRunning={onRunning}
          />
        ) : null}
        {open && mode === "animated" ? (
          <AnimatedExportPanel
            source={animated}
            gif={gif}
            settings={animatedSettings}
            onSettings={onAnimatedSettings}
            onRunning={onRunning}
            blockReason={animatedBlockReason}
          />
        ) : null}
      </dialog>
    </React.Fragment>
  );
}
