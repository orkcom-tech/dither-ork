/**
 * What the documents panel is handed.
 *
 * ## The one thing the document store does not do yet
 *
 * Everything in this feature that *reads* the open document — save a `.dork`,
 * save the self-contained variant, save a preset, make a share link — needs
 * nothing the store does not already offer. Everything that *replaces* it —
 * open a `.dork`, apply a preset, take a shared link — needs one method that
 * does not exist:
 *
 * ```ts
 * loadDocument(document: DitherDocument, label: string): void;
 * ```
 *
 * It is declared here, on the narrow interface this panel actually depends on,
 * rather than assumed of `DocumentStore`, because `web/src/state/` belongs to
 * someone else this round. `DocumentStore` satisfies every other member of
 * {@link DocumentTarget} as it stands; adding that one method makes it satisfy
 * the whole thing and the panel wires up with a single line in `app/main.tsx`.
 *
 * What the method has to do, precisely — the panel depends on all four:
 *
 * 1. **Replace the present document as one undo step** labelled `label`. Not a
 *    history rewrite and not a clear: opening a document should be undoable, the
 *    same as every other command (F-ST-04).
 * 2. **Clear the selection and the solo point if the new stack does not contain
 *    them.** `buildRenderGraph` refuses a solo point that is not in the stack,
 *    so leaving one behind turns every later render into an error rather than
 *    into a wrong picture. The store already does exactly this after undo —
 *    `#afterHistoryMove` is the code.
 * 3. **Leave the decoded source alone.** A document names its image; whether to
 *    open one is the caller's decision, and this panel makes it — a
 *    self-contained `.dork` is unpacked through `openImageFile` immediately
 *    after, which rewrites the source reference across the history the way
 *    `openSource` already does.
 * 4. **Bump the revision.** The renderer subscribes to it and to nothing else,
 *    and the palette bridge in `session.ts` picks the new palette up through the
 *    same notification.
 *
 * ## Why the panel takes an interface rather than the store
 *
 * The same reason `ui/stack/store.ts` gives for having stopped: a panel that
 * names the four things it needs can be built, reviewed and tested before the
 * store grows them, and cannot quietly start depending on a fifth.
 */

import type { DitherDocument } from "../../types/document";
import type { EffectRegistry } from "../../registry";
import type { DocumentSnapshot } from "../../state";
import type { PresetStorage } from "../../io/document";

export type { DocumentSnapshot };

/** The part of the document store this panel uses. */
export interface DocumentTarget {
  readonly registry: EffectRegistry;
  readonly document: DitherDocument;
  /** Referentially stable until something changes — see `ui/stack/store.ts`. */
  getSnapshot(): DocumentSnapshot;
  subscribe(listener: () => void): () => void;
  /** Replace the open document as one undo step. See the note at the top. */
  loadDocument(document: DitherDocument, label: string): void;
}

export interface DocumentsDependencies {
  readonly store: DocumentTarget;
  /**
   * `session.openFile`.
   *
   * The self-contained variant's image goes back in through the ordinary
   * intake, so it gets the same sniff, the same extent ceiling (F-IN-04) and the
   * same log line every dropped file gets. A second decode path for embedded
   * images would be the one that skips the limit.
   */
  openImageFile(file: File): Promise<void>;
  /**
   * Where saved presets live, or `null` where the browser has no OPFS.
   *
   * `null` is a stated absence, not a degradation: the presets section says the
   * library needs origin-private storage and this browser has none, and saving
   * documents and making share links go on working. It is the same position
   * autosave takes in `state/session.ts` for the same missing capability.
   */
  readonly storage: PresetStorage | null;
  /**
   * The page's own URL, for building share links. Injected rather than read from
   * `location` so that the one place this panel touches the browser's address is
   * the line that registers it.
   */
  readonly href: string;
  /** The page's fragment at boot — where an incoming share link arrives. */
  readonly hash: string;
}
