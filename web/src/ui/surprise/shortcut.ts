/**
 * The keyboard shortcut — F-SM-12, "designed to be hammered".
 *
 * # Which key, and why
 *
 * Plain `S`, with no modifier. Three reasons, in the order they decided it:
 *
 * - **Hammering has to be one key.** A chord is a two-hand gesture and the
 *   requirement is explicitly about repetition. Every unmodified letter in the
 *   application is free — the existing shortcuts are `0`, `1`, `-`, `+`, `\` and
 *   `Cmd/Ctrl+Z`.
 * - **It must not collide with the platform.** `Cmd+S` is save and `Ctrl+S` is
 *   save; taking either would either shadow the browser's or be shadowed by it,
 *   depending on the browser, which is the worst of both. Unmodified letters are
 *   the application's to spend.
 * - **Nothing is prevented that the platform owns.** `preventDefault` is called
 *   only once the key has been claimed, so a plain `S` typed anywhere the
 *   platform cares about is untouched.
 *
 * # A keystroke aimed at a text field is left alone
 *
 * The same rule `installHistoryShortcuts` follows in `app/toolbar.tsx`, and for
 * a sharper reason here: this shortcut is a bare letter, so without the check,
 * typing a hex colour into the palette editor or a number into a parameter field
 * would regenerate the entire document on every `s`. That is not a nuisance, it
 * is data loss with a shrug.
 *
 * Repeats from a held key are ignored (`event.repeat`). Holding `S` down would
 * otherwise fire at the keyboard's auto-repeat rate — thirty a second — which is
 * not hammering, it is a stuck accelerator; the engine would coalesce them, but
 * the honest behaviour is that one press is one surprise.
 */

import { logger } from "../../lib/log";

const log = logger("app");

/** The key, as `KeyboardEvent.key` lower-cased. */
export const SURPRISE_SHORTCUT_KEY = "s";

/** How the shortcut is written in a tooltip. */
export const SURPRISE_SHORTCUT_LABEL = "S";

/** Whether this event is the surprise shortcut, given where it was aimed. */
export function isSurpriseShortcut(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.repeat) return false;
  if (event.key.toLowerCase() !== SURPRISE_SHORTCUT_KEY) return false;
  return !isTextEntry(event.target);
}

/**
 * Install it on a target — the window in the application.
 *
 * Returns the uninstaller. On the window rather than on a React element because
 * the shortcut has to work wherever focus is: the stack list, the viewport, or
 * nothing at all.
 */
export function installSurpriseShortcut(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  run: () => void,
): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isSurpriseShortcut(event)) return;
    event.preventDefault();
    log.info("surprise requested", { source: "keyboard" });
    run();
  };

  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}

/**
 * Whether the keystroke was aimed at somewhere text is typed.
 *
 * Read structurally rather than with `instanceof HTMLElement`. The obvious form
 * is the one `app/toolbar.tsx` uses and it makes the predicate depend on a
 * global that does not exist outside a document — it throws a `ReferenceError`
 * in a Node process, which is where this file's tests run and where any future
 * headless check of the shortcut would run. Reading `tagName` and
 * `isContentEditable` off the target is the same question asked of the object
 * instead of of its constructor, and it is the question that actually matters:
 * only an element has a `tagName`.
 */
function isTextEntry(target: EventTarget | null): boolean {
  if (target === null || typeof target !== "object") return false;
  const element = target as { isContentEditable?: unknown; tagName?: unknown };
  if (element.isContentEditable === true) return true;
  const tag = element.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
