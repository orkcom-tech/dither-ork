/**
 * Surprise Me — F-SM-01 through F-SM-12 — as a toolbar action, a dialog and a
 * keyboard shortcut.
 *
 * Wiring it into the application is one call, from wherever the session is
 * created:
 *
 * ```ts
 * import { registerSurpriseControls } from "./ui/surprise";
 * const surprise = registerSurpriseControls({ session, registry, palette: paletteStore });
 * ```
 *
 * The shell imports no panel and no toolbar item; each registers itself into a
 * slot (`web/src/app/slots.ts`). This is a **toolbar item** rather than a panel
 * because `PanelId` is a closed union of the four names F-UI-08 gives, and
 * Surprise Me is not one of them — see `SurpriseButton.tsx`.
 *
 * The generator itself is `web/src/surprise/`, which knows nothing about React,
 * the document store or the renderer. `engine.ts` here is the single adapter
 * between the two, and it is the whole of the coupling.
 */

import React from "react";

import { registerToolbarItem } from "../../app";
import { logger } from "../../lib/log";
import type { EffectRegistry } from "../../registry";
import type { EditorSession } from "../../state";
import type { PaletteStore } from "../palette/store";
import { SurpriseButton } from "./SurpriseButton";
import { createSurpriseEngine } from "./engine";
import { installSurpriseShortcut } from "./shortcut";
import { createSurpriseStore, type SurpriseStore } from "./store";

const log = logger("app");

export interface SurpriseControlsOptions {
  readonly session: EditorSession;
  readonly registry: EffectRegistry;
  /** The palette editor's store — `paletteStore` from `ui/palette`. */
  readonly palette: PaletteStore;
  /** Where the shortcut is installed. The application passes `window`. */
  readonly shortcutTarget?: Pick<Window, "addEventListener" | "removeEventListener">;
}

export interface SurpriseControls {
  readonly store: SurpriseStore;
  /** Removes the keyboard shortcut and the store's subscriptions. */
  dispose(): void;
}

/**
 * Register the surprise action and its shortcut.
 *
 * Call once. A second call is a duplicate slot registration and the shell
 * throws, which is what stops one of two registrations from being silently
 * invisible.
 */
export function registerSurpriseControls(
  options: SurpriseControlsOptions,
): SurpriseControls {
  const engine = createSurpriseEngine({
    session: options.session,
    registry: options.registry,
    palette: options.palette,
  });
  const store = createSurpriseStore({
    engine,
    documents: options.session.store,
    palette: options.palette,
  });

  registerToolbarItem({
    id: "surprise",
    side: "start",
    // Last of the start group: open (0), history (1), view (2), documents (3),
    // export (4), batch (5). Each is distinct rather than tied, because a tie
    // resolves by registration order, which is a fact about `main.tsx` rather
    // than a decision anyone made.
    order: 6,
    // A closure rather than a context provider: the shell's slot takes a
    // component with no props, and the session is created outside the tree.
    component: () =>
      React.createElement(SurpriseButton, { store, modulators: engine.modulators }),
  });

  const uninstall = installSurpriseShortcut(options.shortcutTarget ?? window, () =>
    store.surprise(),
  );

  log.info("surprise registered", {
    modulators: engine.modulators.renderable,
  });

  return {
    store,
    dispose(): void {
      uninstall();
      store.dispose();
    },
  };
}

export { SurpriseButton, type SurpriseButtonProps } from "./SurpriseButton";
export { SurprisePanel, type SurprisePanelProps } from "./SurprisePanel";
export {
  createSurpriseEngine,
  THUMBNAIL_MAX_SIDE,
  type StackEntry,
  type SurpriseEngine,
  type SurpriseEngineOptions,
  type SurpriseRun,
} from "./engine";
export { probeModulatorSupport, type ModulatorSupport } from "./capability";
export {
  CHAOS_STEP,
  DEFAULT_CHAOS,
  LOCK_KEYS,
  chaosLabel,
  clampChaos,
  describeStack,
  lockHint,
  lockLabel,
  lockedCount,
  readiness,
  toggleLock,
  type LockKey,
  type Readiness,
  type ReadinessInput,
} from "./model";
export {
  SURPRISE_SHORTCUT_KEY,
  SURPRISE_SHORTCUT_LABEL,
  installSurpriseShortcut,
  isSurpriseShortcut,
} from "./shortcut";
export {
  createSurpriseStore,
  type SurpriseSnapshot,
  type SurpriseStore,
  type SurpriseStoreOptions,
} from "./store";
