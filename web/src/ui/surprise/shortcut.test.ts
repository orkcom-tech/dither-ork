/**
 * The shortcut (F-SM-12).
 *
 * The tests run in a Node environment with no DOM, so the events are plain
 * objects in the shape `isSurpriseShortcut` reads. That is not a mock of
 * anything under test — it is the input, and it is the reason `isTextEntry`
 * reads `tagName` off the target rather than asking `instanceof HTMLElement`:
 * the second form throws a `ReferenceError` where there is no document, which
 * would make this shortcut the one part of the UI that could not be checked
 * without a browser.
 */

import { describe, expect, it } from "vitest";

import {
  SURPRISE_SHORTCUT_KEY,
  SURPRISE_SHORTCUT_LABEL,
  installSurpriseShortcut,
  isSurpriseShortcut,
} from "./shortcut";

function key(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: SURPRISE_SHORTCUT_KEY,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    target: null,
    preventDefault: () => undefined,
    ...overrides,
  } as KeyboardEvent;
}

/**
 * A keystroke's target, as the predicate reads it.
 *
 * `isTextEntry` asks the object for `tagName` and `isContentEditable` rather
 * than asking whether it is an `HTMLElement`, so these two fields are the whole
 * of its input. Cast through `unknown` because `EventTarget` also declares three
 * listener methods that nothing in this path touches, and giving them empty
 * bodies would be pretending they mean something.
 */
function focused(props: {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
}): EventTarget {
  return props as unknown as EventTarget;
}

describe("isSurpriseShortcut", () => {
  it("claims a bare S", () => {
    expect(isSurpriseShortcut(key())).toBe(true);
    expect(isSurpriseShortcut(key({ key: "S" }))).toBe(true);
    expect(SURPRISE_SHORTCUT_LABEL).toBe("S");
  });

  /**
   * `Cmd+S` and `Ctrl+S` are save. Taking either would either shadow the
   * browser's or be shadowed by it, depending on the browser — the worst of
   * both.
   */
  it("leaves the platform's modified forms alone", () => {
    expect(isSurpriseShortcut(key({ metaKey: true }))).toBe(false);
    expect(isSurpriseShortcut(key({ ctrlKey: true }))).toBe(false);
    expect(isSurpriseShortcut(key({ altKey: true }))).toBe(false);
  });

  it("ignores every other key", () => {
    for (const other of ["a", "z", "Enter", "0", "1", "\\", "Escape"]) {
      expect(isSurpriseShortcut(key({ key: other })), other).toBe(false);
    }
  });

  /**
   * Holding the key would otherwise fire at the keyboard's auto-repeat rate.
   * That is not hammering, it is a stuck accelerator.
   */
  it("ignores auto-repeat from a held key", () => {
    expect(isSurpriseShortcut(key({ repeat: true }))).toBe(false);
  });

  /**
   * The sharp one. This is a bare letter, so without the check, typing a hex
   * colour into the palette editor or a number into a parameter field would
   * regenerate the whole document on every `s` — not a nuisance, data loss with
   * a shrug.
   */
  it("leaves a keystroke aimed at a text field alone", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(isSurpriseShortcut(key({ target: focused({ tagName }) })), tagName).toBe(false);
    }
    expect(isSurpriseShortcut(key({ target: focused({ isContentEditable: true }) }))).toBe(
      false,
    );
  });

  it("still claims a keystroke aimed at anything else", () => {
    for (const tagName of ["DIV", "BODY", "BUTTON", "CANVAS"]) {
      expect(isSurpriseShortcut(key({ target: focused({ tagName }) })), tagName).toBe(true);
    }
  });
});

describe("installSurpriseShortcut", () => {
  /** A minimal event target, so the install/uninstall path is really exercised. */
  function target(): {
    readonly api: Pick<Window, "addEventListener" | "removeEventListener">;
    fire(event: KeyboardEvent): void;
    listeners(): number;
  } {
    const handlers = new Set<(event: KeyboardEvent) => void>();
    return {
      api: {
        addEventListener: ((_type: string, handler: unknown) => {
          handlers.add(handler as (event: KeyboardEvent) => void);
        }) as Window["addEventListener"],
        removeEventListener: ((_type: string, handler: unknown) => {
          handlers.delete(handler as (event: KeyboardEvent) => void);
        }) as Window["removeEventListener"],
      },
      fire(event: KeyboardEvent): void {
        for (const handler of handlers) handler(event);
      },
      listeners: () => handlers.size,
    };
  }

  it("runs on the key and not on anything else", () => {
    const host = target();
    let runs = 0;
    installSurpriseShortcut(host.api, () => {
      runs += 1;
    });

    host.fire(key());
    expect(runs).toBe(1);
    host.fire(key({ key: "q" }));
    expect(runs).toBe(1);
  });

  it("can be hammered", () => {
    const host = target();
    let runs = 0;
    installSurpriseShortcut(host.api, () => {
      runs += 1;
    });
    for (let i = 0; i < 40; i += 1) host.fire(key());
    expect(runs).toBe(40);
  });

  it("prevents the default only once it has claimed the key", () => {
    const host = target();
    installSurpriseShortcut(host.api, () => undefined);

    let preventedForOurs = false;
    host.fire(key({ preventDefault: () => (preventedForOurs = true) }));
    expect(preventedForOurs).toBe(true);

    let preventedForTheirs = false;
    host.fire(
      key({ key: "q", preventDefault: () => (preventedForTheirs = true) }),
    );
    expect(preventedForTheirs).toBe(false);
  });

  it("uninstalls", () => {
    const host = target();
    let runs = 0;
    const off = installSurpriseShortcut(host.api, () => {
      runs += 1;
    });
    expect(host.listeners()).toBe(1);
    off();
    expect(host.listeners()).toBe(0);
    host.fire(key());
    expect(runs).toBe(0);
  });
});
