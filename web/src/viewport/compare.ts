/**
 * Before/after comparison — F-UI-04.
 *
 * Two gestures, one state. The **split slider** parks a divider across the
 * viewport with the reference on one side and the result on the other, and it
 * stays where you put it. **Hold-to-compare** swaps the whole frame for the
 * reference for exactly as long as a key is held, which is the gesture you want
 * when the question is "did that last change help" rather than "how do these
 * two edges line up".
 *
 * They compose rather than conflict: holding while the split is up shows the
 * reference everywhere, and releasing puts the split back. That is why `holding`
 * is a separate field and not a third value of `mode`.
 *
 * Pure and immutable; the key and pointer handling lives in `viewport.ts`.
 */

export type CompareMode = "off" | "split";

export interface CompareState {
  readonly mode: CompareMode;
  /** Divider position as a fraction of the viewport width, 0..1. */
  readonly split: number;
  /** True while the hold-to-compare key is down. */
  readonly holding: boolean;
}

export const DEFAULT_COMPARE: CompareState = {
  mode: "off",
  split: 0.5,
  holding: false,
};

export function setMode(state: CompareState, mode: CompareMode): CompareState {
  if (state.mode === mode) return state;
  return { ...state, mode };
}

export function toggleSplit(state: CompareState): CompareState {
  return setMode(state, state.mode === "split" ? "off" : "split");
}

export function setSplit(state: CompareState, split: number): CompareState {
  const clamped = Number.isFinite(split) ? Math.min(1, Math.max(0, split)) : state.split;
  if (clamped === state.split) return state;
  return { ...state, split: clamped };
}

export function setHolding(state: CompareState, holding: boolean): CompareState {
  if (state.holding === holding) return state;
  return { ...state, holding };
}

/**
 * How much of the reference to draw.
 *
 * - `none` — draw the result over the whole viewport.
 * - `all` — draw the reference over the whole viewport (hold-to-compare).
 * - `left` — draw the reference left of `split` and the result right of it.
 *
 * `hasReference` is a parameter rather than an assumption: with no reference
 * frame there is nothing to compare against, and the answer is `none` no matter
 * what the state says. The UI disables both controls in that case and says why,
 * rather than letting a key press do nothing.
 */
export function comparePlan(
  state: CompareState,
  hasReference: boolean,
): { readonly reference: "none" | "all" | "left"; readonly split: number } {
  if (!hasReference) return { reference: "none", split: state.split };
  if (state.holding) return { reference: "all", split: state.split };
  if (state.mode === "split") return { reference: "left", split: state.split };
  return { reference: "none", split: state.split };
}
