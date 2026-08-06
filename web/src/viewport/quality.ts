/**
 * Adaptive preview resolution — F-UI-03.
 *
 * The rule the whole file exists to enforce: **degradation is never silent.**
 * The viewport may show a frame rendered below document resolution while the
 * user is dragging something, and while it does, the badge is up and the
 * transition is logged. A preview that quietly stops being the truth is the
 * failure mode that makes people ship the wrong picture.
 *
 * Two separable facts, kept separate on purpose:
 *
 * - **What the app should render** — a function of who is currently
 *   interacting. Anything can declare an interaction: the viewport's own pan
 *   and zoom, a slider drag in the properties panel, playback.
 * - **What is currently on screen** — a property of the frame that was last
 *   handed over, not of the interaction state. The two disagree for exactly as
 *   long as a render takes, and the badge follows the frame, because the badge
 *   describes the picture.
 *
 * Pure and immutable; the timers live in `viewport.ts`.
 */

import type { Size } from "./view";

export type FrameQuality = "full" | "preview";

/**
 * Who is holding the preview down. Sources are named strings — `"pan"`,
 * `"zoom"`, `"param:blur.radius"` — because when the preview is stuck degraded
 * the only useful question is which one never ended, and a counter cannot
 * answer it.
 */
export interface InteractionState {
  readonly sources: readonly string[];
}

export const IDLE_INTERACTION: InteractionState = { sources: [] };

export function beginInteraction(
  state: InteractionState,
  source: string,
): InteractionState {
  if (state.sources.includes(source)) return state;
  return { sources: [...state.sources, source] };
}

export function endInteraction(
  state: InteractionState,
  source: string,
): InteractionState {
  if (!state.sources.includes(source)) return state;
  return { sources: state.sources.filter((s) => s !== source) };
}

export function isInteracting(state: InteractionState): boolean {
  return state.sources.length > 0;
}

export function requestedQuality(state: InteractionState): FrameQuality {
  return isInteracting(state) ? "preview" : "full";
}

/**
 * How much of the document to render during interaction.
 *
 * Two ceilings, both of which are about not doing work nobody can see:
 *
 * - **The zoom.** At 25% four source pixels share one screen pixel, so
 *   rendering at 25% loses nothing that is on screen. Above 100% this raises
 *   nothing — the factor is capped at 1, because there is no such thing as
 *   rendering a document at more than its own resolution.
 * - **A pixel budget.** The graph renders whole documents, not viewport crops,
 *   so a 60-megapixel source at 100% zoom is 60 megapixels of work for the
 *   half-megapixel the window can show. The budget bounds that, and it is the
 *   ceiling that actually bites on large images.
 *
 * There is deliberately **no floor**. A factor of 0.05 at 5% zoom is not a
 * degraded picture, it is the right picture: every source pixel that would be
 * visible is still rendered. Adding a floor would mean the budget could be
 * exceeded by a rule whose only justification is a guess about legibility.
 *
 * Returns a factor in (0, 1]. The caller multiplies the document's dimensions
 * by it, and whatever comes back is labelled `preview`, so the badge is up for
 * as long as it is on screen.
 */
export function previewScaleFactor(
  document: Size,
  zoom: number,
  budgetPixels = 2_000_000,
): number {
  const documentPixels = document.width * document.height;
  if (documentPixels <= 0) return 1;
  const zoomFactor = Math.min(1, Math.max(zoom, 1e-6));
  const budgetFactor = Math.min(1, Math.sqrt(budgetPixels / documentPixels));
  return Math.min(zoomFactor, budgetFactor);
}

/** What the badge says, or `null` when the frame on screen is the real thing. */
export interface DegradedState {
  /** Short label for the badge. */
  readonly label: string;
  /** One line naming exactly what is reduced. */
  readonly detail: string;
}

/**
 * Whether what is on screen is degraded, and how.
 *
 * `frameScale` is the rendered frame's size as a fraction of the document, so
 * 0.5 means the frame is half-resolution and is being magnified to fill the
 * same space.
 */
export function degradedState(
  quality: FrameQuality,
  frameScale: number,
): DegradedState | null {
  const reduced = frameScale < 0.999;
  if (quality === "full" && !reduced) return null;

  const percent = Math.round(frameScale * 100);
  if (reduced) {
    return {
      label: `PREVIEW ${percent}%`,
      detail: `Rendered at ${percent}% of document resolution while you interact. Release to render in full.`,
    };
  }
  return {
    label: "PREVIEW",
    detail:
      "Reduced-quality render while you interact. Release to render in full.",
  };
}
