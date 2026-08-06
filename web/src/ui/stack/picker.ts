/**
 * The add-node picker's model (F-ST-08).
 *
 * Finding one effect out of sixty-three needs three things at once, and this
 * builds all three from the sealed registry and nothing else:
 *
 * - **ranked free text**, which is `registry.search` — already written, already
 *   tested, and the reason typing a spec id such as `F-ED-01` lands on the
 *   effect it names;
 * - **grouping by family**, so the resting state with no query is a readable
 *   catalogue rather than sixty-three rows;
 * - **legality at the insertion point**, so an effect that cannot go where the
 *   user is about to put it says so before it is added rather than after
 *   (`web/src/registry/stack.ts` — the editor must not let it be built).
 *
 * There is no list of effects here and no per-effect rule. An effect added
 * tomorrow appears in this panel with no edit to it.
 */

import type { EffectFilter, EffectRegistry, StackNodeRef } from "../../registry";
import type { EffectDescriptor, EffectFamily } from "../../types/registry";
import { FAMILY_LABEL, FAMILY_ORDER, judgeCandidate, withCandidate } from "./model";

export interface PickerEntry {
  readonly effect: EffectDescriptor;
  /** False when adding it here would introduce a grammar issue. */
  readonly available: boolean;
  /** Present exactly when `available` is false. */
  readonly reason?: string;
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
 * Rank, group and judge in one pass.
 *
 * Groups always come out in {@link FAMILY_ORDER} and empty ones are dropped —
 * a heading with nothing under it is a row of noise between the two results
 * that did match. Within a group the order is the search's ranking, which for
 * an empty query is registry order.
 */
export function buildPicker(request: PickerRequest): PickerModel {
  const { registry, stack, insertAt, query, filter } = request;

  const ranked = registry.search(query, filter);

  // Judged once per effect, not once per rendered row: `judgeCandidate` runs
  // the whole grammar over a copy of the stack, and the picker re-renders on
  // every keystroke.
  const byFamily = new Map<EffectFamily, PickerEntry[]>();
  let unavailable = 0;

  for (const result of ranked) {
    const effect = result.effect;
    const verdict = judgeCandidate(
      registry,
      stack,
      withCandidate(stack, effect.id, insertAt),
    );
    const entry: PickerEntry = verdict.ok
      ? { effect, available: true }
      : { effect, available: false, reason: verdict.reason };
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

  return {
    groups,
    matched: ranked.length,
    total: registry.size,
    unavailable,
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
