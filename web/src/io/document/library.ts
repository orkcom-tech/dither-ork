/**
 * The preset library — F-DO-03's browse, apply, rename and delete, plus
 * F-DO-05's import and export.
 *
 * ## Two kinds of entry, and only one of them is stored
 *
 * The starter set (F-DO-04) is **built, not seeded**. It is materialised from
 * `starter.ts` every time the library opens and merged in front of whatever was
 * saved, and nothing ever writes it to disk. Seeding a store with it instead
 * would mean a starter preset somebody deleted comes back on the next reload,
 * or does not, depending on a "seeded" flag that is itself a thing to get wrong.
 * Built-ins are applied and exported like any other preset; rename and delete
 * refuse them by name, because there is no stored record to change.
 *
 * This is the same arrangement the palette system uses for the hardware
 * palettes, and it is here for the same reason.
 *
 * ## One file, rewritten
 *
 * Same choice as the autosave: the whole library is one JSON document, written
 * whole. A library is tens of kilobytes and every mutation is a user action, so
 * there is nothing to gain from partial writes and a real failure mode to avoid
 * — a half-applied edit across several records is a library that decodes and is
 * not the one that was saved.
 *
 * ## A store that cannot be read is not overwritten
 *
 * {@link PresetLibrary.open} throws when the stored text is there and will not
 * decode, and the library is not constructed, so nothing can then write over it.
 * The alternative — opening empty and carrying on — destroys the file on the
 * next save, which is the one outcome that loses work. The message names the
 * file so it can be retrieved or removed deliberately.
 */

import type { DitherDocument } from "../../types/document";
import type { EffectRegistry } from "../../registry";
import { logger } from "../../lib/log";
import { DocumentFileError } from "./errors";
import { parseJsonObject } from "./file";
import {
  decodePresetRecord,
  encodePresetFile,
  nextPresetId,
  presetFromDocument,
  requireName,
  type Preset,
} from "./preset";
import { buildStarterPresets } from "./starter";

const log = logger("io");

/** Where the library lives. One file, overwritten in place. */
export const PRESET_LIBRARY_FILE_NAME = "presets.dorkpresets.json";

export interface PresetStorage {
  /** The stored text, or `null` when there is none. */
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

/**
 * OPFS, through the same handles the autosave writer uses.
 *
 * `createWritable` rather than `createSyncAccessHandle` for the same reason
 * stated in `state/autosave.ts`: the synchronous handle is worker-only and this
 * runs on the main thread with the rest of the UI.
 */
export function opfsPresetStorage(
  fileName: string = PRESET_LIBRARY_FILE_NAME,
): PresetStorage {
  const root = async (): Promise<FileSystemDirectoryHandle> =>
    navigator.storage.getDirectory();

  return {
    async read(): Promise<string | null> {
      try {
        const directory = await root();
        const handle = await directory.getFileHandle(fileName);
        const text = await (await handle.getFile()).text();
        log.info("preset library read", { file: fileName, bytes: text.length });
        return text;
      } catch (error) {
        // A fresh origin has no library, which is the common case and not a
        // failure.
        if (error instanceof DOMException && error.name === "NotFoundError") {
          log.debug("no preset library stored yet", { file: fileName });
          return null;
        }
        log.error("the preset library could not be read", {
          file: fileName,
          error: String(error),
        });
        throw error;
      }
    },

    async write(text: string): Promise<void> {
      const directory = await root();
      const handle = await directory.getFileHandle(fileName, { create: true });
      const writable = await handle.createWritable();
      try {
        await writable.write(text);
      } finally {
        // Closing is what commits the file; skipping it on the error path leaves
        // a lock and a zero-length library, which is worse than none.
        await writable.close();
      }
      log.info("preset library written", { file: fileName, bytes: text.length });
    },
  };
}

/**
 * Whether this browser has OPFS, and therefore a place to keep presets.
 *
 * The autosave writer asks the same question and `state/autosave.ts` already
 * answers it. Re-exported rather than re-implemented: two copies of a
 * capability check are two answers the day one of them is updated, and the
 * symptom would be a panel offering to save presets into a store that is not
 * there.
 */
export { hasOpfs as hasPresetStorage } from "../../state/autosave";

export interface PresetLibraryOptions {
  readonly storage: PresetStorage;
  readonly registry: EffectRegistry;
  /**
   * The clock the library stamps `createdAt` with. Injected so the library's
   * own tests can assert on whole files rather than on shapes.
   */
  readonly now?: () => Date;
  /** The starter set. Overridden only by tests; the application takes the default. */
  readonly builtins?: readonly Preset[];
}

export class PresetLibrary {
  readonly #storage: PresetStorage;
  readonly #registry: EffectRegistry;
  readonly #now: () => Date;
  readonly #builtins: readonly Preset[];
  readonly #listeners = new Set<() => void>();

  #saved: readonly Preset[];
  #snapshot: readonly Preset[];

  private constructor(
    options: PresetLibraryOptions,
    builtins: readonly Preset[],
    saved: readonly Preset[],
  ) {
    this.#storage = options.storage;
    this.#registry = options.registry;
    this.#now = options.now ?? ((): Date => new Date());
    this.#builtins = builtins;
    this.#saved = saved;
    this.#snapshot = this.#build();
  }

  /**
   * Read the store and build the library.
   *
   * Not the constructor, because reading is asynchronous and a constructor that
   * returned an object still loading would hand the UI a library whose `list()`
   * is momentarily wrong.
   */
  static async open(options: PresetLibraryOptions): Promise<PresetLibrary> {
    const builtins = options.builtins ?? buildStarterPresets(options.registry);
    const text = await options.storage.read();

    let stored: readonly Preset[] = [];
    if (text !== null && text.trim().length > 0) {
      try {
        stored = decodePresetRecord(
          parseJsonObject(text, "the stored preset library"),
          options.registry,
          "the stored preset library",
        );
      } catch (error) {
        throw new DocumentFileError(
          "library-unreadable",
          `the saved preset library could not be read, so it is left untouched rather than ` +
            `overwritten: ${error instanceof Error ? error.message : String(error)} ` +
            `It is the browser's origin-private file "${PRESET_LIBRARY_FILE_NAME}".`,
          { bytes: text.length },
        );
      }
    }

    log.info("preset library open", { builtin: builtins.length, saved: stored.length });
    return new PresetLibrary(options, builtins, stored);
  }

  // --- reading ------------------------------------------------------------

  /**
   * Everything, built-ins first and saved presets newest first.
   *
   * Referentially stable until something changes, so the panel can read it
   * through `useSyncExternalStore` without rendering forever.
   */
  list(): readonly Preset[] {
    return this.#snapshot;
  }

  /** Just what a person saved. What `export` writes when nothing is selected. */
  saved(): readonly Preset[] {
    return this.#saved;
  }

  get(id: string): Preset | undefined {
    return this.#snapshot.find((preset) => preset.id === id);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  // --- writing ------------------------------------------------------------

  /**
   * Save the open document's recipe under a name (F-DO-03).
   *
   * The image reference is dropped by `presetFromDocument`; nothing here has to
   * remember to do it.
   */
  async save(
    name: string,
    document: DitherDocument,
    note: string | null = null,
  ): Promise<Preset> {
    const preset = presetFromDocument(document, {
      id: nextPresetId(this.#saved.map((entry) => entry.id)),
      name: requireName(name),
      createdAt: this.#now().toISOString(),
      note,
    });
    // Newest first, which is where somebody looks for the thing they just saved.
    await this.#commit([preset, ...this.#saved], `saved "${preset.name}"`);
    return preset;
  }

  async rename(id: string, name: string): Promise<Preset> {
    const next = requireName(name);
    const preset = this.#requireSaved(id, "renamed");
    if (preset.name === next) return preset;
    const renamed: Preset = { ...preset, name: next };
    await this.#commit(
      this.#saved.map((entry) => (entry.id === id ? renamed : entry)),
      `renamed "${preset.name}" to "${next}"`,
    );
    return renamed;
  }

  async remove(id: string): Promise<void> {
    const preset = this.#requireSaved(id, "deleted");
    await this.#commit(
      this.#saved.filter((entry) => entry.id !== id),
      `deleted "${preset.name}"`,
    );
  }

  // --- one file in, one file out (F-DO-05) ---------------------------------

  /**
   * Export a selection, or everything saved.
   *
   * Built-ins are exported when they are asked for by id — they are perfectly
   * good presets and somebody who selected one meant it — but "export my
   * library" with no selection writes only what was saved, because a file that
   * silently carried this build's starter set would import six duplicates into
   * the next machine.
   */
  exportFile(ids?: readonly string[]): string {
    if (ids === undefined) return encodePresetFile(this.#saved);
    const chosen: Preset[] = [];
    for (const id of ids) {
      const preset = this.get(id);
      if (preset === undefined) {
        throw new DocumentFileError(
          "unknown-preset",
          `there is no preset with the id "${id}" to export.`,
          { id },
        );
      }
      chosen.push(preset);
    }
    return encodePresetFile(chosen);
  }

  /**
   * Import a preset file (F-DO-05).
   *
   * **Ids are reassigned, names are not.** An id is this library's internal
   * handle and two files written on two machines will collide on `p1`
   * immediately; a name is what the person wrote, and rewriting it to
   * "Something (2)" would be the import editing their work. Two presets with the
   * same name is a thing a person can see and fix, which a silently renamed one
   * is not.
   *
   * A file with one unreadable preset in it is refused whole. Importing the four
   * that decoded would leave somebody believing they had five.
   */
  async importPresets(
    text: string,
    what = "the imported file",
  ): Promise<readonly Preset[]> {
    const incoming = decodePresetRecord(
      parseJsonObject(text, what),
      this.#registry,
      what,
    );
    if (incoming.length === 0) {
      throw new DocumentFileError("malformed-preset", `${what} contains no presets.`);
    }

    const added: Preset[] = [];
    let ids = this.#saved.map((entry) => entry.id);
    for (const preset of incoming) {
      const id = ids.includes(preset.id) ? nextPresetId(ids) : preset.id;
      if (id !== preset.id) {
        log.info("imported preset re-identified", { was: preset.id, now: id, name: preset.name });
      }
      ids = [...ids, id];
      added.push({ ...preset, id, builtin: false });
    }

    await this.#commit(
      [...added, ...this.#saved],
      `imported ${added.length} preset${added.length === 1 ? "" : "s"}`,
    );
    return added;
  }

  // --- internals ----------------------------------------------------------

  #requireSaved(id: string, verb: string): Preset {
    const preset = this.get(id);
    if (preset === undefined) {
      throw new DocumentFileError(
        "unknown-preset",
        `there is no preset with the id "${id}".`,
        { id },
      );
    }
    if (preset.builtin) {
      throw new DocumentFileError(
        "builtin-preset",
        `"${preset.name}" is one of the presets this build ships with, so it cannot be ` +
          `${verb}. Apply it and save your own version instead.`,
        { id, name: preset.name },
      );
    }
    return preset;
  }

  #build(): readonly Preset[] {
    return [...this.#builtins, ...this.#saved];
  }

  /**
   * Write first, then change what the list says.
   *
   * The order is the whole of it. A library that updated in memory and then
   * failed to write would show a preset that is not saved, and the next reload
   * would silently take it away again — the failure that looks like the
   * application losing work at random. Writing first means a storage failure
   * reaches the caller with nothing changed, and the message says the save did
   * not happen because it did not.
   */
  async #commit(next: readonly Preset[], what: string): Promise<void> {
    await this.#storage.write(encodePresetFile(next));
    this.#saved = next;
    this.#snapshot = this.#build();
    log.info(`preset library ${what}`, { saved: this.#saved.length });
    for (const listener of this.#listeners) listener();
  }
}
