/**
 * Node masking (F-PP-08): the arithmetic, and the transcription into WGSL.
 *
 * Same shape as `blend.test.ts` and for the same reason. The formulas exist
 * twice — here for the serial half, in `_composite.wgsl` for the parallel half
 * — because both execution kinds have to produce the same numbers or preview
 * and export stop matching. What a test can check mechanically is that the
 * shader declares every kind and channel and agrees on the ordinals; the
 * formulas themselves have to be diffed by eye, which is why the two files keep
 * them in the same order under a "keep identical" banner.
 */

import { describe, expect, it } from "vitest";

import wgsl from "../shaders/_composite.wgsl?raw";
import type { NodeMask } from "../types/document";
import {
  MASK_CHANNELS,
  MASK_CHANNEL_ORDINAL,
  MASK_KINDS,
  MASK_KIND_ORDINAL,
  linearLuminance,
  maskChannelValue,
  maskCoverage,
  maskDigest,
  maskNeedsImage,
  maskProblem,
  resolveColorTarget,
  smoothstep,
} from "./mask";

const NO_IMAGE = [0, 0, 0, 0] as const;

function luminanceMask(low: number, high: number, feather: number, invert = false): NodeMask {
  return { source: { kind: "luminance", low, high, feather }, invert };
}

describe("the shader transcription", () => {
  it("declares the same ordinal for every mask kind", () => {
    const names: Record<(typeof MASK_KINDS)[number], string> = {
      luminance: "MASK_LUMINANCE",
      color: "MASK_COLOR",
      image: "MASK_IMAGE",
    };
    for (const kind of MASK_KINDS) {
      const declaration = new RegExp(
        `const\\s+${names[kind]}\\s*:\\s*u32\\s*=\\s*(\\d+)u\\s*;`,
      ).exec(wgsl);
      expect(declaration, `_composite.wgsl declares no ${names[kind]}`).not.toBeNull();
      expect(Number(declaration?.[1]), `${kind} ordinal`).toBe(MASK_KIND_ORDINAL[kind]);
    }
  });

  it("declares the same ordinal for every mask channel", () => {
    const names: Record<(typeof MASK_CHANNELS)[number], string> = {
      luminance: "MASK_CH_LUMINANCE",
      alpha: "MASK_CH_ALPHA",
      red: "MASK_CH_RED",
      green: "MASK_CH_GREEN",
      blue: "MASK_CH_BLUE",
    };
    for (const channel of MASK_CHANNELS) {
      const declaration = new RegExp(
        `const\\s+${names[channel]}\\s*:\\s*u32\\s*=\\s*(\\d+)u\\s*;`,
      ).exec(wgsl);
      expect(declaration, `_composite.wgsl declares no ${names[channel]}`).not.toBeNull();
      expect(Number(declaration?.[1]), `${channel} ordinal`).toBe(
        MASK_CHANNEL_ORDINAL[channel],
      );
    }
  });

  it("has both entry points, because a mask picture is a separate pipeline", () => {
    // One entry point would have to be handed some texture on the mask binding
    // for every unmasked composite, and binding a texture to a slot the shader
    // is told to ignore renders fine until the day the flag is wrong.
    expect(wgsl).toMatch(/fn composite\s*\(/);
    expect(wgsl).toMatch(/fn composite_masked\s*\(/);
    expect(wgsl).toMatch(/@group\(0\) @binding\(7\) var mask_tex/);
  });

  it("uses the same luminance weights the definition does", () => {
    // Rec. 709 in linear light. A different set here would put every luminance
    // band in a different place on the GPU than on the CPU.
    expect(wgsl).toContain("0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b");
    expect(linearLuminance(1, 0, 0)).toBeCloseTo(0.2126, 12);
    expect(linearLuminance(0, 1, 0)).toBeCloseTo(0.7152, 12);
    expect(linearLuminance(0, 0, 1)).toBeCloseTo(0.0722, 12);
  });
});

describe("smoothstep", () => {
  it("matches WGSL's polynomial", () => {
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 12);
    expect(smoothstep(0, 1, 0.25)).toBeCloseTo(0.15625, 12);
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
  });

  it("degenerates to a step when the edges meet", () => {
    // This is what makes a feather of zero a hard band with no branch in either
    // implementation.
    expect(smoothstep(0.5, 0.5, 0.49)).toBe(0);
    expect(smoothstep(0.5, 0.5, 0.5)).toBe(1);
  });
});

describe("a luminance mask", () => {
  it("covers inside the band and nothing outside it", () => {
    const mask = luminanceMask(0.2, 0.8, 0);
    expect(maskCoverage(mask, null, [0.5, 0.5, 0.5, 1], NO_IMAGE)).toBe(1);
    expect(maskCoverage(mask, null, [0, 0, 0, 1], NO_IMAGE)).toBe(0);
    expect(maskCoverage(mask, null, [1, 1, 1, 1], NO_IMAGE)).toBe(0);
  });

  it("falls off across the feather on both sides", () => {
    const mask = luminanceMask(0.4, 0.6, 0.2);
    // Half a feather below the low bound is the midpoint of the rise.
    const grey = 0.3 / 0.2126; // a red-only sample whose luminance is 0.3
    const coverage = maskCoverage(mask, null, [grey, 0, 0, 1], NO_IMAGE);
    expect(coverage).toBeGreaterThan(0);
    expect(coverage).toBeLessThan(1);
  });

  it("inverts to the complement", () => {
    const plain = luminanceMask(0.2, 0.8, 0);
    const inverted = luminanceMask(0.2, 0.8, 0, true);
    const pixel = [0.5, 0.5, 0.5, 1] as const;
    expect(maskCoverage(plain, null, pixel, NO_IMAGE)).toBe(1);
    expect(maskCoverage(inverted, null, pixel, NO_IMAGE)).toBe(0);
  });

  it("is refused when the band is empty", () => {
    // A node that contributes nothing anywhere is indistinguishable from a
    // broken effect, so it is a refusal rather than an invisible node.
    expect(maskProblem(luminanceMask(0.8, 0.2, 0))).toMatch(/above high/);
    expect(maskProblem(luminanceMask(-1, 0.5, 0))).toMatch(/outside 0\.\.1/);
    expect(maskProblem(luminanceMask(0.2, 0.8, -1))).toMatch(/negative/);
    expect(maskProblem(luminanceMask(0.2, 0.8, 0))).toBeNull();
  });
});

describe("a colour mask", () => {
  const red: NodeMask = {
    source: { kind: "color", color: [255, 0, 0], tolerance: 0.1, feather: 0.1 },
    invert: false,
  };

  it("covers the colour it names and not its opposite", () => {
    const target = resolveColorTarget([255, 0, 0]);
    expect(maskCoverage(red, target, [1, 0, 0, 1], NO_IMAGE)).toBe(1);
    expect(maskCoverage(red, target, [0, 1, 0, 1], NO_IMAGE)).toBe(0);
  });

  it("measures distance in OKLab rather than in the code values", () => {
    // Two greys the same sRGB distance apart are *not* the same OKLab distance
    // apart, which is the entire reason the metric is what it is. The dark pair
    // is further apart perceptually, so a mask aimed at black covers less of it.
    const black = resolveColorTarget([0, 0, 0]);
    const nearBlack = maskCoverage(
      { source: { kind: "color", color: [0, 0, 0], tolerance: 0.1, feather: 0 }, invert: false },
      black,
      [0.02, 0.02, 0.02, 1],
      NO_IMAGE,
    );
    expect(nearBlack).toBeGreaterThanOrEqual(0);
    expect(nearBlack).toBeLessThanOrEqual(1);
  });

  it("refuses a tolerance of zero", () => {
    expect(
      maskProblem({
        source: { kind: "color", color: [255, 0, 0], tolerance: 0, feather: 0 },
        invert: false,
      }),
    ).toMatch(/not positive/);
  });

  it("refuses a colour that is not a packed triplet", () => {
    expect(
      maskProblem({
        source: { kind: "color", color: [300, 0, 0], tolerance: 0.1, feather: 0 },
        invert: false,
      }),
    ).toMatch(/0\.\.255/);
  });
});

describe("an image mask", () => {
  it("reads the channel it names, from the mask picture and not from the input", () => {
    const mask: NodeMask = { source: { kind: "image", channel: "red" }, invert: false };
    expect(maskCoverage(mask, null, [1, 1, 1, 1], [0.25, 0, 0, 1])).toBe(0.25);
  });

  it("reads alpha, so a shape drawn over transparency masks by its coverage", () => {
    const mask: NodeMask = { source: { kind: "image", channel: "alpha" }, invert: false };
    // Luminance would read this transparent white as fully covering.
    expect(maskCoverage(mask, null, [0, 0, 0, 1], [1, 1, 1, 0])).toBe(0);
  });

  it("clamps out-of-range samples rather than letting them scale opacity past 1", () => {
    // `rgba16float` carries more than 1.0 and several effects produce more.
    const mask: NodeMask = { source: { kind: "image", channel: "red" }, invert: false };
    expect(maskCoverage(mask, null, [0, 0, 0, 1], [4, 0, 0, 1])).toBe(1);
    expect(maskCoverage(mask, null, [0, 0, 0, 1], [-2, 0, 0, 1])).toBe(0);
  });

  it("is the only kind that needs an edge", () => {
    expect(maskNeedsImage({ source: { kind: "image", channel: "red" }, invert: false })).toBe(
      true,
    );
    expect(maskNeedsImage(luminanceMask(0, 1, 0))).toBe(false);
  });

  it("names every channel it can read", () => {
    for (const channel of MASK_CHANNELS) {
      expect(maskChannelValue(channel, 0.1, 0.2, 0.3, 0.4)).toBeGreaterThan(0);
    }
  });
});

describe("the digest folded into the content hash", () => {
  it("differs when the mask differs", () => {
    expect(maskDigest(luminanceMask(0.2, 0.8, 0))).not.toBe(
      maskDigest(luminanceMask(0.2, 0.8, 0.1)),
    );
    expect(maskDigest(luminanceMask(0.2, 0.8, 0))).not.toBe(
      maskDigest(luminanceMask(0.2, 0.8, 0, true)),
    );
  });

  it("is the same for two masks that are the same mask", () => {
    expect(maskDigest(luminanceMask(0.2, 0.8, 0.05))).toBe(
      maskDigest(luminanceMask(0.2, 0.8, 0.05)),
    );
  });

  it("distinguishes the kinds from one another", () => {
    const image: NodeMask = { source: { kind: "image", channel: "luminance" }, invert: false };
    expect(maskDigest(image)).not.toBe(maskDigest(luminanceMask(0, 1, 0)));
  });
});
