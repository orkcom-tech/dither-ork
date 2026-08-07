/**
 * Failures of the document *file* layer.
 *
 * Constructing one logs it, the same rule `state/errors.ts`, `io/errors.ts` and
 * `graph/errors.ts` follow: no error path is silent, and the constructor is the
 * only place that can be true without every throw site remembering.
 *
 * **Separate from `DocumentError`, and deliberately.** That type's codes are
 * about a document's *contents* — an effect the catalogue lacks, a binding
 * pointing at nothing, a schema from the future — and every one of them is still
 * thrown from here, unchanged, because this layer parses documents by calling
 * `decodeDocument` rather than by re-implementing it. What is added here is the
 * set of failures that only exist once a document is a *file*: bytes that are
 * not JSON, a preset library opened as a document, a share link that has been
 * truncated by the chat application it was pasted through. Folding those into
 * `DocumentErrorCode` would mean editing a union in a layer that has no idea
 * files exist.
 */

import type { LogFields } from "../../lib/log";
import { logger } from "../../lib/log";

export type DocumentFileErrorCode =
  /** The bytes are not JSON at all. */
  | "not-json"
  /** Valid JSON, but not a shape this layer writes. */
  | "unrecognised-file"
  /** A preset file written by a newer build (F-DO-08). Refused, never guessed at. */
  | "future-schema"
  /** A preset record that is not one. */
  | "malformed-preset"
  /** A preset carrying an image reference. A preset is a stack (F-DO-03). */
  | "preset-carries-a-source"
  /** A preset id the library does not hold. */
  | "unknown-preset"
  /** Rename or delete aimed at a starter preset, which is not stored. */
  | "builtin-preset"
  /** A preset name that is empty once trimmed. */
  | "empty-name"
  /** The self-contained variant asked for with no image open (F-DO-02). */
  | "no-source"
  /** A `data:` URL that is not one, or not base64. */
  | "bad-data-url"
  /** A share fragment that is empty, truncated or not this encoding (F-DO-06). */
  | "bad-share-link"
  /** The stored preset library exists and cannot be read. */
  | "library-unreadable";

const log = logger("io");

export class DocumentFileError extends Error {
  readonly code: DocumentFileErrorCode;
  readonly fields: LogFields;

  constructor(code: DocumentFileErrorCode, message: string, fields: LogFields = {}) {
    super(message);
    this.name = "DocumentFileError";
    this.code = code;
    this.fields = fields;
    log.error(message, { code, ...fields });
  }
}
