import React from "react";

import { logger } from "../lib/log";
import type { EditorSession } from "../state";
import { IMAGE_ACCEPT_ATTRIBUTE } from "../io";
import { registerToolbarItem } from "./slots";
import { useViewport } from "./ViewportHost";
import "./toolbar.css";

const log = logger("app");

/**
 * The toolbar — the actions that belong to the document rather than to a panel.
 *
 * Open, undo, redo, fit, and the one place a failure is stated to the user.
 * Registered from `main.tsx` once the session exists, through the same slot
 * registry the panels use, so this file is not something the shell imports.
 */
export function registerToolbar(session: EditorSession): void {
  registerToolbarItem({
    id: "open",
    side: "start",
    order: 0,
    component: () => <OpenImage session={session} />,
  });
  registerToolbarItem({
    id: "history",
    side: "start",
    order: 1,
    component: () => <HistoryControls session={session} />,
  });
  registerToolbarItem({
    id: "view",
    side: "start",
    order: 2,
    component: () => <ViewControls />,
  });
  registerToolbarItem({
    id: "notices",
    side: "end",
    order: 0,
    component: () => <Notices session={session} />,
  });
  log.info("toolbar registered");
}

/**
 * Open an image (F-IN-01).
 *
 * A real `<input type="file">` in the document, inside its own label, rather
 * than an input synthesised and clicked from script. Three things follow from
 * that and each is the reason: the label makes it keyboard-reachable and
 * screen-reader-labelled without an `aria-` attribute pretending to be one; the
 * element persists, so the browser's own "no file chosen" state and the
 * `cancel` event behave as the platform defines them; and it is drivable — a
 * test can put a file into it, which an input that exists for one turn of the
 * event loop cannot offer.
 *
 * `value` is cleared after each choice so that picking the *same* file twice in
 * a row fires `change` the second time. Without it the second choice is silent,
 * which reads as the application having ignored it.
 */
function OpenImage({ session }: { readonly session: EditorSession }): React.ReactElement {
  const [busy, setBusy] = React.useState(false);

  const onChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (file === null) {
      log.debug("file input produced no file");
      return;
    }
    log.info("file chosen", { name: file.name, bytes: file.size });
    setBusy(true);
    void session
      .openFile(file)
      .finally(() => setBusy(false));
  };

  return (
    <label className="ui-button toolbar__file" title="Open an image (PNG, JPEG, WebP, BMP, GIF)">
      <input
        type="file"
        accept={IMAGE_ACCEPT_ATTRIBUTE}
        onChange={onChange}
        data-testid="open-image"
      />
      {busy ? "opening…" : "open image"}
    </label>
  );
}

/** Undo and redo (F-ST-04), labelled with what they would do. */
function HistoryControls({
  session,
}: {
  readonly session: EditorSession;
}): React.ReactElement {
  const snapshot = React.useSyncExternalStore(
    session.store.subscribe,
    session.store.getSnapshot,
  );

  return (
    <React.Fragment>
      <button
        type="button"
        className="ui-button"
        disabled={!snapshot.canUndo}
        title={snapshot.undoLabel === null ? "Nothing to undo" : `Undo ${snapshot.undoLabel}`}
        onClick={() => session.store.undo()}
      >
        undo
      </button>
      <button
        type="button"
        className="ui-button"
        disabled={!snapshot.canRedo}
        title={snapshot.redoLabel === null ? "Nothing to redo" : `Redo ${snapshot.redoLabel}`}
        onClick={() => session.store.redo()}
      >
        redo
      </button>
    </React.Fragment>
  );
}

/**
 * Fit and 100%.
 *
 * The viewport carries its own overlay with the same two buttons; these are
 * here because the overlay sits on the picture and a toolbar is where somebody
 * looks for them. Both call the same methods — there is no second zoom model.
 */
function ViewControls(): React.ReactElement | null {
  const viewport = useViewport();
  if (viewport === null) return null;
  return (
    <React.Fragment>
      <button
        type="button"
        className="ui-button"
        title="Fit the image in the viewport (0)"
        onClick={() => viewport.zoomToFit()}
      >
        fit
      </button>
      <button
        type="button"
        className="ui-button"
        title="Zoom to 100% (1)"
        onClick={() => viewport.zoomTo(1, undefined, "toolbar")}
      >
        100%
      </button>
    </React.Fragment>
  );
}

/**
 * The one place a failure reaches the user.
 *
 * Two kinds of notice share it because they are the same shape — a sentence
 * about something that already happened: an error out of the intake or the
 * renderer, and the restored-from-autosave notice F-DO-07 requires. The error
 * wins when both are present, because it is the one that is about right now.
 *
 * The error clears itself when the next render succeeds, as well as on a click.
 * A banner that only a click removes is one that goes on describing a state the
 * application has already left.
 */
function Notices({ session }: { readonly session: EditorSession }): React.ReactElement | null {
  const snapshot = React.useSyncExternalStore(
    session.store.subscribe,
    session.store.getSnapshot,
  );
  const [error, setError] = React.useState<Error | null>(null);

  React.useEffect(() => session.onError(setError), [session]);

  if (error !== null) {
    return (
      <button
        type="button"
        className="toolbar__notice toolbar__notice--error"
        title={`${error.message} — click to dismiss`}
        onClick={() => setError(null)}
      >
        {error.message}
      </button>
    );
  }

  if (snapshot.restored !== null) {
    return (
      <button
        type="button"
        className="toolbar__notice"
        title={`${snapshot.restored.message} — click to dismiss`}
        onClick={() => session.store.dismissRestoreNotice()}
      >
        restored from autosave
      </button>
    );
  }

  return null;
}

/**
 * Undo and redo from the keyboard (F-UI-07).
 *
 * Installed on the window rather than on a React element because the shortcut
 * has to work wherever focus is — the stack list, the viewport, nothing at all.
 * A keystroke aimed at a text field is left alone: undo inside an input is the
 * browser's, and stealing it would make a mistyped hex value unrecoverable.
 *
 * Returns the uninstaller.
 */
export function installHistoryShortcuts(session: EditorSession): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    if (event.key.toLowerCase() !== "z") return;
    if (isTextEntry(event.target)) return;

    event.preventDefault();
    const redo = event.shiftKey;
    const moved = redo ? session.store.redo() : session.store.undo();
    log.info(redo ? "redo requested" : "undo requested", { moved, source: "keyboard" });
  };

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
