/**
 * The effect picker's model — F-ST-08, and the search half of F-UI-15.
 *
 * Finding one effect out of sixty-seven needs five things at once, and this
 * builds all five from the sealed registry and nothing else:
 *
 * - **ranked free text over every descriptive field**, which is
 *   `registry.searchWithMiss` — already written, already tested, and the reason
 *   "bloom" finds Epsilon glow and a spec id such as `F-ED-01` lands on the
 *   effect it names;
 * - **the evidence for each result**, from `./match.ts`, so a row that appeared
 *   because of a keyword says which keyword;
 * - **grouping by family**, so the resting state with no query is a readable
 *   catalogue rather than sixty-seven rows;
 * - **legality at the insertion point**, so an effect that cannot go where the
 *   user is about to put it says so before it is added rather than after
 *   (`web/src/registry/stack.ts` — the editor must not let it be built);
 * - **the gap, named**, when the query is asking for something this build does
 *   not have.
 *
 * ## The gap is reported even when there are results
 *
 * `searchCatalogue` names an unbuilt feature only when it finds nothing, which
 * is right for the search primitive and not enough for this panel. The failure
 * that produced this work was not an empty list: it was typing "wave", getting
 * `wave-warp`, trying it, and discovering some time later that the wave *field*
 * of F-PT-10 does not exist. A plausible near-miss is what cost the time, so
 * when the query names a known gap the panel says so **above** the results
 * rather than only in place of them.
 *
 * That needs a stricter rule than the one `unbuiltFor` applies. `unbuiltFor` is
 * deliberately generous because it only ever runs on a query that already failed,
 * where a loose guess costs nothing; running it on every keystroke would put a
 * "not built" notice over half the catalogue. {@link unbuiltNamedBy} is the
 * strict form: every token of the query has to be a whole word of the feature's
 * name, keywords or requirement id. "wave" matches the keyword "wave field";
 * "waveform" matches nothing.
 *
 * There is no list of effects here and no per-effect rule. An effect added
 * tomorrow appears in this panel with no edit to it.
 */

import {
  UNBUILT_FEATURES,
  matchesFilter,
  type EffectFilter,
  type EffectRegistry,
  type SearchMiss,
  type StackNodeRef,
  type UnbuiltFeature,
} from "../../registry";
import type { EffectDescriptor, EffectFamily } from "../../types/registry";
import { FAMILY_LABEL, FAMILY_ORDER, judgeCandidate, withCandidate } from "../stack/model";
import { explainMatch, highlightTokens, tokenize, type EffectMatch } from "./match";

export interface PickerEntry {
  readonly effect: EffectDescriptor;
  /** False when adding it here would introduce a grammar issue. */
  readonly available: boolean;
  /** Present exactly when `available` is false. */
  readonly reason?: string;
  /** The query marked in this effect's text, and why it matched. */
  readonly match: EffectMatch;
}

export interface PickerGroup {
  readonly family: EffectFamily;
  readonly label: string;
  readonly entries: readonly PickerEntry[];
}

export interface PickerModel {
  readonly groups: readonly PickerGroup[];
  /** How many effects survived the filter and the query. */
  readonly matched: number;
  /** How many are in the catalogue at all — the denominator the panel shows. */
  readonly total: number;
  /** How many matched but cannot be added at this insertion point. */
  readonly unavailable: number;
  /**
   * A feature the spec names, this query is asking for, and this build does not
   * have. Reported whether or not there are results — see the note above.
   */
  readonly unbuilt: UnbuiltFeature | null;
  /**
   * Built effects worth offering in place of {@link PickerModel.unbuilt}, minus
   * any the results already show. Empty when there is honestly nothing near it.
   */
  readonly unbuiltNearest: readonly EffectDescriptor[];
  /**
   * Why there are no results. Null exactly when there are some.
   *
   * Straight from `searchCatalogue`, so the picker, the hover help and the guide
   * all give the same account of the same miss.
   */
  readonly miss: SearchMiss | null;
  /** The tokens the rows are marked with. Empty for an empty query. */
  readonly tokens: readonly string[];
}

export interface PickerRequest {
  readonly registry: EffectRegistry;
  /** The stack as it is now, which is what a candidate is judged against. */
  readonly stack: readonly StackNodeRef[];
  /** Position in the stack array the node would be inserted at. */
  readonly insertAt: number;
  readonly query: string;
  readonly filter: EffectFilter;
}

/**
 * Shortest token that may carry a query on its own.
 *
 * Without a floor, `f` names F-GL-06 — because a requirement id tokenizes to
 * `f`, `gl`, `06`, and every one of those is a word. Two letters is a filter
 * abbreviation, not a request for a feature.
 */
const MEANINGFUL_TOKEN = 3;

/**
 * The unbuilt feature this query is *naming*, as opposed to merely brushing.
 *
 * Strict where `unbuiltFor` is generous. Either the query is the requirement id
 * in full, or every token is a whole word of the feature's name or of one of its
 * keywords and at least one of them is long enough to be a word somebody meant.
 * That is what makes it safe to run on a query that succeeded — the notice
 * appears for "wave", "wave field", "unknown pleasures", "jpeg" and `F-PT-10`,
 * and does not appear because somebody typed a letter, or a word that happens to
 * sit inside a keyword ("block" does not name "blocky").
 */
export function unbuiltNamedBy(query: string): UnbuiltFeature | null {
  const tokens = tokenize(query);
  if (tokens.length === 0) return null;
  const asId = tokens.join(" ");

  for (const feature of UNBUILT_FEATURES) {
    if (tokenize(feature.requirement).join(" ") === asId) return feature;

    const vocabulary = new Set<string>();
    for (const source of [feature.name, ...feature.keywords]) {
      for (const word of tokenize(source)) vocabulary.add(word);
    }
    const named =
      tokens.every((token) => vocabulary.has(token)) &&
      tokens.some((token) => token.length >= MEANINGFUL_TOKEN);
    if (named) return feature;
  }
  return null;
}

/**
 * Rank, explain, group and judge in one pass.
 *
 * Groups always come out in `FAMILY_ORDER` and empty ones are dropped — a
 * heading with nothing under it is a row of noise between the two results that
 * did match. Within a group the order is the search's ranking, which for an
 * empty query is registry order.
 */
export function buildPicker(request: PickerRequest): PickerModel {
  const { registry, stack, insertAt, query, filter } = request;

  const search = registry.searchWithMiss(query, filter);
  const tokens = highlightTokens(query);

  // Judged once per effect, not once per rendered row: `judgeCandidate` runs
  // the whole grammar over a copy of the stack, and the picker re-renders on
  // every keystroke.
  const byFamily = new Map<EffectFamily, PickerEntry[]>();
  const shown = new Set<string>();
  let unavailable = 0;

  for (const result of search.results) {
    const effect = result.effect;
    shown.add(effect.id);
    const verdict = judgeCandidate(
      registry,
      stack,
      withCandidate(stack, effect.id, insertAt),
    );
    const match = explainMatch(effect, tokens);
    const entry: PickerEntry = verdict.ok
      ? { effect, available: true, match }
      : { effect, available: false, reason: verdict.reason, match };
    if (!verdict.ok) unavailable += 1;

    const existing = byFamily.get(effect.family);
    if (existing === undefined) byFamily.set(effect.family, [entry]);
    else existing.push(entry);
  }

  const groups: PickerGroup[] = [];
  for (const family of FAMILY_ORDER) {
    const entries = byFamily.get(family);
    if (entries === undefined || entries.length === 0) continue;
    groups.push({ family, label: FAMILY_LABEL[family], entries });
  }

  // The miss's own account wins when there is one: it ran on a query that found
  // nothing, where the generous match is the right one and has already resolved
  // the suggestions. The strict rule only has to cover the case the miss cannot
  // see, which is a query that succeeded.
  const unbuilt =
    search.miss?.kind === "unbuilt" ? search.miss.feature : unbuiltNamedBy(query);

  const unbuiltNearest =
    unbuilt === null
      ? []
      : unbuilt.nearest
          .map((id) => registry.get(id))
          .filter(
            (effect): effect is EffectDescriptor =>
              effect !== undefined && !shown.has(effect.id) && matchesFilter(effect, filter),
          );

  return {
    groups,
    matched: search.results.length,
    total: registry.size,
    unavailable,
    unbuilt,
    unbuiltNearest,
    miss: search.miss,
    tokens,
  };
}

/**
 * The first entry that can actually be added, in the order they are shown.
 *
 * What Enter commits and what the panel opens with highlighted. Skipping the
 * unavailable ones is the point: the top-ranked result for a query is often
 * exactly the node that cannot go where the caret is, and committing it would
 * be refused.
 */
export function firstAvailable(model: PickerModel): EffectDescriptor | null {
  for (const group of model.groups) {
    for (const entry of group.entries) {
      if (entry.available) return entry.effect;
    }
  }
  return null;
}

/** Every entry in display order — what keyboard navigation steps through. */
export function flatten(model: PickerModel): readonly PickerEntry[] {
  return model.groups.flatMap((group) => group.entries);
}

/**
 * Move the highlight by `delta` rows, skipping nothing.
 *
 * Unavailable rows are still landed on, because they carry the reason they are
 * unavailable and reading it is the point of being able to reach them. Clamped
 * rather than wrapped: wrapping from the last row to the first in a list this
 * long reads as a jump to somewhere else.
 */
export function stepHighlight(
  entries: readonly PickerEntry[],
  currentId: string | null,
  delta: number,
): string | null {
  if (entries.length === 0) return null;
  const current = entries.findIndex((entry) => entry.effect.id === currentId);
  const from = current === -1 ? (delta > 0 ? -1 : entries.length) : current;
  const next = from + delta;
  const clamped = next < 0 ? 0 : next > entries.length - 1 ? entries.length - 1 : next;
  return entries[clamped]?.effect.id ?? null;
}

/** The entry for one effect id, or undefined. What Enter and hover look up. */
export function entryOf(
  entries: readonly PickerEntry[],
  effectId: string | null,
): PickerEntry | undefined {
  if (effectId === null) return undefined;
  return entries.find((entry) => entry.effect.id === effectId);
}
