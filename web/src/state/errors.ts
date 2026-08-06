/**
 * Document-state errors.
 *
 * Constructing one logs it, the same rule as `graph/errors.ts` and `io/errors.ts`:
 * no error path is silent, and the constructor is the only place that can be
 * true without every throw site remembering.
 */

import type { LogFields } from "../lib/log";
import { logger } from "../lib/log";

export type DocumentErrorCode =
  /** A node id that is not in the stack. */
  | "unknown-node"
  /** An effect id the registry does not have. */
  | "unknown-effect"
  /** A parameter key the effect does not declare. */
  | "unknown-param"
  /** An index outside the stack. */
  | "bad-index"
  /** A clock, palette or binding value the schema does not allow. */
  | "invalid-value"
  /** A stored document that is not a document. */
  | "malformed-document"
  /** A document written by a newer build (F-DO-08). Refused, never guessed at. */
  | "future-schema";

const log = logger("app");

export class DocumentError extends Error {
  readonly code: DocumentErrorCode;
  readonly fields: LogFields;

  constructor(code: DocumentErrorCode, message: string, fields: LogFields = {}) {
    super(message);
    this.name = "DocumentError";
    this.code = code;
    this.fields = fields;
    log.error(message, { code, ...fields });
  }
}
