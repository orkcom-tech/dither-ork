import React from "react";

import { logger } from "../lib/log";
import { Viewport } from "../viewport";

const log = logger("app");

/**
 * The live viewport, for anything in the React tree that needs to talk to it —
 * a properties slider declaring an interaction (F-UI-03), a toolbar action
 * zooming to fit.
 *
 * `null` until the host element has mounted, which is one render.
 */
export const ViewportContext = React.createContext<Viewport | null>(null);

export function useViewport(): Viewport | null {
  return React.useContext(ViewportContext);
}

export interface ViewportHostProps {
  readonly onViewport: (viewport: Viewport | null) => void;
}

/**
 * Mounts the non-React viewport into the React tree.
 *
 * This component renders one empty `div` and never re-renders it. Everything
 * inside belongs to the {@link Viewport}, which creates its own canvas and
 * overlay and owns them for its whole life — React never touches those nodes,
 * which is the arrangement docs/ARCHITECTURE.md describes and the reason the
 * canvas is not reconciled sixty times a second during a pan.
 */
export function ViewportHost({ onViewport }: ViewportHostProps): React.ReactElement {
  const host = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const element = host.current;
    if (element === null) {
      // The ref is attached before effects run, so this cannot happen; if it
      // ever does, it is a React version change and not a state to recover from.
      log.error("viewport host element was not attached");
      return;
    }
    const viewport = new Viewport(element);
    onViewport(viewport);
    return () => {
      onViewport(null);
      viewport.dispose();
    };
  }, [onViewport]);

  return <div className="shell__viewport-host" ref={host} />;
}
