/**
 * Effect search and filtering (F-ST-08).
 *
 * The add-node panel has to find one effect out of sixty-seven, so it needs both
 * axes: a structural filter (this slot, this family) and free text. They compose
 * — the filter narrows, the query ranks what is left.
 *
 * Two things were wrong with the first version of this file, and both were found
 * by the owner using the application rather than by a test.
 *
 * **It matched only names and structural fields.** So "glow" did not find
 * Epsilon glow, which is named after the reference product; "noise" did not find
 * blue noise; "halftone" did not find the CMYK separation node. The fix is not a
 * better ranking function, it is more text to rank: every effect now carries a
 * summary, a description and a list of the words a person actually uses for it
 * (F-UI-15), and this file weighs all of them.
 *
 * **A miss returned an empty list and said nothing.** An empty list is
 * indistinguishable from "you spelled it wrong", so the reader retypes the query
 * several ways before concluding anything — which is exactly what happened when
 * the wave effect could not be found although `wave-warp` exists. So a search
 * that finds nothing now *reports why*: the nearest effects in the catalogue,
 * or, when the query names something the spec has but this build does not, the
 * fact that it is not built and the reason (see `./unbuilt.ts`).
 *
 * The near misses are reported and never silently returned. Returning them would
 * make "no results" impossible to tell from "poor results", which is the same
 * failure one level up.
 */

import type { NodeSlot } from "../types/document";
import type {
  EffectDescriptor,
  EffectFamily,
  ExecutionKind,
} from "../types/registry";
import { UNBUILT_FEATURES, unbuiltFor, type UnbuiltFeature } from "./unbuilt";

/**
 * Structural narrowing, applied before ranking.
 *
 * Every field is optional and absent means "no constraint"; the stack panel
 * sets `slot` when the insertion point already fixes it, and Surprise Me sets
 * `requiresIndexMap: false` when nothing upstream has quantized yet.
 */
export interface EffectFilter {
  readonly slot?: NodeSlot;
  readonly family?: EffectFamily;
  readonly execution?: ExecutionKind;
  readonly producesIndexMap?: boolean;
  readonly requiresIndexMap?: boolean;
}

export interface EffectSearchResult {
  readonly effect: EffectDescriptor;
  /** Relative, not normalized. Meaningful only for ordering within one query. */
  readonly score: number;
}

/**
 * Fold case and every separator — hyphens, spaces, the `×` in `16×16` — into
 * single spaces, so `Floyd-Steinberg`, `floyd steinberg` and `FLOYD  STEINBERG`
 * are one query. Separators are collapsed, not deleted: deleting them would
 * make `fs` match `floyd-steinberg` and, with it, half the catalogue.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** How strongly a token matched, independent of which field it matched in. */
const EXACT = 1;
const PREFIX = 0.7;
const SUBSTRING = 0.4;

/**
 * How much each field is worth.
 *
 * Name first because it is what the UI shows and therefore what people type,
 * and `keywords` immediately behind it because that field exists precisely for
 * the case where the name is *not* what people type — "glow" for Epsilon glow.
 * Ranking keywords above `id` would be wrong the other way: an id is a name the
 * user has seen, a keyword is a guess about what they might call it.
 *
 * `description` is last and low. It is the longest field by an order of
 * magnitude, so an incidental mention in one effect's prose must never outrank
 * another effect's name — but it still has to score, because it is where
 * "pairs with", "unlike" and "before the dither" live, and those are real
 * queries.
 *
 * `requirement` is in here so that typing a spec id (`F-ED-01`) jumps straight
 * to the effect, which is how the catalogue gets checked against the spec.
 */
const FIELD_WEIGHT = {
  name: 4,
  keywords: 3.5,
  id: 3,
  summary: 2.5,
  family: 2,
  requirement: 2,
  concept: 1.5,
  slot: 1,
  execution: 1,
  description: 1,
} as const;

interface SearchField {
  readonly weight: number;
  readonly words: readonly string[];
  readonly text: string;
}

function field(weight: number, value: string): SearchField {
  const text = normalize(value);
  return { weight, words: text.split(" ").filter((w) => w.length > 0), text };
}

function fieldsOf(effect: EffectDescriptor): readonly SearchField[] {
  return [
    field(FIELD_WEIGHT.name, effect.name),
    // Joined rather than one field per keyword: the scorer takes the best field,
    // so N fields and one joined field rank identically, and one is cheaper.
    // The join keeps them separate words so a multi-word keyword still matches
    // per word.
    field(FIELD_WEIGHT.keywords, effect.keywords.join(" ")),
    field(FIELD_WEIGHT.id, effect.id),
    field(FIELD_WEIGHT.summary, effect.summary),
    field(FIELD_WEIGHT.family, effect.family),
    field(FIELD_WEIGHT.requirement, effect.requirement),
    field(FIELD_WEIGHT.concept, effect.concept ?? ""),
    field(FIELD_WEIGHT.slot, effect.slot),
    field(FIELD_WEIGHT.execution, effect.execution),
    field(FIELD_WEIGHT.description, effect.description),
  ];
}

/** Best score this token achieves anywhere in the effect. Zero means no match. */
function scoreToken(fields: readonly SearchField[], token: string): number {
  let best = 0;
  for (const f of fields) {
    let strength = 0;
    for (const word of f.words) {
      if (word === token) {
        strength = EXACT;
        break;
      }
      if (word.startsWith(token)) strength = Math.max(strength, PREFIX);
    }
    if (strength === 0 && f.text.includes(token)) strength = SUBSTRING;
    best = Math.max(best, strength * f.weight);
  }
  return best;
}

export function matchesFilter(
  effect: EffectDescriptor,
  filter: EffectFilter,
): boolean {
  if (filter.slot !== undefined && effect.slot !== filter.slot) return false;
  if (filter.family !== undefined && effect.family !== filter.family) {
    return false;
  }
  if (filter.execution !== undefined && effect.execution !== filter.execution) {
    return false;
  }
  if (
    filter.producesIndexMap !== undefined &&
    effect.producesIndexMap !== filter.producesIndexMap
  ) {
    return false;
  }
  if (
    filter.requiresIndexMap !== undefined &&
    effect.requiresIndexMap !== filter.requiresIndexMap
  ) {
    return false;
  }
  return true;
}

/** Ties break on id rather than on nothing; see {@link searchEffects}. */
function byScoreThenId(a: EffectSearchResult, b: EffectSearchResult): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.effect.id < b.effect.id) return -1;
  if (a.effect.id > b.effect.id) return 1;
  return 0;
}

function tokenize(query: string): readonly string[] {
  return normalize(query)
    .split(" ")
    .filter((t) => t.length > 0);
}

/**
 * A whole spec requirement id, typed as one.
 *
 * Matched before tokenization and never after, because normalizing `F-SP-01`
 * gives the three tokens `f`, `sp` and `01`, and every one of them matches
 * something: `f` is a prefix of half the catalogue's words and `01` is a whole
 * word inside `F-PP-01`. Ranked as ordinary text a requirement id therefore
 * lands on an arbitrary effect with total confidence, which is worse than
 * finding nothing. An id is an exact key, so it is looked up as one.
 */
const REQUIREMENT_QUERY = /^\s*F-[A-Z]{2}-[A-Z0-9]{2,3}\s*$/i;

function asRequirementId(query: string): string | null {
  return REQUIREMENT_QUERY.test(query) ? query.trim().toUpperCase() : null;
}

/**
 * Rank `effects` against `query`, after applying `filter`.
 *
 * Every token must match somewhere — `bayer glitch` returns nothing rather than
 * everything Bayer plus everything glitch, because a second word is how a
 * person narrows, not how they broaden.
 *
 * An empty query is the panel's resting state and returns the whole filtered
 * set, scored zero and left in registry order.
 */
export function searchEffects(
  effects: readonly EffectDescriptor[],
  query: string,
  filter: EffectFilter = {},
): readonly EffectSearchResult[] {
  const candidates = effects.filter((e) => matchesFilter(e, filter));

  const requirement = asRequirementId(query);
  if (requirement !== null) {
    return candidates
      .filter((effect) => effect.requirement.toUpperCase() === requirement)
      .map((effect) => ({ effect, score: FIELD_WEIGHT.requirement * EXACT }));
  }

  const tokens = tokenize(query);

  if (tokens.length === 0) {
    return candidates.map((effect) => ({ effect, score: 0 }));
  }

  const results: EffectSearchResult[] = [];
  for (const effect of candidates) {
    const fields = fieldsOf(effect);
    let total = 0;
    let matchedEveryToken = true;
    for (const token of tokens) {
      const score = scoreToken(fields, token);
      if (score === 0) {
        matchedEveryToken = false;
        break;
      }
      total += score;
    }
    if (matchedEveryToken) results.push({ effect, score: total });
  }

  // Ties break on id rather than on nothing: `Array.prototype.sort` is stable,
  // but the input order is a discovery detail, and two builds that list the
  // same effects in a different order must produce the same panel.
  results.sort(byScoreThenId);
  return results;
}

// --- reporting a miss ----------------------------------------------------

/** How many near misses are worth naming. Three fits a sentence and a panel. */
const NEAREST_LIMIT = 3;

/**
 * Levenshtein distance, capped: the caller only cares whether it is small.
 *
 * Here to catch a typo — "halftown", "steinburg" — which is the one failure the
 * substring rules cannot reach, since a misspelling is not a prefix or a
 * substring of the right word. Only run on a query that has already failed, so
 * its cost falls on the path where the user is stuck.
 */
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      const best = Math.min(substitution, deletion, insertion);
      current.push(best);
      rowBest = Math.min(rowBest, best);
    }
    // Every remaining row can only grow, so a row already over the cap settles
    // the answer.
    if (rowBest > cap) return cap + 1;
    previous = current;
  }
  return previous[b.length] ?? cap + 1;
}

/**
 * How far a token may be from a word and still count as a misspelling of it.
 *
 * Length-dependent because one edit in a three-letter token is a different word
 * ("red" to "bed") while one edit in a nine-letter one is a slip of the finger.
 */
function typoBudget(token: string): number {
  if (token.length >= 7) return 2;
  if (token.length >= 4) return 1;
  return 0;
}

/**
 * Rank against a relaxed rule: tokens that match add, tokens that miss cost
 * nothing.
 *
 * This is the "nearest" list, and it is deliberately *not* what
 * {@link searchEffects} returns. Handing these back as results would make a
 * poor answer indistinguishable from a good one; naming them as near misses
 * leaves the reader in charge of deciding whether one of them is what they
 * meant.
 */
function nearest(
  candidates: readonly EffectDescriptor[],
  tokens: readonly string[],
): readonly EffectDescriptor[] {
  const scored: EffectSearchResult[] = [];
  for (const effect of candidates) {
    const fields = fieldsOf(effect);
    let total = 0;
    for (const token of tokens) {
      const direct = scoreToken(fields, token);
      if (direct > 0) {
        total += direct;
        continue;
      }
      const budget = typoBudget(token);
      if (budget === 0) continue;
      // A typo is worth less than a real match, so an effect that genuinely
      // contains one of the words outranks one that nearly contains another.
      let best = 0;
      for (const f of fields) {
        for (const word of f.words) {
          if (editDistance(token, word, budget) <= budget) {
            best = Math.max(best, SUBSTRING * f.weight);
          }
        }
      }
      total += best;
    }
    if (total > 0) scored.push({ effect, score: total });
  }
  scored.sort(byScoreThenId);
  return scored.slice(0, NEAREST_LIMIT).map((r) => r.effect);
}

/**
 * Why a search returned nothing.
 *
 * A closed union rather than a message string, because the three cases call for
 * three different things from the caller — an explanation, a list to click, or
 * a hint to widen the filter — and a caller that only had prose could not tell
 * them apart. {@link describeMiss} turns any of them into the sentence, so all
 * three surfaces of F-UI-15 say the same thing.
 */
export type SearchMiss =
  /**
   * The query names something the spec has and this build does not. The most
   * important case: it is the one where retyping the query cannot ever help.
   */
  | {
      readonly kind: "unbuilt";
      readonly feature: UnbuiltFeature;
      /** Built effects worth offering instead. May be empty. */
      readonly nearest: readonly EffectDescriptor[];
    }
  /** Nothing matched every token, but these came closest. */
  | { readonly kind: "nearest"; readonly nearest: readonly EffectDescriptor[] }
  /**
   * The query matched, but the active structural filter excluded everything it
   * matched — so the fix is to widen the filter, not to retype.
   */
  | {
      readonly kind: "filtered-out";
      readonly nearest: readonly EffectDescriptor[];
    }
  /** Nothing in the catalogue is close, and no known gap explains it either. */
  | { readonly kind: "unknown" };

export interface CatalogueSearch {
  /** The query as typed, for the caller to quote back. */
  readonly query: string;
  /** Ranked matches, best first. Empty exactly when `miss` is not null. */
  readonly results: readonly EffectSearchResult[];
  /** Why there are no results. Null exactly when `results` is non-empty. */
  readonly miss: SearchMiss | null;
}

/**
 * Search the catalogue and, when nothing matches, say why.
 *
 * This is the entry point every surface should use. {@link searchEffects} is the
 * ranking primitive underneath it and returns the list alone; a caller that uses
 * it directly gets an empty array with no explanation, which is the behaviour
 * this function exists to replace.
 */
export function searchCatalogue(
  effects: readonly EffectDescriptor[],
  query: string,
  filter: EffectFilter = {},
): CatalogueSearch {
  const results = searchEffects(effects, query, filter);
  if (results.length > 0) return { query, results, miss: null };

  const tokens = tokenize(query);
  // An empty query under a filter that admits nothing is a filter problem, and
  // `searchEffects` has already returned the whole (empty) filtered set.
  if (tokens.length === 0) {
    return { query, results, miss: { kind: "filtered-out", nearest: [] } };
  }

  // The unbuilt table is consulted first. When someone types "unknown
  // pleasures" the useful answer is that F-PT-09 is not built, even though
  // `line-screen` would also have come back as a near miss — a near miss
  // invites another five minutes of looking, a named gap does not.
  const requirement = asRequirementId(query);
  const feature =
    requirement !== null
      ? (UNBUILT_FEATURES.find((f) => f.requirement === requirement) ?? null)
      : unbuiltFor(tokens, normalize);
  if (feature !== null) {
    const byId = new Map(effects.map((e) => [e.id, e]));
    const suggestions = feature.nearest
      .map((id) => byId.get(id))
      .filter((e): e is EffectDescriptor => e !== undefined && matchesFilter(e, filter));
    return { query, results, miss: { kind: "unbuilt", feature, nearest: suggestions } };
  }

  // Distinguish "no effect matches" from "the filter hid the ones that do": the
  // second is fixed by widening the filter and the first never is, and a reader
  // cannot tell which they are looking at from an empty list.
  const unfiltered = searchEffects(effects, query, {});
  if (unfiltered.length > 0) {
    return {
      query,
      results,
      miss: {
        kind: "filtered-out",
        nearest: unfiltered.slice(0, NEAREST_LIMIT).map((r) => r.effect),
      },
    };
  }

  const close = nearest(effects.filter((e) => matchesFilter(e, filter)), tokens);
  if (close.length > 0) return { query, results, miss: { kind: "nearest", nearest: close } };
  return { query, results, miss: { kind: "unknown" } };
}

/**
 * The miss as one sentence a person can read.
 *
 * Here rather than in each surface for the same reason the descriptions
 * themselves are in the registry: hover help, the picker and the guide must not
 * each write their own wording for "that does not exist yet", because three
 * copies of a sentence drift exactly the way three copies of a description do.
 */
export function describeMiss(miss: SearchMiss, query: string): string {
  const names = (effects: readonly EffectDescriptor[]): string =>
    effects.map((e) => e.name).join(", ");

  switch (miss.kind) {
    case "unbuilt":
      return [
        `“${query}” is not in this build.`,
        `${miss.feature.name} (${miss.feature.requirement}) is specified but not implemented: ${miss.feature.reason}`,
        miss.nearest.length > 0 ? `The closest effects that do exist are ${names(miss.nearest)}.` : "",
      ]
        .filter((part) => part.length > 0)
        .join(" ");
    case "filtered-out":
      return miss.nearest.length > 0
        ? `No effect matches “${query}” here, but ${names(miss.nearest)} would match without the current filter.`
        : `No effect matches “${query}” under the current filter.`;
    case "nearest":
      return `Nothing matches “${query}”. The nearest effects are ${names(miss.nearest)}.`;
    case "unknown":
      return `Nothing in the catalogue matches “${query}”, and it is not a known gap either.`;
  }
}
