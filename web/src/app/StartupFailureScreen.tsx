import React from "react";

import type { RegistryIssue } from "../types/registry";

export interface StartupFailureScreenProps {
  readonly issues: readonly RegistryIssue[];
  readonly message: string;
}

/**
 * The node registry was rejected, so the application does not start.
 *
 * This is not a browser problem and it is not the user's fault — it is a build
 * whose effect catalogue does not validate, and the only useful thing to do
 * with it is to put every issue on the screen. Starting anyway is the one
 * option that is definitely wrong: a catalogue that is 62 effects because one
 * was quietly dropped renders documents that are missing a node, convincingly
 * and without a symptom.
 */
export function StartupFailureScreen({
  issues,
  message,
}: StartupFailureScreenProps): React.ReactElement {
  return (
    <div className="screen">
      <div className="screen__inner">
        <h1 className="screen__title">The effect catalogue was rejected</h1>
        <p className="screen__lede">
          Every effect module is discovered and validated as one set at startup.
          This build&rsquo;s catalogue did not pass, so nothing further ran.
          Nothing is repaired and nothing is dropped: an effect that silently
          disappears leaves a document rendering one node short, with no symptom
          anyone could see. The same issues are in the browser console.
        </p>

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
            <p className="screen__detail">{message}</p>
          </>
        )}
      </div>
    </div>
  );
}
