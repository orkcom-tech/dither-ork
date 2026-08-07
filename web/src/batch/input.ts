/**
 * F-BA-02 — the three ways a folder's worth of images gets in.
 *
 * Multi-select, a folder dragged onto the window, or a directory handle where
 * the browser has the File System Access API. All three end in the same list of
 * {@link BatchInputFile}, and all three refuse loudly: a drop that carried no
 * files, a folder with no images in it, and a file whose bytes are not an image
 * each produce a message written for a person rather than an empty queue.
 *
 * ## The three are genuinely different capabilities, and the panel says so
 *
 * - **Multi-select** is `<input type="file" multiple>`, which exists in every
 *   browser. It is the floor, and nothing degrades to less than it.
 * - **Folder drag-and-drop** is `DataTransferItem.webkitGetAsEntry()`. Not a
 *   standard, shipped by every engine, and the *only* way to read a dropped
 *   directory without a picker. Its absence drops folder drops to "the files at
 *   the top level", which is stated rather than discovered.
 * - **A directory handle** is `showDirectoryPicker()`, which is what the
 *   capability report already calls `fsa`. It is the only one of the three that
 *   can also be *written* back to, which is why it is the one F-BA-03 turns on.
 *
 * ## Filtering happens on the bytes, not on the name
 *
 * A folder of two hundred photographs contains `.DS_Store`, `Thumbs.db` and a
 * `notes.txt`, and none of them is a failure worth reporting — they are not
 * images and were never offered as ones. So the extension is used *here*, as a
 * cheap pre-filter to decide what to put in the queue at all, and `io/decode.ts`
 * does the real check on the file's own bytes when the item runs. A `.png` that
 * is really a PDF therefore reaches the queue and fails as one item, with a
 * message, which is exactly F-BA-06's requirement; a `.DS_Store` never appears.
 */

import { IMAGE_ACCEPT_ATTRIBUTE, IMAGE_FORMATS } from "../io";
import { logger } from "../lib/log";
import type { BatchInputFile } from "./types";

const log = logger("batch");

/**
 * The extensions worth queueing, derived from the decoder's own format table so
 * a format added there appears here without a second list to keep in step.
 */
const IMAGE_EXTENSIONS: readonly string[] = IMAGE_FORMATS.flatMap((format) =>
  format.extensions.map((extension) => extension.toLowerCase()),
);

export function looksLikeImage(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.includes(name.slice(dot).toLowerCase());
}

/**
 * Mint queue ids.
 *
 * A counter, never `Math.random` or a clock: ids appear in log lines and in
 * React keys, and an id that changes between two reads of the same queue is a
 * list that re-mounts every row on every render.
 */
let nextId = 0;

export function batchInputFile(blob: Blob, path: string): BatchInputFile {
  nextId += 1;
  return { id: `batch-${nextId}`, path, blob, bytes: blob.size };
}

/** Sort by path so a run's order is the folder's order and not the OS's. */
export function orderInputs(files: readonly BatchInputFile[]): readonly BatchInputFile[] {
  return [...files].sort((a, b) => a.path.localeCompare(b.path, "en"));
}

// --- multi-select --------------------------------------------------------

/**
 * The file chooser, in multi-select mode.
 *
 * A detached `<input>` rather than `showOpenFilePicker`, for the reason
 * `io/input.ts` gives: this is the path that exists everywhere, so *getting
 * images in* is never the thing that degrades.
 */
export async function pickBatchFiles(): Promise<readonly BatchInputFile[]> {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = IMAGE_ACCEPT_ATTRIBUTE;

  const files = await new Promise<readonly File[]>((resolve) => {
    input.addEventListener("change", () => resolve([...(input.files ?? [])]), { once: true });
    input.addEventListener("cancel", () => resolve([]), { once: true });
    input.click();
  });

  const queued = files.filter((file) => looksLikeImage(file.name));
  log.info("files chosen for a batch", { offered: files.length, queued: queued.length });
  return orderInputs(queued.map((file) => batchInputFile(file, file.name)));
}

/**
 * The same chooser, in directory mode.
 *
 * `webkitdirectory` is the pre-File-System-Access way to select a folder, and it
 * is read-only — which is why it is offered as an *input* even in browsers that
 * have `showDirectoryPicker`, and why F-BA-03's write-back is a separate check.
 * `webkitRelativePath` is what carries the folder structure through.
 */
export async function pickBatchDirectoryFiles(): Promise<readonly BatchInputFile[]> {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  // Not in TypeScript's `HTMLInputElement`: it is a non-standard attribute that
  // every engine implements. Set through the attribute API rather than declared
  // as a property, so nothing here pretends it is standard.
  input.setAttribute("webkitdirectory", "");

  const files = await new Promise<readonly File[]>((resolve) => {
    input.addEventListener("change", () => resolve([...(input.files ?? [])]), { once: true });
    input.addEventListener("cancel", () => resolve([]), { once: true });
    input.click();
  });

  const queued = files.filter((file) => looksLikeImage(file.name));
  log.info("a folder was chosen for a batch", {
    offered: files.length,
    queued: queued.length,
  });
  return orderInputs(
    queued.map((file) => {
      const relative = (file as File & { readonly webkitRelativePath?: string })
        .webkitRelativePath;
      return batchInputFile(
        file,
        relative !== undefined && relative.length > 0 ? relative : file.name,
      );
    }),
  );
}

// --- drag and drop -------------------------------------------------------

/**
 * Whether this browser can read a *dropped folder*.
 *
 * Checked rather than assumed, because the difference is visible: without it a
 * dropped folder contributes nothing at all — `DataTransfer.files` is empty for
 * a directory — and a queue that stays empty after a drop looks like a bug.
 */
export function canReadDroppedFolders(): boolean {
  return typeof DataTransferItem !== "undefined" && "webkitGetAsEntry" in DataTransferItem.prototype;
}

/** How deep into a dropped folder tree to walk. */
const MAX_DEPTH = 8;

function readEntries(reader: FileSystemDirectoryReader): Promise<readonly FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(
      (entries) => resolve(entries),
      (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(
      (file) => resolve(file),
      (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

/**
 * Walk one dropped entry, depth first.
 *
 * `readEntries` returns at most a hundred entries per call and signals the end
 * with an empty batch — a directory of two hundred files read with one call
 * silently loses the second hundred, which is the classic way this API is used
 * wrongly. Hence the loop.
 */
async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  depth: number,
  out: BatchInputFile[],
): Promise<void> {
  if (entry.isFile) {
    const file = await entryFile(entry as FileSystemFileEntry);
    if (!looksLikeImage(file.name)) return;
    out.push(batchInputFile(file, `${prefix}${file.name}`));
    return;
  }
  if (!entry.isDirectory) return;
  if (depth >= MAX_DEPTH) {
    log.warn("a dropped folder is deeper than the walk goes", {
      path: prefix,
      maxDepth: MAX_DEPTH,
    });
    return;
  }

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const here = `${prefix}${entry.name}/`;
  for (;;) {
    const batch = await readEntries(reader);
    if (batch.length === 0) return;
    for (const child of batch) {
      await walkEntry(child, here, depth + 1, out);
    }
  }
}

export interface DroppedInputs {
  readonly files: readonly BatchInputFile[];
  /** Non-null when the drop produced nothing and the reason is worth saying. */
  readonly refusal: string | null;
  /** True when at least one dropped item was a directory. For the log line. */
  readonly hadFolder: boolean;
}

/**
 * Everything droppable in a `DataTransfer`, folders walked.
 *
 * Both lists are read: `items` is what carries directory entries, and `files` is
 * the fallback for a browser without `webkitGetAsEntry` and for the flat case.
 */
export async function collectDroppedInputs(
  data: DataTransfer | null,
): Promise<DroppedInputs> {
  if (data === null) {
    return { files: [], refusal: "That drop carried nothing.", hadFolder: false };
  }

  const out: BatchInputFile[] = [];
  let hadFolder = false;

  if (canReadDroppedFolders() && data.items.length > 0) {
    // The entries must be taken synchronously: `DataTransferItemList` is
    // emptied when the drop event's handler returns, and awaiting first leaves
    // an empty list — which is the single most common way folder drop is
    // shipped broken.
    const entries: FileSystemEntry[] = [];
    for (const item of data.items) {
      if (item.kind !== "file") continue;
      const entry = item.webkitGetAsEntry();
      if (entry === null) continue;
      if (entry.isDirectory) hadFolder = true;
      entries.push(entry);
    }
    for (const entry of entries) {
      await walkEntry(entry, "", 0, out);
    }
  }

  if (out.length === 0 && !hadFolder) {
    for (const file of data.files) {
      if (!looksLikeImage(file.name)) continue;
      out.push(batchInputFile(file, file.name));
    }
  }

  log.info("drop collected for a batch", {
    files: out.length,
    hadFolder,
    viaEntries: canReadDroppedFolders(),
  });

  if (out.length === 0) {
    return {
      files: [],
      refusal: hadFolder
        ? "That folder holds no images this can open."
        : canReadDroppedFolders()
          ? "That drop carried no images."
          : "That drop carried no images. This browser cannot read a dropped " +
            "folder, so drop the files themselves, or use “add files”.",
      hadFolder,
    };
  }
  return { files: orderInputs(out), refusal: null, hadFolder };
}

// --- a directory handle --------------------------------------------------

/**
 * `showDirectoryPicker`, declared because TypeScript's DOM library does not
 * carry it — it does carry `FileSystemDirectoryHandle`, which is everything
 * after the picker. A type for a real function, not a shim for a missing one:
 * where it is absent the code takes the multi-select path and never calls this.
 */
interface DirectoryPickerOptions {
  readonly id?: string;
  readonly mode?: "read" | "readwrite";
  readonly startIn?: string;
}

type ShowDirectoryPicker = (
  options?: DirectoryPickerOptions,
) => Promise<FileSystemDirectoryHandle>;

export function directoryPicker(): ShowDirectoryPicker | null {
  const scope = globalThis as typeof globalThis & {
    showDirectoryPicker?: ShowDirectoryPicker;
  };
  return typeof scope.showDirectoryPicker === "function" ? scope.showDirectoryPicker : null;
}

/**
 * What this browser can do about folders, in one line the panel always shows.
 *
 * The capability report already carries `fsa` and states it in the status bar;
 * this is the same fact at the point where it changes what the buttons do.
 */
export interface BatchInputCapability {
  readonly directoryHandle: boolean;
  readonly droppedFolders: boolean;
  readonly detail: string;
}

export function batchInputCapability(): BatchInputCapability {
  const handle = directoryPicker() !== null;
  const dropped = canReadDroppedFolders();
  if (handle) {
    return {
      directoryHandle: true,
      droppedFolders: dropped,
      detail:
        "This browser has the File System Access API, so a batch can read a " +
        "folder you choose and write the results back into one.",
    };
  }
  return {
    directoryHandle: false,
    droppedFolders: dropped,
    detail:
      "This browser has no File System Access API. Batch is multi-select in and " +
      "ZIP out: you can still select files" +
      (dropped ? " or drop a folder" : "") +
      ", and the results arrive as one archive rather than as files written into " +
      "a folder you chose.",
  };
}

/**
 * `FileSystemDirectoryHandle.entries()`, which TypeScript's DOM library does
 * not declare although every implementation of the picker ships it.
 *
 * Reached through a check rather than a cast so its absence is a stated
 * refusal. There is no fallback: iterating a directory is the whole of reading
 * one, and a browser that has `showDirectoryPicker` without it would be a
 * combination nothing in this file can work around.
 */
type DirectoryEntries = () => AsyncIterableIterator<[string, FileSystemHandle]>;

function entriesOf(
  handle: FileSystemDirectoryHandle,
): AsyncIterableIterator<[string, FileSystemHandle]> {
  const withEntries = handle as FileSystemDirectoryHandle & {
    readonly entries?: DirectoryEntries;
  };
  if (typeof withEntries.entries !== "function") {
    throw new Error(
      `"${handle.name}" cannot be listed: this browser's FileSystemDirectoryHandle ` +
        `has no entries(). Use “add files” instead.`,
    );
  }
  return withEntries.entries();
}

/** Every image directly inside a chosen directory, one level deep. */
export async function readDirectoryHandle(
  handle: FileSystemDirectoryHandle,
): Promise<readonly BatchInputFile[]> {
  const out: BatchInputFile[] = [];
  for await (const [name, child] of entriesOf(handle)) {
    if (child.kind !== "file") continue;
    if (!looksLikeImage(name)) continue;
    const file = await (child as FileSystemFileHandle).getFile();
    out.push(batchInputFile(file, `${handle.name}/${name}`));
  }
  log.info("directory read for a batch", { directory: handle.name, files: out.length });
  return orderInputs(out);
}

/**
 * Ask for an input directory.
 *
 * `null` means the person dismissed the picker — a cancellation, not a failure.
 * Read-only: the *output* directory is asked for separately, because reading
 * the inputs and overwriting them are not the same permission and should not be
 * granted by one click.
 */
export async function pickInputDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const picker = directoryPicker();
  if (picker === null) return null;
  try {
    return await picker({ id: "dither-ork-batch-in", mode: "read" });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      log.info("the input directory picker was dismissed");
      return null;
    }
    log.error("the input directory picker failed", { error: String(error) });
    throw error;
  }
}
