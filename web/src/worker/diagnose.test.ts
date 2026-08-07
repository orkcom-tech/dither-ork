import { describe, expect, it } from "vitest";

import {
  describeWorkerError,
  describeWorkerScriptResponse,
  describeWorkerScriptUnreachable,
} from "./diagnose";

const SCRIPT = "https://example.test/assets/render.worker-D_P7S7EN.js";

/**
 * The event shapes a browser actually hands over.
 *
 * These are plain objects rather than constructed `ErrorEvent`s because that is
 * exactly the contract under test: the listener receives an object whose fields
 * may or may not be there, and the whole defect was code that assumed they were.
 * Node has no `ErrorEvent` to construct anyway, and building one would not make
 * the assertion truer — the values are the same values.
 */
const LOAD_FAILURE = {} as const;

const THREW = {
  message: "GPUAdapter is null",
  filename: `${SCRIPT}`,
  lineno: 1,
  colno: 4212,
} as const;

describe("describeWorkerError — the shape that produced 'undefined'", () => {
  it("never reports the word undefined for an event that carried nothing", () => {
    const described = describeWorkerError(LOAD_FAILURE, SCRIPT);
    expect(described.summary).not.toContain("undefined");
  });

  it("names the script that did not run, which is the only fact the browser gave", () => {
    const described = describeWorkerError(LOAD_FAILURE, SCRIPT);
    expect(described.summary).toContain(SCRIPT);
    expect(described.failedToLoad).toBe(true);
  });

  it("treats an empty message the same as a missing one", () => {
    // The old code guarded against `""` and not against `undefined`; both are
    // the same situation and both must reach the same report.
    const described = describeWorkerError({ message: "" }, SCRIPT);
    expect(described.failedToLoad).toBe(true);
    expect(described.summary).toContain(SCRIPT);
  });

  it("reports a real message when the script ran and threw", () => {
    const described = describeWorkerError(THREW, SCRIPT);
    expect(described.failedToLoad).toBe(false);
    expect(described.summary).toContain("GPUAdapter is null");
    expect(described.summary).toContain(":1:4212");
  });

  it("reads the thrown error when the event carried one but no message", () => {
    const cause = new TypeError("importScripts is not defined");
    const described = describeWorkerError({ error: cause }, SCRIPT);
    expect(described.failedToLoad).toBe(false);
    expect(described.summary).toContain("TypeError: importScripts is not defined");
    expect(described.cause).toBe(cause);
  });

  it("keeps the thrown value so it can be hung on Error.cause", () => {
    const cause = new Error("device lost");
    expect(describeWorkerError({ message: "worker died", error: cause }, SCRIPT).cause).toBe(cause);
  });

  it("does not mistake a useless stringification for a message", () => {
    // `String({})` is "[object Object]", which names nothing. Falling back to
    // the script URL is more informative than printing it.
    const described = describeWorkerError({ error: {} }, SCRIPT);
    expect(described.failedToLoad).toBe(true);
    expect(described.summary).not.toContain("[object Object]");
  });
});

describe("describeWorkerScriptResponse — where the cause actually lives", () => {
  it("calls a 404 what it is: the file is not at that path in this build", () => {
    const detail = describeWorkerScriptResponse(404, "text/plain");
    expect(detail).toContain("404");
    expect(detail).toContain("not at that path");
  });

  it("names a wrong content type, which is how an SPA fallback breaks a worker", () => {
    // A host that answers unknown paths with index.html returns HTTP 200 and
    // text/html. The worker fails with no message and the file "exists".
    const detail = describeWorkerScriptResponse(200, "text/html; charset=utf-8");
    expect(detail).toContain("text/html");
    expect(detail).toContain("will not execute");
  });

  it("accepts the content types a module worker will actually run", () => {
    for (const type of ["text/javascript; charset=utf-8", "application/javascript"]) {
      expect(describeWorkerScriptResponse(200, type)).toContain("reachable");
    }
  });

  it("points at cross-origin isolation when the script is served correctly", () => {
    // Everything fetchable and still refused is the COEP case, and saying so is
    // the difference between a lead and a shrug.
    expect(describeWorkerScriptResponse(200, "text/javascript")).toContain(
      "Cross-Origin-Embedder-Policy",
    );
  });

  it("says something for a response with no content type at all", () => {
    const detail = describeWorkerScriptResponse(200, null);
    expect(detail).toContain("(none)");
    expect(detail).not.toContain("undefined");
  });
});

describe("describeWorkerScriptUnreachable", () => {
  it("reports a probe that could not complete, without inventing a cause", () => {
    const detail = describeWorkerScriptUnreachable(new Error("Failed to fetch"));
    expect(detail).toContain("Failed to fetch");
  });

  it("still says something when the probe failed with nothing to say", () => {
    expect(describeWorkerScriptUnreachable(undefined)).not.toContain("undefined");
  });
});
