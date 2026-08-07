/**
 * F-EX-15 — copy the result to the clipboard.
 *
 * ## It is always a PNG, and the button says so
 *
 * The async clipboard's image support is `image/png` and nothing else. Chrome,
 * Safari and Firefox all reject any other image type from `ClipboardItem`, and
 * there is no flag or permission that changes it. So the copy path encodes a
 * PNG whatever the panel's format control says.
 *
 * That could have been hidden — encode a PNG, copy it, say nothing — and it is
 * not, because a person who has just set quality to 40 for a small JPEG and
 * pressed copy would otherwise paste a lossless file several times the size and
 * have no way to find out why. The button is labelled `copy PNG` and its title
 * says the format control does not apply to it.
 *
 * ## The blob is handed over as a promise
 *
 * `ClipboardItem` accepts `Promise<Blob>`, and that is the only form that works
 * in Safari: the write has to be issued inside the click's user activation,
 * while the encode takes longer than the activation lasts. Passing the promise
 * lets the browser hold the clipboard slot open and fill it when the encode
 * finishes. Passing the resolved blob after awaiting it fails with a
 * NotAllowedError on exactly the exports that take long enough to matter.
 */

import { logger } from "../lib/log";

const log = logger("export");

export interface ClipboardCapability {
  readonly available: boolean;
  /** One line for the panel, whether it is available or not. */
  readonly detail: string;
}

export function clipboardCapability(): ClipboardCapability {
  if (typeof ClipboardItem === "undefined") {
    return {
      available: false,
      detail: "This browser has no ClipboardItem, so an image cannot be copied.",
    };
  }
  if (typeof navigator.clipboard?.write !== "function") {
    return {
      available: false,
      detail:
        "The async clipboard is unavailable here — it needs a secure context " +
        "(https, or localhost).",
    };
  }
  return {
    available: true,
    detail: "Copies as a PNG: the clipboard accepts no other image format.",
  };
}

/** The one type the clipboard takes an image in. */
export const CLIPBOARD_MIME = "image/png";

/**
 * Put an image on the clipboard.
 *
 * Takes the *promise* rather than the blob — see the note at the top. The
 * caller must not await the encode first.
 */
export async function copyImageToClipboard(blob: Promise<Blob>): Promise<void> {
  const capability = clipboardCapability();
  if (!capability.available) throw new Error(capability.detail);

  const tracked = blob.then(
    (ready) => ready,
    (error: unknown) => {
      log.error("the image to copy could not be encoded", { error: String(error) });
      throw error;
    },
  );

  // The same promise is handed to the platform, which may never observe it if
  // the write itself fails first. Observing it here as well is what keeps an
  // encode failure from surfacing as an unhandled rejection instead of as this
  // function's own error; the size it produces is what gets logged.
  const size = tracked.then(
    (ready) => ready.size,
    () => -1,
  );

  await navigator.clipboard.write([new ClipboardItem({ [CLIPBOARD_MIME]: tracked })]);
  log.info("copied to the clipboard", { bytes: await size });
}
