/**
 * The blend definitions, and the one thing a reader cannot check by eye.
 *
 * Two kinds of assertion here, and the second is the reason the file exists.
 *
 * **The arithmetic**, which is ordinary: known values, the identities every
 * compositing model has to satisfy (opacity 0 is the base, opacity 1 in normal
 * blend is the top), and the continuity of soft light at its pivot.
 *
 * **The transcription.** There are two implementations of these formulas —
 * this module for the serial half and `shaders/_composite.wgsl` for the
 * parallel one — because there have to be, and a preview that does not match an
 * export is the failure that follows from them drifting. A test cannot run WGSL
 * without a device, so it cannot check the *formulas* agree; what it can check
 * is the part that goes wrong silently rather than visibly, which is the
 * **ordinal numbering**. A mode inserted in the middle of `BLEND_MODES` and not
 * in the shader's const block does not fail to compile and does not throw: it
 * renders the wrong blend mode, for that mode and every mode after it, in every
 * document already saved.
 */

import { describe, expect, it } from "vitest";

import type { BlendMode } from "../types/document";
import type { CpuColorSurface } from "../types/graph";
import {
  BLEND_MODES,
  BLEND_ORDINAL,
  blendChannel,
  compositeChannel,
  compositeLinearSurface,
} from "./blend";

import wgsl from "../shaders/_composite.wgsl?raw";

/** `hard-light` -> `BLEND_HARD_LIGHT`, the shader's naming. */
function constantName(mode: BlendMode): string {
  return `BLEND_${mode.toUpperCase().replace(/-/g, "_")}`;
}

describe("blend ordinals", () => {
  it("numbers every mode exactly once, from zero", () => {
    const ordinals = BLEND_MODES.map((mode) => BLEND_ORDINAL[mode]);
    expect(ordinals).toEqual(BLEND_MODES.map((_, index) => index));
    expect(new Set(ordinals).size).toBe(BLEND_MODES.length);
  });

  it("covers the whole BlendMode union", () => {
    // `Record<BlendMode, number>` makes the *type* total; this checks the value
    // is, which is what fails when a mode is added to the union alone.
    const every: Record<BlendMode, true> = {
      normal: true,
      multiply: true,
      screen: true,
      overlay: true,
      "hard-light": true,
      "soft-light": true,
      darken: true,
      lighten: true,
      difference: true,
      exclusion: true,
      add: true,
      subtract: true,
    };
    expect([...BLEND_MODES].sort()).toEqual(Object.keys(every).sort());
  });
});

describe("the shader transcription", () => {
  it("declares the same ordinal for every mode", () => {
    for (const mode of BLEND_MODES) {
      const declaration = new RegExp(
        `const\\s+${constantName(mode)}\\s*:\\s*u32\\s*=\\s*(\\d+)u\\s*;`,
      ).exec(wgsl);
      expect(declaration, `_composite.wgsl declares no ${constantName(mode)}`).not.toBeNull();
      expect(Number(declaration?.[1]), `${mode} ordinal`).toBe(BLEND_ORDINAL[mode]);
    }
  });

  it("has an arm in blend_channel for every ordinal", () => {
    // Scoped to `blend_channel`'s own body rather than the whole file: the
    // masking half (F-PP-08) has a switch of its own over MASK_CHANNELS, and a
    // file-wide scan would count its arms as blend modes.
    const body = /fn blend_channel\([\s\S]*?\n\}/.exec(wgsl)?.[0];
    expect(body, "_composite.wgsl declares no blend_channel").not.toBeUndefined();
    // The last mode is the `default` arm — WGSL requires one, and the
    // convention (shaders/CONVENTIONS.md) is to spend it on the last real case
    // rather than on a catch-all that could mask a mode nobody wired up.
    const arms = [...(body ?? "").matchAll(/case\s+(\d+)u\s*:/g)].map((match) =>
      Number(match[1]),
    );
    const last = BLEND_MODES.length - 1;
    expect(arms.sort((a, b) => a - b)).toEqual(
      BLEND_MODES.slice(0, last).map((_, index) => index),
    );
    expect(body).toMatch(/default\s*:/);
  });
});

describe("blendChannel", () => {
  it("returns the top layer for normal", () => {
    expect(blendChannel("normal", 0.25, 0.75)).toBe(0.75);
  });

  it("multiplies, screens and differences light", () => {
    expect(blendChannel("multiply", 0.5, 0.5)).toBeCloseTo(0.25, 12);
    expect(blendChannel("screen", 0.5, 0.5)).toBeCloseTo(0.75, 12);
    expect(blendChannel("difference", 0.25, 0.75)).toBeCloseTo(0.5, 12);
    expect(blendChannel("exclusion", 0.5, 0.5)).toBeCloseTo(0.5, 12);
  });

  it("picks a side for darken and lighten", () => {
    expect(blendChannel("darken", 0.25, 0.75)).toBe(0.25);
    expect(blendChannel("lighten", 0.25, 0.75)).toBe(0.75);
  });

  it("keeps white and black neutral where the mode says they are", () => {
    // The identities that make the modes recognisable: multiply by white and
    // screen by black both leave the base alone.
    expect(blendChannel("multiply", 0.4, 1)).toBeCloseTo(0.4, 12);
    expect(blendChannel("screen", 0.4, 0)).toBeCloseTo(0.4, 12);
    expect(blendChannel("darken", 0.4, 1)).toBeCloseTo(0.4, 12);
    expect(blendChannel("lighten", 0.4, 0)).toBeCloseTo(0.4, 12);
    expect(blendChannel("add", 0.4, 0)).toBeCloseTo(0.4, 12);
    expect(blendChannel("subtract", 0.4, 0)).toBeCloseTo(0.4, 12);
  });

  it("swaps the pivot between overlay and hard light", () => {
    // The same function with the operands exchanged, which is the whole
    // difference between the two and the easiest thing to get backwards.
    for (const [base, top] of [
      [0.2, 0.8],
      [0.8, 0.2],
      [0.3, 0.3],
    ] as const) {
      expect(blendChannel("overlay", base, top)).toBeCloseTo(
        blendChannel("hard-light", top, base),
        12,
      );
    }
  });

  it("keeps soft light continuous across its pivot", () => {
    // The piecewise `d(base)` term is what makes this true; the "raise base to
    // a power of top" shortcut is discontinuous here and bands a gradient.
    for (const base of [0.05, 0.2, 0.25, 0.6, 0.95]) {
      const below = blendChannel("soft-light", base, 0.5 - 1e-7);
      const above = blendChannel("soft-light", base, 0.5 + 1e-7);
      expect(above - below).toBeCloseTo(0, 6);
      // At exactly 0.5 soft light is the identity on the base.
      expect(blendChannel("soft-light", base, 0.5)).toBeCloseTo(base, 12);
    }
  });

  it("does not clip above one, and floors subtract at zero", () => {
    // The working format is rgba16float and effects such as light leak
    // legitimately produce more than 1.0; clamping in the composite would
    // change what those nodes do the moment their opacity left 100%.
    expect(blendChannel("add", 0.8, 0.9)).toBeCloseTo(1.7, 12);
    // Negative light has no meaning downstream — it would poison any luminance
    // or OKLab conversion it passed through before the edge clamped it.
    expect(blendChannel("subtract", 0.2, 0.9)).toBe(0);
  });
});

describe("compositeChannel", () => {
  it("is the base at opacity zero, for every mode", () => {
    for (const mode of BLEND_MODES) {
      expect(compositeChannel({ opacity: 0, blend: mode, mask: null }, 0.3, 0.9), mode).toBeCloseTo(
        0.3,
        12,
      );
    }
  });

  it("is the blend at opacity one, for every mode", () => {
    for (const mode of BLEND_MODES) {
      expect(compositeChannel({ opacity: 1, blend: mode, mask: null }, 0.3, 0.9), mode).toBeCloseTo(
        blendChannel(mode, 0.3, 0.9),
        12,
      );
    }
  });

  it("interpolates linearly between the two", () => {
    expect(compositeChannel({ opacity: 0.5, blend: "normal", mask: null }, 0.2, 0.8)).toBeCloseTo(0.5, 12);
  });
});

function surface(pixels: number, value: number): CpuColorSurface {
  return {
    residency: "cpu",
    r: new Float32Array(pixels).fill(value),
    g: new Float32Array(pixels).fill(value),
    b: new Float32Array(pixels).fill(value),
    a: new Float32Array(pixels).fill(1),
  };
}

describe("compositeLinearSurface", () => {
  it("blends every colour plane and lerps alpha", () => {
    const base = surface(4, 0.2);
    const top: CpuColorSurface = { ...surface(4, 0.8), a: new Float32Array(4).fill(0.5) };

    const out = compositeLinearSurface(base, top, { opacity: 0.5, blend: "normal", mask: null }, 4);

    for (let i = 0; i < 4; i += 1) {
      expect(out.r[i]).toBeCloseTo(0.5, 6);
      expect(out.g[i]).toBeCloseTo(0.5, 6);
      expect(out.b[i]).toBeCloseTo(0.5, 6);
      // Alpha is unassociated and is interpolated by opacity alone rather than
      // blended: multiplying it would erode coverage on every composite.
      expect(out.a[i]).toBeCloseTo(0.75, 6);
    }
  });

  it("leaves the base untouched at opacity zero, whatever the mode", () => {
    const base = surface(2, 0.35);
    const top = surface(2, 0.9);
    for (const mode of BLEND_MODES) {
      const out = compositeLinearSurface(base, top, { opacity: 0, blend: mode, mask: null }, 2);
      expect(out.r[0], mode).toBeCloseTo(0.35, 6);
    }
  });

  it("returns a new surface rather than writing through either input", () => {
    const base = surface(2, 0.2);
    const top = surface(2, 0.8);
    const out = compositeLinearSurface(base, top, { opacity: 1, blend: "normal", mask: null }, 2);
    expect(out.r).not.toBe(base.r);
    expect(out.r).not.toBe(top.r);
    expect(base.r[0]).toBeCloseTo(0.2, 6);
    expect(top.r[0]).toBeCloseTo(0.8, 6);
  });

  it("refuses two surfaces that do not describe the same pixel count", () => {
    // A composite with no common coordinate system is refused rather than
    // resampled: the plane lengths are the only evidence available here that
    // the caller has handed over two different grids.
    expect(() => compositeLinearSurface(surface(4, 0.2), surface(9, 0.8), {
      opacity: 0.5,
      blend: "normal",
      mask: null,
    }, 4)).toThrow(/9 samples/);
  });
});
