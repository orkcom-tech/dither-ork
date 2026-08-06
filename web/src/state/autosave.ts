/**
 * F-DO-07 — autosave to OPFS, restore on reload, and say so.
 *
 * The requirement has three parts and the third is the one that is usually
 * skipped: **an explicit restored-from-autosave notice.** A document that comes
 * back silently is indistinguishable from a document that was never closed, and
 * the first time somebody sees a stack they do not remember building, they have
 * no way to know whether the application restored something or invented it. So
 * the restore is a fact the store carries and the UI states, with the time it
 * was saved, until it is dismissed.
 *
 * **The image is not in it.** A `.dork` references its source and does not embed
 * it (F-DO-01), and the autosave record is a `.dork`. So a restore brings back
 * the stack, the parameters, the palette and the clock, and names the image it
 * was built against — and the notice says that too, because a restored document
 * with no picture under it is otherwise just an application that looks broken.
 *
 * **OPFS only.** docs/API.md section 7 names IndexedDB as the non-fatal
 * degradation when OPFS is missing, and that half is **not built**. Where OPFS
 * is unavailable, autosave is off and the capability report already states it in
 * the status bar — which is a stated absence rather than a silent one, but it is
 * an absence, and it is recorded here rather than in a commit message.
 *
 * The storage interface exists so the scheduling and the record format can be
 * tested without a browser: {@link opfsAutosaveStorage} is the only
 * implementation the application uses.
 */

import type { DitherDocument } from "../types/document";
import type { EffectRegistry } from "../registry";
import { logger } from "../lib/log";
import { DocumentError } from "./errors";
import { decodeDocument, encodeDocument } from "./serialize";

const log = logger("io");

/** Where an autosave lives. One file, overwritten in place. */
export const AUTOSAVE_FILE_NAME = "autosave.dork.json";

/** How long after the last edit the write happens. */
export const AUTOSAVE_DEBOUNCE_MS = 1_500;

export interface AutosaveStorage {
  /** The stored text, or `null` when there is none. */
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
  clear(): Promise<void>;
}

/** The record as it is written. A `.dork` plus when it was saved. */
export interface AutosaveRecord {
  readonly savedAt: string;
  readonly document: DitherDocument;
}

export interface RestoredAutosave {
  readonly document: DitherDocument;
  readonly savedAt: Date;
  /** Name of the image the document was built against, or `null`. */
  readonly sourceName: string | null;
}

/**
 * OPFS through the File System Access handles on the origin-private root.
 *
 * `createWritable` rather than `createSyncAccessHandle`: the synchronous handle
 * is worker-only and this runs on the main thread with the rest of the store.
 * When the render loop moves to a worker (see the note in
 * `state/render/renderer.ts`), the autosave writer is the one piece that would
 * rather go with it, because the sync handle avoids the copy this makes.
 */
export function opfsAutosaveStorage(
  fileName: string = AUTOSAVE_FILE_NAME,
): AutosaveStorage {
  const root = async (): Promise<FileSystemDirectoryHandle> =>
    navigator.storage.getDirectory();

  return {
    async read(): Promise<string | null> {
      try {
        const directory = await root();
        const handle = await directory.getFileHandle(fileName);
        const file = await handle.getFile();
        const text = await file.text();
        log.info("autosave read", { file: fileName, bytes: text.length });
        return text;
      } catch (error) {
        // The first run of a fresh origin has no file, which is not a failure
        // and is the overwhelmingly common case.
        if (error instanceof DOMException && error.name === "NotFoundError") {
          log.debug("no autosave present", { file: fileName });
          return null;
        }
        log.error("autosave could not be read", { file: fileName, error: String(error) });
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
        // Closing is what commits the file; skipping it on the error path
        // leaves a lock and a zero-length autosave, which is worse than none.
        await writable.close();
      }
      log.debug("autosave written", { file: fileName, bytes: text.length });
    },

    async clear(): Promise<void> {
      try {
        const directory = await root();
        await directory.removeEntry(fileName);
        log.info("autosave cleared", { file: fileName });
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") return;
        log.error("autosave could not be cleared", { file: fileName, error: String(error) });
        throw error;
      }
    },
  };
}

/** Whether this browser has OPFS at all. The capability report says so too. */
export function hasOpfs(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "storage" in navigator &&
    typeof navigator.storage.getDirectory === "function"
  );
}

export function encodeAutosave(document: DitherDocument, savedAt: Date): string {
  const record: AutosaveRecord = {
    savedAt: savedAt.toISOString(),
    document: JSON.parse(encodeDocument(document)) as DitherDocument,
  };
  return JSON.stringify(record);
}

/**
 * Read and validate an autosave.
 *
 * Returns `null` when there is nothing stored. A record that *is* there and
 * cannot be read is a different thing entirely and throws — the document that
 * comes back has to be the document that was saved, and the one failure this
 * whole feature must not have is quietly restoring something else.
 */
export async function loadAutosave(
  storage: AutosaveStorage,
  registry: EffectRegistry,
): Promise<RestoredAutosave | null> {
  const text = await storage.read();
  if (text === null || text.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new DocumentError(
      "malformed-document",
      `the autosave is not valid JSON: ${String(error)}`,
      { bytes: text.length },
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DocumentError("malformed-document", "the autosave is not an object");
  }
  const record = parsed as Partial<AutosaveRecord>;
  const savedAt = new Date(String(record.savedAt));
  if (Number.isNaN(savedAt.getTime())) {
    throw new DocumentError(
      "malformed-document",
      `the autosave has no readable timestamp (${String(record.savedAt)})`,
    );
  }

  const document = decodeDocument(record.document, registry);
  log.info("autosave restored", {
    savedAt: savedAt.toISOString(),
    nodes: document.stack.length,
    source: document.source?.name ?? "<none>",
  });
  return {
    document,
    savedAt,
    sourceName: document.source?.name ?? null,
  };
}

/**
 * Debounced writer.
 *
 * One timer, restarted on every change: a slider drag is one write when it
 * settles, not one per pointer move. `flush` exists for `pagehide`, where the
 * page is going away and the timer will never fire.
 */
export class AutosaveWriter {
  readonly #storage: AutosaveStorage;
  readonly #debounceMs: number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pending: DitherDocument | null = null;
  #inFlight: Promise<void> | null = null;
  #writes = 0;

  constructor(storage: AutosaveStorage, debounceMs: number = AUTOSAVE_DEBOUNCE_MS) {
    this.#storage = storage;
    this.#debounceMs = debounceMs;
  }

  get writeCount(): number {
    return this.#writes;
  }

  /** Note a new document. The write happens once the edits stop. */
  schedule(document: DitherDocument): void {
    this.#pending = document;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, this.#debounceMs);
  }

  /** Write now, if anything is pending. Awaits the write in flight. */
  async flush(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const document = this.#pending;
    if (document === null) {
      await this.#inFlight;
      return;
    }
    this.#pending = null;

    const write = (async (): Promise<void> => {
      try {
        await this.#storage.write(encodeAutosave(document, new Date()));
        this.#writes += 1;
      } catch (error) {
        // Autosave failing must not take the session with it — a full disk is
        // not a reason to lose the document on screen. It is said out loud and
        // the next edit tries again.
        log.error("autosave failed", { error: String(error) });
      }
    })();
    this.#inFlight = write;
    await write;
  }

  /** Stop the timer. Anything pending is dropped; call {@link flush} first. */
  dispose(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#pending = null;
  }
}
