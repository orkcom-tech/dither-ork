/**
 * What export needs from the rest of the application, written down here.
 *
 * `web/src/state/` owns the document, the renderer and the session, and none of
 * it belongs to this module. So this is the interface export codes against, in
 * export's own vocabulary, and the adapter that satisfies it from an
 * `EditorSession` lives in `web/src/ui/export/session.ts` — the same
 * arrangement `ui/stack/store.ts` used while the document store was being
 * written, and for the same reason.
 *
 * ## What it assumes about the renderer, and why each assumption is safe
 *
 * **`renderFrame()` returns the picture that is on screen.** The renderer
 * always renders at the document's own resolution and always reapplies the sRGB
 * transfer on the way out (`state/render/renderer.ts`, `io/linear.ts`), so the
 * bytes export encodes are the bytes the viewport drew. docs/ARCHITECTURE.md
 * requires that preview and export share one graph and differ only in
 * resolution; here they do not even differ in that, which is the strongest form
 * of the requirement — there is one frame, so the file cannot disagree with the
 * picture.
 *
 * **A solo point is part of what is on screen.** F-ST-02 stops the render after
 * a node, and the preview shows that. Export shows it too rather than silently
 * rendering the full stack, because "what you see" is the only rule that does
 * not need explaining — and {@link ExportSubject.soloNodeName} is here so the
 * panel can say out loud that it is happening.
 *
 * **The frame may be re-rendered for the same document.** The node cache lives
 * across renders and hashes every node over its parameters, so a second render
 * of an unchanged document executes nothing and costs one readback.
 */

import type { ExportFrame } from "./types";

export interface ExportSubject {
  /** The open image's file name, for the default export name. */
  readonly name: string | null;
  /** Document resolution — the frame's size before the scale multiplier. */
  readonly width: number;
  readonly height: number;
  /**
   * The effect name of the solo point (F-ST-02), when one is set. Null when the
   * whole stack is being rendered, which is the ordinary case.
   */
  readonly soloNodeName: string | null;
  /** Increments whenever the document or its source changes. */
  readonly revision: number;
}

export interface ExportImageSource {
  /** What is open, or `null` before an image has been opened. */
  subject(): ExportSubject | null;
  /**
   * Render the current document. Rejects when no image is open, and when the
   * document is one the renderer refuses — the panel states the reason rather
   * than exporting something else.
   */
  renderFrame(signal?: AbortSignal): Promise<ExportFrame>;
  /** Notified when {@link subject} would return something different. */
  subscribe(listener: () => void): () => void;
}
