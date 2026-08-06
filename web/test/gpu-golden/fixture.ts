/**
 * The generated source the GPU golden set is taken from.
 *
 * Generated, not committed as an input. `core/crates/dither-core/tests/golden.rs`
 * settled that shape for the CPU path and this follows it: the fixture is code a
 * reviewer can read, the *output* is what is stored, and the fixture's own PNG
 * is written alongside the references so a change to this file shows up as one
 * image diff instead of as one per effect.
 *
 * ## One fixture, four regions
 *
 * The CPU set uses five separate fixtures because a diffusion kernel is fed a
 * whole image and its behaviour changes with the image. The parallel effects
 * are a different problem: they are per-pixel independent, so what matters is
 * that *every* kind of content a shader can key off is present in the one frame
 * each of them renders. Five fixtures times forty-eight effects times two
 * parameter sets is 480 reference images to review; one fixture with four
 * regions is 96, and it catches the same defects because each region is the
 * thing some family of shaders needs:
 *
 * - **Hue sweep** — the only region with chroma. Channel swap, RGB split,
 *   chromatic aberration, gradient map, HSL and the CMYK halftone do nothing
 *   readable on grey.
 * - **Detail band** — combs at five periods, a checkerboard, and isolated single
 *   pixels. Without high-frequency content a working blur is indistinguishable
 *   from a pass-through, and so are sharpen, edge detect and emboss.
 * - **Hard-edge chart** — saturated flats meeting at exact boundaries. This is
 *   where an off-by-one in a displacement kernel becomes visible as a shifted
 *   edge rather than as a rounding difference inside a gradient, and it is what
 *   the index-map consumers (outline, dilate/erode) need to have anything to
 *   outline.
 * - **Tone ramp** — a smooth two-dimensional gradient. Every dither, halftone
 *   and screen effect writes its structure onto this, so a transposed
 *   coefficient in a screen shows up here as a changed pattern.
 *
 * ## Size
 *
 * 100x76, in the same range as the CPU fixtures (128x32 to 101x67) so the
 * reference set stays reviewable and small. Neither dimension is a multiple of
 * the 8x8 workgroup size every per-pixel pass declares: both leave a partial
 * workgroup, so a shader that writes outside its bounds check, or that skips the
 * remainder, is caught by the golden rather than by a driver on someone's
 * machine.
 *
 * Alpha is 255 everywhere. Nothing in the catalogue keys off alpha, and a
 * varying alpha would only add a channel of noise to eighty-eight diffs.
 */

import { srgbToLinear } from "../../src/gpu";
import type { CpuColorSurface } from "../../src/types/graph";

/** Identity of the fixture, used in the stored path and in every diagnostic. */
export const FIXTURE_ID = "gpu-catalogue";

export const FIXTURE_WIDTH = 100;
export const FIXTURE_HEIGHT = 76;

/** Row at which each region starts. The last runs to the bottom. */
const HUE_ROWS = 28;
const DETAIL_ROWS = 20;
const CHART_ROWS = 12;

const DETAIL_TOP = HUE_ROWS;
const CHART_TOP = DETAIL_TOP + DETAIL_ROWS;
const RAMP_TOP = CHART_TOP + CHART_ROWS;

/**
 * The eight corners and edges of the sRGB cube, in the order the chart lays
 * them out. Saturated on purpose: a palette match on one of these is never a
 * close call, so a difference here is a real difference and not a decision that
 * went the other way by one ulp.
 */
const CHART_COLORS: readonly (readonly [number, number, number])[] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [0, 255, 255],
  [255, 0, 255],
  [255, 255, 0],
  [255, 255, 255],
  [0, 0, 0],
];

/** HSV to 8-bit sRGB. Exact rational arithmetic; no table, no interpolation. */
function hsvToSrgb(hue: number, saturation: number, value: number): [number, number, number] {
  const sector = ((hue % 360) + 360) % 360 / 60;
  const i = Math.floor(sector);
  const f = sector - i;
  const p = value * (1 - saturation);
  const q = value * (1 - saturation * f);
  const t = value * (1 - saturation * (1 - f));
  const table: readonly (readonly [number, number, number])[] = [
    [value, t, p],
    [q, value, p],
    [p, value, t],
    [p, q, value],
    [t, p, value],
    [value, p, q],
  ];
  const rgb = table[i % 6] ?? [value, value, value];
  return [Math.round(rgb[0] * 255), Math.round(rgb[1] * 255), Math.round(rgb[2] * 255)];
}

/**
 * One pixel of the detail band, as an 8-bit grey.
 *
 * Five comb periods, a checkerboard and a row of isolated single pixels, in
 * bands four rows deep. The periods are 2, 3, 4, 6 and 8 — deliberately not all
 * powers of two, because a shader that samples on a power-of-two grid (every
 * ordered dither, every halftone screen) aliases against 2, 4 and 8 in a way it
 * does not against 3 and 6, and a fixture that only carried powers of two would
 * hide the difference.
 */
function detailValue(x: number, row: number): number {
  const band = Math.floor(row / 4);
  switch (band) {
    case 0:
      return x % 2 === 0 ? 255 : 0;
    case 1:
      return x % 3 === 0 ? 255 : 32;
    case 2:
      return x % 4 < 2 ? 224 : 16;
    case 3:
      return (x + row) % 2 === 0 ? 255 : 0;
    default:
      // Isolated single pixels on a mid field: the one pattern a neighbourhood
      // kernel cannot fake, because a pass-through leaves the dot alone and any
      // real kernel spreads it.
      return x % 8 === 4 ? 255 : 96;
  }
}

/**
 * The fixture as 8-bit sRGB RGBA, the layout the reference PNG stores.
 *
 * `Uint8Array` rather than `ImageData` because this file is imported by the
 * harness page *and* is the definition the stored source PNG is written from;
 * tying it to a DOM type would make it un-runnable outside a browser for no
 * gain.
 */
export function renderFixture(): Uint8Array {
  const data = new Uint8Array(FIXTURE_WIDTH * FIXTURE_HEIGHT * 4);

  for (let y = 0; y < FIXTURE_HEIGHT; y += 1) {
    for (let x = 0; x < FIXTURE_WIDTH; x += 1) {
      const at = (y * FIXTURE_WIDTH + x) * 4;
      let r: number;
      let g: number;
      let b: number;

      if (y < DETAIL_TOP) {
        // Hue across, value down: every hue at four levels of brightness, so a
        // hue-keyed effect and a luminance-keyed one both have somewhere to act.
        const hue = (x / (FIXTURE_WIDTH - 1)) * 360;
        const value = 1 - 0.7 * (y / (DETAIL_TOP - 1));
        [r, g, b] = hsvToSrgb(hue, 0.9, value);
      } else if (y < CHART_TOP) {
        const v = detailValue(x, y - DETAIL_TOP);
        r = v;
        g = v;
        b = v;
      } else if (y < RAMP_TOP) {
        const column = Math.min(
          CHART_COLORS.length - 1,
          Math.floor((x * CHART_COLORS.length) / FIXTURE_WIDTH),
        );
        const swatch = CHART_COLORS[column] ?? [0, 0, 0];
        [r, g, b] = swatch;
      } else {
        // Tone ramp: left-to-right lightness crossed with a top-to-bottom
        // envelope, so the surface has a gradient in both axes and a screen
        // effect cannot look right by getting only one of them right.
        const across = x / (FIXTURE_WIDTH - 1);
        const down = (y - RAMP_TOP) / Math.max(1, FIXTURE_HEIGHT - 1 - RAMP_TOP);
        const v = across * (0.25 + 0.75 * (1 - down));
        r = Math.round(v * 255);
        g = Math.round(v * 255);
        b = Math.round(v * 255);
      }

      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      data[at + 3] = 255;
    }
  }

  return data;
}

/**
 * The same fixture decoded to linear light, which is what the GPU path takes.
 *
 * Through the renderer's own `srgbToLinear`, not a second implementation of it:
 * a fixture decoded with a different transfer function would put every reference
 * image a fraction of a level away from what the app produces, and the whole
 * point of the set is that it records what the app produces.
 */
export function fixtureAsLinearSurface(): CpuColorSurface {
  const srgb = renderFixture();
  const pixels = FIXTURE_WIDTH * FIXTURE_HEIGHT;
  const r = new Float32Array(pixels);
  const g = new Float32Array(pixels);
  const b = new Float32Array(pixels);
  const a = new Float32Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    const at = i * 4;
    r[i] = srgbToLinear((srgb[at] ?? 0) / 255);
    g[i] = srgbToLinear((srgb[at + 1] ?? 0) / 255);
    b[i] = srgbToLinear((srgb[at + 2] ?? 0) / 255);
    // Alpha carries no transfer function (F-IN-03).
    a[i] = (srgb[at + 3] ?? 0) / 255;
  }
  return { residency: "cpu", r, g, b, a };
}
