import React from "react";

import type { Capability, CapabilityReport } from "../lib/capabilities";

export interface UnsupportedScreenProps {
  readonly report: CapabilityReport;
}

/**
 * F-UI-12 — the unsupported screen.
 *
 * "**No fallback means the unsupported screen is a real user-facing surface** —
 * for those visitors it is the entire product." (docs/ARCHITECTURE.md, "Known
 * technical risks".) So it names the requirement that is missing, says what it
 * is for, and says where the app does run. What it never does is suggest a
 * workaround, because there is not one: there is no WebGL2 path and no
 * single-threaded path, by decision.
 *
 * The whole capability report is shown, not only the failure. Someone whose
 * WebGPU works and whose `SharedArrayBuffer` does not is looking at a server
 * misconfiguration rather than a browser problem, and the two rows together are
 * what say so.
 */
export function UnsupportedScreen({ report }: UnsupportedScreenProps): React.ReactElement {
  const missing = report.fatalFailures;
  const isolationMissing = missing.some((c) => c.id === "sab");

  return (
    <div className="screen">
      <div className="screen__inner">
        <h1 className="screen__title">dither-ork cannot run here</h1>
        <p className="screen__lede">
          {missing.length === 1
            ? "One requirement this browser does not meet stops the application: "
            : "Requirements this browser does not meet stop the application: "}
          {missing.map((c) => c.label).join(" and ")}. Every effect in the
          catalogue is either a WebGPU compute pass or a WebAssembly kernel that
          needs threads, so neither requirement has a slower path behind it —
          there is nothing to fall back to.
        </p>

        <h2 className="screen__section">What this build checked</h2>
        <table className="screen__table">
          <thead>
            <tr>
              <th>Requirement</th>
              <th className="screen__state">State</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {report.capabilities.map((capability) => (
              <CapabilityRow key={capability.id} capability={capability} />
            ))}
          </tbody>
        </table>

        <h2 className="screen__section">Where it does run</h2>
        <ul className="screen__list">
          <li>Chrome or Edge 113 and later, on macOS or Windows.</li>
          <li>Safari 26 and later, on macOS.</li>
          <li>Firefox 141 and later on Windows, 145 and later on macOS.</li>
          <li>
            Linux is not a target platform: WebGPU there is limited to particular
            drivers and, on Firefox, to Nightly.
          </li>
        </ul>

        {isolationMissing ? (
          <>
            <h2 className="screen__section">If you are running this locally</h2>
            <p className="screen__lede">
              <code>SharedArrayBuffer</code> is only exposed to a cross-origin
              isolated document, which needs the server to send{" "}
              <code>Cross-Origin-Opener-Policy: same-origin</code> and{" "}
              <code>Cross-Origin-Embedder-Policy: require-corp</code>. The dev
              server sets both from <code>web/vite.config.ts</code>; a proxy in
              front of it must pass them through unmodified.
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}

function CapabilityRow({ capability }: { readonly capability: Capability }): React.ReactElement {
  const state =
    capability.state === "ok" ? "ok" : capability.fatal ? "missing" : "degraded";
  const label =
    capability.state === "ok" ? "OK" : capability.fatal ? "MISSING" : "DEGRADED";
  return (
    <tr>
      <td>{capability.label}</td>
      <td className={`screen__state screen__state--${state}`}>{label}</td>
      <td className="screen__detail">{capability.detail}</td>
    </tr>
  );
}
