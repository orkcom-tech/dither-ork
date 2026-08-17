import React from "react";
import { createRoot, type Root } from "react-dom/client";

import { hasPresetStorage, opfsPresetStorage } from "../io/document";
import { correlationId, logger } from "../lib/log";
import { createEditorSession, type EditorSession } from "../state";
import { registerBatchControls } from "../ui/batch";
import { registerDocumentsToolbar } from "../ui/documents";
import { animatedSourceFor, gifCoreFor, registerExportControls } from "../ui/export";
import { registerGraphPanel } from "../ui/graph";
import { registerGuide } from "../ui/guide";
import { installHelp } from "../ui/help";
import { paletteStore } from "../ui/palette";
import { registerStackPanel } from "../ui/stack";
import { registerPropertiesPanel } from "../ui/properties";
import { registerSurpriseControls } from "../ui/surprise";
import { registerTimelinePanel, type TimelineStore } from "../ui/timeline";
import type { Viewport } from "../viewport";
import { App } from "./App";
import { StartupFailureScreen } from "./StartupFailureScreen";
import { UnsupportedScreen } from "./UnsupportedScreen";
import { boot, describeStartupError } from "./boot";
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
        <StartupFailureScreen
          failure={{ kind: "registry", issues: outcome.issues, message: outcome.message }}
        />
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
    // The capability gate passed and the catalogue validated, so a render
    // worker, GPU device or WASM core that will not come up now is a real
    // failure and not a supported state. It gets its **own** screen: this is
    // not a catalogue problem, and reporting it as one — which this did — sends
    // the reader to the wrong half of the codebase.
    //
    // The cause chain goes with it. `RenderService` hangs the browser's own
    // event on `Error.cause`, and that is where the specific fault lives.
    const described = describeStartupError(error);
    log.error("startup halted: the render engine could not be started", {
      error: described.message,
      causes: described.causes.join(" <- "),
    });
    root.render(
      <React.StrictMode>
        <StartupFailureScreen
          failure={{
            kind: "engine",
            message: described.message,
            causes: described.causes,
          }}
        />
      </React.StrictMode>,
    );
    return;
  }

  // The panels. Each registers itself into a slot; the shell imports none of
  // them. `ui/palette` registers on import, which is why it has no call here.
  registerStackPanel({ store: session.store, registry: outcome.registry });
  // The node editor, beside the stack rather than in place of it: the stack is
  // the document's list and the editor is its wiring, and only one of the two
  // can express a second image edge. Both read this same store, so selecting a
  // node in either one is the same selection and drives the same properties
  // panel. See `ui/graph/index.ts`.
  registerGraphPanel({ store: session.store, registry: outcome.registry });
  registerPropertiesPanel({ store: session.store, registry: outcome.registry });
  registerToolbar(session);
  // Documents before export, which is the order the two are reached in: you
  // save or open the recipe far more often than you write the finished file.
  // `hasPresetStorage()` decides only whether the preset *library* exists;
  // saving a `.dork` and making a share link never depend on OPFS, so a browser
  // without it loses one section of one dialog and says so there.
  registerDocumentsToolbar({
    store: session.store,
    openImageFile: (file) => session.openFile(file),
    storage: hasPresetStorage() ? opfsPresetStorage() : null,
    href: window.location.href,
    hash: window.location.hash,
  });
  // The timeline is built before export registers, because export takes it:
  // `document.bindings` carries modulators and nothing else, and a keyframe
  // track lives only in the timeline's own state, so the animated export reads
  // the plan from here rather than exporting half of a keyframed loop. Slot
  // position is decided by the `order` each registration carries, not by the
  // order of these calls, so moving this up changes nothing on screen.
  //
  // It takes the whole session rather than just the store, because unlike the
  // other three panels it draws: while a track exists the picture is a function
  // of the playhead, so it becomes the render pump and hands the viewport back
  // when the last track goes. See `ui/timeline/preview.ts`.
  const timeline = registerTimelinePanel({ session, registry: outcome.registry });
  registerExportControls({ session, timeline });
  // Batch after export: you make one picture right and then apply it to the
  // folder, which is the order the two are reached in.
  registerBatchControls({
    session,
    registry: outcome.registry,
    report: outcome.report,
    palette: paletteStore,
    timeline,
  });
  // Surprise Me last of the start group. It is the only one of the six that can
  // rewrite the whole document, so it sits at the far end rather than next to
  // the actions that only read it.
  registerSurpriseControls({
    session,
    registry: outcome.registry,
    palette: paletteStore,
  });
  // The guide (F-UI-14). Registered on the `end` side, so it is not a step in
  // the document workflow the start group spells out.
  registerGuide({ registry: outcome.registry });
  installHistoryShortcuts(session);

  // Contextual help (F-UI-13). Installed after the panels rather than before,
  // because it delegates from the document and reads the sealed registry: the
  // order only matters in that it must be after `boot()` produced a registry.
  // Its React root is its own, mounted on `document.body`, which is why it is a
  // call here and not an element in the shell — help describes controls drawn by
  // panels that mount and unmount underneath it.
  //
  // The returned uninstaller is dropped on purpose: this is the application's
  // only session, and it ends when the document does. `installHelp` returns one
  // so a test — or a second window — can take it down; nothing here can.
  installHelp({ registry: outcome.registry });

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
          installDebugHandle(session, viewport, timeline);
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
function installDebugHandle(
  session: EditorSession,
  viewport: Viewport | null,
  timeline: TimelineStore,
): void {
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
    // The timeline and the two animated-export adapters, so the animated path
    // can be exercised from the console the way the viewport already can be.
    // Built the same way `registerExportControls` builds them, over the same
    // session and the same timeline store, so what they reach is the wiring the
    // dialog uses rather than a parallel copy of it.
    timeline,
    animated: animatedSourceFor({ session, timeline }),
    gif: gifCoreFor(session),
  };
  log.debug("debug handle installed on globalThis.__ditherOrk", {
    viewport: viewport !== null,
  });
}
