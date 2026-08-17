/**
 * Node masking — F-PP-08. **Spatially-varying opacity**, and nothing else.
 *
 * Recorded as unbuilt since phase 3 for one reason: "a mask is a second image
 * edge, and the graph carries one image edge per node". That is now false, so
 * this is the rest of it.
 *
 * ## What a mask is, and what it is not
 *
 * It is the number the composite already applies — `opacity` — with a value per
 * pixel instead of one for the frame. That is the whole model. It is therefore
 * *not* an effect, not a node, and not a layer: a masked blur is a blur whose
 * result reaches the picture in some places and not others, exactly as a blur
 * at 40% reaches it everywhere a bit.
 *
 * Three consequences fall straight out, and each of them is a thing that would
 * otherwise have to be decided over and over:
 *
 * - **Every node is maskable**, including ones that did not exist when this was
 *   written, because the composite is where it happens and every node has one.
 * - **A node that resamples cannot be masked.** It has no pixel-for-pixel
 *   correspondence with its own input, so there is no picture the coverage
 *   would be *of*. `graph/ports.ts` does not give such a node a mask port and
 *   `graph/plan.ts` refuses the composite, which is the same refusal per-node
 *   opacity already gets.
 * - **Mask and opacity multiply.** They answer different questions — how much
 *   of this node overall, and where — and letting one override the other makes
 *   a slider that sometimes does nothing.
 *
 * ## Where coverage comes from
 *
 * The three sources F-PP-08 names, and they differ only in that:
 *
 * - `luminance` — the tone of **the node's own input**, as a band with a
 *   falloff. A band rather than a threshold because "the shadows" and "the
 *   highlights" are both bands and a threshold is the case where one bound sits
 *   at an end of the range.
 * - `color` — nearness to a colour, measured **in OKLab**, on the node's own
 *   input. sRGB distance would mean something different in the shadows than in
 *   the highlights, which is exactly what makes a colour-range mask hard to
 *   aim; the rest of the pipeline already compares colours in OKLab and this is
 *   the same comparison.
 * - `image` — a channel of the picture wired into the node's `mask` port. The
 *   second image edge, and the only one of the three that needs one.
 *
 * ## Two implementations, one definition
 *
 * Same rule as `blend.ts` and for the same reason: the parallel half evaluates
 * this in `web/src/shaders/_composite.wgsl` and the serial half evaluates it
 * here, and **both must produce the same numbers or preview and export stop
 * matching**. This module is the definition; the WGSL is a transcription of it.
 * `mask.test.ts` checks the ordinals agree and that the shader declares every
 * kind and channel — the formulas themselves have to be diffed by eye, so the
 * two are kept in the same order.
 */

import type { MaskChannel, MaskSource, NodeMask, SrgbTriplet } from "../types/document";
import { linearToOklab } from "../gpu/resources";
import { GraphError } from "./errors";

/**
 * Mask kinds in the order the ordinals number them.
 *
 * **Append-only**, exactly like `BLEND_MODES`: the ordinal crosses into the
 * shader as a `u32`, so inserting one in the middle renumbers the kinds after
 * it and every saved document naming one is a different picture.
 */
export const MASK_KINDS = ["luminance", "color", "image"] as const;

export type MaskKind = (typeof MASK_KINDS)[number];

/** The ordinal each kind crosses to the GPU as. Derived, so it cannot disagree. */
export const MASK_KIND_ORDINAL: Readonly<Record<MaskKind, number>> = Object.fromEntries(
  MASK_KINDS.map((kind, index) => [kind, index]),
) as Readonly<Record<MaskKind, number>>;

/** Channels of a wired mask picture, in ordinal order. Append-only. */
export const MASK_CHANNELS = [
  "luminance",
  "alpha",
  "red",
  "green",
  "blue",
] as const satisfies readonly MaskChannel[];

export const MASK_CHANNEL_ORDINAL: Readonly<Record<MaskChannel, number>> =
  Object.fromEntries(
    MASK_CHANNELS.map((channel, index) => [channel, index]),
  ) as Readonly<Record<MaskChannel, number>>;

/**
 * Rec. 709 luminance, in **linear light**.
 *
 * The same weights the rest of the pipeline uses to turn colour into tone. It
 * is not a perceptual lightness and is not meant to be: a mask band is aimed at
 * the picture's own tone, and OKLab lightness would put the band somewhere the
 * user did not point it when they dragged against a histogram of linear values.
 */
export function linearLuminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Hermite smoothstep, matching WGSL's `smoothstep` exactly.
 *
 * Written out rather than approximated because the shader's built-in is
 * specified as this polynomial and a different curve here would put the two
 * halves of the pipeline a few percent apart in every falloff.
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** sRGB code value to linear light. The pipeline's transfer function. */
function srgbComponentToLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * One pixel of a wired mask picture, reduced to coverage by channel.
 *
 * Alpha is a legal channel because a mask drawn as a shape over transparency is
 * a mask whose *coverage* is its alpha, and forcing that through luminance
 * would read a transparent white shape as fully covering.
 */
export function maskChannelValue(
  channel: MaskChannel,
  r: number,
  g: number,
  b: number,
  a: number,
): number {
  switch (channel) {
    case "luminance":
      return linearLuminance(r, g, b);
    case "alpha":
      return a;
    case "red":
      return r;
    case "green":
      return g;
    case "blue":
      return b;
  }
}

/**
 * A colour mask, resolved once per node instead of once per pixel.
 *
 * The target colour is an 8-bit sRGB triplet in the document and an OKLab
 * coordinate in the arithmetic, and converting it per pixel would be three
 * `cbrt` calls per invocation for a value that does not vary across the frame.
 * The GPU path packs exactly these three numbers into its uniforms for the same
 * reason.
 */
export interface ResolvedColorTarget {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

export function resolveColorTarget(color: SrgbTriplet): ResolvedColorTarget {
  const [r, g, b] = color;
  const [l, ca, cb] = linearToOklab(
    srgbComponentToLinear(r),
    srgbComponentToLinear(g),
    srgbComponentToLinear(b),
  );
  return { l, a: ca, b: cb };
}

/**
 * Coverage in `[0, 1]` for one pixel.
 *
 * `input` is the node's own input — the same picture the composite blends
 * against — and `image` is the pixel from the `mask` port, which is only read
 * by the `image` kind and may be zeroes for the other two.
 *
 * Pure and free of any buffer, so the curve can be read and tested as
 * arithmetic and the WGSL can be diffed against it line for line.
 */
export function maskCoverage(
  mask: NodeMask,
  target: ResolvedColorTarget | null,
  input: readonly [r: number, g: number, b: number, a: number],
  image: readonly [r: number, g: number, b: number, a: number],
): number {
  const raw = rawCoverage(mask.source, target, input, image);
  const clamped = Math.min(1, Math.max(0, raw));
  return mask.invert ? 1 - clamped : clamped;
}

function rawCoverage(
  source: MaskSource,
  target: ResolvedColorTarget | null,
  input: readonly [number, number, number, number],
  image: readonly [number, number, number, number],
): number {
  switch (source.kind) {
    case "luminance": {
      const l = linearLuminance(input[0], input[1], input[2]);
      // Two edges of one band. `feather` is a half-width outside each bound, so
      // a feather of zero is a hard band and the same expression covers both —
      // `smoothstep` with equal edges is a step, which is why there is no
      // branch on feather here or in the shader.
      const rise = smoothstep(source.low - source.feather, source.low, l);
      const fall = 1 - smoothstep(source.high, source.high + source.feather, l);
      return Math.min(rise, fall);
    }
    case "color": {
      if (target === null) {
        throw new GraphError(
          "invariant",
          "a colour mask was evaluated without its OKLab target resolved; resolveColorTarget is per node and must be called before the pixel loop",
        );
      }
      const [l, a, b] = linearToOklab(input[0], input[1], input[2]);
      const dl = l - target.l;
      const da = a - target.a;
      const db = b - target.b;
      const distance = Math.sqrt(dl * dl + da * da + db * db);
      // Full inside the tolerance, falling to nothing across the feather beyond
      // it. Inverted relative to the luminance band because the band is
      // two-sided and this is a radius.
      return 1 - smoothstep(source.tolerance, source.tolerance + source.feather, distance);
    }
    case "image":
      return maskChannelValue(source.channel, image[0], image[1], image[2], image[3]);
  }
}

/** True when this mask reads the node's `mask` port rather than its own input. */
export function maskNeedsImage(mask: NodeMask): boolean {
  return mask.source.kind === "image";
}

/**
 * The mask, as a stable string folded into the node's content hash.
 *
 * A mask changes which pixels a node contributes, so a document whose mask
 * moved is a different picture and must not be served the previous one from the
 * cache. It goes in through `MASK_PARAM_KEY` rather than as a field on
 * `ContentHashInput` for the same reason the palette digest and the asset
 * digest do: the hash input is a bag of parameters plus the few things that are
 * not parameters, and adding a field per not-a-parameter is how that interface
 * grows without limit.
 *
 * Written out field by field rather than `JSON.stringify`d because
 * `JSON.stringify` writes keys in assignment order, and two masks that are the
 * same mask must hash the same however they were built.
 */
export function maskDigest(mask: NodeMask): string {
  const source = mask.source;
  const invert = mask.invert ? "1" : "0";
  switch (source.kind) {
    case "luminance":
      return `luminance:${source.low}:${source.high}:${source.feather}:${invert}`;
    case "color":
      return `color:${source.color[0]},${source.color[1]},${source.color[2]}:${source.tolerance}:${source.feather}:${invert}`;
    case "image":
      return `image:${source.channel}:${invert}`;
  }
}

/** Whether a mask is legal on its own terms, with the reason when it is not. */
export function maskProblem(mask: NodeMask): string | null {
  const source = mask.source;
  switch (source.kind) {
    case "luminance": {
      if (!inUnit(source.low) || !inUnit(source.high)) {
        return `luminance mask bounds ${source.low}..${source.high} are outside 0..1`;
      }
      if (source.low > source.high) {
        return `luminance mask has low ${source.low} above high ${source.high}; the band would be empty and the node would contribute nothing anywhere`;
      }
      if (!Number.isFinite(source.feather) || source.feather < 0) {
        return `luminance mask feather ${source.feather} is negative`;
      }
      return null;
    }
    case "color": {
      for (const [index, component] of source.color.entries()) {
        if (!Number.isInteger(component) || component < 0 || component > 255) {
          return `colour mask component ${index} is ${component}; a packed sRGB triplet is three integers in 0..255`;
        }
      }
      if (!Number.isFinite(source.tolerance) || source.tolerance <= 0) {
        return `colour mask tolerance ${source.tolerance} is not positive; a tolerance of zero selects the exact colour and nothing else, which no picture contains after linear-light processing`;
      }
      if (!Number.isFinite(source.feather) || source.feather < 0) {
        return `colour mask feather ${source.feather} is negative`;
      }
      return null;
    }
    case "image":
      return MASK_CHANNELS.includes(source.channel)
        ? null
        : `mask channel "${String(source.channel)}" is not one of ${MASK_CHANNELS.join(", ")}`;
  }
}

function inUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}
