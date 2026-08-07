/**
 * Surprise history — F-SM-10.
 *
 * "The last N surprises kept with thumbnails and seeds, one click to restore,
 * one click to save as a preset."
 *
 * The list is pure and immutable, like every other model in the application: the
 * store holds the array and calls {@link pushSurprise}, which returns a new one.
 *
 * # There is no timestamp
 *
 * The obvious field to put on a history entry is when it happened, and it is
 * deliberately absent. `Date.now()` is a wall-clock read, the project's rule is
 * that there are none in a render path, and the *only* thing a timestamp would
 * buy here is ordering — which the array already has, newest first. A field that
 * exists to be displayed and cannot be derived from the document is a field that
 * has to be serialised, autosaved and reasoned about; the ordering is free.
 *
 * # The whole document is kept, not just the seed
 *
 * A seed plus a build reproduces a surprise (F-SM-02), so keeping the seed alone
 * would be enough *in principle*. It is not enough in practice for two reasons
 * that both bite:
 *
 * - The extracted palette mode (F-SM-05) runs the core's clustering against the
 *   open image. Restore after opening a different image and the same seed
 *   produces a different palette — correctly, since it is a different picture,
 *   and not what "restore" should mean.
 * - A per-node reroll (F-SM-08) or any hand edit leaves a document that no seed
 *   produces. Those are not pushed here, but a restored entry must come back as
 *   what was on screen rather than as what the seed would have made.
 *
 * So the document is the record and the seed is the label.
 */

import { logger } from "../lib/log";
import type { DitherDocument } from "../types/document";
import type { SurpriseSummary } from "./generate";

const log = logger("app");

/**
 * How many surprises are kept.
 *
 * Each entry holds a document (kilobytes) and a thumbnail (a data URL of a few
 * kilobytes), so twelve is tens of kilobytes rather than anything that needs a
 * budget. Twelve is also about as many as fit on a strip without the thumbnails
 * becoming too small to tell apart, which is the actual constraint — a history
 * you cannot read is a list of seeds.
 */
export const HISTORY_LIMIT = 12;

export interface SurpriseHistoryEntry {
  /** Stable key for the UI list. Assigned by the store, unique within a session. */
  readonly id: string;
  /** The seed, as sixteen hex characters (F-SM-02). */
  readonly seed: string;
  readonly summary: SurpriseSummary;
  /** What to restore. See the note above on why this is not just the seed. */
  readonly document: DitherDocument;
  /**
   * A PNG data URL of the rendered result, or `null` when the render that would
   * have produced it failed.
   *
   * Nullable rather than absent-or-placeholder: a thumbnail is a picture of
   * something that happened, and inventing one — a grey square, a colour swatch
   * — would put a picture in the history that is not the surprise it is labelled
   * with. The strip shows the seed and the stack instead and says why.
   */
  readonly thumbnail: string | null;
  /** Present when the thumbnail is null: the reason, ready to show. */
  readonly thumbnailProblem: string | null;
}

/**
 * Put a surprise at the front of the history.
 *
 * An entry whose seed is already in the list is **moved** to the front rather
 * than added, so restoring an old surprise and looking at it again does not push
 * a second copy of it in front of eleven others. Two different documents cannot
 * share a seed — a fresh one is minted per surprise — so matching on the seed is
 * matching on identity.
 */
export function pushSurprise(
  history: readonly SurpriseHistoryEntry[],
  entry: SurpriseHistoryEntry,
  limit: number = HISTORY_LIMIT,
): readonly SurpriseHistoryEntry[] {
  const withoutDuplicate = history.filter((existing) => existing.seed !== entry.seed);
  const next = [entry, ...withoutDuplicate].slice(0, Math.max(1, limit));
  if (next.length < withoutDuplicate.length + 1) {
    log.debug("surprise history trimmed", { kept: next.length, limit });
  }
  return next;
}

/**
 * Attach a thumbnail to the entry with this id.
 *
 * Separate from {@link pushSurprise} because the two happen at different times:
 * the entry exists the moment the document does, and the thumbnail arrives when
 * a render of it comes back. Returns the list unchanged when the id is gone —
 * the entry may have been pushed off the end while its render was in flight, and
 * that is ordinary rather than an error.
 */
export function withThumbnail(
  history: readonly SurpriseHistoryEntry[],
  id: string,
  thumbnail: string | null,
  problem: string | null,
): readonly SurpriseHistoryEntry[] {
  if (!history.some((entry) => entry.id === id)) {
    log.debug("thumbnail arrived for an entry that is no longer in the history", { id });
    return history;
  }
  return history.map((entry) =>
    entry.id === id ? { ...entry, thumbnail, thumbnailProblem: problem } : entry,
  );
}

/** One line naming what a history entry is, for its tooltip and the log. */
export function describeEntry(entry: SurpriseHistoryEntry): string {
  const stack =
    entry.summary.effectNames.length === 0
      ? "empty stack"
      : entry.summary.effectNames.join(" → ");
  return `${entry.seed} · ${stack} · ${entry.summary.paletteName} (${entry.summary.paletteEntries})`;
}
