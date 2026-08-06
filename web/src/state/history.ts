/**
 * F-ST-04 — unlimited undo and redo, across every document mutation.
 *
 * **Snapshots, not inverse operations.** The alternative — recording a command
 * and how to invert it — needs an inverse per mutation and is wrong the first
 * time somebody adds a mutation and forgets one; the bug it produces is an undo
 * that appears to work and leaves the document subtly different. A document is
 * a small tree of plain data whose unchanged parts are shared by reference
 * between snapshots, so a stack of them costs one object per edit, not one
 * document per edit. That is what makes "unlimited" a defensible word here
 * rather than a promise about memory.
 *
 * **Coalescing is what makes it usable.** A slider drag emits a mutation per
 * pointer move; without coalescing, one drag is two hundred undo steps and undo
 * becomes useless exactly where it is needed most. Consecutive commits carrying
 * the same `coalesce` key replace the top entry instead of pushing a new one,
 * so a drag is one step and the step's *starting* state is the one undo returns
 * to. The key is per-control (`param:n3.strength`), so moving to a different
 * slider begins a new step without anyone having to signal the end of a drag.
 *
 * **Committing clears the redo tail**, which is the linear model every editor
 * uses: once you have branched, the abandoned future is gone. Nothing here is a
 * tree.
 *
 * Pure and generic — no document type, no logging, no clock. The store above it
 * owns all three.
 */

export interface HistoryEntry<T> {
  readonly state: T;
  /** Shown next to Undo/Redo. "Add Floyd-Steinberg", "Reorder stack". */
  readonly label: string;
}

export class History<T> {
  /** Index 0 is the state the document was opened at; it is never popped. */
  readonly #entries: HistoryEntry<T>[];
  #index = 0;
  /**
   * The coalesce key of the entry at {@link #index}, when it was made by a
   * coalescing commit and nothing has happened since. Cleared by undo, by redo
   * and by any commit with a different key, so a drag interrupted by anything
   * at all starts a new step rather than silently absorbing the next edit.
   */
  #openKey: string | null = null;

  constructor(initial: T, label = "Open") {
    this.#entries = [{ state: initial, label }];
  }

  get present(): T {
    // The index is maintained inside 0..length-1 by every path below, so this
    // is total; the fallback is unreachable and exists because
    // noUncheckedIndexedAccess is on and a non-null assertion would be a claim
    // with no check behind it.
    const entry = this.#entries[this.#index];
    if (entry === undefined) throw new Error("history index is out of range");
    return entry.state;
  }

  get depth(): number {
    return this.#entries.length;
  }

  get position(): number {
    return this.#index;
  }

  get canUndo(): boolean {
    return this.#index > 0;
  }

  get canRedo(): boolean {
    return this.#index < this.#entries.length - 1;
  }

  /** What Undo would undo, for the menu item's label. */
  get undoLabel(): string | null {
    return this.canUndo ? (this.#entries[this.#index]?.label ?? null) : null;
  }

  /** What Redo would redo. */
  get redoLabel(): string | null {
    return this.canRedo ? (this.#entries[this.#index + 1]?.label ?? null) : null;
  }

  /**
   * Record a new state.
   *
   * `coalesce` groups consecutive commits under one entry — pass the control's
   * identity, and pass `null` for anything discrete.
   */
  commit(state: T, label: string, coalesce: string | null = null): void {
    if (coalesce !== null && coalesce === this.#openKey) {
      // Replace rather than push: the entry already holds this drag's label and
      // the state before the drag is the one below it.
      this.#entries[this.#index] = { state, label };
      return;
    }

    // Anything after the current position is an abandoned future.
    this.#entries.length = this.#index + 1;
    this.#entries.push({ state, label });
    this.#index += 1;
    this.#openKey = coalesce;
  }

  /** The previous state, or `null` when there is none. */
  undo(): T | null {
    if (!this.canUndo) return null;
    this.#index -= 1;
    this.#openKey = null;
    return this.present;
  }

  /** The next state, or `null` when there is none. */
  redo(): T | null {
    if (!this.canRedo) return null;
    this.#index += 1;
    this.#openKey = null;
    return this.present;
  }

  /**
   * Rewrite every entry through `fn`.
   *
   * One caller: opening an image. The source is part of the document, so a
   * history recorded against the previous image would let undo travel to a
   * document naming a picture the session no longer holds — and the pixels are
   * not in the history and cannot be. Rewriting every entry to name the new
   * source keeps undo inside what is actually loadable and keeps the stack
   * edits, which is what somebody opening a second image wants to keep.
   *
   * Labels are untouched, and the position does not move.
   */
  rewrite(fn: (state: T) => T): void {
    for (const [index, entry] of this.#entries.entries()) {
      this.#entries[index] = { state: fn(entry.state), label: entry.label };
    }
    // A drag cannot continue across this: the states it was accumulating into
    // are not the ones that are there now.
    this.#openKey = null;
  }

  /** Drop everything and start again from `state`. */
  reset(state: T, label = "Open"): void {
    this.#entries.length = 0;
    this.#entries.push({ state, label });
    this.#index = 0;
    this.#openKey = null;
  }
}
