import React from "react";

import { SURPRISE_SHORTCUT_LABEL } from "./shortcut";
import { SurprisePanel } from "./SurprisePanel";
import type { ModulatorSupport } from "./capability";
import type { SurpriseStore } from "./store";
import "./surprise.css";

/**
 * The toolbar's Surprise Me action (F-SM-01), and the dialog behind it.
 *
 * ## Two controls rather than one
 *
 * The big one generates immediately. That is the whole feature and it should
 * cost one click; F-SM-12 asks for a shortcut "designed to be hammered", and a
 * button that opens a dialog you then press a second button inside is not that.
 * The small one opens the panel, where the seed, the chaos slider, the locks,
 * the per-node dice and the history live.
 *
 * ## Registered as a toolbar item, not a panel
 *
 * `PanelId` in `app/slots.ts` is a closed union of the four names F-UI-08 gives,
 * and Surprise Me is not one of them — a fifth panel is a decision about the
 * shell's layout and belongs to whoever owns the shell. The toolbar registry is
 * open, and it is where export and documents already live.
 *
 * ## The button says why it cannot run
 *
 * Disabled with the reason in its tooltip, never enabled-and-silently-ignored.
 * The two reasons are real preconditions rather than caution: a surprise is
 * built against an open image (F-SM-01), and one of the three palette modes
 * draws from the hardware library (F-SM-05), which is read from the core at
 * startup. Falling back to the other two modes when the library is not there
 * would make one seed mean two different palettes depending on timing, which is
 * the one promise F-SM-02 makes.
 */
export interface SurpriseButtonProps {
  readonly store: SurpriseStore;
  readonly modulators: ModulatorSupport;
}

export function SurpriseButton({ store, modulators }: SurpriseButtonProps): React.ReactElement {
  const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [open, setOpen] = React.useState(false);
  const dialogRef = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const blocked = snapshot.ready.ready ? null : snapshot.ready.reason;

  return (
    <React.Fragment>
      <button
        type="button"
        className="ui-button sm__go"
        disabled={blocked !== null}
        title={
          blocked ??
          `Generate a complete random document against this image (${SURPRISE_SHORTCUT_LABEL})`
        }
        data-testid="surprise-me"
        onClick={() => store.surprise()}
      >
        {snapshot.busy ? "surprising…" : "surprise me"}
      </button>
      <button
        type="button"
        className="ui-button"
        aria-pressed={open}
        title="Seed, chaos, locks, per-node reroll and history"
        data-testid="open-surprise"
        onClick={() => setOpen(true)}
      >
        …
      </button>

      <dialog
        ref={dialogRef}
        className="sm-dialog"
        aria-label="Surprise Me"
        onClose={() => setOpen(false)}
      >
        <header className="sm-dialog__head">
          <span className="sm-dialog__title">surprise me</span>
          <div className="sm-dialog__actions">
            <button
              type="button"
              className="ui-button"
              disabled={blocked !== null}
              title={blocked ?? `Generate another (${SURPRISE_SHORTCUT_LABEL})`}
              data-testid="surprise-again"
              onClick={() => store.surprise()}
            >
              {snapshot.busy ? "surprising…" : "surprise"}
            </button>
            <button type="button" className="ui-button" onClick={() => setOpen(false)}>
              close
            </button>
          </div>
        </header>
        {blocked === null ? null : <p className="sm-dialog__blocked">{blocked}</p>}
        {open ? <SurprisePanel store={store} modulators={modulators} /> : null}
      </dialog>
    </React.Fragment>
  );
}
