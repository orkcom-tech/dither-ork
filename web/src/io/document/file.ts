/**
 * What kind of file is this, and is it JSON at all.
 *
 * Two things this layer writes look alike from the outside — both are JSON,
 * both are offered by the same "open" control — and telling them apart before
 * decoding is what makes the refusals readable. Handing a preset library to the
 * document decoder produces `document.stack is not an array`, which is true and
 * tells the person nothing; naming the file for what it actually is takes one
 * check.
 *
 * This is the same move `io/formats.ts` makes for images: decide from the
 * content, say what was found, and never from the extension. A `.dork` renamed
 * to `.json` opens; a spreadsheet renamed to `.dork` is refused by name.
 *
 * It lives in its own module rather than in `dork.ts` or `preset.ts` because
 * both of those need it, and putting it in either would make the two import each
 * other.
 */

import { DocumentFileError } from "./errors";

/** The marker a preset file carries so it cannot be mistaken for a document. */
export const PRESET_FILE_KIND = "dork-presets";

export type DorkFileKind =
  /** A `.dork` document — F-DO-01, and F-DO-02 when its source has a `dataUrl`. */
  | "document"
  /** One or more presets in one file — F-DO-03, F-DO-05. */
  | "preset-library";

export interface SniffedDorkFile {
  readonly kind: DorkFileKind;
  /** The parsed JSON, so the caller decodes without parsing twice. */
  readonly value: Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `JSON.parse` with a failure a person can act on.
 *
 * The native `SyntaxError` names a character offset and nothing else, which is
 * useless against a file that is actually a PNG or an HTML error page saved by
 * mistake. The first few characters are worth more than the offset, so they are
 * in the message.
 */
export function parseJsonObject(text: string, what: string): Record<string, unknown> {
  if (text.trim().length === 0) {
    throw new DocumentFileError("not-json", `${what} is empty.`, { bytes: text.length });
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new DocumentFileError(
      "not-json",
      `${what} is not JSON: ${String(error)}. It starts "${text.slice(0, 24).replace(/\s+/g, " ")}".`,
      { bytes: text.length },
    );
  }

  if (!isRecord(value)) {
    throw new DocumentFileError(
      "unrecognised-file",
      `${what} is JSON, but it is ${Array.isArray(value) ? "an array" : typeof value} rather than an object.`,
      { bytes: text.length },
    );
  }
  return value;
}

/**
 * Decide which of the two shapes this is.
 *
 * The preset file is checked first because it is the one carrying an explicit
 * marker; a document has no marker to carry — its schema was fixed before this
 * layer existed and `web/src/types/document.ts` is not this layer's to change —
 * so it is recognised by the two fields every document has and no preset file
 * has at the top level.
 */
export function sniffDorkFile(text: string, what = "this file"): SniffedDorkFile {
  const value = parseJsonObject(text, what);

  if (value["kind"] === PRESET_FILE_KIND) {
    if (!Array.isArray(value["presets"])) {
      throw new DocumentFileError(
        "malformed-preset",
        `${what} says it is a preset file but has no "presets" array.`,
      );
    }
    return { kind: "preset-library", value };
  }

  if ("schema" in value && Array.isArray(value["stack"])) {
    return { kind: "document", value };
  }

  throw new DocumentFileError(
    "unrecognised-file",
    `${what} is JSON, but it is neither a .dork document (no "schema" and "stack") ` +
      `nor a preset file (no "kind": "${PRESET_FILE_KIND}").`,
    { keys: Object.keys(value).slice(0, 8).join(",") },
  );
}
