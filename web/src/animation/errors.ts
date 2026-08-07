/**
 * Animation errors.
 *
 * Constructing an `AnimationError` logs it, for the same reason `GraphError`
 * does: no error path in the render pipeline may be silent, and putting the log
 * in the constructor is the only way to make that true without every throw site
 * remembering to.
 *
 * The channel is `graph` rather than a new one. Animation is not a stage beside
 * the render graph; it is the thing that decides what the graph is asked to
 * render on each frame, so its lines belong in the same stream as the plan they
 * produced, tied together by the same correlation id.
 *
 * The codes are a closed set. A caller that wants to tell "this document binds a
 * parameter that is not animatable" from "this frame count is not a positive
 * integer" should switch on a value, not match on message text.
 */

import type { LogFields } from "../lib/log";
import { logger } from "../lib/log";

export type AnimationErrorCode =
  /** A clock whose frame count or fps cannot describe a loop. */
  | "invalid-clock"
  /**
   * Cycles per loop is not a positive integer (F-AN-03). This is the constraint
   * the whole design rests on: an integer number of cycles is what makes frame
   * `N` equal frame `0` by construction rather than by luck.
   */
  | "invalid-cycles"
  /** Global speed is not a positive integer, so it would break F-AN-03 for every binding at once. */
  | "invalid-speed"
  /** An amount, phase or offset that is not finite, and so cannot be hashed or rendered. */
  | "non-finite-value"
  /** A frame index that is not an integer. */
  | "invalid-frame"
  /** A binding or a temporal variation names a node that is not in the stack. */
  | "unknown-node"
  /** A node names an effect the registry does not have. */
  | "unknown-effect"
  /** A binding names a parameter the effect does not declare. */
  | "unknown-parameter"
  /** A binding names a parameter whose descriptor says `animatable: false`. */
  | "parameter-not-animatable"
  /** A binding names a parameter that is not a `float` or an `int`. */
  | "parameter-not-numeric"
  /** Two bindings drive the same node parameter, so neither one describes the result. */
  | "duplicate-binding"
  /** Two temporal variations are attached to one node. */
  | "duplicate-variation"
  /**
   * A temporal variation asks for a lever the target effect does not have — a
   * pattern offset on a node with no pattern, a reseed on a node with no seed.
   */
  | "unsupported-lever"
  /** A hold, cell period or turn count that is not the positive integer its mode requires. */
  | "invalid-period"
  /** An internal invariant this module maintains itself was violated. */
  | "invariant";

const log = logger("graph");

export class AnimationError extends Error {
  readonly code: AnimationErrorCode;
  readonly detail: LogFields;

  constructor(code: AnimationErrorCode, message: string, detail: LogFields = {}) {
    super(message);
    this.name = "AnimationError";
    this.code = code;
    this.detail = detail;
    log.error(message, { code, ...detail });
  }
}

/**
 * Assert a lookup succeeded.
 *
 * Same role as `graph/errors.ts`'s `expect`: a missing value here means a broken
 * invariant rather than an impossible branch, and it should arrive as a logged,
 * coded error naming what was being looked up rather than as `undefined`
 * reaching a parameter record.
 */
export function expect<T>(
  value: T | null | undefined,
  code: AnimationErrorCode,
  message: string,
  detail: LogFields = {},
): T {
  if (value === null || value === undefined) {
    throw new AnimationError(code, message, detail);
  }
  return value;
}
