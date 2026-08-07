/**
 * Turning a `Worker` failure into a sentence that names something real.
 *
 * This module exists because of a defect that reached production and was
 * unreadable when it got there. The startup failure screen said:
 *
 *     render worker error: undefined
 *
 * which is the worst kind of error message: it is not a description of a
 * failure, it is a description of the reporting code losing one.
 *
 * ## Where the `undefined` came from
 *
 * A `Worker` fires `error` for two entirely different situations, and the two
 * events do not have the same shape.
 *
 * - **The script ran and threw.** The event is an `ErrorEvent`: `message`,
 *   `filename`, `lineno`, `colno`, and often `error` with a real stack.
 * - **The script never ran** — it 404'd, it was served with a content type a
 *   module worker will not execute, or the browser refused it (a
 *   `Cross-Origin-Embedder-Policy` mismatch on the script's own response is the
 *   one this application can hit, because the document is cross-origin
 *   isolated). Per HTML, the browser fires a plain `Event` here. It has no
 *   `message`, no `filename`, no `error`. **Every field is `undefined`.**
 *
 * The old code read `event.message` and guarded only against `""`, so the second
 * case interpolated `undefined` into the message and threw away the one fact it
 * did have: which script it was. That fact is now the message.
 *
 * ## What is reported instead
 *
 * {@link describeWorkerError} never returns a string containing "undefined". For
 * the load failure it says the script never ran and names its URL, and it tells
 * the caller (via `failedToLoad`) that the cause is worth going and fetching —
 * because for that case the cause is not in the event at all, it is in the HTTP
 * response. {@link describeWorkerScriptResponse} turns that response into the
 * second half of the sentence.
 *
 * Both are pure functions over plain values, so they are tested against every
 * shape a browser can hand over without a browser being present.
 */

/**
 * The fields a `Worker` `error` event may carry.
 *
 * Everything is `unknown` and everything is optional, which is the honest type:
 * the whole point is that the event is one of two shapes and the reporting code
 * does not get to assume which. Declaring it as `ErrorEvent` — which is what the
 * old listener did — is what made `undefined` type-check.
 */
export interface WorkerErrorEvent {
  readonly message?: unknown;
  readonly filename?: unknown;
  readonly lineno?: unknown;
  readonly colno?: unknown;
  readonly error?: unknown;
}

export interface WorkerErrorDescription {
  /**
   * The script never started.
   *
   * True when the event carried nothing at all, which is the browser's way of
   * saying the module was not fetched, not parsed, or not allowed. The caller
   * uses this to decide whether asking the network is worth doing.
   */
  readonly failedToLoad: boolean;
  /** One line naming what happened. Never empty and never "undefined". */
  readonly summary: string;
  /** The event's own `error`, when it had one, to hang on `Error.cause`. */
  readonly cause: unknown;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function position(event: WorkerErrorEvent): string {
  const file = text(event.filename);
  if (file === null) return "";
  const line = typeof event.lineno === "number" ? `:${event.lineno}` : "";
  const column = typeof event.colno === "number" ? `:${event.colno}` : "";
  return ` (${file}${line}${column})`;
}

function fromThrown(value: unknown): string | null {
  if (value instanceof Error) {
    return value.message === "" ? value.name : `${value.name}: ${value.message}`;
  }
  if (value === undefined || value === null) return null;
  const rendered = String(value);
  return rendered === "" || rendered === "[object Object]" ? null : rendered;
}

/**
 * Say what a `Worker` `error` event means, given the script it was constructed
 * with.
 *
 * `scriptUrl` is not decoration. In the load-failure case it is the *only* fact
 * that exists — the browser has told us that something about that URL did not
 * work and nothing else — and it is what makes the difference between a report
 * somebody can act on and one they cannot.
 */
export function describeWorkerError(
  event: WorkerErrorEvent,
  scriptUrl: string,
): WorkerErrorDescription {
  const message = text(event.message);
  if (message !== null) {
    return {
      failedToLoad: false,
      summary: `${message}${position(event)}`,
      cause: event.error,
    };
  }

  // No message, but a thrown value: some browsers populate one and not the
  // other. Read it rather than reporting nothing.
  const thrown = fromThrown(event.error);
  if (thrown !== null) {
    return {
      failedToLoad: false,
      summary: `${thrown}${position(event)}`,
      cause: event.error,
    };
  }

  return {
    failedToLoad: true,
    summary:
      `the worker script at ${scriptUrl} never ran — the browser reported the failure ` +
      `with no message, which is what a script that could not be fetched, could not be ` +
      `parsed, or was refused looks like`,
    cause: undefined,
  };
}

/**
 * What the worker script's URL actually answers with.
 *
 * Called only after {@link describeWorkerError} reported `failedToLoad`, because
 * that is the case where the event has no cause in it and the cause is in the
 * response instead. The three outcomes are the three ways this fails in a built
 * application: the file is not there, it is there but served as something a
 * module worker will not execute, or it is served correctly and the problem is
 * inside it.
 */
export function describeWorkerScriptResponse(
  status: number,
  contentType: string | null,
): string {
  if (status >= 400) {
    return `fetching it returned HTTP ${status}, so the file is not at that path in this build`;
  }
  // The JavaScript MIME types HTML lists as executable for a module script.
  // Anything else is refused by strict MIME checking, which is the whole
  // failure being described here — so the list is the spec's, not a guess.
  const type = contentType === null ? null : (contentType.split(";")[0] ?? "").trim().toLowerCase();
  const executable =
    type !== null &&
    (type === "text/javascript" ||
      type === "application/javascript" ||
      type === "application/x-javascript" ||
      type === "text/ecmascript" ||
      type === "application/ecmascript");
  if (!executable) {
    return (
      `fetching it returned HTTP ${status} with content type ` +
      `${contentType === null ? "(none)" : contentType}, which a module worker will not execute`
    );
  }
  return (
    `fetching it returned HTTP ${status} and a correct content type, so the script is ` +
    `reachable and the browser refused or failed on it for another reason — a ` +
    `Cross-Origin-Embedder-Policy mismatch on this response is the one to check first, ` +
    `because the document is cross-origin isolated`
  );
}

/** The same, for a probe that could not complete at all. */
export function describeWorkerScriptUnreachable(error: unknown): string {
  const detail = fromThrown(error);
  return `fetching it failed outright${detail === null ? "" : `: ${detail}`}`;
}
