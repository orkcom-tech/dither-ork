import React from "react";

import { logger } from "../../lib/log";
import type { DitherDocument } from "../../types/document";
import {
  DORK_MIME,
  PresetLibrary,
  SHARE_LINK_WARNING_CHARS,
  applyPreset,
  copyToClipboard,
  decodeSharePayload,
  decodeSniffedDocument,
  documentFileName,
  downloadTextFile,
  embeddedSourceFile,
  encodeDorkFile,
  encodeShareFragmentFor,
  encodeSourceDataUrl,
  isSelfContained,
  readTextFile,
  sharePayloadInHash,
  shareUrl,
  sniffDorkFile,
  withEmbeddedSource,
  withoutEmbeddedSource,
  type Preset,
} from "../../io/document";
import { PresetsSection } from "./PresetsSection";
import { formatBytes, textByteLength } from "./model";
import type { DocumentsDependencies } from "./store";
import "./documents.css";

const log = logger("app");

/** Only ever one document is open, so a share link needs only one identity. */
const SHARE_IDENTITY = {
  id: "shared",
  createdAt: "1970-01-01T00:00:00.000Z",
} as const;

type LibraryState =
  | { readonly kind: "unavailable" }
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly library: PresetLibrary }
  | { readonly kind: "failed"; readonly message: string };

interface Message {
  readonly kind: "notice" | "failure";
  readonly text: string;
}

/**
 * Documents, presets and sharing — F-DO-01 to F-DO-06.
 *
 * ## Why a toolbar item and a dialog rather than a panel
 *
 * `app/slots.ts` declares the panel ids as a closed union of the four F-UI-08
 * names, and a fifth is stated there to be a decision rather than an accident.
 * This is not one of those four — it is a set of *actions on the document*,
 * which is what the toolbar already holds — so it registers as a toolbar item
 * and opens a modal for the parts that need room.
 *
 * A native `<dialog>` with `showModal`, not a positioned `<div>`: the platform
 * gives the focus trap, the Escape key, the inert background and the top layer,
 * and every one of those is something a hand-built overlay gets subtly wrong.
 *
 * ## Every failure is stated, none is swallowed
 *
 * A `.dork` that will not open, a preset library that will not decode, a
 * clipboard the browser refused — each one lands in the same line at the top of
 * the dialog, and each is logged. The one thing that never happens is an action
 * that appears to work and did not.
 *
 * ## The incoming share link
 *
 * A link is *offered*, never applied. The page may have been opened with a
 * fragment while a document is already on screen, and taking it silently would
 * throw away work with no way back to it. The offer names the preset, and the
 * document store's undo covers the apply.
 */
export function DocumentsToolbar({
  deps,
}: {
  readonly deps: DocumentsDependencies;
}): React.ReactElement {
  const { store } = deps;
  const subscribe = React.useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  );
  const getSnapshot = React.useCallback(() => store.getSnapshot(), [store]);
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot);
  const document_ = snapshot.document;

  const [open, setOpen] = React.useState(false);
  const [message, setMessage] = React.useState<Message | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [library, setLibrary] = React.useState<LibraryState>(() =>
    deps.storage === null ? { kind: "unavailable" } : { kind: "idle" },
  );
  const [link, setLink] = React.useState<string | null>(null);
  const [incoming, setIncoming] = React.useState<Preset | null>(null);
  const dialogRef = React.useRef<HTMLDialogElement>(null);

  const fail = React.useCallback((error: unknown): void => {
    const text = error instanceof Error ? error.message : String(error);
    setMessage({ kind: "failure", text });
  }, []);
  const notice = React.useCallback((text: string): void => {
    setMessage({ kind: "notice", text });
  }, []);

  // --- the modal ----------------------------------------------------------

  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // --- the preset library, opened when it is first wanted -------------------

  React.useEffect(() => {
    if (!open || library.kind !== "idle") return;
    const storage = deps.storage;
    if (storage === null) return;
    setLibrary({ kind: "loading" });
    void PresetLibrary.open({ storage, registry: store.registry })
      .then((opened) => setLibrary({ kind: "ready", library: opened }))
      .catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        log.error("the preset library could not be opened", { error: text });
        setLibrary({ kind: "failed", message: text });
      });
  }, [open, library.kind, deps.storage, store.registry]);

  // --- an incoming share link (F-DO-06) ------------------------------------

  React.useEffect(() => {
    const payload = sharePayloadInHash(deps.hash);
    if (payload === null) return;
    let live = true;
    void decodeSharePayload(payload, store.registry)
      .then((preset) => {
        if (live) setIncoming(preset);
      })
      .catch((error: unknown) => {
        // A damaged link is worth saying out loud: the person followed it
        // expecting something, and silence reads as the application ignoring
        // them.
        if (live) fail(error);
      });
    return () => {
      live = false;
    };
  }, [deps.hash, store.registry, fail]);

  // --- document actions ----------------------------------------------------

  const load = (next: DitherDocument, label: string): void => {
    store.loadDocument(next, label);
  };

  const saveDocument = (): void => {
    const referenced = withoutEmbeddedSource(document_);
    const text = encodeDorkFile(referenced);
    downloadTextFile(documentFileName(referenced), text, DORK_MIME);
    notice(
      `Saved ${documentFileName(referenced)} — ${formatBytes(textByteLength(text))}. ` +
        `It names "${referenced.source?.name ?? "no image"}" rather than carrying it.`,
    );
  };

  const saveSelfContained = (): void => {
    const image = snapshot.source;
    if (image === null) return;
    setBusy(true);
    void (async () => {
      const embedded = withEmbeddedSource(document_, await encodeSourceDataUrl(image));
      const text = encodeDorkFile(embedded);
      downloadTextFile(documentFileName(embedded, { selfContained: true }), text, DORK_MIME);
      notice(
        `Saved ${documentFileName(embedded, { selfContained: true })} — ` +
          `${formatBytes(textByteLength(text))}, with the picture inside it as PNG.`,
      );
    })()
      .catch(fail)
      .finally(() => setBusy(false));
  };

  const openDocumentFile = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0] ?? null;
    // Cleared so that choosing the same file twice fires `change` the second
    // time — without it the second choice is silent.
    event.target.value = "";
    if (file === null) return;

    setBusy(true);
    void (async () => {
      const text = await readTextFile(file);
      const document = decodeSniffedDocument(sniffDorkFile(text, file.name), store.registry, file.name);

      // The recipe first, then the picture. `openImageFile` rewrites the source
      // reference across the history, so doing it in this order leaves exactly
      // one document naming exactly the image that is loaded — and drops the
      // base64 copy, which would otherwise go through the autosave writer every
      // 1.5 seconds for a picture already decoded.
      load(withoutEmbeddedSource(document), `Open ${file.name}`);

      if (isSelfContained(document)) {
        await deps.openImageFile(embeddedSourceFile(document));
        notice(`Opened ${file.name}, with the image it carries.`);
        return;
      }
      const named = document.source?.name ?? null;
      notice(
        named === null
          ? `Opened ${file.name}.`
          : `Opened ${file.name}. It was built on "${named}" — open that image to see it, ` +
            `as a .dork carries the recipe and not the picture.`,
      );
    })()
      .catch(fail)
      .finally(() => setBusy(false));
  };

  // --- sharing (F-DO-06) ---------------------------------------------------

  const makeLink = (): void => {
    setBusy(true);
    void (async () => {
      const payload = await encodeShareFragmentFor(document_, {
        ...SHARE_IDENTITY,
        name: document_.source?.name ?? "Shared stack",
      });
      const url = shareUrl(deps.href, payload);
      setLink(url);
      await copyToClipboard(url);
      notice(
        url.length > SHARE_LINK_WARNING_CHARS
          ? `Link copied — ${url.length} characters, which is long enough that some chat and ` +
            `mail clients will break it. Send it as a file if it does not survive.`
          : `Link copied — ${url.length} characters. The stack is in the fragment, which is ` +
            `never sent to a server, and the image is not in it at all.`,
      );
    })()
      .catch(fail)
      .finally(() => setBusy(false));
  };

  const takeIncoming = (preset: Preset): void => {
    load(applyPreset(preset, document_), `Shared preset: ${preset.name}`);
    setIncoming(null);
    notice(`Applied the shared preset "${preset.name}".`);
  };

  // --- rendering -----------------------------------------------------------

  return (
    <React.Fragment>
      <button
        type="button"
        className="ui-button"
        disabled={busy}
        title="Save this document as a .dork file (F-DO-01)"
        onClick={saveDocument}
      >
        save
      </button>

      <label className="ui-button documents__file" title="Open a .dork document">
        <input
          type="file"
          accept=".dork,.json,application/json"
          onChange={openDocumentFile}
          data-testid="open-document"
        />
        open
      </label>

      <button
        type="button"
        className="ui-button"
        aria-pressed={open}
        title="Presets, the self-contained variant, and the share link"
        onClick={() => setOpen(true)}
      >
        presets
      </button>

      {incoming === null ? null : (
        <button
          type="button"
          className="documents__incoming"
          title={`Apply the shared preset "${incoming.name}" to the open document`}
          onClick={() => takeIncoming(incoming)}
        >
          apply shared preset “{incoming.name}”
        </button>
      )}

      <dialog
        ref={dialogRef}
        className="documents"
        aria-label="Documents and presets"
        onClose={() => setOpen(false)}
      >
        <header className="documents__head">
          <h2 className="ui-label">Documents &amp; presets</h2>
          <button type="button" className="ui-button" onClick={() => setOpen(false)}>
            close
          </button>
        </header>

        {message === null ? null : (
          <button
            type="button"
            className={
              message.kind === "failure"
                ? "documents__message documents__message--failure"
                : "documents__message"
            }
            title="Dismiss"
            onClick={() => setMessage(null)}
          >
            {message.text}
          </button>
        )}

        <section className="documents__section">
          <h3 className="ui-label">This document</h3>
          <p className="documents__note">
            A <code>.dork</code> holds the stack, the parameters, the palette, the clock and
            the bindings. It <em>names</em> the image rather than carrying it, so it stays
            small and stays yours to move around.
          </p>
          <div className="documents__row">
            <button type="button" className="ui-button" disabled={busy} onClick={saveDocument}>
              save .dork
            </button>
            <button
              type="button"
              className="ui-button"
              disabled={busy || snapshot.source === null}
              title={
                snapshot.source === null
                  ? "Open an image first — there is nothing to put inside the file"
                  : "Write the picture into the file as PNG, so it opens anywhere on its own"
              }
              onClick={saveSelfContained}
            >
              save with the image
            </button>
          </div>
          {snapshot.source === null ? (
            <p className="documents__note">
              No image is open, so the self-contained variant has nothing to carry.
            </p>
          ) : (
            <p className="documents__note">
              The self-contained variant re-encodes “{snapshot.source.name}” as PNG. A photograph
              that arrived as JPEG comes out several times larger; that is the price of the file
              standing on its own.
            </p>
          )}
        </section>

        <section className="documents__section">
          <h3 className="ui-label">Share</h3>
          <p className="documents__note">
            The whole recipe goes in the link’s <code>#</code> fragment, which browsers never
            send to a server. <strong>The image is never included</strong> — what travels is a
            preset, which has no picture in it by construction.
          </p>
          <div className="documents__row">
            <button type="button" className="ui-button" disabled={busy} onClick={makeLink}>
              copy share link
            </button>
          </div>
          {link === null ? null : (
            <input
              className="documents__input documents__link"
              type="text"
              readOnly
              value={link}
              aria-label="Share link"
              onFocus={(event) => event.currentTarget.select()}
            />
          )}
        </section>

        {library.kind === "unavailable" ? (
          <section className="documents__section">
            <h3 className="ui-label">Presets</h3>
            <p className="documents__note">
              Saved presets need origin-private storage (OPFS), which this browser does not
              have. Saving documents and share links are unaffected.
            </p>
          </section>
        ) : library.kind === "failed" ? (
          <section className="documents__section">
            <h3 className="ui-label">Presets</h3>
            <p className="documents__message documents__message--failure">{library.message}</p>
          </section>
        ) : library.kind === "ready" ? (
          <PresetsSection
            library={library.library}
            registry={store.registry}
            document={document_}
            onApply={load}
            onError={fail}
            onNotice={notice}
          />
        ) : (
          <section className="documents__section">
            <h3 className="ui-label">Presets</h3>
            <p className="documents__note">Reading the library…</p>
          </section>
        )}
      </dialog>
    </React.Fragment>
  );
}
