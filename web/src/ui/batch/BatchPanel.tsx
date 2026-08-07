import React from "react";

import {
  DEFAULT_TEMPLATE,
  MAX_BATCH_WORKERS,
  MIN_BATCH_WORKERS,
  archiveFileName,
  batchDeliveryCapability,
  batchInputCapability,
  chooseArchiveDestination,
  chooseOutputDirectory,
  collectDroppedInputs,
  createBatchRun,
  initialItems,
  orderInputs,
  pickBatchDirectoryFiles,
  pickBatchFiles,
  pickInputDirectory,
  planBatch,
  readDirectoryHandle,
  tokenHint,
  type BatchDeliveryKind,
  type BatchInputFile,
  type BatchOutput,
  type BatchRun,
  type BatchRunState,
  type BatchSettings,
} from "../../batch";
import {
  EXPORT_FORMATS,
  MAX_SCALE_MULTIPLIER,
  formatBytes,
  formatInfo,
  isCancellation,
} from "../../export";
import { logger } from "../../lib/log";
import type { CapabilityReport } from "../../lib/capabilities";
import type { EffectRegistry } from "../../registry";
import type { EditorSession } from "../../state";
import type { PaletteStore } from "../palette";
import { frameDocument, type TimelineStore } from "../timeline";
import { QueueList } from "./QueueList";
import {
  batchDecoderFor,
  batchPaletteExtractorFor,
  poolFor,
  presetNameFor,
} from "./session";
import "./batch.css";

const log = logger("batch");

/**
 * The batch dialog — F-BA-01 through F-BA-06 on one surface.
 *
 * ## Nothing here is a control wired to nothing
 *
 * Three things could have been faked and are not. Folder input is only offered
 * where the browser can read one and says which of the two mechanisms it has.
 * Writing into a folder is only offered where the File System Access API
 * exists, and where it does not the panel *says what happens instead* rather
 * than silently producing a ZIP. Per-image palettes are only offered when the
 * palette editor's own settings permit an extraction; where they do not, the
 * button is disabled with the reason on it, because a per-image run that
 * quietly used the document palette would be indistinguishable from the feature
 * not existing.
 *
 * ## The destination is chosen inside the click
 *
 * `showDirectoryPicker` and `showSaveFilePicker` need transient user
 * activation, which expires seconds after the click; a batch outlives it by
 * minutes. So the order is click → pick → run, which is the same order and the
 * same reason as `export/destination.ts`, and the case where getting it wrong
 * fails every time rather than occasionally.
 *
 * ## The pool is built per run
 *
 * Each member holds a `GPUDevice` and a WASM core, so it exists for exactly as
 * long as the run does and is disposed in a `finally` — including when the run
 * was cancelled and when it failed.
 */
export interface BatchPanelProps {
  readonly session: EditorSession;
  readonly registry: EffectRegistry;
  readonly report: CapabilityReport;
  readonly palette: PaletteStore;
  /**
   * The timeline, because the recipe a batch applies is one *frame* of the
   * document and the playhead is what says which. See `frameDocument`.
   */
  readonly timeline: TimelineStore;
  readonly settings: BatchSettings;
  readonly onSettings: (settings: BatchSettings) => void;
  /**
   * The queue, held by the dialog rather than here.
   *
   * Somebody who queued two hundred files, closed the dialog to look at their
   * stack and came back must not have to queue them again — and this component
   * is unmounted while the dialog is shut, so the list cannot live in it.
   */
  readonly inputs: readonly BatchInputFile[];
  readonly onInputs: (
    next: (current: readonly BatchInputFile[]) => readonly BatchInputFile[],
  ) => void;
  /** Told when a run starts and stops, so the dialog can hold Escape. */
  readonly onRunning: (cancel: (() => void) | null) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function BatchPanel({
  session,
  registry,
  report,
  palette,
  timeline,
  settings,
  onSettings,
  inputs,
  onInputs,
  onRunning,
}: BatchPanelProps): React.ReactElement {
  const [delivery, setDelivery] = React.useState<BatchDeliveryKind | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [collecting, setCollecting] = React.useState(false);

  const [run, setRun] = React.useState<BatchRun | null>(null);
  const [runState, setRunState] = React.useState<BatchRunState | null>(null);

  const input = React.useMemo(() => batchInputCapability(), []);
  const output = React.useMemo(() => batchDeliveryCapability(), []);

  // The palette editor's settings decide whether per-image extraction can run
  // at all, and they can change while this dialog is open.
  const paletteSnapshot = React.useSyncExternalStore(palette.subscribe, palette.getSnapshot);
  const extractor = React.useMemo(
    () => batchPaletteExtractorFor(palette),
    // Rebuilt whenever the editor's state moves, because the extractor closes
    // over the locked swatches and the extraction settings as they are now.
    [palette, paletteSnapshot],
  );

  const documentSnapshot = React.useSyncExternalStore(
    session.store.subscribe,
    session.store.getSnapshot,
  );
  const presetName = presetNameFor(session, registry);

  const chosenDelivery: BatchDeliveryKind = delivery ?? output.preferred;
  const running = run !== null;
  const info = formatInfo(settings.export.format);

  const plan = React.useMemo(
    () =>
      planBatch({
        items: inputs,
        settings,
        presetName,
        hasExtractor: extractor !== null,
        stackSize: documentSnapshot.document.stack.length,
        delivery: chosenDelivery,
      }),
    [inputs, settings, presetName, extractor, documentSnapshot, chosenDelivery],
  );

  const items = runState?.items ?? initialItems(inputs);

  // --- gathering inputs ---------------------------------------------------

  const addFiles = (found: readonly BatchInputFile[], how: string): void => {
    if (found.length === 0) {
      setNotice(`No images were ${how}.`);
      return;
    }
    setFailure(null);
    onInputs((current) => {
      // Two selections of the same file are two entries with two ids and would
      // fight over one output name, so a repeat of a path already queued is
      // dropped and said rather than silently duplicated.
      const paths = new Set(current.map((file) => file.path));
      const fresh = found.filter((file) => !paths.has(file.path));
      const skipped = found.length - fresh.length;
      setNotice(
        `${fresh.length} image${fresh.length === 1 ? "" : "s"} ${how}` +
          (skipped > 0 ? `; ${skipped} already queued` : "") + ".",
      );
      return orderInputs([...current, ...fresh]);
    });
  };

  const guard = async (what: string, run_: () => Promise<void>): Promise<void> => {
    setCollecting(true);
    try {
      await run_();
    } catch (error) {
      if (isCancellation(error)) return;
      log.error(`${what} failed`, { error: messageOf(error) });
      setFailure(messageOf(error));
    } finally {
      setCollecting(false);
    }
  };

  const onAddFiles = (): void =>
    void guard("adding files", async () => {
      addFiles(await pickBatchFiles(), "added");
    });

  const onAddFolderInput = (): void =>
    void guard("adding a folder", async () => {
      addFiles(await pickBatchDirectoryFiles(), "added from the folder");
    });

  const onAddDirectoryHandle = (): void =>
    void guard("reading a folder", async () => {
      const handle = await pickInputDirectory();
      if (handle === null) {
        setNotice("No folder was chosen.");
        return;
      }
      addFiles(await readDirectoryHandle(handle), `read from “${handle.name}”`);
    });

  const onDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    // The session installs an image drop on the window that opens the first
    // file dropped anywhere. Stopping propagation here is what keeps a drop
    // meant for the batch from also replacing the open document.
    event.stopPropagation();
    setDragging(false);
    const data = event.dataTransfer;
    void guard("reading the drop", async () => {
      const dropped = await collectDroppedInputs(data);
      if (dropped.refusal !== null) {
        setNotice(dropped.refusal);
        return;
      }
      addFiles(dropped.files, dropped.hadFolder ? "found in the folder" : "dropped");
    });
  };

  // --- running ------------------------------------------------------------

  const onRun = async (): Promise<void> => {
    if (plan.refusals.length > 0 || running) return;
    setNotice(null);
    setFailure(null);

    // Inside the click, before anything long. See the note at the top.
    let target: BatchOutput | null = null;
    try {
      if (chosenDelivery === "directory") {
        const handle = await chooseOutputDirectory();
        if (handle === null) {
          setNotice("Batch cancelled: no output folder was chosen.");
          return;
        }
        target = { kind: "directory", handle, name: handle.name };
      } else {
        const name = archiveFileName(presetName);
        const destination = await chooseArchiveDestination(name);
        if (destination === null) {
          setNotice("Batch cancelled: no destination was chosen.");
          return;
        }
        target = { kind: "zip", destination, name };
      }
    } catch (error) {
      setFailure(messageOf(error));
      return;
    }

    let pool = null;
    try {
      pool = await poolFor(report, settings.workers, inputs.length);
    } catch (error) {
      log.error("the batch pool would not start", { error: messageOf(error) });
      setFailure(
        `The batch workers could not be started: ${messageOf(error)}. ` +
          `Try one worker instead of ${settings.workers}.`,
      );
      return;
    }

    const started = createBatchRun({
      items: inputs,
      // The frame at the playhead when the document is animated — a batch is one
      // recipe over many images, and the recipe is the picture on screen. It is
      // also what makes an animated document batchable at all: once tracks are
      // written back to `document.bindings`, `buildRenderGraph` refuses the raw
      // document, so passing it here would fail every item in the queue with a
      // message addressed to a programmer.
      document: frameDocument(timeline, session.store.getSnapshot().document),
      presetName,
      settings,
      output: target,
      pool,
      decode: batchDecoderFor(session),
      extractor: settings.palette === "per-image" ? extractor : null,
      // The one clock read in the whole pipeline, here, where it can be
      // justified: it is the modification time stamped into every ZIP entry.
      modifiedAt: new Date(),
    });

    const off = started.subscribe(() => setRunState(started.getSnapshot()));
    setRun(started);
    setRunState(started.getSnapshot());
    onRunning(() => started.cancel());

    try {
      const final = await started.start();
      const summary = final.summary;
      if (summary !== null) {
        setNotice(
          `${summary.done} of ${summary.total} written, ${formatBytes(summary.outputBytes)}, ` +
            `${summary.delivery}, in ${(summary.ms / 1000).toFixed(1)} s.` +
            (summary.failed > 0 ? ` ${summary.failed} failed — see the queue.` : "") +
            (summary.cancelled > 0 ? ` ${summary.cancelled} were not run.` : ""),
        );
      }
      if (final.failure !== null) setFailure(final.failure);
    } finally {
      off();
      setRun(null);
      onRunning(null);
      // Each member holds a device and a core. Disposed on every path.
      await pool.dispose();
    }
  };

  // --- rendering ----------------------------------------------------------

  const setExport = (patch: Partial<BatchSettings["export"]>): void => {
    onSettings({ ...settings, export: { ...settings.export, ...patch } });
  };

  const scaleCeiling = info.vector ? 1 : MAX_SCALE_MULTIPLIER;

  return (
    <div
      className={`bx${dragging ? " bx--dragging" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setDragging(true);
      }}
      onDragOver={(event) => {
        // Cancelling this is what makes the drop happen at all.
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        event.stopPropagation();
        setDragging(false);
      }}
      onDrop={onDrop}
    >
      <p className="bx__detail">{input.detail}</p>

      {/* --- images ------------------------------------------------------ */}

      <div className="bx__row-controls">
        <span className="ui-label">images</span>
        <div className="bx__group">
          <button
            type="button"
            className="ui-button"
            disabled={running || collecting}
            title="Choose one or more image files"
            onClick={onAddFiles}
          >
            add files
          </button>
          <button
            type="button"
            className="ui-button"
            disabled={running || collecting}
            title="Choose a folder and queue every image in it"
            onClick={onAddFolderInput}
          >
            add folder
          </button>
          {input.directoryHandle ? (
            <button
              type="button"
              className="ui-button"
              disabled={running || collecting}
              title="Open a folder through the File System Access API"
              onClick={onAddDirectoryHandle}
            >
              open folder…
            </button>
          ) : null}
          <button
            type="button"
            className="ui-button"
            disabled={running || inputs.length === 0}
            title="Empty the queue"
            onClick={() => {
              onInputs(() => []);
              setRunState(null);
              setNotice(null);
            }}
          >
            clear
          </button>
        </div>
        <span className="bx__note">
          {inputs.length === 0
            ? input.droppedFolders
              ? "or drop images or a folder here"
              : "or drop images here — this browser cannot read a dropped folder"
            : `${inputs.length} queued`}
        </span>
      </div>

      {/* --- output ------------------------------------------------------ */}

      <div className="bx__row-controls">
        <span className="ui-label">format</span>
        <div className="bx__group">
          {EXPORT_FORMATS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="ui-button"
              aria-pressed={settings.export.format === entry.id}
              disabled={running}
              title={entry.detail}
              onClick={() => setExport({ format: entry.id })}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {info.lossy ? (
        <div className="bx__row-controls">
          <label className="ui-label" htmlFor="bx-quality">
            quality
          </label>
          <input
            id="bx-quality"
            className="bx__slider"
            type="range"
            min={1}
            max={100}
            step={1}
            value={settings.export.quality}
            disabled={running}
            onChange={(event) => setExport({ quality: Number(event.target.value) })}
          />
          <span className="bx__value">{settings.export.quality}</span>
        </div>
      ) : null}

      {info.vector ? (
        <p className="bx__detail">
          SVG is traced from each finished picture, so every input needs 256
          colours or fewer once the stack has run. An image with more is refused
          as one item, with the reason on its row, and the rest of the run
          continues.
        </p>
      ) : (
        <div className="bx__row-controls">
          <span className="ui-label">scale</span>
          <div className="bx__group">
            <button
              type="button"
              className="ui-button"
              disabled={settings.export.scale <= 1 || running}
              title="Lower the multiplier"
              onClick={() => setExport({ scale: settings.export.scale - 1 })}
            >
              −
            </button>
            <span className="bx__value">{settings.export.scale}x</span>
            <button
              type="button"
              className="ui-button"
              disabled={settings.export.scale >= scaleCeiling || running}
              title="Raise the multiplier"
              onClick={() => setExport({ scale: settings.export.scale + 1 })}
            >
              +
            </button>
          </div>
          <span className="bx__note">
            nearest-neighbour, applied to every image. An image too large to
            allocate at this multiplier fails on its own row and names the
            multiplier that would work.
          </span>
        </div>
      )}

      {/* --- palette (F-BA-04) ------------------------------------------- */}

      <div className="bx__row-controls">
        <span className="ui-label">palette</span>
        <div className="bx__group">
          <button
            type="button"
            className="ui-button"
            aria-pressed={settings.palette === "document"}
            disabled={running}
            title="Quantize every image against the palette this document carries"
            onClick={() => onSettings({ ...settings, palette: "document" })}
          >
            document
          </button>
          <button
            type="button"
            className="ui-button"
            aria-pressed={settings.palette === "per-image"}
            disabled={running || extractor === null}
            title={
              extractor === null
                ? "Extraction cannot run: at least k swatches are locked in the palette panel. Unlock some, or raise k."
                : extractor.detail
            }
            onClick={() => onSettings({ ...settings, palette: "per-image" })}
          >
            per image
          </button>
        </div>
        <span className="bx__note">
          {settings.palette === "document"
            ? `every output uses “${documentSnapshot.document.palette.name}”, ${
                documentSnapshot.document.palette.colors.length / 3
              } colours`
            : (extractor?.detail ?? "")}
        </span>
      </div>

      {/* --- names (F-BA-05) --------------------------------------------- */}

      <div className="bx__row-controls">
        <label className="ui-label" htmlFor="bx-template">
          names
        </label>
        <input
          id="bx-template"
          className="bx__text"
          type="text"
          value={settings.template}
          disabled={running}
          spellCheck={false}
          onChange={(event) => onSettings({ ...settings, template: event.target.value })}
        />
        <button
          type="button"
          className="ui-button"
          disabled={running || settings.template === DEFAULT_TEMPLATE}
          title="Back to {name}-dither"
          onClick={() => onSettings({ ...settings, template: DEFAULT_TEMPLATE })}
        >
          reset
        </button>
      </div>
      <p className="bx__detail">
        Tokens: {tokenHint()}. The extension comes from the format. The default
        carries <code>-dither</code> on purpose — a batch written back into the
        folder it read would otherwise overwrite the originals.
      </p>
      {/*
        The names the run will actually produce, for the two ends of the queue.
        Shown only when there are names to show: `plan.names` is an empty array
        for an empty queue, and "first: —" is a control reporting on nothing.
      */}
      {plan.names === null || plan.names.length === 0 ? null : (
        <p className="bx__note bx__preview">
          first: {plan.names[0]}
          {plan.names.length > 1 ? ` · last: ${plan.names[plan.names.length - 1] ?? ""}` : ""}
        </p>
      )}

      {/* --- workers ------------------------------------------------------ */}

      <div className="bx__row-controls">
        <span className="ui-label">workers</span>
        <div className="bx__group">
          <button
            type="button"
            className="ui-button"
            disabled={settings.workers <= MIN_BATCH_WORKERS || running}
            title="Fewer parallel renderers"
            onClick={() => onSettings({ ...settings, workers: settings.workers - 1 })}
          >
            −
          </button>
          <span className="bx__value">{settings.workers}</span>
          <button
            type="button"
            className="ui-button"
            disabled={settings.workers >= MAX_BATCH_WORKERS || running}
            title="More parallel renderers"
            onClick={() => onSettings({ ...settings, workers: settings.workers + 1 })}
          >
            +
          </button>
        </div>
        <span className="bx__note">
          each holds its own GPU device and core, brought up when the run starts
        </span>
      </div>

      {/* --- destination (F-BA-03) ---------------------------------------- */}

      <div className="bx__row-controls">
        <span className="ui-label">output</span>
        <div className="bx__group">
          <button
            type="button"
            className="ui-button"
            aria-pressed={chosenDelivery === "directory"}
            disabled={running || !output.directory}
            title={
              output.directory
                ? "Write each file into a folder you choose, as it finishes"
                : "This browser has no File System Access API, so a batch cannot write into a folder."
            }
            onClick={() => setDelivery("directory")}
          >
            into a folder
          </button>
          <button
            type="button"
            className="ui-button"
            aria-pressed={chosenDelivery === "zip"}
            disabled={running}
            title="Collect everything into one archive, written when the run finishes"
            onClick={() => setDelivery("zip")}
          >
            one ZIP
          </button>
        </div>
      </div>
      <p className="bx__detail">{output.detail}</p>

      {/* --- verdicts ----------------------------------------------------- */}

      {plan.refusals.map((reason) => (
        <p key={reason} className="bx__notice bx__notice--error">
          {reason}
        </p>
      ))}
      {plan.warnings.map((reason) => (
        <p key={reason} className="bx__notice bx__notice--warn">
          {reason}
        </p>
      ))}
      {failure === null ? null : (
        <p className="bx__notice bx__notice--error">{failure}</p>
      )}
      {notice === null ? null : <p className="bx__notice bx__notice--ok">{notice}</p>}

      {/* --- the run ------------------------------------------------------ */}

      {runState === null ? null : (
        <div className="bx__progress">
          <progress max={1} value={runState.completed} />
          <span className="bx__note">{runState.detail}</span>
        </div>
      )}

      <div className="bx__actions">
        <button
          type="button"
          className="ui-button ui-button--primary"
          disabled={running || collecting || plan.refusals.length > 0}
          title={
            plan.refusals[0] ??
            `Apply this document's stack to ${inputs.length} image${
              inputs.length === 1 ? "" : "s"
            }`
          }
          onClick={() => {
            void onRun();
          }}
        >
          run
        </button>
        <span className="bx__spacer" />
        {running ? (
          <button
            type="button"
            className="ui-button"
            title="Stop the run. Files already written are kept."
            onClick={() => run?.cancel()}
          >
            cancel
          </button>
        ) : null}
      </div>

      <QueueList
        items={items}
        {...(running
          ? {}
          : {
              onRemove: (id: string) => {
                onInputs((current) => current.filter((file) => file.id !== id));
                setRunState(null);
              },
            })}
      />
    </div>
  );
}
