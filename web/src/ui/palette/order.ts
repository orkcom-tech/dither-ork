/**
 * Palette ordering — F-CO-06, and the discipline that keeps a reorder from
 * corrupting everything downstream of it.
 *
 * **A reorder is a permutation, never a rewritten list.** `order[newPosition]
 * === oldIndex`. Everything that is indexed by palette position — the index map
 * a quantizing node emits, the population counts an extraction produced, the
 * per-swatch locks — is moved by the same permutation, or it silently stops
 * describing the swatch it is attached to. The failure mode is not a crash: it
 * is an outline node stroking the wrong colour and a population column that
 * looks plausible, so the permutation is the value that travels and the
 * reordered list is derived from it.
 *
 * This file mirrors `Palette::sort_order`, `Palette::reordered` and
 * `remap_indices` in `core/crates/dither-core/src/palette.rs`, **including
 * their tie-breaks**, because the core's versions are not exported across the
 * WASM boundary — see `dither-wasm/src/lib.rs`, which binds `builtinPalettes`
 * and `extractPalette` but none of the ordering helpers. When they are bound,
 * every function here should be deleted in favour of them; the tests below pin
 * the semantics so that swap is checkable rather than hopeful.
 */

import type { Swatch } from "./model";
import { hueAngle, tripletToOklab } from "./color";

/** How a palette is ordered (F-CO-06). */
export type SortKey = "hue" | "luminance" | "population";

/**
 * Hue angles are compared on a grid this many radians wide.
 *
 * **This is the one place this file deliberately does not mirror the core's
 * arithmetic, and it is a measured decision rather than a taste one.**
 *
 * The core's `sort_order` compares hue angles directly and its comment explains
 * that neutrals, having no hue, "collect at the start of the order and sort
 * among themselves by lightness". They do not. The forward OKLab matrix's rows
 * do not sum to exactly one, so a neutral carries a chroma residual around
 * `5e-8` whose angle is `1.5008849…` — the same value for every grey to nine
 * significant figures, and different in the last few bits. Compared directly,
 * those last bits decide the order: the lightness tie-break never fires, and a
 * palette of five greys sorted by hue comes out shuffled. Measured across the
 * whole grey ramp, not inferred.
 *
 * Quantizing the comparison fixes it and nothing else. `1e-6 rad` is six
 * hundred-thousandths of a degree: eight orders of magnitude above the residual
 * noise and four below the smallest hue difference any two distinguishable
 * colours have. Two entries that land in one bucket then fall through to
 * lightness, which is the ordering the core's comment describes and this
 * delivers.
 *
 * Quantizing rather than comparing with a tolerance, because a tolerance is not
 * transitive — `a ~ b` and `b ~ c` would not give `a ~ c` — and a comparator
 * that is not a total preorder produces an order that depends on the sort's
 * internals. A grid is transitive by construction.
 *
 * The core has the same defect and should get the same fix; see the report for
 * this round.
 */
export const HUE_QUANTUM = 1e-6;

export const SORT_KEYS: readonly SortKey[] = ["hue", "luminance", "population"];

export function sortKeyLabel(key: SortKey): string {
  return key === "hue" ? "hue" : key === "luminance" ? "luminance" : "population";
}

export class PermutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermutationError";
  }
}

/**
 * True when `order` is a permutation of `0..n`.
 *
 * Checked rather than assumed everywhere a permutation is applied: a malformed
 * one drops or duplicates palette entries, and the damage surfaces several
 * nodes later as wrong colours attributable to nothing.
 */
export function isPermutation(order: readonly number[], n: number): boolean {
  if (order.length !== n) return false;
  const seen = new Uint8Array(n);
  for (const i of order) {
    if (!Number.isInteger(i) || i < 0 || i >= n) return false;
    if (seen[i] === 1) return false;
    seen[i] = 1;
  }
  return true;
}

export function assertPermutation(order: readonly number[], n: number): void {
  if (!isPermutation(order, n)) {
    throw new PermutationError(
      `not a permutation of 0..${n}: [${order.join(", ")}]`,
    );
  }
}

/** The identity permutation of length `n`. */
export function identityOrder(n: number): number[] {
  return Array.from({ length: n }, (_unused, i) => i);
}

/**
 * The permutation that sorts `swatches` by `key`.
 *
 * Ties break on the original index in every case, so the result is a total
 * order and two runs over the same palette cannot disagree — the same rule the
 * core states, and the reason a "stable enough" sort is not good enough here:
 * a palette editor that reshuffles equal entries on every click is one whose
 * undo stack no one can follow.
 *
 * `hue` breaks first on lightness and only then on index, which is what makes
 * the neutrals readable: quantized by {@link HUE_QUANTUM} they share one hue
 * bucket and therefore come out as a lightness ramp, sitting between the reds
 * and the yellows rather than at the start (see {@link HUE_QUANTUM} for the
 * measurement and why the start is where the core expected them).
 *
 * `population` needs counts, which belong to the extraction that produced the
 * palette rather than to the palette itself. A swatch with no count sorts last
 * among its equals rather than being treated as zero — {@link canSortBy} is
 * what the UI asks before offering the control at all.
 */
export function sortOrder(swatches: readonly Swatch[], key: SortKey): number[] {
  const order = identityOrder(swatches.length);
  const at = (i: number): Swatch => {
    const s = swatches[i];
    if (s === undefined) throw new PermutationError(`no swatch at index ${i}`);
    return s;
  };

  if (key === "population") {
    // Descending: the most-used entry first. `null` means the palette did not
    // come from an extraction; those sink below every counted entry.
    order.sort((x, y) => {
      const px = at(x).population;
      const py = at(y).population;
      if (px === null && py === null) return x - y;
      if (px === null) return 1;
      if (py === null) return -1;
      return py === px ? x - y : py - px;
    });
    return order;
  }

  const lab = swatches.map((s) => tripletToOklab(s.rgb));
  const labAt = (i: number): { l: number; a: number; b: number } => {
    const c = lab[i];
    if (c === undefined) throw new PermutationError(`no swatch at index ${i}`);
    return c;
  };

  if (key === "luminance") {
    order.sort((x, y) => {
      const d = labAt(x).l - labAt(y).l;
      return d === 0 ? x - y : d;
    });
    return order;
  }

  // Quantized, for the reason HUE_QUANTUM states: compared directly, every
  // neutral in the palette has a distinct angle made of floating-point
  // residue, and the lightness tie-break below never gets a chance to run.
  const hue = lab.map((c) => Math.round(hueAngle(c) / HUE_QUANTUM));
  order.sort((x, y) => {
    const hx = hue[x] ?? 0;
    const hy = hue[y] ?? 0;
    if (hx !== hy) return hx - hy;
    const dl = labAt(x).l - labAt(y).l;
    return dl === 0 ? x - y : dl;
  });
  return order;
}

/** Whether a sort key can be offered, and why not when it cannot. */
export function canSortBy(
  swatches: readonly Swatch[],
  key: SortKey,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (swatches.length < 2) {
    return { ok: false, reason: "a palette of one colour has nothing to order" };
  }
  if (key === "population" && swatches.every((s) => s.population === null)) {
    return {
      ok: false,
      reason: "population comes from an extraction; run one first",
    };
  }
  return { ok: true };
}

/** Apply a permutation to anything indexed by palette position. */
export function applyPermutation<T>(items: readonly T[], order: readonly number[]): T[] {
  assertPermutation(order, items.length);
  return order.map((old) => {
    const item = items[old];
    if (item === undefined) throw new PermutationError(`no entry at index ${old}`);
    return item;
  });
}

/**
 * `inverse[oldIndex] === newPosition`.
 *
 * The direction an index map needs: `order` answers "what used to be here",
 * an index map asks "where did my entry go".
 */
export function invertPermutation(order: readonly number[]): number[] {
  assertPermutation(order, order.length);
  const inverse = new Array<number>(order.length).fill(0);
  order.forEach((old, position) => {
    inverse[old] = position;
  });
  return inverse;
}

/**
 * Rewrite an index map in place so it addresses a palette reordered by `order`.
 *
 * Mirrors `remap_indices` in the core, refusal included: an index outside the
 * palette throws rather than being remapped to something plausible. **This must
 * be called on every index map belonging to a palette that was reordered** —
 * that is the whole reason {@link PaletteChange.permutation} exists.
 */
export function remapIndices(indices: Uint16Array, order: readonly number[]): void {
  const n = order.length;
  assertPermutation(order, n);
  const inverse = invertPermutation(order);
  for (let i = 0; i < indices.length; i += 1) {
    const old = indices[i];
    const next = old === undefined ? undefined : inverse[old];
    if (next === undefined) {
      throw new PermutationError(
        `index ${String(old)} at ${i} is outside a palette of ${n} entries`,
      );
    }
    indices[i] = next;
  }
}

/**
 * The permutation for a drag: take the entry at `from` and drop it at `to`.
 *
 * Expressed as a permutation like every other reorder, so a drag and a sort go
 * through exactly one code path on the consumer's side.
 */
export function moveOrder(length: number, from: number, to: number): number[] {
  if (!Number.isInteger(from) || from < 0 || from >= length) {
    throw new PermutationError(`move source ${from} is outside 0..${length}`);
  }
  if (!Number.isInteger(to) || to < 0 || to >= length) {
    throw new PermutationError(`move target ${to} is outside 0..${length}`);
  }
  const order = identityOrder(length);
  const [moved] = order.splice(from, 1);
  if (moved === undefined) throw new PermutationError(`move source ${from} was empty`);
  order.splice(to, 0, moved);
  return order;
}

/** True when a permutation leaves every entry where it was. */
export function isIdentity(order: readonly number[]): boolean {
  return order.every((old, position) => old === position);
}
