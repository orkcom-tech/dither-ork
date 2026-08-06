import React from "react";
import { createRoot, type Root } from "react-dom/client";

import { correlationId, logger } from "../lib/log";
import { createEditorSession, type EditorSession } from "../state";
import { paletteStore } from "../ui/palette";
import { registerStackPanel } from "../ui/stack";
import { registerPropertiesPanel } from "../ui/properties";
import type { Viewport } from "../viewport";
import { App } from "./App";
import { StartupFailureScreen } from "./StartupFailureScreen";
import { UnsupportedScreen } from "./UnsupportedScreen";
import { boot } from "./boot";
import { registerPanel, registerToolbarItem } from "./slots";
import { createThemeController } from "./theme";
import { installHistoryShortcuts, registerToolbar } from "./toolbar";

/**
 * Application entry point.
 *
 * The order is the whole of it: theme, then the startup gate, then the session,
 * then the panels, and only then React. Three of the possible surfaces are
 * failures and every one of them is a real screen — a browser that cannot run
 * the app gets a page naming the requirement (F-UI-12), a build whose effect
 * catalogue does not validate gets every issue on the screen, and a device or
 * core that will not come up gets the same treatment rather than an empty
 * shell.
 *
 * The theme is applied before the gate so that even the unsupported screen is
 * the right colour; it is the only thing that runs unconditionally.
 *
 * ## Why the session is built before React renders
 *
 * The panels register themselves into the shell's slots, and a duplicate
 * registration throws — that is what stops one of two panels from being
 * silently invisible. React in development mounts every effect twice to prove
 * it is clean, so registering from inside the tree would throw on the second
 * mount. Building the session here, once, and registering against it here,
 * once, is what makes StrictMode's double mount a non-event: the only thing
 * that happens twice is the viewport, and the session takes a viewport that can
 * arrive, leave and arrive again.
 *
 * ## `web/src/main.ts` is still there
 *
 * It is the proof page — the capability check, the registry validation and an
 * end-to-end render of every effect in the catalogue with a per-effect
 * judgement of what it did to the frame. It has caught real defects that no
 * golden image can, because a golden pins what an effect does and not that what
 * it does matches its name. It is no longer an entry point of the application:
 * it is reached in development at `/proof.html`, and it is not in the
 * production build. See docs/DEVELOPMENT.md.
 */

const log = logger("app", correlationId());

const container = document.getElementById("root");
if (container === null) {
  // index.html and this file are edited together; a missing root is a build
  // that cannot start, and saying so beats an empty page.
  log.error("index.html has no #root element");
  throw new Error("main: #root is missing from the document");
}

const root: Root = createRoot(container);
const theme = createThemeController();

void start();

async function start(): Promise<void> {
  const outcome = await boot();

  if (outcome.kind === "unsupported") {
    root.render(
      <React.StrictMode>
        <UnsupportedScreen report={outcome.report} />
      </React.StrictMode>,
    );
    return;
  }

  if (outcome.kind === "registry-failed") {
    root.render(
      <React.StrictMode>
        <StartupFailureScreen issues={outcome.issues} message={outcome.message} />
      </React.StrictMode>,
    );
    return;
  }

  let session: EditorSession;
  try {
    session = await createEditorSession({
      registry: outcome.registry,
      report: outcome.report,
      palette: paletteStore,
    });
  } catch (error) {
    // The capability gate passed, so a GPU device or a WASM core that will not
    // come up now is a real failure and not a supported state. It gets the same
    // screen a bad catalogue gets, because the user's position is the same:
    // nothing can be done here and the reason has to be readable.
    const message = error instanceof Error ? error.message : String(error);
    log.error("startup halted: the editor session could not be created", { error: message });
    root.render(
      <React.StrictMode>
        <StartupFailureScreen issues={[]} message={message} />
      </React.StrictMode>,
    );
    return;
  }

  // The panels. Each registers itself into a slot; the shell imports none of
  // them. `ui/palette` registers on import, which is why it has no call here.
  registerStackPanel({ store: session.store, registry: outcome.registry });
  registerPropertiesPanel({ store: session.store, registry: outcome.registry });
  registerToolbar(session);
  installHistoryShortcuts(session);

  // Autosave is debounced, so a tab closing mid-debounce would lose the last
  // edit. `pagehide` is the event that fires for a bfcache navigation as well
  // as a close, which `beforeunload` does not.
  window.addEventListener("pagehide", () => {
    void session.store.flushAutosave();
  });

  root.render(
    <React.StrictMode>
      <App
        report={outcome.report}
        registry={outcome.registry}
        theme={theme}
        onViewport={(viewport) => {
          session.attachViewport(viewport);
          installDebugHandle(session, viewport);
        }}
      />
    </React.StrictMode>,
  );
}

/**
 * The debug handle.
 *
 * Development only, and it exists because the viewport is the one part of the
 * app with no React tree to inspect: without a handle, the only way to check
 * that a frame draws, that the split slider clips where it should or that the
 * degraded badge comes up is to have the rest of the application finished
 * first. `web/test/gpu-golden/harness.ts` reaches its own code the same way.
 *
 * It is a handle on things that already exist. Nothing here is a code path the
 * application takes.
 */
function installDebugHandle(session: EditorSession, viewport: Viewport | null): void {
  if (!import.meta.env.DEV) return;
  const globalScope = globalThis as typeof globalThis & {
    __ditherOrk?: Record<string, unknown>;
  };
  globalScope.__ditherOrk = {
    session,
    store: session.store,
    palette: paletteStore,
    viewport,
    theme,
    registerPanel,
    registerToolbarItem,
  };
  log.debug("debug handle installed on globalThis.__ditherOrk", {
    viewport: viewport !== null,
  });
}
