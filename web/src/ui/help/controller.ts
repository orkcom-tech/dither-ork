/**
 * The DOM half of contextual help — F-UI-13.
 *
 * Everything decidable without a browser is decided elsewhere: when the panel
 * opens (`dwell.ts`), where it goes (`placement.ts`), what it says
 * (`article.ts`). This file is the translation layer, and it is deliberately the
 * only file in the directory that touches an event or an element, because it is
 * the only one that cannot be tested in this repository's node-only runner.
 *
 * ## One listener, not one per control
 *
 * Every handler here is delegated from a single root. That is what makes the
 * "no flicker between adjacent controls" clause achievable at all: with a
 * listener per control, the pointer moving from a slider to the slider under it
 * arrives as *leave, gap, enter*, and the gap is a closed panel. Delegated, the
 * same movement is one `pointerover` on the new control and the panel changes
 * its text without ever going away.
 *
 * It also means a control opts in with one attribute and nothing else — no
 * wrapper, no ref, no provider — which is what keeps this feature from having to
 * be threaded through every panel in the application.
 *
 * ## Accessibility is wired from here
 *
 * While the panel is up, the control it describes carries `aria-describedby`
 * pointing at it, and the previous value is restored on close. Doing that from
 * the controller rather than at the call site is the only way it can be correct:
 * the relationship exists only while the panel exists, and the call site does
 * not know when that is.
 *
 * ## What closes it
 *
 * Moving away, Escape, pressing the control, the window losing focus, and the
 * control leaving the document. The last is the one that is easy to forget: a
 * node row unmounts while its help is open — the picker closed, the stack was
 * reordered — and a panel describing a control that is no longer on screen is a
 * panel that lies, so an observer watches for it while the panel is up.
 */

import { logger } from "../../lib/log";
import type { EffectRegistry } from "../../registry";
import { resolveHelp, type HelpArticle } from "./article";
import {
  DEFAULT_TIMING,
  IDLE_DWELL,
  isHelpOpen,
  nextDeadline,
  reduceDwell,
  type DwellEvent,
  type DwellState,
  type DwellTiming,
} from "./dwell";
import type { Rect, Size } from "./placement";
import { HELP_ATTRIBUTE, HELP_SELECTOR, parseHelpToken } from "./target";

const log = logger("app");

/** The panel's element id, referenced by the anchor's `aria-describedby`. */
export const HELP_PANEL_ID = "dither-ork-help";

/** Class on the panel root. The controller uses it to recognise its own DOM. */
export const HELP_PANEL_CLASS = "help-panel";

/**
 * The key that opens help without waiting.
 *
 * `F1` because it is the platform's help key everywhere, needs no modifier, and
 * collides with nothing this application has taken — the existing shortcuts are
 * `0`, `1`, `-`, `+`, `\`, `S` and `Cmd/Ctrl+Z`, every one of which is also a
 * character somebody might type into a field. A keyboard user reaches a control
 * with Tab and reads it with F1 rather than by holding focus still for 700 ms,
 * which is the difference between help being keyboard-*reachable* and being
 * keyboard-*usable*.
 */
export const HELP_KEY = "F1";

/** What the panel needs in order to draw itself. */
export interface HelpView {
  readonly article: HelpArticle;
  readonly anchor: Rect;
  readonly viewport: Size;
}

export interface HelpControllerOptions {
  readonly registry: EffectRegistry;
  readonly timing?: DwellTiming;
}

export interface HelpController {
  /** `useSyncExternalStore` shape. */
  subscribe(listener: () => void): () => void;
  getSnapshot(): HelpView | null;
  /** Wire pointer, focus, keyboard and layout listeners. Returns the uninstaller. */
  attach(scope: Window): () => void;
  /** Close whatever is open, as Escape does. */
  dismiss(): void;
}

/** The element an event landed on, or its parent when it landed on a text node. */
function elementFrom(target: EventTarget | null): Element | null {
  if (target === null || typeof target !== "object") return null;
  const node = target as Node;
  if (typeof node.nodeType !== "number") return null;
  if (node.nodeType === 1) return node as Element;
  return node.parentElement;
}

function rectOf(element: Element): Rect {
  const box = element.getBoundingClientRect();
  return { x: box.left, y: box.top, width: box.width, height: box.height };
}

export function createHelpController(options: HelpControllerOptions): HelpController {
  const { registry } = options;
  const timing = options.timing ?? DEFAULT_TIMING;

  const listeners = new Set<() => void>();
  let state: DwellState = IDLE_DWELL;
  let view: HelpView | null = null;

  /** Identity per element, so the dwell machine can compare anchors as strings. */
  const keys = new WeakMap<Element, string>();
  let minted = 0;
  const keyOf = (element: Element): string => {
    const existing = keys.get(element);
    if (existing !== undefined) return existing;
    minted += 1;
    const key = `h${minted}`;
    keys.set(element, key);
    return key;
  };

  /** The element the dwell machine's `key` refers to. */
  let tracked: { readonly key: string; readonly element: Element } | null = null;
  /** Set immediately before an `enter`/`reveal` dispatch. See {@link dispatch}. */
  let pending: Element | null = null;

  let scope: Window | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let observer: MutationObserver | null = null;

  /**
   * True between `pointerdown` and `pointerup`, and help is off for the duration.
   *
   * Without it, a slider drag opens help on top of the slider being dragged. The
   * sequence is not obvious: the press dismisses whatever was up, but the
   * control then takes focus, `focusin` arms a fresh dwell, and 700 ms into a
   * drag a panel appears over the thing under the pointer. `suppressed` in the
   * dwell machine does not cover it, because that remembers the control help
   * was dismissed *from* and nothing had been shown yet.
   */
  let pressed = false;

  /** The anchor's own `aria-describedby`, restored when the panel closes. */
  let described: { readonly element: Element; readonly previous: string | null } | null =
    null;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const now = (): number => performance.now();

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const describe = (element: Element): void => {
    if (described !== null && described.element === element) return;
    undescribe();
    const previous = element.getAttribute("aria-describedby");
    described = { element, previous };
    element.setAttribute(
      "aria-describedby",
      previous === null || previous.length === 0
        ? HELP_PANEL_ID
        : `${previous} ${HELP_PANEL_ID}`,
    );
  };

  const undescribe = (): void => {
    if (described === null) return;
    const { element, previous } = described;
    described = null;
    if (previous === null) element.removeAttribute("aria-describedby");
    else element.setAttribute("aria-describedby", previous);
  };

  const unwatchAnchor = (): void => {
    if (observer === null) return;
    observer.disconnect();
    observer = null;
  };

  const watchAnchor = (): void => {
    if (scope === null || observer !== null) return;
    // Only while the panel is up. One boolean per mutation batch, and it is what
    // stops a panel outliving the control it points at.
    observer = new MutationObserver(() => {
      if (tracked !== null && !tracked.element.isConnected) {
        log.debug("contextual help closed: its control left the document");
        dispatch({ kind: "dismiss", at: now() });
      }
    });
    observer.observe(scope.document.documentElement, { childList: true, subtree: true });
  };

  /** Everything that has to stop when nothing is shown. */
  const teardownView = (): boolean => {
    const changed = view !== null;
    view = null;
    undescribe();
    unwatchAnchor();
    return changed;
  };

  const close = (): boolean => {
    state = IDLE_DWELL;
    tracked = null;
    clearTimer();
    return teardownView();
  };

  /** Rebuild `view` from the current state. Returns whether anything changed. */
  const rebuild = (): boolean => {
    if (!isHelpOpen(state) || state.token === null || tracked === null) {
      return teardownView();
    }
    if (scope === null || !tracked.element.isConnected) return close();

    const parsed = parseHelpToken(state.token);
    if (!parsed.ok) {
      // A call site pointing at nothing. Said once, with the token, because the
      // panel not opening is otherwise indistinguishable from help being off.
      log.warn("a control carries an unreadable help token", {
        token: parsed.token,
        code: parsed.code,
      });
      return close();
    }

    const lookup = resolveHelp(registry, parsed.target);
    // `resolveHelp` has already logged what is missing. Nothing is invented to
    // fill the gap; the panel simply does not open.
    if (!lookup.ok) return close();

    view = {
      article: lookup.article,
      anchor: rectOf(tracked.element),
      viewport: { width: scope.innerWidth, height: scope.innerHeight },
    };
    describe(tracked.element);
    watchAnchor();
    return true;
  };

  const dispatch = (event: DwellEvent): void => {
    const next = reduceDwell(state, event, timing);
    if (next === state) return;

    // The anchor is adopted only if the reducer actually took the key. An
    // `enter` on a suppressed control changes nothing, and pointing `tracked`
    // at it anyway would leave the open panel describing one control while
    // measuring another.
    if (
      (event.kind === "enter" || event.kind === "reveal") &&
      next.key === event.key &&
      pending !== null
    ) {
      tracked = { key: event.key, element: pending };
    }
    if (next.phase === "idle") tracked = null;

    const wasOpen = isHelpOpen(state);
    state = next;

    clearTimer();
    const deadline = nextDeadline(state, timing);
    if (deadline !== null) {
      timer = setTimeout(
        () => {
          timer = null;
          dispatch({ kind: "tick", at: now() });
        },
        Math.max(0, deadline - now()),
      );
    }

    const changed = rebuild();
    if (changed || wasOpen !== isHelpOpen(state)) notify();
  };

  const enter = (element: Element, token: string, reveal: boolean): void => {
    // A press is an interaction with the control, not a request to read about
    // it. F1 still works — asking for help explicitly is never fought.
    if (pressed && !reveal) {
      dispatch({ kind: "leave", at: now() });
      return;
    }
    pending = element;
    const key = keyOf(element);
    const at = now();
    dispatch(reveal ? { kind: "reveal", key, token, at } : { kind: "enter", key, token, at });
    pending = null;
  };

  /** The nearest ancestor carrying help, or null. */
  const anchorOf = (from: EventTarget | null): Element | null => {
    const element = elementFrom(from);
    return element === null ? null : element.closest(HELP_SELECTOR);
  };

  const inPanel = (from: EventTarget | null): boolean => {
    const element = elementFrom(from);
    return element !== null && element.closest(`.${HELP_PANEL_CLASS}`) !== null;
  };

  /** Enter the control the event landed on, or leave if there is none. */
  const towards = (from: EventTarget | null): void => {
    const anchor = anchorOf(from);
    const token = anchor === null ? null : anchor.getAttribute(HELP_ATTRIBUTE);
    if (anchor === null || token === null) {
      dispatch({ kind: "leave", at: now() });
      return;
    }
    enter(anchor, token, false);
  };

  const onPointerOver = (event: Event): void => {
    if (inPanel(event.target)) {
      dispatch({ kind: "hold", at: now() });
      return;
    }
    towards(event.target);
  };

  const onPointerOut = (event: PointerEvent): void => {
    // Only the pointer leaving the window entirely. Every other transition is
    // already described by the `pointerover` on whatever it moved onto.
    if (event.relatedTarget !== null) return;
    dispatch({ kind: "leave", at: now() });
  };

  const onPointerDown = (event: Event): void => {
    // A press inside the panel is somebody selecting the text to copy it.
    // Closing under them would be the panel fighting its own reader.
    if (inPanel(event.target)) return;
    pressed = true;
    dispatch({ kind: "dismiss", at: now() });
  };

  const onPointerUp = (): void => {
    pressed = false;
  };

  const onFocusIn = (event: Event): void => {
    if (inPanel(event.target)) return;
    towards(event.target);
  };

  const onFocusOut = (): void => {
    dispatch({ kind: "leave", at: now() });
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      if (state.phase === "idle") return;
      const wasOpen = state.phase === "open";
      dispatch({ kind: "dismiss", at: now() });
      if (wasOpen) {
        // Help takes the first Escape and nothing else sees it, so one press
        // closes the panel and a second closes whatever is behind it. A press
        // that only cancelled a pending dwell is *not* swallowed — nothing was
        // on screen, and eating it would look like the key was broken.
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (event.key !== HELP_KEY || scope === null) return;
    const focused = anchorOf(scope.document.activeElement);
    const anchor =
      focused ?? (tracked !== null && tracked.element.isConnected ? tracked.element : null);
    const token = anchor === null ? null : anchor.getAttribute(HELP_ATTRIBUTE);
    if (anchor === null || token === null) {
      log.debug("help key pressed with nothing under focus or pointer");
      return;
    }
    event.preventDefault();
    enter(anchor, token, true);
  };

  const onLayoutChange = (): void => {
    if (view === null) return;
    if (rebuild()) notify();
  };

  const onWindowBlur = (): void => {
    dispatch({ kind: "dismiss", at: now() });
  };

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot(): HelpView | null {
      return view;
    },

    dismiss(): void {
      dispatch({ kind: "dismiss", at: now() });
    },

    attach(target: Window): () => void {
      scope = target;
      const doc = target.document;

      doc.addEventListener("pointerover", onPointerOver);
      doc.addEventListener("pointerout", onPointerOut);
      doc.addEventListener("pointerdown", onPointerDown, true);
      // Capture, and on the document, so a release outside the control that was
      // pressed still ends the press. A drag that ended off the slider must not
      // leave help switched off for the rest of the session.
      doc.addEventListener("pointerup", onPointerUp, true);
      doc.addEventListener("pointercancel", onPointerUp, true);
      doc.addEventListener("focusin", onFocusIn);
      doc.addEventListener("focusout", onFocusOut);
      // Capture, so Escape reaches help before the dialog or picker the control
      // lives in gets to act on it.
      target.addEventListener("keydown", onKeyDown, true);
      target.addEventListener("resize", onLayoutChange);
      target.addEventListener("blur", onWindowBlur);
      // Capture, because a scroll inside a panel does not bubble to the window.
      target.addEventListener("scroll", onLayoutChange, true);

      log.info("contextual help installed", {
        dwellMs: timing.dwellMs,
        graceMs: timing.graceMs,
        key: HELP_KEY,
      });

      return () => {
        doc.removeEventListener("pointerover", onPointerOver);
        doc.removeEventListener("pointerout", onPointerOut);
        doc.removeEventListener("pointerdown", onPointerDown, true);
        doc.removeEventListener("pointerup", onPointerUp, true);
        doc.removeEventListener("pointercancel", onPointerUp, true);
        doc.removeEventListener("focusin", onFocusIn);
        doc.removeEventListener("focusout", onFocusOut);
        target.removeEventListener("keydown", onKeyDown, true);
        target.removeEventListener("resize", onLayoutChange);
        target.removeEventListener("blur", onWindowBlur);
        target.removeEventListener("scroll", onLayoutChange, true);
        close();
        pressed = false;
        scope = null;
        notify();
        log.info("contextual help removed");
      };
    },
  };
}
