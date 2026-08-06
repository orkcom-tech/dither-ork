import React from "react";

import type { ColorMetric, SrgbTriplet } from "../../types/document";
import { ExtractSection } from "./ExtractSection";
import { LibrarySection } from "./LibrarySection";
import { OrderSection } from "./OrderSection";
import { OutputSection } from "./OutputSection";
import { SwatchGrid } from "./SwatchGrid";
import { SwatchInspector } from "./SwatchInspector";
import type { ExtractSettings } from "./extract";
import type { OutputMode } from "./modes";
import type { SortKey } from "./order";
import { paletteStore } from "./store";
import "./palette.css";

/**
 * The palette panel — the whole of the palette system's surface.
 *
 * It holds exactly one piece of state of its own, the selected swatch, and
 * reads everything else from the store. Every control dispatches an edit and
 * re-renders from what the store came back with; nothing here keeps a copy of
 * the palette, so a document load, an undo, or Surprise Me changing the palette
 * updates this panel without it knowing any of those things exist.
 *
 * The library is read on first mount rather than at module load, so a build
 * whose WASM package is missing fails inside a panel that can say so, instead
 * of during the import that would take the whole app down with it.
 */
export function PalettePanel(): React.ReactElement {
  const snapshot = React.useSyncExternalStore(
    paletteStore.subscribe,
    paletteStore.getSnapshot,
  );
  const [selected, setSelected] = React.useState(0);

  React.useEffect(() => {
    void paletteStore.loadLibrary();
  }, []);

  const { editor } = snapshot;
  const swatches = editor.swatches;
  // The palette shrinks under the selection when a swatch is removed or an
  // extraction returns fewer colours; the selection follows rather than
  // addressing an entry that is gone.
  const index = Math.min(Math.max(selected, 0), swatches.length - 1);

  const set = (at: number, rgb: SrgbTriplet): void => {
    paletteStore.dispatch({ kind: "set", index: at, rgb });
  };
  const move = (from: number, to: number): void => {
    const change = paletteStore.dispatch({ kind: "move", from, to });
    if (change !== null) setSelected(to);
  };

  return (
    <div className="pal">
      <header className="pal__head">
        <span className="pal__name" title={`palette id: ${editor.id}`}>
          {editor.name}
        </span>
        <span className="pal__note">
          {swatches.length} · {editor.metric}
        </span>
      </header>

      {snapshot.refusal === null ? null : (
        <p className="pal__refusal" role="status">
          {snapshot.refusal}
        </p>
      )}

      <SwatchGrid
        swatches={swatches}
        selected={index}
        onSelect={setSelected}
        onMove={move}
        onToggleLock={(at, locked) => paletteStore.dispatch({ kind: "lock", index: at, locked })}
      />

      <SwatchInspector
        swatches={swatches}
        index={index}
        onSet={set}
        onLock={(at, locked) => paletteStore.dispatch({ kind: "lock", index: at, locked })}
        onMove={move}
        onAdd={(rgb: SrgbTriplet) => {
          paletteStore.dispatch({ kind: "add", rgb });
          setSelected(swatches.length);
        }}
        onRemove={(at) => paletteStore.dispatch({ kind: "remove", index: at })}
      />

      <OutputSection
        mode={editor.mode}
        metric={editor.metric}
        entries={swatches.length}
        onMode={(mode: OutputMode) => paletteStore.dispatch({ kind: "mode", mode })}
        onMetric={(metric: ColorMetric) => paletteStore.dispatch({ kind: "metric", metric })}
      />

      <ExtractSection
        swatches={swatches}
        settings={editor.extract}
        source={snapshot.source}
        running={snapshot.extracting}
        error={snapshot.extractionError}
        report={editor.report}
        onSettings={(settings: ExtractSettings) =>
          paletteStore.dispatch({ kind: "extract-settings", settings })
        }
        onExtract={() => {
          void paletteStore.extract();
        }}
      />

      <OrderSection
        swatches={swatches}
        onSort={(key: SortKey) => paletteStore.dispatch({ kind: "sort", key })}
        onRamp={(from, to, steps) => paletteStore.dispatch({ kind: "ramp", from, to, steps })}
      />

      <LibrarySection
        library={snapshot.library}
        status={snapshot.libraryStatus}
        currentId={editor.id}
        onPick={(palette) => paletteStore.dispatch({ kind: "library", palette })}
        onRetry={() => {
          void paletteStore.loadLibrary();
        }}
      />
    </div>
  );
}
