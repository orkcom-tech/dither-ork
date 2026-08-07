/**
 * Startup — the gate the application opens behind.
 *
 * Two checks, in this order, and both of them are terminal when they fail:
 *
 * 1. **Capabilities (F-UI-12).** WebGPU and `SharedArrayBuffer` are fatal.
 *    There is no WebGL2 path and no single-threaded path — docs/ARCHITECTURE.md,
 *    "Platform support policy" — so a browser missing either gets one explicit
 *    screen naming the requirement. For those visitors that screen *is* the
 *    product, which is why it is a real surface and not an alert.
 * 2. **The node registry.** `loadEffectRegistry()` validates the whole
 *    catalogue and throws on any issue. Nothing is repaired and nothing is
 *    dropped: a build whose catalogue is wrong renders wrong documents, and it
 *    does it convincingly. So the app stops and lists every issue.
 *
 * The order matters. The registry is not consulted when the capability check
 * has already failed: on an unsupported browser the catalogue's health is not
 * the user's problem, and two failure screens fighting over the same page is
 * how a report becomes unreadable.
 *
 * Non-fatal capabilities never stop anything and are never silent either — the
 * shell states them in the status bar for the whole session.
 */

import { checkCapabilities, type CapabilityReport } from "../lib/capabilities";
import { correlationId, logger } from "../lib/log";
import {
  RegistryValidationError,
  loadEffectRegistry,
  type EffectRegistry,
} from "../registry";
import type { RegistryIssue } from "../types/registry";

export type BootOutcome =
  | {
      readonly kind: "ready";
      readonly report: CapabilityReport;
      readonly registry: EffectRegistry;
    }
  | { readonly kind: "unsupported"; readonly report: CapabilityReport }
  | {
      readonly kind: "registry-failed";
      readonly report: CapabilityReport;
      /** Empty when the failure was discovery rather than validation. */
      readonly issues: readonly RegistryIssue[];
      readonly message: string;
    };

/**
 * Decide what the application does, given a capability report and a way to load
 * the registry.
 *
 * The loader is a parameter so this decision can be tested against every
 * outcome without a browser and without a broken catalogue having to exist.
 */
export function classifyBoot(
  report: CapabilityReport,
  loadRegistry: () => EffectRegistry,
): BootOutcome {
  const log = logger("app", correlationId());

  if (!report.usable) {
    log.error("startup halted: a fatal capability is missing", {
      missing: report.fatalFailures.map((c) => c.id).join(","),
    });
    return { kind: "unsupported", report };
  }

  try {
    const registry = loadRegistry();
    log.info("startup complete", {
      effects: registry.size,
      wasm: registry.byExecution("wasm").length,
      gpu: registry.byExecution("gpu").length,
    });
    return { kind: "ready", report, registry };
  } catch (error) {
    // Not swallowed: `loadEffectRegistry` has already logged one line per
    // issue. This carries the same facts onto the screen, because a console
    // nobody opens is not a report.
    const issues = error instanceof RegistryValidationError ? error.issues : [];
    const message = error instanceof Error ? error.message : String(error);
    log.error("startup halted: the node registry was rejected", {
      issues: issues.length,
      error: message,
    });
    return { kind: "registry-failed", report, issues, message };
  }
}

/** Run the real checks. */
export async function boot(): Promise<BootOutcome> {
  const report = await checkCapabilities();
  return classifyBoot(report, loadEffectRegistry);
}

/**
 * How deep a cause chain is followed before it is called a cycle.
 *
 * Nothing in this application wraps an error more than three deep. The bound is
 * here because `Error.cause` can be made to point at an ancestor, and a startup
 * failure screen that hangs the browser is not an improvement on one that says
 * the wrong thing.
 */
const MAX_CAUSE_DEPTH = 8;

export interface StartupErrorDescription {
  /** The outermost failure, as one line. Never empty. */
  readonly message: string;
  /** Everything it was wrapped around, outermost first. */
  readonly causes: readonly string[];
}

/**
 * Flatten a thrown value into what the startup failure screen shows.
 *
 * `Error.cause` is the only place the specific fault survives once a layer has
 * wrapped it — the render service reports "the render worker failed to start"
 * and hangs the browser's own event on the cause — so a report that reads only
 * `error.message` is a report that dropped the answer. This walks the chain.
 *
 * A non-`Error` throw is stringified rather than skipped, because "the thing
 * that was thrown was not an Error" is itself worth seeing on screen.
 */
export function describeStartupError(error: unknown): StartupErrorDescription {
  const line = (value: unknown): string => {
    if (value instanceof Error) {
      return value.message === "" ? value.name : `${value.name}: ${value.message}`;
    }
    const rendered = String(value);
    return rendered === "" ? "a failure with no message" : rendered;
  };

  const causes: string[] = [];
  const seen = new Set<unknown>();
  seen.add(error);
  let current: unknown = error instanceof Error ? error.cause : undefined;
  while (current !== undefined && current !== null && causes.length < MAX_CAUSE_DEPTH) {
    if (seen.has(current)) {
      causes.push("(the cause chain refers back to itself and was not followed further)");
      break;
    }
    seen.add(current);
    causes.push(line(current));
    current = current instanceof Error ? current.cause : undefined;
  }

  return { message: line(error), causes };
}
