/**
 * Effect search and filtering (F-ST-08).
 *
 * The add-node panel has to find one effect out of 63, so it needs both axes:
 * a structural filter (this slot, this family) and free text. They compose —
 * the filter narrows, the query ranks what is left.
 *
 * Ranking exists because substring matching alone puts "Bayer 16x16" above
 * "Bayer" for the query `bayer`, which is the wrong answer every time. Fields
 * are weighted by how likely a person is to be typing them, and an exact word
 * beats a prefix beats a substring.
 */

import type { NodeSlot } from "../types/document";
import type {
  EffectDescriptor,
  EffectFamily,
  ExecutionKind,
} from "../types/registry";

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
 * Fold case and every separator — hyphens, spaces, the `×` in `16x16` — into
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
 * Name first because it is what the UI shows and therefore what people type.
 * `requirement` is in here so that typing a spec id (`F-ED-01`) jumps straight
 * to the effect, which is how the catalogue gets checked against the spec.
 */
const FIELD_WEIGHT = {
  name: 4,
  id: 3,
  family: 2,
  requirement: 2,
  slot: 1,
  execution: 1,
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
    field(FIELD_WEIGHT.id, effect.id),
    field(FIELD_WEIGHT.family, effect.family),
    field(FIELD_WEIGHT.requirement, effect.requirement),
    field(FIELD_WEIGHT.slot, effect.slot),
    field(FIELD_WEIGHT.execution, effect.execution),
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
  const tokens = normalize(query).split(" ").filter((t) => t.length > 0);

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
  results.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : a.effect.id < b.effect.id
        ? -1
        : a.effect.id > b.effect.id
          ? 1
          : 0,
  );
  return results;
}
