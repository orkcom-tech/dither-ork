/**
 * Resolving a pass's output extent.
 *
 * Four layers read the number this module produces — the texture pool allocates
 * it, the executor dispatches over it, the packer hands it to the shader, the
 * cache is charged for it — so the assertions here are about the arithmetic
 * being exactly one thing rather than four nearly-identical things. The rounding
 * cases are the ones worth having: a downscale that rounds the wrong way drops a
 * column of the image, and a downscale that rounds to zero is a WebGPU
 * validation error a long way from the slider that caused it.
 */

import { describe, expect, it } from "vitest";

import type { ComputePass, Extent, PassExtent, UniformLayout } from "../types/gpu";
import { SAME_EXTENT } from "../types/gpu";
import { setLevel } from "../lib/log";
import {
  ExtentError,
  assertExtent,
  describeExtent,
  extentsEqual,
  passExtentRule,
  resizes,
  resolveExtent,
  resolvePassExtent,
} from "./extent";

setLevel("error");

const EMPTY_UNIFORMS: UniformLayout = { sizeBytes: 16, fields: [] };

function passWith(extent?: PassExtent): ComputePass {
  return {
    id: "test/resample",
    label: "Test",
    wgsl: "// not compiled here",
    entryPoint: "main",
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    access: "neighbourhood",
    bindings: [],
    uniforms: EMPTY_UNIFORMS,
    ...(extent === undefined ? {} : { extent }),
  };
}

const HD: Extent = { width: 1920, height: 1080 };

describe("resolveExtent", () => {
  it("returns the input unchanged for the same-extent rule", () => {
    expect(resolveExtent("p", SAME_EXTENT, HD, {})).toEqual(HD);
  });

  it("divides by an integer factor, rounding up", () => {
    const rule: PassExtent = { kind: "downscale", factorParam: "factor" };
    expect(resolveExtent("p", rule, HD, { factor: 4 })).toEqual({
      width: 480,
      height: 270,
    });
    // 1921 / 4 is 480.25. Rounding down would drop the last column of the image
    // rather than letting the final box cover a partial source window.
    expect(
      resolveExtent("p", rule, { width: 1921, height: 1081 }, { factor: 4 }),
    ).toEqual({ width: 481, height: 271 });
  });

  it("never resolves a downscale below one texel", () => {
    const rule: PassExtent = { kind: "downscale", factorParam: "factor" };
    expect(
      resolveExtent("p", rule, { width: 3, height: 1 }, { factor: 64 }),
    ).toEqual({ width: 1, height: 1 });
  });

  it("treats factor 1 as the identity in either direction", () => {
    for (const kind of ["downscale", "upscale"] as const) {
      expect(resolveExtent("p", { kind, factorParam: "f" }, HD, { f: 1 })).toEqual(HD);
    }
  });

  it("multiplies by an integer factor", () => {
    expect(
      resolveExtent(
        "p",
        { kind: "upscale", factorParam: "scale" },
        { width: 160, height: 144 },
        { scale: 6 },
      ),
    ).toEqual({ width: 960, height: 864 });
  });

  it("scales one axis when the rule names one", () => {
    // Separable resampling is two passes, each touching one axis. A rule that
    // could only scale both would make that implementation inexpressible.
    expect(
      resolveExtent("p", { kind: "downscale", factorParam: "f", axes: "x" }, HD, {
        f: 2,
      }),
    ).toEqual({ width: 960, height: 1080 });
    expect(
      resolveExtent("p", { kind: "downscale", factorParam: "f", axes: "y" }, HD, {
        f: 2,
      }),
    ).toEqual({ width: 1920, height: 540 });
  });

  it("composes two single-axis passes into the two-axis answer", () => {
    const horizontal = resolveExtent(
      "p0",
      { kind: "downscale", factorParam: "f", axes: "x" },
      HD,
      { f: 3 },
    );
    const vertical = resolveExtent(
      "p1",
      { kind: "downscale", factorParam: "f", axes: "y" },
      horizontal,
      { f: 3 },
    );
    expect(vertical).toEqual(
      resolveExtent("p", { kind: "downscale", factorParam: "f" }, HD, { f: 3 }),
    );
  });

  it("refuses a factor that is missing, fractional, zero or negative", () => {
    const rule: PassExtent = { kind: "downscale", factorParam: "factor" };
    expect(() => resolveExtent("p", rule, HD, {})).toThrowError(ExtentError);
    for (const bad of [1.5, 0, -2, Number.NaN]) {
      expect(() => resolveExtent("p", rule, HD, { factor: bad })).toThrowError(
        ExtentError,
      );
    }
  });

  it("refuses a factor that is not a number", () => {
    const rule: PassExtent = { kind: "upscale", factorParam: "factor" };
    expect(() => resolveExtent("p", rule, HD, { factor: "4" })).toThrowError(
      ExtentError,
    );
    expect(() => resolveExtent("p", rule, HD, { factor: true })).toThrowError(
      ExtentError,
    );
  });

  it("refuses an input extent nothing could allocate", () => {
    for (const bad of [
      { width: 0, height: 8 },
      { width: 8, height: 0 },
      { width: 8.5, height: 8 },
      { width: -8, height: 8 },
    ]) {
      expect(() => resolveExtent("p", SAME_EXTENT, bad, {})).toThrowError(ExtentError);
    }
  });

  it("names the pass in every refusal", () => {
    try {
      resolveExtent("crush/main", { kind: "downscale", factorParam: "factor" }, HD, {});
      expect.unreachable("a missing factor parameter must not resolve");
    } catch (error) {
      expect(String(error)).toContain("crush/main");
      expect(String(error)).toContain("factor");
    }
  });
});

describe("passExtentRule", () => {
  it("reads an absent declaration as the same-extent rule", () => {
    // 63 effects declare a pass and two of them resample. Making every one of
    // them restate "same" would put the interesting declaration where nobody
    // looks, so absence has to mean something definite.
    expect(passExtentRule(passWith())).toEqual(SAME_EXTENT);
    expect(resizes(passExtentRule(passWith()))).toBe(false);
    expect(resolvePassExtent(passWith(), HD, {})).toEqual(HD);
  });

  it("reads a declared rule", () => {
    const pass = passWith({ kind: "downscale", factorParam: "factor" });
    expect(resizes(passExtentRule(pass))).toBe(true);
    expect(resolvePassExtent(pass, HD, { factor: 2 })).toEqual({
      width: 960,
      height: 540,
    });
  });
});

describe("extent helpers", () => {
  it("compares both axes", () => {
    expect(extentsEqual(HD, { width: 1920, height: 1080 })).toBe(true);
    expect(extentsEqual(HD, { width: 1920, height: 1081 })).toBe(false);
    expect(extentsEqual(HD, { width: 1921, height: 1080 })).toBe(false);
  });

  it("describes an extent the way the logs do", () => {
    expect(describeExtent(HD)).toBe("1920x1080");
  });

  it("returns the extent it accepted, so it can be used inline", () => {
    expect(assertExtent("x", HD)).toBe(HD);
  });
});
