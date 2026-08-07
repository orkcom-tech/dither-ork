/**
 * When the help panel opens, when it stays, and when it goes — F-UI-13.
 *
 * The requirement is short and every clause of it is a state transition:
 * *dwell for about 700 ms and a panel opens*, *it must not fight the user*, *no
 * flicker moving between adjacent controls*, *dismiss on move-away and on
 * Escape*. So the timing is a reducer over events with an explicit clock, and
 * the DOM half of it (`controller.ts`) only translates pointer and focus events
 * into these and schedules one timer.
 *
 * Four decisions live here, and each one is a way of not fighting the user:
 *
 * - **Re-entering the same control does not restart the dwell.** `pointerover`
 *   bubbles, so moving across a control that has children fires it once per
 *   child. Restarting on each would mean help never opens over a node row.
 * - **While the panel is open, moving to another control switches it instantly.**
 *   Waiting again would read as a flicker; closing first would read as a worse
 *   one. This is the "adjacent controls" clause, and it is the reason the
 *   controller delegates from one listener rather than binding per control.
 * - **Leaving starts a short grace rather than closing.** Crossing the gutter
 *   between two adjacent controls leaves the first before it enters the second,
 *   and a close-then-open across that gap is exactly the flicker being avoided.
 *   The grace is also what lets the pointer travel onto the panel to read it.
 * - **Dismissing suppresses the control it dismissed.** Escape with the pointer
 *   sitting still would otherwise re-arm and reopen a moment later, which is the
 *   panel refusing to be dismissed. Suppression lifts as soon as the pointer
 *   leaves that control, so nothing is remembered longer than the gesture.
 *
 * Pure, immutable, and it returns the identical object when an event changes
 * nothing — the controller renders on state identity, and a `pointerover` per
 * descendant element must not become a render per descendant element.
 */

/** The dwell F-UI-13 asks for. */
export const DWELL_MS = 700;

/**
 * How long the panel survives the pointer leaving.
 *
 * Long enough to cross the gap between two stacked controls and to travel onto
 * the panel; short enough that moving away reads as a dismissal rather than as
 * a delay.
 */
export const CLOSE_GRACE_MS = 180;

export interface DwellTiming {
  readonly dwellMs: number;
  readonly graceMs: number;
}

export const DEFAULT_TIMING: DwellTiming = {
  dwellMs: DWELL_MS,
  graceMs: CLOSE_GRACE_MS,
};

export type DwellPhase =
  /** Nothing shown, nothing pending. */
  | "idle"
  /** A control is under the pointer or focus; the dwell is running. */
  | "arming"
  /** The panel is up. */
  | "open"
  /** The pointer has left; the grace is running. */
  | "closing";

export interface DwellState {
  readonly phase: DwellPhase;
  /** Identity of the anchor element. Null in `idle`. */
  readonly key: string | null;
  /** The anchor's `data-help` token. Null in `idle`. */
  readonly token: string | null;
  /** When the current phase began, on the caller's clock. */
  readonly since: number;
  /**
   * The anchor a dismissal was aimed at. Re-entry is ignored until the pointer
   * leaves it, so Escape and a click are not undone by the pointer standing
   * still.
   */
  readonly suppressed: string | null;
}

export const IDLE_DWELL: DwellState = {
  phase: "idle",
  key: null,
  token: null,
  since: 0,
  suppressed: null,
};

export type DwellEvent =
  /** The pointer or focus reached a control carrying help. */
  | { readonly kind: "enter"; readonly key: string; readonly token: string; readonly at: number }
  /** The pointer or focus reached something with no help on it, or left. */
  | { readonly kind: "leave"; readonly at: number }
  /** The pointer is over the panel itself; keep it up. */
  | { readonly kind: "hold"; readonly at: number }
  /** The clock reached a deadline. See {@link nextDeadline}. */
  | { readonly kind: "tick"; readonly at: number }
  /** Escape, or a press on the control. */
  | { readonly kind: "dismiss"; readonly at: number }
  /** Asked for explicitly — the help key. Opens with no dwell. */
  | { readonly kind: "reveal"; readonly key: string; readonly token: string; readonly at: number };

function opened(key: string, token: string, at: number): DwellState {
  return { phase: "open", key, token, since: at, suppressed: null };
}

export function reduceDwell(
  state: DwellState,
  event: DwellEvent,
  timing: DwellTiming = DEFAULT_TIMING,
): DwellState {
  switch (event.kind) {
    case "enter": {
      // Still suppressed: the user dismissed this very control and has not
      // moved off it yet.
      if (state.suppressed !== null && state.suppressed === event.key) return state;

      if (state.phase === "open" || state.phase === "closing") {
        // Instant switch — no dwell, no close. The no-flicker clause.
        if (state.phase === "open" && state.key === event.key && state.token === event.token) {
          return state;
        }
        return opened(event.key, event.token, event.at);
      }

      // Idle or arming. A repeat of the control already being armed keeps the
      // original start time, so bubbling from a child does not push the dwell
      // out indefinitely.
      if (state.phase === "arming" && state.key === event.key && state.token === event.token) {
        return state;
      }
      return {
        phase: "arming",
        key: event.key,
        token: event.token,
        since: event.at,
        suppressed: null,
      };
    }

    case "leave": {
      if (state.phase === "open") {
        return {
          phase: "closing",
          key: state.key,
          token: state.token,
          since: event.at,
          suppressed: null,
        };
      }
      if (state.phase === "arming") return IDLE_DWELL;
      // Closing keeps running. Idle only changes if a suppression has to lift.
      if (state.phase === "closing") {
        return state.suppressed === null
          ? state
          : { ...state, suppressed: null };
      }
      return state.suppressed === null ? state : IDLE_DWELL;
    }

    case "hold": {
      if (state.phase !== "closing") return state;
      if (state.key === null || state.token === null) return state;
      return opened(state.key, state.token, event.at);
    }

    case "tick": {
      if (state.phase === "arming" && event.at - state.since >= timing.dwellMs) {
        if (state.key === null || state.token === null) return IDLE_DWELL;
        return opened(state.key, state.token, event.at);
      }
      if (state.phase === "closing" && event.at - state.since >= timing.graceMs) {
        return IDLE_DWELL;
      }
      return state;
    }

    case "dismiss": {
      if (state.phase === "idle" && state.suppressed === null) return state;
      return { ...IDLE_DWELL, suppressed: state.key };
    }

    case "reveal":
      return opened(event.key, event.token, event.at);
  }
}

/** Whether the panel should be on screen. */
export function isHelpOpen(state: DwellState): boolean {
  return state.phase === "open" || state.phase === "closing";
}

/** The token the panel should be showing, or null. */
export function shownToken(state: DwellState): string | null {
  return isHelpOpen(state) ? state.token : null;
}

/**
 * When the next `tick` matters, or null if no clock is running.
 *
 * The controller schedules one timeout at this instant rather than polling. A
 * state with no deadline needs no timer at all, which is the common case: the
 * pointer is somewhere with no help on it.
 */
export function nextDeadline(
  state: DwellState,
  timing: DwellTiming = DEFAULT_TIMING,
): number | null {
  if (state.phase === "arming") return state.since + timing.dwellMs;
  if (state.phase === "closing") return state.since + timing.graceMs;
  return null;
}
