/**
 * The three ways an image gets in (F-IN-01): file picker, drag-and-drop onto
 * the window, clipboard paste.
 *
 * All three end in {@link decodeImage}, and none of them decides anything about
 * the image — one intake, one set of refusals, one log line per load. What
 * differs between them is only how the browser hands the bytes over, and each
 * of those three ways has a quirk that has to be handled here or it looks like
 * the feature is broken:
 *
 * - **The picker** is a detached `<input type="file">` rather than
 *   `showOpenFilePicker`. File System Access is a non-fatal capability
 *   (docs/API.md, section 7) and the input element is the one path that exists
 *   everywhere, so opening an image is never the thing that degrades. Batch
 *   (F-IN-07) is where the directory API earns its place.
 * - **The drop target** must cancel `dragover` as well as `drop`. Without the
 *   first, the browser navigates away to the dropped file and the application is
 *   simply gone — the most common way this feature is shipped broken.
 * - **The paste listener** reads `clipboardData.items`, because a screenshot on
 *   the clipboard is an item of kind `file` with no name and does not appear in
 *   `clipboardData.files` in every browser.
 *
 * Every one of them refuses loudly. An unsupported file, an oversized image and
 * a drop carrying no image at all each reach {@link ImageIntake.onError} with a
 * message written for a person; nothing is dropped on the floor.
 */

import { logger } from "../lib/log";
import { decodeImage, type DecodeImageOptions } from "./decode";
import { ImageLoadError } from "./errors";
import { IMAGE_ACCEPT_ATTRIBUTE, describeAcceptedFormats } from "./formats";
import type { SourceImage } from "./source";

const log = logger("io");

export interface ImageIntake {
  /** A decoded image. Errors thrown from here are reported to {@link onError}. */
  onImage(image: SourceImage): void | Promise<void>;
  /** Every refusal, so the UI can state it. Never optional; nothing is silent. */
  onError(error: ImageLoadError): void;
  /**
   * Something worth saying that is not a failure — "four files dropped, opened
   * the first". Optional because not every host has somewhere to put it; it is
   * logged either way.
   */
  onNotice?(message: string): void;
}

export interface ImageInputOptions extends DecodeImageOptions {
  readonly intake: ImageIntake;
}

/** Decode one blob and hand it to the intake, routing every failure to `onError`. */
export async function receiveImage(
  blob: Blob,
  name: string,
  options: ImageInputOptions,
): Promise<void> {
  const { intake, ...decodeOptions } = options;
  try {
    const image = await decodeImage(blob, name, decodeOptions);
    await intake.onImage(image);
  } catch (error) {
    intake.onError(asLoadError(error, name));
  }
}

/**
 * An `ImageLoadError` whatever went wrong.
 *
 * A failure thrown out of `onImage` — the store refusing the document, say —
 * would otherwise reach the caller as an unhandled rejection from an event
 * listener, which is the one place a stack trace goes nowhere.
 */
function asLoadError(error: unknown, name: string): ImageLoadError {
  if (error instanceof ImageLoadError) return error;
  return new ImageLoadError(
    "decode-failed",
    `"${name}" could not be opened: ${String(error)}`,
    { name },
  );
}

/**
 * The first image among dropped or pasted files.
 *
 * More than one is not an error — it is what happens when somebody selects a
 * folder's worth of photos — so the first is opened and the rest are reported
 * as a notice. Batch (F-IN-07) is the requirement that makes the others mean
 * something, and it does not exist yet; pretending to queue them would be worse
 * than saying what happened.
 */
function firstFile(
  files: readonly File[],
  intake: ImageIntake,
  source: string,
): File | null {
  if (files.length === 0) return null;
  if (files.length > 1) {
    const message = `${files.length} files ${source}; opened "${files[0]?.name ?? ""}". Batch import is not built yet.`;
    log.warn("multiple files offered", { count: files.length, source });
    intake.onNotice?.(message);
  }
  return files[0] ?? null;
}

// --- file picker --------------------------------------------------------

/**
 * Open the browser's file chooser and load what comes back.
 *
 * The input element is created per call and never attached to the document: a
 * hidden input left in the tree is one more thing that can be focused, styled
 * or found by a query somewhere else. It is not removed on cancel either,
 * because there is nothing to remove — the reference is dropped when this
 * resolves.
 */
export async function pickImageFile(options: ImageInputOptions): Promise<void> {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = IMAGE_ACCEPT_ATTRIBUTE;

  const file = await new Promise<File | null>((resolve) => {
    // `change` fires on a choice. `cancel` fires on dismissal where it is
    // supported; where it is not, the promise settles when the next choice is
    // made and this listener has already been dropped.
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });

  if (file === null) {
    log.debug("file picker dismissed");
    return;
  }
  log.info("file chosen", { name: file.name, bytes: file.size });
  await receiveImage(file, file.name, options);
}

// --- drag and drop ------------------------------------------------------

export interface DropTargetOptions extends ImageInputOptions {
  /**
   * Called as a drag enters and leaves, so the host can show it is a target.
   * The counter behind it is what makes a drag over a child element not read as
   * a leave — `dragleave` fires on every boundary inside the target.
   */
  readonly onDragStateChange?: (dragging: boolean) => void;
}

/**
 * Accept images dropped anywhere on `target`, which is the window in the
 * application shell.
 *
 * Returns the uninstaller. Every listener is removed by it, including the
 * document-level pair that stops the browser navigating to a file dropped
 * outside the target — without those, a near-miss drop replaces the application
 * with the raw image and any unsaved document with it.
 */
export function installImageDrop(
  target: HTMLElement | Window,
  options: DropTargetOptions,
): () => void {
  let depth = 0;

  const setDragging = (dragging: boolean): void => {
    options.onDragStateChange?.(dragging);
  };

  const onDragEnter = (event: Event): void => {
    const drag = event as DragEvent;
    if (!carriesFiles(drag)) return;
    drag.preventDefault();
    depth += 1;
    if (depth === 1) {
      log.debug("drag entered");
      setDragging(true);
    }
  };

  const onDragOver = (event: Event): void => {
    const drag = event as DragEvent;
    if (!carriesFiles(drag)) return;
    // Cancelling this is what makes the drop happen at all.
    drag.preventDefault();
    if (drag.dataTransfer !== null) drag.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = (event: Event): void => {
    const drag = event as DragEvent;
    if (!carriesFiles(drag)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) setDragging(false);
  };

  const onDrop = (event: Event): void => {
    const drag = event as DragEvent;
    drag.preventDefault();
    depth = 0;
    setDragging(false);

    const files = filesOf(drag.dataTransfer);
    if (files.length === 0) {
      options.intake.onError(
        new ImageLoadError(
          "no-image",
          `That drop carried no file. Drop an image file — ${describeAcceptedFormats()}.`,
        ),
      );
      return;
    }
    const file = firstFile(files, options.intake, "dropped");
    if (file === null) return;
    log.info("file dropped", { name: file.name, bytes: file.size });
    void receiveImage(file, file.name, options);
  };

  // Cancelling these on the document is what stops a drop that misses the
  // target from navigating the tab to the file.
  const swallow = (event: Event): void => {
    if (carriesFiles(event as DragEvent)) event.preventDefault();
  };

  target.addEventListener("dragenter", onDragEnter);
  target.addEventListener("dragover", onDragOver);
  target.addEventListener("dragleave", onDragLeave);
  target.addEventListener("drop", onDrop);
  document.addEventListener("dragover", swallow);
  document.addEventListener("drop", swallow);

  log.debug("drop target installed");
  return () => {
    target.removeEventListener("dragenter", onDragEnter);
    target.removeEventListener("dragover", onDragOver);
    target.removeEventListener("dragleave", onDragLeave);
    target.removeEventListener("drop", onDrop);
    document.removeEventListener("dragover", swallow);
    document.removeEventListener("drop", swallow);
    log.debug("drop target removed");
  };
}

/**
 * Whether a drag carries files at all.
 *
 * During a drag the browser exposes the *kinds* on the clipboard but not their
 * contents, so this is the only question that can be asked before the drop —
 * and asking it keeps a text selection dragged across the window from lighting
 * up the drop target.
 */
function carriesFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  if (types === undefined) return false;
  for (const type of types) if (type === "Files") return true;
  return false;
}

function filesOf(data: DataTransfer | null): readonly File[] {
  if (data === null) return [];
  const files: File[] = [];
  // `items` first: it is the one that carries a screenshot with no file name.
  if (data.items.length > 0) {
    for (const item of data.items) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file !== null) files.push(file);
    }
    if (files.length > 0) return files;
  }
  for (const file of data.files) files.push(file);
  return files;
}

// --- clipboard paste ----------------------------------------------------

/**
 * Accept an image pasted into `target`, which is the window in the application
 * shell.
 *
 * A paste that carries text and no image is left alone rather than refused: the
 * user was pasting into a text field, and an error banner over a document
 * because somebody pasted a hex colour into the palette editor would be the
 * application shouting at them for using it correctly. A paste carrying a
 * *file* that is not an image does produce the refusal, because there is no
 * other thing that could have been meant.
 */
export function installClipboardPaste(
  target: HTMLElement | Window | Document,
  options: ImageInputOptions,
): () => void {
  const onPaste = (event: Event): void => {
    const paste = event as ClipboardEvent;
    const data = paste.clipboardData;
    if (data === null) return;

    const files = filesOf(data);
    if (files.length === 0) return;

    paste.preventDefault();
    const file = firstFile(files, options.intake, "pasted");
    if (file === null) return;
    // A pasted screenshot has an empty name in most browsers; the name is
    // carried into the document and into every message, so it gets one here
    // rather than an empty string three layers down.
    const name = file.name.length > 0 ? file.name : "clipboard image";
    log.info("image pasted", { name, bytes: file.size });
    void receiveImage(file, name, options);
  };

  target.addEventListener("paste", onPaste);
  log.debug("paste listener installed");
  return () => {
    target.removeEventListener("paste", onPaste);
    log.debug("paste listener removed");
  };
}
