/**
 * Blend modes for per-node compositing (F-ST-03).
 *
 * A stack node is a filter, not a layer: its composite is against **its own
 * input**, so 50% of a blur is half-blurred rather than blurred over whatever
 * happened to precede it in the panel. `CompositeOp` in `plan.ts` says whether
 * a node has one; this says what the arithmetic is.
 *
 * ## Why the formulas live in the graph layer
 *
 * They are a property of the document's `BlendMode`, not of either backend, and
 * **both execution kinds have to produce the same numbers or preview and export
 * stop matching** — a diffusion node at 60% opacity has to look the same as a
 * blur at 60% opacity. There are two implementations because there have to be:
 * WGSL for the parallel half (`web/src/shaders/_composite.wgsl`) and this one
 * for the serial half, which composites in WASM memory so a composite costs no
 * extra boundary crossing. This module is the definition the WGSL is a
 * transcription of; `blend.test.ts` checks that the transcription covers every
 * mode and agrees on the ordinals, which is the part a reader cannot verify by
 * eye.
 *
 * This is the one place in `web/src/graph` that touches pixels, and it is here
 * rather than in a backend precisely because it must not be written twice
 * independently.
 *
 * ## Linear light, and what that changes
 *
 * **Every formula below is evaluated in linear light**, because the whole
 * pipeline is (docs/ARCHITECTURE.md, "Colour") and converting to sRGB to
 * composite and back would be a second colour path.
 *
 * That is a deliberate choice with a visible consequence, not an oversight.
 * `multiply`, `screen`, `difference`, `darken`, `lighten`, `add` and `subtract`
 * are defined by arithmetic that means the same thing in any encoding — they
 * are light being multiplied, added or compared, and doing them in linear light
 * is doing them correctly. The pivoted modes — `overlay`, `hard-light`,
 * `soft-light` — are not: they are defined around a **0.5 pivot**, and 0.5 is
 * the middle of the *code range*, not the middle of perceived brightness. In
 * linear light perceptual mid-grey sits at about 0.216, so the pivot falls
 * higher up the tone scale than it does in Photoshop and these three modes come
 * out with more of the frame on the "multiply" side: darker, with contrast
 * pivoting around a brighter tone.
 *
 * That is accepted rather than corrected. Correcting it would mean encoding to
 * sRGB, applying the pivot there and decoding back — a gamma-space island in the
 * middle of a linear pipeline, on a per-node basis, which is exactly the kind of
 * hidden second colour path the architecture exists to prevent. The look is
 * different from a compositing app's and it is consistent with everything else
 * in the stack.
 *
 * ## Range
 *
 * Values are linear-light and are **not clipped to `[0, 1]`**. The working
 * format is `rgba16float` and effects such as light leak legitimately produce
 * more than 1.0; clamping here would quietly change what those nodes do the
 * moment their opacity left 100%. `subtract` is the one exception and it floors
 * at zero, because negative light has no meaning anywhere downstream — a
 * negative sample would be re-encoded as black by the sRGB transfer at the edge
 * but would first poison any luminance or OKLab conversion it passed through.
 */

import type { BlendMode } from "../types/document";
import type { CpuColorSurface } from "../types/graph";
import type { CompositeOp } from "./plan";
import { maskCoverage, maskNeedsImage, resolveColorTarget } from "./mask";
import { GraphError } from "./errors";

/**
 * Every blend mode, in the order the ordinals below number them.
 *
 * **Append-only.** The ordinal crosses into the shader as a `u32`, so inserting
 * a mode in the middle renumbers the ones after it and every saved document
 * that names one renders a different picture. Same rule as an enum parameter's
 * `values` list (see `web/src/shaders/CONVENTIONS.md`).
 */
export const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "hard-light",
  "soft-light",
  "darken",
  "lighten",
  "difference",
  "exclusion",
  "add",
  "subtract",
] as const satisfies readonly BlendMode[];

/**
 * The ordinal each mode crosses to the GPU as.
 *
 * Derived from {@link BLEND_MODES} rather than written out, so the two cannot
 * disagree. `_composite.wgsl` restates the same numbers as `const` declarations
 * and `blend.test.ts` checks they match.
 */
export const BLEND_ORDINAL: Readonly<Record<BlendMode, number>> =
  Object.fromEntries(
    BLEND_MODES.map((mode, index) => [mode, index]),
  ) as Readonly<Record<BlendMode, number>>;

/**
 * One channel of one pixel, in linear light.
 *
 * `base` is the node's input — what was there before this node ran. `top` is
 * what the node produced. Pure, and free of any buffer, so the formulas can be
 * read and tested as arithmetic.
 */
export function blendChannel(mode: BlendMode, base: number, top: number): number {
  switch (mode) {
    case "normal":
      return top;
    case "multiply":
      return base * top;
    case "screen":
      return base + top - base * top;
    case "overlay":
      // The pivot is on the *base*, which is what distinguishes overlay from
      // hard-light; the two are the same function with the operands swapped.
      return base <= 0.5 ? 2 * base * top : 1 - 2 * (1 - base) * (1 - top);
    case "hard-light":
      return top <= 0.5 ? 2 * base * top : 1 - 2 * (1 - base) * (1 - top);
    case "soft-light":
      return softLight(base, top);
    case "darken":
      return Math.min(base, top);
    case "lighten":
      return Math.max(base, top);
    case "difference":
      return Math.abs(base - top);
    case "exclusion":
      return base + top - 2 * base * top;
    case "add":
      return base + top;
    case "subtract":
      // Floored at zero: see the range note in the module header.
      return Math.max(0, base - top);
  }
}

/**
 * The W3C compositing definition of soft light, which is also Photoshop's.
 *
 * Written out rather than approximated by a gamma curve because the piecewise
 * `d(base)` term is what keeps the function continuous at the pivot; the
 * "raise base to a power of top" shortcut is not, and the discontinuity shows
 * as a band across a gradient.
 */
function softLight(base: number, top: number): number {
  if (top <= 0.5) {
    return base - (1 - 2 * top) * base * (1 - base);
  }
  const d =
    base <= 0.25
      ? ((16 * base - 12) * base + 4) * base
      : Math.sqrt(Math.max(0, base));
  return base + (2 * top - 1) * (d - base);
}

/**
 * One pixel's worth of composite, including opacity.
 *
 * Opacity is applied **after** the blend, as a linear interpolation back
 * towards the base — the standard compositing order and the only one under
 * which opacity 0 is the identity for every mode.
 */
export function compositeChannel(op: CompositeOp, base: number, top: number): number {
  const blended = blendChannel(op.blend, base, top);
  return base + (blended - base) * op.opacity;
}

/**
 * Composite one CPU-resident colour surface over another, in place of neither.
 *
 * Both surfaces must describe the same pixel grid; a caller that hands over two
 * different extents is asking for a composite with no common coordinate system,
 * which is refused rather than resampled. The **index map is not touched** —
 * see the note on the same subject in `web/src/gpu/composite.ts`: the map
 * records which palette entry this node chose per pixel, and opacity changes
 * how much of that decision is shown, not what the decision was.
 *
 * Alpha is unassociated throughout the pipeline (F-IN-03) and is interpolated by
 * opacity alone rather than blended: `multiply` on an alpha channel would
 * silently erode coverage every time a node's opacity left 100%.
 */
export function compositeLinearSurface(
  base: CpuColorSurface,
  top: CpuColorSurface,
  op: CompositeOp,
  pixels: number,
  /**
   * The picture wired to the node's `mask` port (F-PP-08).
   *
   * Required when — and legal only when — `op.mask` reads an image. A mask that
   * reads the node's own input needs none, because `base` is that input.
   */
  maskSurface?: CpuColorSurface | null,
): CpuColorSurface {
  const mask = op.mask ?? null;
  const needsImage = mask !== null && maskNeedsImage(mask);
  const image = maskSurface ?? null;

  // Both directions refuse, for the reason `gpu/composite.ts` gives: an image
  // mask with no picture would have to fall back to full coverage, which is a
  // mask that silently is not one.
  if (needsImage && image === null) {
    throw new GraphError(
      "invariant",
      "composite: the mask reads a picture and none was supplied",
    );
  }
  if (!needsImage && image !== null) {
    throw new GraphError(
      "invariant",
      "composite: a mask picture was supplied and this node's mask does not read one",
    );
  }
  // Resolved once rather than per pixel: the target does not vary across the
  // frame and OKLab costs three cube roots.
  const target = mask?.source.kind === "color" ? resolveColorTarget(mask.source.color) : null;

  for (const [label, surface] of [
    ["base", base],
    ["top", top],
    ...(image === null ? [] : ([["mask", image]] as const)),
  ] as const) {
    for (const [channel, plane] of [
      ["r", surface.r],
      ["g", surface.g],
      ["b", surface.b],
      ["a", surface.a],
    ] as const) {
      if (plane.length !== pixels) {
        throw new GraphError(
          "invariant",
          `composite: the ${label} surface's ${channel} plane holds ${plane.length} samples, and the composite covers ${pixels} pixels`,
          { plane: `${label}.${channel}`, got: plane.length, expected: pixels },
        );
      }
    }
  }

  const r = new Float32Array(pixels);
  const g = new Float32Array(pixels);
  const b = new Float32Array(pixels);
  const a = new Float32Array(pixels);
  const { blend, opacity } = op;

  for (let i = 0; i < pixels; i += 1) {
    // `noUncheckedIndexedAccess` types these as `number | undefined`. The
    // length check above is what makes the index in range, so the coalesce is a
    // type obligation rather than a value decision, and 0 can never be reached.
    const br = base.r[i] ?? 0;
    const bg = base.g[i] ?? 0;
    const bb = base.b[i] ?? 0;
    const ba = base.a[i] ?? 0;
    const tr = top.r[i] ?? 0;
    const tg = top.g[i] ?? 0;
    const tb = top.b[i] ?? 0;
    const ta = top.a[i] ?? 0;

    // Coverage multiplies opacity, per pixel (F-PP-08). The same expression the
    // WGSL evaluates, from the same definition in `mask.ts` — a difference here
    // is a preview that does not match its export.
    const amount =
      mask === null
        ? opacity
        : opacity *
          maskCoverage(
            mask,
            target,
            [br, bg, bb, ba],
            image === null
              ? [0, 0, 0, 0]
              : [image.r[i] ?? 0, image.g[i] ?? 0, image.b[i] ?? 0, image.a[i] ?? 0],
          );

    r[i] = br + (blendChannel(blend, br, tr) - br) * amount;
    g[i] = bg + (blendChannel(blend, bg, tg) - bg) * amount;
    b[i] = bb + (blendChannel(blend, bb, tb) - bb) * amount;
    a[i] = ba + (ta - ba) * amount;
  }

  return { residency: "cpu", r, g, b, a };
}
