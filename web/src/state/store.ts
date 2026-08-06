/**
 * The live document — the application's single piece of state.
 *
 * Everything that is not pixels is in here: the stack, the parameters, the
 * palette, the clock, the bindings, which node is selected, what undo would
 * undo, and the image the document is pointed at. Panels read it through
 * `useSyncExternalStore` and change it by calling a command; the renderer
 * subscribes to it and nothing else.
 *
 * Three properties the design turns on:
 *
 * - **The snapshot is immutable and its identity changes exactly when the state
 *   does.** That is `useSyncExternalStore`'s contract: React compares snapshots
 *   by reference, so a store that mutated in place would render nothing and a
 *   store that rebuilt its snapshot on every read would render forever.
 *
 * - **Every command is one undo step** (F-ST-04), unless it opts into
 *   coalescing — a slider drag passes `continuous: true` and becomes one step
 *   whose starting point is where the drag began.
 *
 * - **Opening an image rewrites the history rather than clearing it.** The
 *   source is part of the document, so a history recorded against the previous
 *   image would let undo travel to a document naming a picture the session no
 *   longer holds; the pixels are not in the history and cannot be. Rewriting
 *   every entry keeps the stack edits — which is what somebody opening a second
 *   image wants — and keeps undo inside what is loadable. It is the one place
 *   the history is not a plain stack of what happened, and it is here rather
 *   than in `history.ts` because the reason is about documents, not about undo.
 */

import type {
  Binding,
  Clock,
  DitherDocument,
  Palette,
  ParameterValue,
} from "../types/document";
import type { EffectRegistry } from "../registry";
import type { SourceImage } from "../io";
import { sourceRefOf } from "../io";
import { logger } from "../lib/log";
import { AutosaveWriter } from "./autosave";
import { createDocument } from "./document";
import { History } from "./history";
import * as mutate from "./mutations";

const log = logger("app");

/** What the UI shows about a document that came back from autosave (F-DO-07). */
export interface RestoreNotice {
  readonly savedAt: Date;
  /** The image the restored document names, or `null` if it named none. */
  readonly sourceName: string | null;
  /** One sentence, ready to display. */
  readonly message: string;
}

export interface DocumentSnapshot {
  readonly document: DitherDocument;
  /** The decoded image, or `null` before one is opened. */
  readonly source: SourceImage | null;
  readonly selectedNodeId: string | null;
  /**
   * The solo point (F-ST-02): the render stops after this node and everything
   * below it is excluded.
   *
   * Not a document field, and deliberately. Solo is a way of *looking* at a
   * document rather than part of one — a `.dork` that saved it would reopen
   * showing a truncated stack with no visible reason, and undoing past a solo
   * would move the picture without moving the document. `render/graph.ts`
   * implements it by pointing the graph's output at an earlier node, so the
   * nodes below keep their cache entries and un-soloing is free.
   */
  readonly soloNodeId: string | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
  readonly historyDepth: number;
  /** Set until dismissed. The explicit notice F-DO-07 requires. */
  readonly restored: RestoreNotice | null;
  /** Increments on every change. The renderer's "something moved" signal. */
  readonly revision: number;
}

export interface DocumentStoreOptions {
  readonly registry: EffectRegistry;
  /** Absent where OPFS is unavailable; the status bar states that separately. */
  readonly autosave?: AutosaveWriter | null;
  /** A restored document and its notice, from `loadAutosave` at boot. */
  readonly restored?: RestoreNotice | null;
  readonly document?: DitherDocument;
}

export interface CommitOptions {
  /**
   * Group consecutive commits of the same control into one undo step. Pass it
   * from a pointer-driven control; leave it off for anything discrete.
   */
  readonly continuous?: boolean;
}

export class DocumentStore {
  readonly #registry: EffectRegistry;
  readonly #history: History<DitherDocument>;
  readonly #autosave: AutosaveWriter | null;
  readonly #listeners = new Set<() => void>();

  #source: SourceImage | null = null;
  #selected: string | null = null;
  #solo: string | null = null;
  #restored: RestoreNotice | null;
  #revision = 0;
  #snapshot: DocumentSnapshot;

  constructor(options: DocumentStoreOptions) {
    this.#registry = options.registry;
    this.#autosave = options.autosave ?? null;
    this.#restored = options.restored ?? null;
    this.#history = new History<DitherDocument>(
      options.document ?? createDocument(),
      this.#restored === null ? "Open" : "Restored from autosave",
    );
    this.#snapshot = this.#buildSnapshot();
    log.info("document store ready", {
      nodes: this.#history.present.stack.length,
      restored: this.#restored !== null,
      autosave: this.#autosave !== null,
    });
  }

  // --- reading ----------------------------------------------------------

  /** For `useSyncExternalStore`. Stable until something changes. */
  readonly getSnapshot = (): DocumentSnapshot => this.#snapshot;

  /** For `useSyncExternalStore`. Returns the unsubscriber. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  get document(): DitherDocument {
    return this.#history.present;
  }

  get source(): SourceImage | null {
    return this.#source;
  }

  get registry(): EffectRegistry {
    return this.#registry;
  }

  // --- source -----------------------------------------------------------

  /**
   * Point the document at a decoded image (F-IN-01).
   *
   * Not an undo step of its own — see the note at the top of the file. The
   * document's `source` reference is rewritten through the whole history so no
   * reachable state names an image that is not loaded.
   */
  openSource(image: SourceImage): void {
    const ref = sourceRefOf(image);
    this.#source = image;
    this.#history.rewrite((document) => mutate.setSource(document, ref));
    log.info("source opened", {
      name: image.name,
      width: image.width,
      height: image.height,
      hash: image.hash,
      stack: this.#history.present.stack.length,
    });
    this.#changed();
  }

  // --- stack (F-ST-01, F-ST-02) ----------------------------------------

  addNode(effectId: string, index?: number): string {
    const result = mutate.addNode(this.document, this.#registry, effectId, index);
    const name = this.#registry.get(effectId)?.name ?? effectId;
    this.#selected = result.nodeId;
    this.#commit(result.document, `Add ${name}`);
    return result.nodeId;
  }

  removeNode(nodeId: string): void {
    const name = this.#effectNameOf(nodeId);
    const index = this.document.stack.findIndex((node) => node.id === nodeId);
    const next = mutate.removeNode(this.document, nodeId);
    // Select what took its place, or what is now last: a panel whose selection
    // vanished would show an empty properties column after a delete.
    const neighbour = next.stack[Math.min(index, next.stack.length - 1)];
    if (this.#selected === nodeId) this.#selected = neighbour?.id ?? null;
    // Deleting the solo point clears solo rather than leaving the render
    // pointed at a node that is gone, which `buildRenderGraph` refuses by name.
    if (this.#solo === nodeId) {
      log.info("solo cleared: its node was removed", { nodeId });
      this.#solo = null;
    }
    this.#commit(next, `Remove ${name}`);
  }

  duplicateNode(nodeId: string): string {
    const name = this.#effectNameOf(nodeId);
    const result = mutate.duplicateNode(this.document, nodeId);
    this.#selected = result.nodeId;
    this.#commit(result.document, `Duplicate ${name}`);
    return result.nodeId;
  }

  moveNode(nodeId: string, to: number): void {
    const next = mutate.moveNode(this.document, nodeId, to);
    if (next === this.document) return;
    this.#commit(next, `Reorder ${this.#effectNameOf(nodeId)}`);
  }

  setNodeEnabled(nodeId: string, enabled: boolean): void {
    const next = mutate.setNodeEnabled(this.document, nodeId, enabled);
    if (next === this.document) return;
    this.#commit(next, `${enabled ? "Enable" : "Disable"} ${this.#effectNameOf(nodeId)}`);
  }

  /** The node's own seed, not a `seed` parameter (F-SM-02). */
  setNodeSeed(nodeId: string, seed: number, options: CommitOptions = {}): void {
    const next = mutate.setNodeSeed(this.document, nodeId, seed);
    if (next === this.document) return;
    this.#commit(
      next,
      `${this.#effectNameOf(nodeId)}: seed`,
      options.continuous === true ? `seed:${nodeId}` : null,
    );
  }

  setNodeParam(
    nodeId: string,
    key: string,
    value: ParameterValue,
    options: CommitOptions = {},
  ): void {
    const next = mutate.setNodeParam(this.document, this.#registry, nodeId, key, value);
    this.#commit(
      next,
      `${this.#effectNameOf(nodeId)}: ${key}`,
      options.continuous === true ? `param:${nodeId}.${key}` : null,
    );
  }

  selectNode(nodeId: string | null): void {
    if (nodeId !== null) mutate.requireNode(this.document, nodeId);
    if (this.#selected === nodeId) return;
    this.#selected = nodeId;
    // Selection is not a document mutation: it is not saved, not undone, and
    // does not invalidate a single cached node.
    this.#changed();
  }

  /**
   * Set or clear the solo point (F-ST-02).
   *
   * Like selection, this is not a document mutation and not an undo step — see
   * {@link DocumentSnapshot.soloNodeId}. It does move the picture, so it bumps
   * the revision and the renderer runs; nothing is recomputed that the cache
   * already holds, because the nodes below the solo point simply stop being
   * reachable from the graph's output.
   */
  setSolo(nodeId: string | null): void {
    if (nodeId !== null) mutate.requireNode(this.document, nodeId);
    if (this.#solo === nodeId) return;
    log.info("solo set", { nodeId: nodeId ?? "none" });
    this.#solo = nodeId;
    this.#changed();
  }

  // --- palette, clock, bindings ----------------------------------------

  setPalette(palette: Palette, options: CommitOptions = {}): void {
    this.#commit(
      mutate.setPalette(this.document, palette),
      `Palette: ${palette.name}`,
      options.continuous === true ? "palette" : null,
    );
  }

  setClock(clock: Clock): void {
    this.#commit(mutate.setClock(this.document, clock), "Clock");
  }

  setBindings(bindings: readonly Binding[]): void {
    this.#commit(mutate.setBindings(this.document, bindings), "Bindings");
  }

  // --- history (F-ST-04) -----------------------------------------------

  undo(): boolean {
    const label = this.#history.undoLabel;
    if (this.#history.undo() === null) return false;
    log.info("undo", { to: label, depth: this.#history.depth });
    this.#afterHistoryMove();
    return true;
  }

  redo(): boolean {
    const label = this.#history.redoLabel;
    if (this.#history.redo() === null) return false;
    log.info("redo", { to: label, depth: this.#history.depth });
    this.#afterHistoryMove();
    return true;
  }

  /** Dismiss the restored-from-autosave notice. */
  dismissRestoreNotice(): void {
    if (this.#restored === null) return;
    log.info("restore notice dismissed");
    this.#restored = null;
    this.#changed();
  }

  /** Write any pending autosave now — for `pagehide`. */
  async flushAutosave(): Promise<void> {
    await this.#autosave?.flush();
  }

  // --- internals --------------------------------------------------------

  #effectNameOf(nodeId: string): string {
    const node = mutate.requireNode(this.document, nodeId);
    return this.#registry.get(node.effect)?.name ?? node.effect;
  }

  #commit(next: DitherDocument, label: string, coalesce: string | null = null): void {
    this.#history.commit(next, label, coalesce);
    this.#changed();
  }

  /**
   * A selection that undo has removed from the stack has to go somewhere; the
   * alternative is a properties panel bound to a node that is not there.
   */
  #afterHistoryMove(): void {
    if (
      this.#selected !== null &&
      !this.document.stack.some((node) => node.id === this.#selected)
    ) {
      this.#selected = null;
    }
    // Same for solo, and for a harder reason: a solo point that undo has taken
    // out of the stack makes every subsequent render throw from
    // `buildRenderGraph` rather than merely look wrong.
    if (this.#solo !== null && !this.document.stack.some((node) => node.id === this.#solo)) {
      log.info("solo cleared: undo removed its node", { nodeId: this.#solo });
      this.#solo = null;
    }
    this.#changed();
  }

  #changed(): void {
    this.#revision += 1;
    this.#snapshot = this.#buildSnapshot();
    this.#autosave?.schedule(this.#snapshot.document);
    for (const listener of this.#listeners) listener();
  }

  #buildSnapshot(): DocumentSnapshot {
    return {
      document: this.#history.present,
      source: this.#source,
      selectedNodeId: this.#selected,
      soloNodeId: this.#solo,
      canUndo: this.#history.canUndo,
      canRedo: this.#history.canRedo,
      undoLabel: this.#history.undoLabel,
      redoLabel: this.#history.redoLabel,
      historyDepth: this.#history.depth,
      restored: this.#restored,
      revision: this.#revision,
    };
  }
}

/**
 * The sentence the UI shows after a restore (F-DO-07).
 *
 * It names the time and the image, because a restored document with no picture
 * under it otherwise looks like an application that failed to load one — and
 * the image is genuinely not in the record: a `.dork` references its source
 * rather than embedding it.
 */
export function restoreNotice(savedAt: Date, sourceName: string | null): RestoreNotice {
  const when = savedAt.toLocaleString();
  const message =
    sourceName === null
      ? `Restored the document autosaved at ${when}.`
      : `Restored the document autosaved at ${when}. It was built on "${sourceName}" — ` +
        `open that image again to see it, as autosave stores the recipe and not the picture.`;
  return { savedAt, sourceName, message };
}
