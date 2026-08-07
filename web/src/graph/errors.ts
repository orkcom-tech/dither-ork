/**
 * Graph errors.
 *
 * Constructing a `GraphError` logs it. The rule is that no error path is
 * silent, and putting the log in the constructor is the only way to make that
 * true without depending on every throw site remembering to do it.
 *
 * The codes are a closed set for the same reason the registry's are: a caller
 * that wants to distinguish "this document has a cycle" from "the cache budget
 * is too small for this resolution" should switch on a value, not match on
 * message text.
 */

import type { LogFields } from "../lib/log";
import { logger } from "../lib/log";

export type GraphErrorCode =
  /** Two nodes in one graph share an id, so edges are ambiguous. */
  | "duplicate-node-id"
  /** A node names an effect the registry does not have. */
  | "unknown-effect"
  /** An edge, or the graph output, points at a node id that is not in the graph. */
  | "unknown-node"
  /** A node declares the same input port twice. */
  | "duplicate-port"
  /** The graph is not acyclic. Reported with the ids that could not be ordered. */
  | "cycle"
  /** A parameter value is NaN or infinite, so it cannot be hashed stably. */
  | "non-finite-parameter"
  /** A parameter value is not one of the `ParameterValue` members. */
  | "unsupported-parameter"
  /** Bulk data registered for a node is unusable — no id, no slot, or no bytes. */
  | "invalid-asset"
  /** The cache was given a budget that cannot hold anything. */
  | "invalid-budget"
  /** One buffer is larger than the entire cache budget. */
  | "buffer-exceeds-budget"
  /** Buffers pinned by the render in flight do not fit the budget. */
  | "pinned-over-budget"
  /** An entry the plan said was cached had gone by the time it was read. */
  | "cache-miss"
  /** A backend returned no output buffer for a node it was asked to run. */
  | "missing-output"
  /** A backend returned no timing for a node it ran; the perf ceiling has to stay measurable. */
  | "missing-timing"
  /** The source buffer handed to the renderer is not the one the graph was prepared against. */
  | "source-mismatch"
  /** A per-frame graph reports a frame index other than the one it was asked for. */
  | "frame-mismatch"
  /** Two frames of one animation do not contain the same nodes. */
  | "node-set-mismatch"
  /** A frame count that is not a positive integer. */
  | "invalid-frame-count"
  /**
   * A node asks for a composite that cannot be expressed — today, opacity or a
   * blend mode on a node that resamples, whose output and input are different
   * pixel grids (F-ST-03).
   */
  | "unsupported-composite"
  /**
   * The render was abandoned through its `AbortSignal` and the signal carried no
   * reason of its own. A newer render superseding this one is the ordinary
   * cause, and it is not a failure — see `RenderDeps.signal`.
   */
  | "aborted"
  /** An internal invariant the graph maintains itself was violated. */
  | "invariant";

const log = logger("graph");

export class GraphError extends Error {
  readonly code: GraphErrorCode;
  readonly detail: LogFields;

  constructor(code: GraphErrorCode, message: string, detail: LogFields = {}) {
    super(message);
    this.name = "GraphError";
    this.code = code;
    this.detail = detail;
    log.error(message, { code, ...detail });
  }
}

/**
 * Assert a lookup succeeded.
 *
 * Used instead of a non-null assertion wherever the missing value would mean a
 * broken invariant rather than an impossible branch, so the failure arrives as
 * a logged, coded error naming what was being looked up instead of as
 * `undefined` propagating into a backend call.
 */
export function expect<T>(
  value: T | null | undefined,
  code: GraphErrorCode,
  message: string,
  detail: LogFields = {},
): T {
  if (value === null || value === undefined) {
    throw new GraphError(code, message, detail);
  }
  return value;
}
