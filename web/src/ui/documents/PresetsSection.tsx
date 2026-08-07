import React from "react";

import { logger } from "../../lib/log";
import type { EffectRegistry } from "../../registry";
import type { DitherDocument } from "../../types/document";
import {
  PRESET_EXTENSION,
  PRESET_MIME,
  applyPreset,
  downloadTextFile,
  readTextFile,
  safeFileStem,
  type Preset,
  type PresetLibrary,
} from "../../io/document";
import { presetSummary, searchPresets, suggestPresetName } from "./model";

const log = logger("app");

export interface PresetsSectionProps {
  readonly library: PresetLibrary;
  readonly registry: EffectRegistry;
  /** The open document — what "save current" saves and what "apply" is applied to. */
  readonly document: DitherDocument;
  readonly onApply: (document: DitherDocument, label: string) => void;
  readonly onError: (error: unknown) => void;
  readonly onNotice: (message: string) => void;
}

/**
 * The preset library — F-DO-03 (browse, apply, rename, delete) and F-DO-05
 * (import and export as one file).
 *
 * ## Rename is an edit in place, not a dialog
 *
 * A row's name becomes a text box when the rename button is pressed, and commits
 * on Enter or on blur. A second modal over the modal is a worse version of the
 * same thing, and it is where a rename that quietly did nothing hides.
 *
 * ## Delete asks, and asks in the row
 *
 * Deleting a preset is the one irreversible thing in this panel — the document
 * store's undo has no idea the library exists. So the button becomes "sure?" and
 * has to be pressed again, in the row, with the name still under the pointer.
 * A `window.confirm` would say "Are you sure?" over a dialog that has already
 * been dismissed by the time the browser draws it.
 *
 * ## Built-ins have no rename and no delete
 *
 * Not disabled buttons — absent ones. The starter set is not stored, so there is
 * nothing to change; a greyed button implies a permission that could be granted.
 */
export function PresetsSection({
  library,
  registry,
  document: openDocument,
  onApply,
  onError,
  onNotice,
}: PresetsSectionProps): React.ReactElement {
  const [presets, setPresets] = React.useState<readonly Preset[]>(() => library.list());
  const [query, setQuery] = React.useState("");
  const [name, setName] = React.useState(() => suggestPresetName(openDocument, registry));
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [renameTo, setRenameTo] = React.useState("");
  const [confirmingDelete, setConfirmingDelete] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    setPresets(library.list());
    return library.subscribe(() => setPresets(library.list()));
  }, [library]);

  const shown = React.useMemo(
    () => searchPresets(presets, query, registry),
    [presets, query, registry],
  );

  /** Every library call goes through here, so no failure path is silent. */
  const run = (what: string, action: () => Promise<void>): void => {
    setBusy(true);
    void action()
      .catch((error: unknown) => {
        log.error(`preset ${what} failed`, {
          error: error instanceof Error ? error.message : String(error),
        });
        onError(error);
      })
      .finally(() => setBusy(false));
  };

  const saveCurrent = (): void => {
    run("save", async () => {
      const saved = await library.save(name, openDocument);
      log.info("preset saved", { id: saved.id, name: saved.name, nodes: saved.document.stack.length });
      onNotice(`Saved "${saved.name}".`);
    });
  };

  const apply = (preset: Preset): void => {
    log.info("preset applied", { id: preset.id, name: preset.name });
    onApply(applyPreset(preset, openDocument), `Preset: ${preset.name}`);
    onNotice(`Applied "${preset.name}".`);
  };

  const commitRename = (preset: Preset): void => {
    const wanted = renameTo;
    setRenaming(null);
    if (wanted.trim() === preset.name) return;
    run("rename", async () => {
      const renamed = await library.rename(preset.id, wanted);
      onNotice(`Renamed to "${renamed.name}".`);
    });
  };

  const remove = (preset: Preset): void => {
    setConfirmingDelete(null);
    run("delete", async () => {
      await library.remove(preset.id);
      onNotice(`Deleted "${preset.name}".`);
    });
  };

  const exportAll = (): void => {
    const saved = library.saved();
    if (saved.length === 0) {
      onNotice("There is nothing saved to export yet — the starter presets ship with the build.");
      return;
    }
    downloadTextFile(`presets${PRESET_EXTENSION}`, library.exportFile(), PRESET_MIME);
    onNotice(`Exported ${saved.length} preset${saved.length === 1 ? "" : "s"}.`);
  };

  const exportOne = (preset: Preset): void => {
    // The same sanitiser a `.dork` is named with, rather than a second regex
    // over here: a preset called "3/4 tone" must not propose a path.
    downloadTextFile(
      `${safeFileStem(preset.name, preset.id)}${PRESET_EXTENSION}`,
      library.exportFile([preset.id]),
      PRESET_MIME,
    );
  };

  const importFile = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (file === null) return;
    run("import", async () => {
      const added = await library.importPresets(await readTextFile(file), file.name);
      onNotice(`Imported ${added.length} preset${added.length === 1 ? "" : "s"} from "${file.name}".`);
    });
  };

  return (
    <section className="documents__section">
      <h3 className="ui-label">Presets</h3>

      <div className="documents__row">
        <input
          className="documents__input"
          type="text"
          value={name}
          placeholder="Name this stack"
          aria-label="Preset name"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && name.trim().length > 0) saveCurrent();
          }}
          data-testid="preset-name"
        />
        <button
          type="button"
          className="ui-button"
          disabled={busy || name.trim().length === 0}
          title="Save the open stack, palette and clock — without the image"
          onClick={saveCurrent}
        >
          save preset
        </button>
      </div>

      <div className="documents__row">
        <input
          className="documents__input"
          type="search"
          value={query}
          placeholder={`Search ${presets.length} preset${presets.length === 1 ? "" : "s"}`}
          aria-label="Search presets"
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className="ui-button documents__file" title="Import a preset file (F-DO-05)">
          <input type="file" accept={PRESET_EXTENSION + ",.json,application/json"} onChange={importFile} />
          import
        </label>
        <button
          type="button"
          className="ui-button"
          disabled={busy}
          title="Export everything you have saved as one file"
          onClick={exportAll}
        >
          export
        </button>
      </div>

      {shown.length === 0 ? (
        <p className="documents__note">
          {presets.length === 0
            ? "No presets."
            : `Nothing matches "${query}".`}
        </p>
      ) : (
        <ul className="documents__list ui-scroll">
          {shown.map((preset) => (
            <li key={preset.id} className="documents__preset">
              <div className="documents__preset-head">
                {renaming === preset.id ? (
                  <input
                    className="documents__input"
                    type="text"
                    value={renameTo}
                    autoFocus
                    aria-label={`Rename ${preset.name}`}
                    onChange={(event) => setRenameTo(event.target.value)}
                    onBlur={() => commitRename(preset)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitRename(preset);
                      if (event.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="documents__preset-name">
                    {preset.name}
                    {preset.builtin ? <span className="documents__badge">starter</span> : null}
                  </span>
                )}
                <button
                  type="button"
                  className="ui-button"
                  disabled={busy}
                  title="Replace the open stack, palette and clock with this one"
                  onClick={() => apply(preset)}
                >
                  apply
                </button>
              </div>

              <p className="documents__preset-note">{presetSummary(preset, registry)}</p>
              {preset.note === null ? null : (
                <p className="documents__preset-note">{preset.note}</p>
              )}

              <div className="documents__preset-actions">
                <button
                  type="button"
                  className="ui-button"
                  onClick={() => exportOne(preset)}
                  title="Write this one preset to a file"
                >
                  export
                </button>
                {preset.builtin ? null : (
                  <React.Fragment>
                    <button
                      type="button"
                      className="ui-button"
                      disabled={busy}
                      onClick={() => {
                        setRenameTo(preset.name);
                        setRenaming(preset.id);
                      }}
                    >
                      rename
                    </button>
                    <button
                      type="button"
                      className="ui-button"
                      disabled={busy}
                      aria-pressed={confirmingDelete === preset.id}
                      title={
                        confirmingDelete === preset.id
                          ? "Press again to delete — the document's undo does not reach the library"
                          : "Delete this preset"
                      }
                      onClick={() => {
                        if (confirmingDelete === preset.id) remove(preset);
                        else setConfirmingDelete(preset.id);
                      }}
                    >
                      {confirmingDelete === preset.id ? "sure?" : "delete"}
                    </button>
                  </React.Fragment>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
