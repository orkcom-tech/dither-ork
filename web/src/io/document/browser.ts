/**
 * The browser edges of the document layer: getting a file out, getting one in,
 * and putting a link on the clipboard.
 *
 * Everything else under `io/document/` is pure and tested. This module is the
 * part that cannot be, and it is kept as small as it can be for exactly that
 * reason — the same split `io/input.ts` and `io/decode.ts` make against the rest
 * of the image intake.
 *
 * ## One way to save, not two
 *
 * An anchor with an object URL. The File System Access API's `showSaveFilePicker`
 * gives a real save dialog and a handle that could be written to again, and it
 * is **not** used: it exists in Chromium and not in Firefox, so taking it would
 * mean two save paths, two sets of failure modes and a feature that behaves
 * differently depending on the browser. Batch (F-IN-07) is where the directory
 * API earns that cost; one file does not.
 *
 * What is given up is the folder choice and the overwrite prompt — the file
 * lands wherever downloads land. That is stated here rather than discovered.
 */

import { logger } from "../../lib/log";

const log = logger("io");

/**
 * Hand a text file to the browser's download.
 *
 * The object URL is revoked on the next task rather than immediately: revoking
 * it in the same turn as the click races the browser's own fetch of it in some
 * versions, and the symptom is a download that silently does not happen.
 */
export function downloadTextFile(name: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  log.info("file offered for download", { name, bytes: blob.size, mime });
}

/** Read a chosen file as text. */
export async function readTextFile(file: File): Promise<string> {
  const text = await file.text();
  log.info("file read", { name: file.name, bytes: file.size });
  return text;
}

/**
 * Put the share link on the clipboard.
 *
 * Throws when the browser refuses — a permission prompt dismissed, or a call
 * that lost its user activation. The caller states that; a swallowed failure
 * here is somebody pasting whatever was on their clipboard before.
 */
export async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  log.info("copied to clipboard", { chars: text.length });
}
