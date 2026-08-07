import React from "react";

import { HELP_PANEL_ID, type HelpController } from "./controller";
import { HelpPanel } from "./HelpPanel";

/**
 * The subscription between the controller and the panel.
 *
 * Kept apart from {@link installHelp} so the help layer can also be mounted
 * inside an existing React tree rather than in a root of its own — the panel is
 * `position: fixed`, so where it sits in the tree changes nothing about where it
 * draws.
 *
 * Renders nothing at all when no help is open. There is no hidden element
 * waiting to be filled: the DOM either has a panel describing something, or it
 * has no panel.
 */
export function HelpLayer({
  controller,
}: {
  readonly controller: HelpController;
}): React.ReactElement | null {
  const view = React.useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    // Server snapshot: help is a pointer affordance and there is no pointer
    // during a prerender.
    () => null,
  );

  if (view === null) return null;
  return (
    <HelpPanel
      article={view.article}
      anchor={view.anchor}
      viewport={view.viewport}
      id={HELP_PANEL_ID}
    />
  );
}
