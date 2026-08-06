import { describe, expect, it } from "vitest";

import type { Capability, CapabilityReport } from "../lib/capabilities";
import {
  RegistryValidationError,
  loadEffectRegistry,
  type EffectRegistry,
} from "../registry";
import { classifyBoot } from "./boot";

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
