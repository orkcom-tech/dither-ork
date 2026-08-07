import React from "react";

import type { RegistryIssue } from "../types/registry";

/**
 * The two ways the application can refuse to start after the browser has been
 * cleared as capable.
 *
 * They are separate cases because they are separate failures with separate
 * causes and separate fixes, and for a while they shared one screen — a render
 * worker that would not start was reported under the heading "The effect
 * catalogue was rejected", which sent the only person who could fix it looking
 * at the effect descriptors for a fault that was in the build's worker entry.
 * A screen that names the wrong thing is worse than one that says nothing: it
 * spends somebody's afternoon.
 */
export type StartupFailure =
  | {
      /** `loadEffectRegistry()` refused the catalogue. */
      readonly kind: "registry";
      /** Empty when the failure was discovery rather than validation. */
      readonly issues: readonly RegistryIssue[];
      readonly message: string;
    }
  | {
      /**
       * The render path would not come up: the worker, its GPU device, or the
       * WASM core. The capability gate has already passed, so this is a real
       * failure and not a browser that was never going to work.
       */
      readonly kind: "engine";
      readonly message: string;
      /** The `Error.cause` chain, outermost first, when the failure carried one. */
      readonly causes: readonly string[];
    };

export interface StartupFailureScreenProps {
  readonly failure: StartupFailure;
}

const COPY = {
  registry: {
    title: "The effect catalogue was rejected",
    lede: (
      <>
        Every effect module is discovered and validated as one set at startup.
        This build&rsquo;s catalogue did not pass, so nothing further ran. Nothing
        is repaired and nothing is dropped: an effect that silently disappears
        leaves a document rendering one node short, with no symptom anyone could
        see. The same issues are in the browser console.
      </>
    ),
  },
  engine: {
    title: "The render engine did not start",
    lede: (
      <>
        This browser passed the capability check, and the effect catalogue
        validated. What failed is the part that draws: the render worker, the
        GPU device it acquires, or the WASM core it loads. The application does
        not open without one, because an editor that cannot render is an editor
        that will lose your work at the first save. The same failure is in the
        browser console, with the correlation id.
      </>
    ),
  },
} as const;

/**
 * The application does not start, and this says why.
 *
 * The only useful thing to do with either failure is to put everything known
 * about it on the screen. Starting anyway is the one option that is definitely
 * wrong: a catalogue that is 62 effects because one was quietly dropped renders
 * documents that are missing a node, convincingly and without a symptom, and a
 * session with no render worker is a window full of controls that do nothing.
 */
export function StartupFailureScreen({
  failure,
}: StartupFailureScreenProps): React.ReactElement {
  const copy = COPY[failure.kind];
  const issues = failure.kind === "registry" ? failure.issues : [];

  return (
    <div className="screen">
      <div className="screen__inner">
        <h1 className="screen__title">{copy.title}</h1>
        <p className="screen__lede">{copy.lede}</p>

        {issues.length > 0 ? (
          <>
            <h2 className="screen__section">
              {issues.length} issue{issues.length === 1 ? "" : "s"}
            </h2>
            <table className="screen__table">
              <thead>
                <tr>
                  <th>Effect</th>
                  <th>Parameter</th>
                  <th>Code</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {issues.map((issue, index) => (
                  <tr key={`${issue.effect}:${issue.param ?? ""}:${issue.code}:${index}`}>
                    <td>{issue.effect}</td>
                    <td className="screen__detail">{issue.param ?? "—"}</td>
                    <td className="screen__state screen__state--missing">{issue.code}</td>
                    <td className="screen__detail">{issue.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <>
            <h2 className="screen__section">What stopped it</h2>
            <p className="screen__detail">{failure.message}</p>
          </>
        )}

        {/* The chain, when there is one. A wrapped failure keeps the layer that
            wrapped it *and* the thing that actually went wrong; showing only the
            outermost is how a report loses the one line that identifies the
            fault. */}
        {failure.kind === "engine" && failure.causes.length > 0 ? (
          <>
            <h2 className="screen__section">Caused by</h2>
            <ul className="screen__list">
              {failure.causes.map((cause, index) => (
                <li key={`${index}:${cause}`} className="screen__detail">
                  {cause}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  );
}
