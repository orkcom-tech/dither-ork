/**
 * Image input errors.
 *
 * Constructing one logs it, for the same reason `graph/errors.ts` does: the
 * rule is that no error path is silent, and putting the log in the constructor
 * is the only way to make that true without every throw site remembering.
 *
 * The codes are a closed set so a caller distinguishes "this file is a PDF"
 * from "this image is 30000 pixels wide" by switching on a value rather than
 * matching message text. Every message is written to be shown to a person:
 * F-IN-04 requires the refusal above the maximum dimension to be *stated*, and
 * a message only a developer can read is not stated.
 */

import type { LogFields } from "../lib/log";
import { logger } from "../lib/log";

export type ImageLoadErrorCode =
  /** The bytes are not one of the five formats F-IN-01 names. */
  | "unsupported-format"
  /** Above the maximum source dimension (F-IN-04). Never downscaled silently. */
  | "too-large"
  /** Zero bytes, or a file the browser handed over empty. */
  | "empty-source"
  /** A drop or a paste that carried no image at all. */
  | "no-image"
  /** The browser's decoder refused bytes that sniffed as a supported format. */
  | "decode-failed"
  /** A decoded image with a zero dimension; nothing downstream can size a buffer from it. */
  | "zero-dimension";

const log = logger("io");

export class ImageLoadError extends Error {
  readonly code: ImageLoadErrorCode;
  readonly fields: LogFields;

  constructor(code: ImageLoadErrorCode, message: string, fields: LogFields = {}) {
    super(message);
    this.name = "ImageLoadError";
    this.code = code;
    this.fields = fields;
    log.error(message, { code, ...fields });
  }
}
