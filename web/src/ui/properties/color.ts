/**
 * The colour parameter's arithmetic.
 *
 * A `color` parameter is three 8-bit sRGB integers — the same layout the
 * palette and the WASM boundary use (`web/src/types/document.ts`). That is the
 * *edge* of the pipeline, where sRGB is allowed; nothing downstream of the
 * document sees these numbers without the transfer curve coming off first.
 *
 * Hex exists here because it is what a person pastes, not because it is a
 * storage format. It is parsed into the triplet and never kept.
 */

import type { SrgbTriplet } from "../../types/document";

export function clampComponent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value);
  return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
}

export function toHex(triplet: SrgbTriplet): string {
  const pair = (value: number): string =>
    clampComponent(value).toString(16).padStart(2, "0");
  return `#${pair(triplet[0])}${pair(triplet[1])}${pair(triplet[2])}`;
}

/**
 * Read `#rgb`, `#rrggbb`, or either without the hash. `null` for anything else,
 * which the field turns into reverting rather than into a guess — a
 * half-finished paste is not a colour the user chose.
 */
export function fromHex(text: string): SrgbTriplet | null {
  const trimmed = text.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) return null;

  if (trimmed.length === 3) {
    const expanded = [...trimmed].map((digit) => Number.parseInt(digit + digit, 16));
    const [r, g, b] = expanded;
    if (r === undefined || g === undefined || b === undefined) return null;
    return [r, g, b];
  }
  if (trimmed.length === 6) {
    const r = Number.parseInt(trimmed.slice(0, 2), 16);
    const g = Number.parseInt(trimmed.slice(2, 4), 16);
    const b = Number.parseInt(trimmed.slice(4, 6), 16);
    return [r, g, b];
  }
  return null;
}

/** Replace one channel, returning a new triplet. */
export function withComponent(
  triplet: SrgbTriplet,
  index: 0 | 1 | 2,
  value: number,
): SrgbTriplet {
  const next: [number, number, number] = [triplet[0], triplet[1], triplet[2]];
  next[index] = clampComponent(value);
  return next;
}

export const CHANNEL_LABEL = ["R", "G", "B"] as const;
