/**
 * The built-in palette library — F-CO-04, and the search over it that F-CO-14
 * asks for on the shipped half.
 *
 * **There is no palette table in this file.** The fifteen hardware palettes are
 * facts about hardware, they live in `core/…/palette.rs` where the renderer
 * reads them, and they reach the web layer through `builtinPalettes()` at the
 * WASM boundary (`core.ts`). A second copy here would be a second set of
 * numbers to keep true, and the one that drifts is always the one nobody
 * renders with.
 *
 * What is here is the shape they arrive in and the pure search over them, so
 * the filter box can be tested without a browser or a WASM instance.
 */

export interface BuiltinPalette {
  /** Stable id; `.dork` documents store it. */
  readonly id: string;
  readonly name: string;
  /** Packed 8-bit sRGB triplets, straight from the core. */
  readonly colors: readonly number[];
}

/**
 * Filter the library by a free-text query over id and name.
 *
 * Every whitespace-separated term must match somewhere, so "game boy" finds
 * both Game Boy entries and "cga high" finds the two high-intensity CGA modes.
 * An empty query returns the library in catalogue order, which is the order the
 * core lists them in and therefore the order the hardware came in.
 */
export function searchPalettes(
  palettes: readonly BuiltinPalette[],
  query: string,
): readonly BuiltinPalette[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return palettes;
  return palettes.filter((palette) => {
    const haystack = `${palette.id} ${palette.name}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** Entries in a packed triplet list. */
export function paletteSize(palette: BuiltinPalette): number {
  return Math.floor(palette.colors.length / 3);
}
