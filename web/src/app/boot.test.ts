import { describe, expect, it } from "vitest";

import type { Capability, CapabilityReport } from "../lib/capabilities";
import {
  RegistryValidationError,
  loadEffectRegistry,
  type EffectRegistry,
} from "../registry";
import { classifyBoot, describeStartupError } from "./boot";

function capability(id: string, fatal: boolean, ok: boolean): Capability {
  return {
    id,
    label: id,
    fatal,
    state: ok ? "ok" : "missing",
    detail: `${id} is ${ok ? "present" : "absent"}`,
  };
}

function report(capabilities: readonly Capability[]): CapabilityReport {
  const fatalFailures = capabilities.filter((c) => c.fatal && c.state === "missing");
  return { capabilities, fatalFailures, usable: fatalFailures.length === 0 };
}

const HEALTHY = report([
  capability("webgpu", true, true),
  capability("sab", true, true),
  capability("opfs", false, true),
  capability("fsa", false, true),
]);

const NO_WEBGPU = report([
  capability("webgpu", true, false),
  capability("sab", true, true),
]);

const DEGRADED = report([
  capability("webgpu", true, true),
  capability("sab", true, true),
  capability("opfs", false, false),
]);

function neverLoads(): EffectRegistry {
  throw new Error("the registry must not be consulted");
}

describe("classifyBoot — F-UI-12", () => {
  it("routes a missing fatal capability to the unsupported screen", () => {
    const outcome = classifyBoot(NO_WEBGPU, neverLoads);
    expect(outcome.kind).toBe("unsupported");
  });

  it("does not consult the registry when the browser cannot run the app at all", () => {
    // `neverLoads` throwing would surface as `registry-failed`, so this asserts
    // the ordering rather than merely describing it.
    expect(classifyBoot(NO_WEBGPU, neverLoads).kind).toBe("unsupported");
  });

  it("carries the report onto the unsupported screen so it can name the failure", () => {
    const outcome = classifyBoot(NO_WEBGPU, neverLoads);
    expect(outcome.report.fatalFailures.map((c) => c.id)).toEqual(["webgpu"]);
  });

  it("starts when only a non-fatal capability is missing", () => {
    const registry = loadEffectRegistry();
    const outcome = classifyBoot(DEGRADED, () => registry);
    expect(outcome.kind).toBe("ready");
  });
});

describe("classifyBoot — the registry gate", () => {
  it("stops on a rejected catalogue and keeps every issue", () => {
    const error = new RegistryValidationError([
      {
        effect: "bogus",
        code: "missing-surprise",
        message: "no surprise range",
      },
    ]);
    const outcome = classifyBoot(HEALTHY, () => {
      throw error;
    });
    expect(outcome.kind).toBe("registry-failed");
    if (outcome.kind !== "registry-failed") throw new Error("unreachable");
    expect(outcome.issues).toHaveLength(1);
    expect(outcome.issues[0]?.effect).toBe("bogus");
  });

  it("still stops, with the message, when the failure carries no issue list", () => {
    const outcome = classifyBoot(HEALTHY, () => {
      throw new Error("the effect glob matched nothing");
    });
    expect(outcome.kind).toBe("registry-failed");
    if (outcome.kind !== "registry-failed") throw new Error("unreachable");
    expect(outcome.issues).toEqual([]);
    expect(outcome.message).toContain("matched nothing");
  });

  it("hands the sealed registry to the application when everything passes", () => {
    // The real catalogue, not a stand-in: this is the same call the app makes.
    const outcome = classifyBoot(HEALTHY, loadEffectRegistry);
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") throw new Error("unreachable");
    expect(outcome.registry.size).toBeGreaterThan(0);
  });
});

describe("describeStartupError — what the screen is given", () => {
  it("keeps the whole chain, because the outermost line is the least specific", () => {
    // This is the real shape of the failure that shipped: the session layer
    // wraps what the render service threw, and the render service hangs the
    // browser's own event on the cause. Reading only `error.message` there is
    // what left the screen with nothing to say.
    const browser = new Error("the worker script at /assets/render.worker-x.js never ran");
    const service = new Error("render worker error", { cause: browser });
    const described = describeStartupError(service);
    expect(described.message).toContain("render worker error");
    expect(described.causes).toEqual(["Error: the worker script at /assets/render.worker-x.js never ran"]);
  });

  it("follows more than one level", () => {
    const root = new Error("HTTP 404");
    const middle = new Error("the worker script never ran", { cause: root });
    const outer = new Error("the render service could not start", { cause: middle });
    expect(describeStartupError(outer).causes).toEqual([
      "Error: the worker script never ran",
      "Error: HTTP 404",
    ]);
  });

  it("reports a throw that was not an Error rather than dropping it", () => {
    expect(describeStartupError("device lost").message).toBe("device lost");
  });

  it("names an Error with no message instead of producing an empty line", () => {
    expect(describeStartupError(new RangeError()).message).toBe("RangeError");
  });

  it("does not follow a cause chain round in a circle", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    const described = describeStartupError(a);
    expect(described.causes.length).toBeLessThan(4);
    expect(described.causes.at(-1)).toContain("refers back to itself");
  });
});
