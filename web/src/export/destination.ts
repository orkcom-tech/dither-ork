/**
 * Where the file goes: a place the person picked, or the downloads folder.
 *
 * The capability report (F-UI-12, `lib/capabilities.ts`) already carries `fsa`
 * — File System Access — as a non-fatal capability whose absence "degrades
 * stated capabilities visibly, never silently". This is the export half of
 * that statement, and the panel puts {@link deliveryCapability}'s `detail`
 * on the screen next to the button so the difference is read before the click
 * rather than discovered after it.
 *
 * ## The picker comes first, and that is not a preference
 *
 * `showSaveFilePicker` requires transient user activation, which expires a few
 * seconds after the click. Encoding a 4x PNG takes longer than that. So the
 * order is: click, pick the destination, *then* encode, then write. Doing the
 * work first and asking afterwards fails with a security error on exactly the
 * exports that take long enough to matter — the large ones.
 *
 * ## The two checks are different capabilities
 *
 * `lib/capabilities.ts` probes `showDirectoryPicker`, because batch (F-BA-01)
 * needs a directory. Export needs `showSaveFilePicker`, which is a different
 * entry point of the same specification. Every browser that ships one ships the
 * other, but "every browser today" is not the same statement as "the function
 * this module calls exists", and this module checks the one it calls.
 */

import { logger } from "../lib/log";
import { formatInfo } from "./settings";
import type { ExportFormat } from "./types";

const log = logger("export");

export type DeliveryKind = "file-system-access" | "download";

export interface DeliveryCapability {
  readonly kind: DeliveryKind;
  /** One line for the panel. Always shown; there is no silent path. */
  readonly detail: string;
}

/**
 * The shape of the File System Access entry point this module uses.
 *
 * Declared here because TypeScript's DOM library does not carry
 * `showSaveFilePicker` — it does carry `FileSystemFileHandle` and
 * `FileSystemWritableFileStream`, which is everything after the picker. This is
 * a type for a real function, not a shim for a missing one: if the function is
 * absent the code takes the download path instead, and never calls this.
 */
interface SaveFilePickerType {
  readonly description: string;
  readonly accept: Readonly<Record<string, readonly string[]>>;
}

interface SaveFilePickerOptions {
  readonly suggestedName?: string;
  readonly types?: readonly SaveFilePickerType[];
  /** Groups the picker's remembered location per id. */
  readonly id?: string;
}

type ShowSaveFilePicker = (
  options?: SaveFilePickerOptions,
) => Promise<FileSystemFileHandle>;

function savePicker(): ShowSaveFilePicker | null {
  const scope = globalThis as typeof globalThis & {
    showSaveFilePicker?: ShowSaveFilePicker;
  };
  return typeof scope.showSaveFilePicker === "function" ? scope.showSaveFilePicker : null;
}

export function deliveryCapability(): DeliveryCapability {
  if (savePicker() !== null) {
    return {
      kind: "file-system-access",
      detail: "You choose where the file goes, and can overwrite it on a re-export.",
    };
  }
  return {
    kind: "download",
    detail:
      "This browser has no File System Access API, so the file goes to your " +
      "downloads folder and a second export lands beside the first rather than " +
      "replacing it.",
  };
}

export type Destination =
  | { readonly kind: "file-system-access"; readonly handle: FileSystemFileHandle }
  | { readonly kind: "download"; readonly name: string };

/**
 * Ask for a destination.
 *
 * Returns `null` when the person dismissed the picker — a cancellation, not a
 * failure, and the caller stops without a banner. On the download path there is
 * nothing to ask, so it returns immediately with the name.
 *
 * **Call this from inside the click handler.** See the note at the top.
 */
export async function chooseDestination(
  suggestedName: string,
  format: ExportFormat,
): Promise<Destination | null> {
  const info = formatInfo(format);
  return chooseDestinationForType(suggestedName, {
    label: info.label,
    mime: info.mime,
    extension: info.extension,
  });
}

/**
 * What the picker needs to describe a file type.
 *
 * The three fields both format tables already carry, named here so the picker
 * is not coupled to either of them: `ExportFormat` is the four still formats and
 * an animated GIF is none of them. `export/animated/settings.ts` has its own
 * table with the same three fields, and `ui/export/AnimatedExportPanel.tsx`
 * passes them straight through.
 */
export interface DestinationType {
  readonly label: string;
  readonly mime: string;
  readonly extension: string;
}

/** {@link chooseDestination}, for a file type that is not a still image format. */
export async function chooseDestinationForType(
  suggestedName: string,
  type: DestinationType,
): Promise<Destination | null> {
  const picker = savePicker();
  if (picker === null) return { kind: "download", name: suggestedName };

  try {
    const handle = await picker({
      suggestedName,
      // A stable id so the picker reopens where the last export went, which is
      // almost always where this one wants to go.
      id: "dither-ork-export",
      types: [
        {
          description: `${type.label} file`,
          accept: { [type.mime]: [`.${type.extension}`] },
        },
      ],
    });
    return { kind: "file-system-access", handle };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      log.info("the save picker was dismissed");
      return null;
    }
    log.error("the save picker failed", { error: String(error) });
    throw error;
  }
}

/** Write the blob to the destination. */
export async function writeToDestination(
  destination: Destination,
  blob: Blob,
): Promise<void> {
  if (destination.kind === "file-system-access") {
    const writable = await destination.handle.createWritable();
    try {
      await writable.write(blob);
    } catch (error) {
      // Close before rethrowing, or the file is left locked and zero length
      // with no indication of why.
      await writable.abort().catch((reason: unknown) => {
        log.warn("the writable would not abort", { reason: String(reason) });
      });
      log.error("writing the export failed", { error: String(error) });
      throw error;
    }
    await writable.close();
    log.info("export written", { bytes: blob.size, via: "file-system-access" });
    return;
  }

  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = destination.name;
    // Appended before the click: a detached anchor's download attribute is
    // ignored in more than one browser, and the symptom is a navigation to the
    // blob rather than a download.
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    log.info("export downloaded", { bytes: blob.size, name: destination.name });
  } finally {
    // The download has already been handed to the browser by the time click()
    // returns, but the URL must outlive the current task for it to be fetched.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
