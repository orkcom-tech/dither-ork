/**
 * The documents panel's pure half.
 *
 * Everything here is a function of its arguments: the search over the library,
 * the sentence a row shows, the name a save box opens with, and the size a
 * self-contained document is reported at. The panel is a React component and is
 * checked by a person with a browser; this is the part that can be checked
 * without one, and it is where the decisions that are easy to get subtly wrong
 * live.
 */

import type { DitherDocument } from "../../types/document";
import type { EffectRegistry } from "../../registry";
import type { Preset } from "../../io/document";

/**
 * Bytes, for a person.
 *
 * Decimal units, because that is what every operating system's file listing and
 * every browser's download shelf shows — reporting 12.4 MiB beside a download
 * the browser calls 13 MB is a discrepancy nobody can explain.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} kB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

/**
 * Filter the library by a free-text query over name, note and effect names.
 *
 * Effect names are in the haystack deliberately: somebody looking for "the one
 * with the halftone in it" is searching for the contents rather than for the
 * name they gave it, and the contents are the thing they remember.
 *
 * Every whitespace-separated term must match somewhere, so "crt bayer" narrows
 * rather than widens. An empty query returns the library in its own order —
 * built-ins first, then newest saved first — which is the order the library
 * hands out and not one this re-decides.
 */
export function searchPresets(
  presets: readonly Preset[],
  query: string,
  registry: EffectRegistry,
): readonly Preset[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) return presets;
  return presets.filter((preset) => {
    const effects = preset.document.stack
      .map((node) => `${node.effect} ${registry.get(node.effect)?.name ?? ""}`)
      .join(" ");
    const haystack = `${preset.name} ${preset.note ?? ""} ${effects}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/**
 * The line under a preset's name.
 *
 * The first few effect names in stack order, because that is what a preset *is*
 * — the order is the content. Truncated at three: a row is one line, and a
 * fifteen-node stack renders as a name and an ellipsis either way.
 */
export function presetSummary(preset: Preset, registry: EffectRegistry): string {
  const stack = preset.document.stack;
  if (stack.length === 0) return "empty stack";

  const shown = stack.slice(0, 3).map((node) => registry.get(node.effect)?.name ?? node.effect);
  const rest = stack.length - shown.length;
  const chain = shown.join(" → ") + (rest > 0 ? ` → +${rest}` : "");
  const colours = Math.floor(preset.document.palette.colors.length / 3);
  return `${stack.length} node${stack.length === 1 ? "" : "s"} · ${chain} · ${colours} colour${colours === 1 ? "" : "s"}`;
}

/**
 * What the "save as preset" box opens with.
 *
 * The dither in the stack, because that is what somebody would call the look —
 * a preset built on Floyd–Steinberg with three glitch nodes after it is "the
 * Floyd–Steinberg one". The *last* dither rather than the first: a stack with
 * two of them ends up looking like the second.
 *
 * A proposal, not a decision. The box is editable and an empty name is refused
 * rather than replaced, so nothing is ever saved under a name nobody chose.
 */
export function suggestPresetName(
  document: DitherDocument,
  registry: EffectRegistry,
): string {
  const named = (effect: string): string => registry.get(effect)?.name ?? effect;

  for (let index = document.stack.length - 1; index >= 0; index -= 1) {
    const node = document.stack[index];
    if (node === undefined) continue;
    if (registry.get(node.effect)?.slot === "dither") return named(node.effect);
  }
  const first = document.stack[0];
  if (first !== undefined) return named(first.effect);
  return "";
}

/** How many characters a string costs as UTF-8 bytes, for the size readout. */
export function textByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
