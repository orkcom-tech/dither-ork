/**
 * The palette editor's state and the one function that changes it.
 *
 * Every mutation the UI can perform is a {@link PaletteEdit} put through
 * {@link reduce}, which is pure and returns either the next state with the
 * change it produced, or a refusal with a reason. Two things follow from that
 * shape and both are the point:
 *
 * - **Nothing is repaired quietly.** An edit that would leave the palette in a
 *   state the renderer cannot use — no colours, an index outside the list, a
 *   ramp with one end — is refused and the reason is what the button's tooltip
 *   says. The alternative is a clamp, and a clamp is a control that lies about
 *   what it did.
 * - **A reorder emits its permutation.** `change.permutation` is non-null
 *   exactly when the palette's *contents* are unchanged and only their order
 *   moved. Anything holding data indexed by palette position — an index map
 *   above all — must be put through it (see `remapIndices` in `order.ts`).
 *   When it is null the palette's contents changed and any index map must be
 *   regenerated, which is what a re-render does anyway.
 *
 * Provenance travels with the colours. A palette that came from the library or
 * from an extraction keeps that id until it is hand-edited, at which point it
 * becomes `custom` once and its name records where it started. A `.dork`
 * document that says `gameboy-dmg` therefore means it, and one that says
 * `custom` is not pretending otherwise.
 */

import type { ColorMetric, Palette, SrgbTriplet } from "../../types/document";
import { packColors, unpackColors } from "./color";
import type { ExtractSettings, ExtractionReport } from "./extract";
import { DEFAULT_EXTRACT_SETTINGS, mergeLocked } from "./extract";
import type { BuiltinPalette } from "./library";
import type { OutputMode } from "./modes";
import { derivedColors, describeMode } from "./modes";
import type { SortKey } from "./order";
import { applyPermutation, canSortBy, isIdentity, moveOrder, sortOrder } from "./order";
import { canRamp, oklabRamp } from "./ramp";

/** One palette entry as the editor holds it. */
export interface Swatch {
  readonly rgb: SrgbTriplet;
  /** Locked against re-extraction (F-CO-05). */
  readonly locked: boolean;
  /**
   * Pixels the extraction that produced this entry matched to it, or `null`
   * when the entry did not come from one. Kept per swatch rather than in a
   * parallel array so that a reorder cannot separate a count from its colour.
   */
  readonly population: number | null;
}

export interface PaletteState {
  readonly id: string;
  readonly name: string;
  readonly swatches: readonly Swatch[];
  readonly metric: ColorMetric;
  readonly mode: OutputMode;
  readonly extract: ExtractSettings;
  /** The last extraction's report, or `null` until one has run. */
  readonly report: ExtractionReport | null;
}

/**
 * A palette of one colour cannot dither: every pixel maps to the same entry and
 * the whole stack collapses to a flat fill. Refused rather than allowed and
 * then wondered about.
 */
export const MIN_SWATCHES = 2;

/**
 * The editor's ceiling. The index map addresses 65536 entries, so this is not
 * the format's limit — it is the largest palette the per-pixel linear
 * nearest-colour scan stays sane at, and it is exactly what per-channel RGB
 * tops out at (16 x 16 x 16).
 */
export const MAX_SWATCHES = 4096;

/** The id a palette carries once it has been hand-edited. */
export const CUSTOM_PALETTE_ID = "custom";

export type PaletteEdit =
  | { readonly kind: "load"; readonly palette: Palette }
  | { readonly kind: "library"; readonly palette: BuiltinPalette }
  | {
      readonly kind: "extracted";
      readonly colors: readonly SrgbTriplet[];
      readonly populations: readonly number[];
      readonly report: ExtractionReport;
    }
  | { readonly kind: "add"; readonly rgb: SrgbTriplet }
  | { readonly kind: "remove"; readonly index: number }
  | { readonly kind: "set"; readonly index: number; readonly rgb: SrgbTriplet }
  | { readonly kind: "lock"; readonly index: number; readonly locked: boolean }
  | { readonly kind: "move"; readonly from: number; readonly to: number }
  | { readonly kind: "sort"; readonly key: SortKey }
  | {
      readonly kind: "ramp";
      readonly from: number;
      readonly to: number;
      readonly steps: number;
    }
  | { readonly kind: "mode"; readonly mode: OutputMode }
  | { readonly kind: "metric"; readonly metric: ColorMetric }
  | { readonly kind: "extract-settings"; readonly settings: ExtractSettings };

/** Why the palette changed. `source` is the store's own, for a new image. */
export type PaletteChangeReason = PaletteEdit["kind"] | "source";

export interface PaletteChange {
  readonly reason: PaletteChangeReason;
  /** The document palette after the change — what `.dork` writes and the graph reads. */
  readonly palette: Palette;
  /**
   * `order[newPosition] === oldIndex`, non-null **exactly** when this change
   * was a pure reorder. Everything indexed by palette position must be put
   * through it; when it is null, index maps are stale and must be regenerated.
   */
  readonly permutation: readonly number[] | null;
  /** False when only editor state moved and the rendered picture is unchanged. */
  readonly rerender: boolean;
}

export type PaletteEditOutcome =
  | {
      readonly kind: "applied";
      readonly state: PaletteState;
      readonly change: PaletteChange;
    }
  | { readonly kind: "refused"; readonly reason: string };

/** The document palette for a state. */
export function documentPalette(state: PaletteState): Palette {
  return {
    id: state.id,
    name: state.name,
    colors: packColors(state.swatches.map((s) => s.rgb)),
    metric: state.metric,
  };
}

function plain(colors: readonly SrgbTriplet[]): Swatch[] {
  return colors.map((rgb) => ({ rgb, locked: false, population: null }));
}

/**
 * The state the editor opens on: 1-bit mono.
 *
 * Not an arbitrary default. Before an image is open there is nothing to extract
 * from and no reason to prefer one hardware palette over another, and a
 * two-entry black/white palette is both the product's subject and the one
 * palette that is correct for any image.
 */
export function initialPaletteState(): PaletteState {
  const mode: OutputMode = { kind: "mono" };
  const described = describeMode(mode);
  const colors = derivedColors(mode);
  if (colors === null) throw new Error("the mono output mode must generate colours");
  return {
    id: described.id,
    name: described.name,
    swatches: plain(colors),
    metric: "oklab",
    mode,
    extract: DEFAULT_EXTRACT_SETTINGS,
    report: null,
  };
}

/**
 * Mark a palette as hand-edited.
 *
 * Runs once: the second edit finds the id already `custom` and leaves the name
 * alone, so a name cannot grow a tail of "(edited) (edited)".
 */
function handEdited(state: PaletteState): { readonly id: string; readonly name: string } {
  if (state.id === CUSTOM_PALETTE_ID) return { id: state.id, name: state.name };
  return { id: CUSTOM_PALETTE_ID, name: `${state.name} (edited)` };
}

/** Editing generated colours makes them no longer generated. */
const INDEXED: OutputMode = { kind: "indexed" };

function change(
  reason: PaletteChangeReason,
  state: PaletteState,
  permutation: readonly number[] | null,
  rerender: boolean,
): PaletteChange {
  return { reason, palette: documentPalette(state), permutation, rerender };
}

function applied(
  reason: PaletteChangeReason,
  state: PaletteState,
  permutation: readonly number[] | null = null,
  rerender = true,
): PaletteEditOutcome {
  return { kind: "applied", state, change: change(reason, state, permutation, rerender) };
}

function refused(reason: string): PaletteEditOutcome {
  return { kind: "refused", reason };
}

function inRange(index: number, length: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < length;
}

/** Apply one edit. Pure: the store is what logs and notifies. */
export function reduce(state: PaletteState, edit: PaletteEdit): PaletteEditOutcome {
  switch (edit.kind) {
    case "load": {
      const colors = edit.palette.colors;
      if (colors.length === 0 || colors.length % 3 !== 0) {
        return refused(
          `a palette needs a non-empty multiple of 3 components, got ${colors.length}`,
        );
      }
      const swatches = plain(unpackColors(colors));
      if (swatches.length < MIN_SWATCHES) {
        return refused(`a palette needs at least ${MIN_SWATCHES} colours`);
      }
      // A loaded document says nothing about which generator produced its
      // colours, so the mode becomes `indexed`: the palette is whatever the
      // document said it was, and no level count is going to regenerate it.
      return applied("load", {
        ...state,
        id: edit.palette.id,
        name: edit.palette.name,
        swatches,
        metric: edit.palette.metric,
        mode: INDEXED,
        report: null,
      });
    }

    case "library": {
      const colors = edit.palette.colors;
      if (colors.length === 0 || colors.length % 3 !== 0) {
        return refused(
          `built-in palette ${edit.palette.id} has ${colors.length} components`,
        );
      }
      return applied("library", {
        ...state,
        id: edit.palette.id,
        name: edit.palette.name,
        swatches: plain(unpackColors(colors)),
        mode: INDEXED,
        report: null,
      });
    }

    case "extracted": {
      const swatches = mergeLocked(state.swatches, edit.colors, edit.populations);
      if (swatches.length < MIN_SWATCHES) {
        return refused(
          `the extraction produced ${swatches.length} colours; this image has too few distinguishable ones`,
        );
      }
      return applied("extracted", {
        ...state,
        id: "extracted",
        name: `Extracted · ${edit.report.method} · ${swatches.length}`,
        swatches,
        mode: INDEXED,
        report: edit.report,
      });
    }

    case "add": {
      if (state.swatches.length >= MAX_SWATCHES) {
        return refused(`a palette tops out at ${MAX_SWATCHES} colours`);
      }
      const swatches = [
        ...state.swatches,
        { rgb: edit.rgb, locked: false, population: null },
      ];
      return applied("add", { ...state, ...handEdited(state), swatches, mode: INDEXED });
    }

    case "remove": {
      if (!inRange(edit.index, state.swatches.length)) {
        return refused(`there is no swatch ${edit.index}`);
      }
      if (state.swatches.length <= MIN_SWATCHES) {
        return refused(`a palette needs at least ${MIN_SWATCHES} colours`);
      }
      const swatches = state.swatches.filter((_unused, i) => i !== edit.index);
      return applied("remove", { ...state, ...handEdited(state), swatches, mode: INDEXED });
    }

    case "set": {
      const current = state.swatches[edit.index];
      if (current === undefined) return refused(`there is no swatch ${edit.index}`);
      if (
        current.rgb[0] === edit.rgb[0] &&
        current.rgb[1] === edit.rgb[1] &&
        current.rgb[2] === edit.rgb[2]
      ) {
        return refused("that swatch is already that colour");
      }
      const swatches = state.swatches.map((s, i) =>
        // The population counted pixels matched to the *old* colour; once the
        // colour moves it describes nothing, so it goes rather than becoming a
        // number that looks like evidence.
        i === edit.index ? { rgb: edit.rgb, locked: s.locked, population: null } : s,
      );
      return applied("set", { ...state, ...handEdited(state), swatches, mode: INDEXED });
    }

    case "lock": {
      const current = state.swatches[edit.index];
      if (current === undefined) return refused(`there is no swatch ${edit.index}`);
      if (current.locked === edit.locked) {
        return refused(`swatch ${edit.index} is already ${edit.locked ? "locked" : "unlocked"}`);
      }
      const swatches = state.swatches.map((s, i) =>
        i === edit.index ? { rgb: s.rgb, locked: edit.locked, population: s.population } : s,
      );
      // A lock changes no colour, so the picture is unchanged and nothing
      // downstream needs to re-render.
      return applied("lock", { ...state, swatches }, null, false);
    }

    case "move": {
      const length = state.swatches.length;
      if (!inRange(edit.from, length)) return refused(`there is no swatch ${edit.from}`);
      if (!inRange(edit.to, length)) return refused(`there is no position ${edit.to}`);
      if (edit.from === edit.to) return refused("that swatch is already there");
      const order = moveOrder(length, edit.from, edit.to);
      return applied(
        "move",
        {
          ...state,
          ...handEdited(state),
          swatches: applyPermutation(state.swatches, order),
          mode: INDEXED,
        },
        order,
      );
    }

    case "sort": {
      const allowed = canSortBy(state.swatches, edit.key);
      if (!allowed.ok) return refused(allowed.reason);
      const order = sortOrder(state.swatches, edit.key);
      if (isIdentity(order)) return refused(`the palette is already ordered by ${edit.key}`);
      return applied(
        "sort",
        {
          ...state,
          ...handEdited(state),
          swatches: applyPermutation(state.swatches, order),
          mode: INDEXED,
        },
        order,
      );
    }

    case "ramp": {
      const allowed = canRamp(state.swatches.length, edit.from, edit.to, edit.steps);
      if (!allowed.ok) return refused(allowed.reason);

      const lo = Math.min(edit.from, edit.to);
      const hi = Math.max(edit.from, edit.to);
      const first = state.swatches[lo];
      const last = state.swatches[hi];
      if (first === undefined || last === undefined) {
        return refused(`there is no swatch ${first === undefined ? lo : hi}`);
      }

      const ramp = oklabRamp(first.rgb, last.rgb, edit.steps);
      // The endpoints are kept whole rather than replaced by the ramp's own
      // copies of them: their locks and their populations still describe the
      // colour, which `oklabRamp` guarantees is byte-identical.
      const interior = ramp.colors.slice(1, -1).map(
        (rgb): Swatch => ({ rgb, locked: false, population: null }),
      );
      const swatches = [
        ...state.swatches.slice(0, lo),
        first,
        ...interior,
        last,
        ...state.swatches.slice(hi + 1),
      ];
      if (swatches.length < MIN_SWATCHES) {
        return refused(`that ramp would leave fewer than ${MIN_SWATCHES} colours`);
      }
      if (swatches.length > MAX_SWATCHES) {
        return refused(`that ramp would exceed ${MAX_SWATCHES} colours`);
      }
      return applied("ramp", { ...state, ...handEdited(state), swatches, mode: INDEXED });
    }

    case "mode": {
      const colors = derivedColors(edit.mode);
      if (colors === null) {
        // Switching *to* indexed generates nothing: the palette on screen is
        // already the answer, and the mode is now a record that it was edited
        // by hand rather than produced by a level count.
        if (state.mode.kind === "indexed") return refused("the output mode is already indexed");
        return applied("mode", { ...state, mode: edit.mode }, null, false);
      }
      if (colors.length > MAX_SWATCHES) {
        return refused(`that mode produces ${colors.length} colours; the ceiling is ${MAX_SWATCHES}`);
      }
      const described = describeMode(edit.mode);
      return applied("mode", {
        ...state,
        id: described.id,
        name: described.name,
        swatches: plain(colors),
        mode: edit.mode,
        report: null,
      });
    }

    case "metric": {
      if (state.metric === edit.metric) return refused(`the metric is already ${edit.metric}`);
      // The metric changes which palette entry a pixel matches, so the picture
      // moves even though not one swatch did.
      return applied("metric", { ...state, metric: edit.metric });
    }

    case "extract-settings":
      return applied("extract-settings", { ...state, extract: edit.settings }, null, false);
  }
}
