import React from "react";

import {
  EXPORT_FORMATS,
  MAX_MIN_FEATURE_AREA,
  MAX_STROKE_WIDTH,
  MAX_TRACE_TOLERANCE,
  TRACE_MODES,
  TRACE_MODE_DETAIL,
  TRACE_MODE_LABEL,
  canvasEncoderSupport,
  chooseDestination,
  clampSettings,
  clipboardCapability,
  copyImageToClipboard,
  deliveryCapability,
  encodeExport,
  estimateExportSize,
  exportFileName,
  formatBytes,
  formatInfo,
  indexImage,
  isCancellation,
  isFullyOpaque,
  maxScaleFor,
  outputExtent,
  runExport,
  traceReportSummary,
  type ExportFrame,
  type ExportImageSource,
  type ExportProgress,
  type ExportSettings,
  type Destination,
  type FrameCensus,
  type SizeEstimate,
  type VectorTraceSettings,
  type VectorTracer,
} from "../../export";
import { logger } from "../../lib/log";
import { minFeatureFilters, traceCostWarning } from "./trace-cost";
import "./export.css";

const log = logger("export");

/**
 * The export panel — format, quality, scale, estimated size, and the button.
 *
 * ## It renders the picture once, when it opens
 *
 * The size estimate has to encode something (F-EX-14 is measured, not
 * modelled), so a frame exists from the moment the panel is on screen — and
 * that same frame is what the export button encodes. The number a person reads
 * and the file they get therefore come from one render, and cannot drift apart.
 *
 * Changing format, quality or scale does **not** re-render: none of the three
 * is an input to the graph. Only a document change is, and that arrives as a
 * new `revision` on the subject.
 *
 * ## The colour census is taken once, here
 *
 * Whether the output is indexed (F-EX-01) depends on the frame alone. Taking it
 * once when the frame arrives, and handing it to every later estimate and to
 * the export itself, is what keeps a quality slider from costing a full pass
 * over the image on every pixel of drag.
 *
 * ## Nothing here is disabled without a reason on it
 *
 * A format the browser cannot encode, a clipboard that is not available, a
 * scale the frame is too large for — each is a control that states why rather
 * than one that silently does nothing.
 */
export interface ExportPanelProps {
  readonly source: ExportImageSource;
  /** The core's SVG tracer (F-EX-08). */
  readonly tracer: VectorTracer;
  readonly settings: ExportSettings;
  readonly onSettings: (settings: ExportSettings) => void;
  /** Told when a job starts and stops, so the dialog can hold Escape. */
  readonly onRunning: (cancel: (() => void) | null) => void;
}

/**
 * The mime types worth asking a canvas about.
 *
 * SVG is excluded: it is not produced by a canvas, so `canvasEncoderSupport`
 * would report it unsupported everywhere and disable a button that works.
 */
const MIMES = EXPORT_FORMATS.filter((entry) => !entry.vector).map((entry) => entry.mime);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ExportPanel({
  source,
  tracer,
  settings,
  onSettings,
  onRunning,
}: ExportPanelProps): React.ReactElement {
  const readSubject = React.useCallback(() => source.subject(), [source]);
  const subject = React.useSyncExternalStore(source.subscribe, readSubject);

  const [frame, setFrame] = React.useState<ExportFrame | null>(null);
  const [census, setCensus] = React.useState<FrameCensus | null>(null);
  const [opaque, setOpaque] = React.useState(true);
  const [preparing, setPreparing] = React.useState(false);
  const [frameError, setFrameError] = React.useState<string | null>(null);

  const [estimate, setEstimate] = React.useState<SizeEstimate | null>(null);
  const [estimating, setEstimating] = React.useState(false);

  const [progress, setProgress] = React.useState<ExportProgress | null>(null);
  const [running, setRunning] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);

  const [supported, setSupported] = React.useState<ReadonlySet<string> | null>(null);
  const jobRef = React.useRef<AbortController | null>(null);

  const delivery = React.useMemo(() => deliveryCapability(), []);
  const clipboard = React.useMemo(() => clipboardCapability(), []);
  const info = formatInfo(settings.format);

  // --- what this browser can encode -------------------------------------

  React.useEffect(() => {
    let live = true;
    void canvasEncoderSupport(MIMES).then((set) => {
      if (live) setSupported(set);
    });
    return () => {
      live = false;
    };
  }, []);

  // --- the frame, and its census ----------------------------------------

  React.useEffect(() => {
    if (subject === null) {
      setFrame(null);
      setCensus(null);
      return;
    }
    const controller = new AbortController();
    setPreparing(true);
    setFrameError(null);

    void (async () => {
      try {
        const next = await source.renderFrame(controller.signal);
        if (controller.signal.aborted) return;
        const indexed = await indexImage(next.width, next.height, next.data, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setFrame(next);
        setCensus({ indexed });
        setOpaque(isFullyOpaque(next.data));
      } catch (error) {
        if (isCancellation(error)) return;
        log.error("the frame to export could not be produced", {
          error: messageOf(error),
        });
        setFrameError(messageOf(error));
        setFrame(null);
        setCensus(null);
      } finally {
        if (!controller.signal.aborted) setPreparing(false);
      }
    })();

    // `subject` is memoised against the store's snapshot identity, so this is
    // exactly "the document moved" and not "the panel re-rendered".
    return () => controller.abort();
  }, [source, subject]);

  // A frame that is larger than the last one can put the scale multiplier past
  // its own ceiling. The control's maximum moves, so the value follows it.
  React.useEffect(() => {
    if (subject === null) return;
    const clamped = clampSettings(settings, subject.width, subject.height);
    if (clamped !== settings) onSettings(clamped);
  }, [subject, settings, onSettings]);

  // --- the estimate (F-EX-14) -------------------------------------------

  // PNG and SVG are written here, so no canvas has an opinion about them.
  const encodable =
    settings.format === "png" ||
    info.vector ||
    supported === null ||
    supported.has(info.mime);

  // A vector export needs an indexed picture and there is no approximation of
  // one. Known before the button is pressed, so the button says so.
  const traceable = !info.vector || census === null || census.indexed !== null;

  React.useEffect(() => {
    if (frame === null || census === null || !encodable || !traceable) {
      setEstimate(null);
      return;
    }
    const controller = new AbortController();
    // Debounced, because the quality slider emits a value per pointer move and
    // each one would otherwise start an encode of a megapixel band.
    const timer = setTimeout(() => {
      setEstimating(true);
      void (async () => {
        try {
          const next = await estimateExportSize(frame, settings, {
            census,
            tracer,
            signal: controller.signal,
          });
          if (!controller.signal.aborted) setEstimate(next);
        } catch (error) {
          if (isCancellation(error)) return;
          log.warn("the size estimate failed", { error: messageOf(error) });
          if (!controller.signal.aborted) setEstimate(null);
        } finally {
          if (!controller.signal.aborted) setEstimating(false);
        }
      })();
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [frame, census, settings, encodable, traceable, tracer]);

  // --- running a job -----------------------------------------------------

  const startJob = (): AbortController => {
    const controller = new AbortController();
    jobRef.current = controller;
    setRunning(true);
    setProgress(null);
    setNotice(null);
    setFailure(null);
    onRunning(() => controller.abort());
    return controller;
  };

  const endJob = (): void => {
    jobRef.current = null;
    setRunning(false);
    setProgress(null);
    onRunning(null);
  };

  const onExport = async (): Promise<void> => {
    if (frame === null || census === null) return;
    const name = exportFileName(subject?.name ?? null, settings);

    // The picker first, inside the click's user activation — the encode outlives
    // it. See `export/destination.ts`.
    let destination: Destination | null;
    try {
      destination = await chooseDestination(name, settings.format);
    } catch (error) {
      setFailure(messageOf(error));
      return;
    }
    if (destination === null) {
      setNotice("Export cancelled: no destination was chosen.");
      return;
    }

    const controller = startJob();
    try {
      const result = await runExport({
        frame,
        settings,
        census,
        tracer,
        destination,
        signal: controller.signal,
        onProgress: setProgress,
      });
      setNotice(
        `${result.width} x ${result.height}, ${formatBytes(result.bytes)}` +
          (result.indexed ? `, indexed with ${result.paletteEntries} colours` : "") +
          (result.flattened ? ", transparency flattened onto black" : "") +
          `, in ${result.ms} ms.` +
          (result.trace === null
            ? ""
            : ` ${traceReportSummary(result.trace, result.width * result.height)}`),
      );
    } catch (error) {
      if (isCancellation(error)) {
        setNotice("Export cancelled. Nothing was written.");
      } else {
        log.error("the export failed", { error: messageOf(error) });
        setFailure(messageOf(error));
      }
    } finally {
      endJob();
    }
  };

  const onCopy = (): void => {
    if (frame === null || census === null) return;
    const controller = startJob();
    // The clipboard write has to be issued inside this click, so the encode is
    // handed over as a promise rather than awaited first.
    const encoded = encodeExport({
      frame,
      settings: { ...settings, format: "png" },
      census,
      signal: controller.signal,
      onProgress: setProgress,
    }).then((result) => result.blob);

    void copyImageToClipboard(encoded)
      .then(() => setNotice("Copied to the clipboard as a PNG."))
      .catch((error: unknown) => {
        if (isCancellation(error)) {
          setNotice("Copy cancelled.");
          return;
        }
        log.error("the copy failed", { error: messageOf(error) });
        setFailure(messageOf(error));
      })
      .finally(endJob);
  };

  // --- rendering ---------------------------------------------------------

  if (subject === null) {
    return (
      <div className="xp">
        <p className="xp__detail">
          Open an image first — there is nothing to export yet.
        </p>
      </div>
    );
  }

  const maxScale = maxScaleFor(subject.width, subject.height);
  const output = outputExtent(subject.width, subject.height, settings.scale);
  const ready = frame !== null && census !== null && !preparing;

  const setScale = (scale: number): void => {
    onSettings({ ...settings, scale: Math.max(1, Math.min(maxScale, scale)) });
  };

  const setTrace = (patch: Partial<VectorTraceSettings>): void => {
    onSettings({ ...settings, trace: { ...settings.trace, ...patch } });
  };

  // A vector export ignores the scale multiplier, so what gets traced is always
  // the subject at 1:1 — see the `scale` decision in `export/estimate.ts`. The
  // warning is computed from the settings alone rather than from a finished
  // trace, because the trace is the thing that does not finish.
  const traceCost = info.vector
    ? traceCostWarning(settings.trace, subject.width * subject.height)
    : null;

  return (
    <div className="xp">
      <div className="xp__row">
        <span className="ui-label">format</span>
        <div className="xp__group">
          {EXPORT_FORMATS.map((entry) => {
            const unavailable =
              entry.id !== "png" &&
              !entry.vector &&
              supported !== null &&
              !supported.has(entry.mime);
            return (
              <button
                key={entry.id}
                type="button"
                className="ui-button"
                aria-pressed={settings.format === entry.id}
                disabled={unavailable || running}
                title={
                  unavailable
                    ? `This browser cannot encode ${entry.mime}.`
                    : entry.detail
                }
                onClick={() => onSettings({ ...settings, format: entry.id })}
              >
                {entry.label}
              </button>
            );
          })}
        </div>
      </div>

      <p className="xp__detail">{info.detail}</p>

      {info.lossy ? (
        <div className="xp__row">
          <label className="ui-label" htmlFor="xp-quality">
            quality
          </label>
          <input
            id="xp-quality"
            className="xp__slider"
            type="range"
            min={1}
            max={100}
            step={1}
            value={settings.quality}
            disabled={running}
            onChange={(event) =>
              onSettings({ ...settings, quality: Number(event.target.value) })
            }
          />
          <span className="xp__value">{settings.quality}</span>
        </div>
      ) : null}

      {info.vector ? (
        <React.Fragment>
          {/*
            No scale control: the multiplier replicates pixels and this document
            has none. A hidden control rather than a disabled one, because there
            is nothing a person could change to make it apply — the same rule
            the stack row uses for a composite on a resampling node.
          */}
          <div className="xp__row">
            <span className="ui-label">outline</span>
            <div className="xp__group">
              {TRACE_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className="ui-button"
                  aria-pressed={settings.trace.mode === mode}
                  disabled={running}
                  title={TRACE_MODE_DETAIL[mode]}
                  onClick={() => setTrace({ mode })}
                >
                  {TRACE_MODE_LABEL[mode]}
                </button>
              ))}
            </div>
            <span className="xp__note">
              {subject.width} x {subject.height} user units, one per source pixel
            </span>
          </div>

          <p className="xp__detail">{TRACE_MODE_DETAIL[settings.trace.mode]}</p>

          {settings.trace.mode === "simplified" ? (
            <div className="xp__row">
              <label className="ui-label" htmlFor="xp-tolerance">
                tolerance
              </label>
              <input
                id="xp-tolerance"
                className="xp__slider"
                type="range"
                min={0}
                max={MAX_TRACE_TOLERANCE}
                step={0.1}
                value={settings.trace.tolerance}
                disabled={running}
                onChange={(event) => setTrace({ tolerance: Number(event.target.value) })}
              />
              <span className="xp__value">{settings.trace.tolerance.toFixed(1)} px</span>
            </div>
          ) : null}

          <div className="xp__row">
            <label className="ui-label" htmlFor="xp-min-feature">
              min. feature
            </label>
            <input
              id="xp-min-feature"
              className="xp__slider"
              type="range"
              min={0}
              max={MAX_MIN_FEATURE_AREA}
              step={1}
              value={settings.trace.minFeatureArea}
              disabled={running}
              onChange={(event) => setTrace({ minFeatureArea: Number(event.target.value) })}
            />
            <span className="xp__value">
              {/*
                1 reads as off, because it is: the core skips the filter below 2
                and a region of area 1 clears a minimum of 1 anyway. See
                `trace-cost.ts`.
              */}
              {minFeatureFilters(settings.trace.minFeatureArea)
                ? `${settings.trace.minFeatureArea} px²`
                : "off"}
            </span>
          </div>
          <p className="xp__detail">
            Regions smaller than this are removed and enclosed holes smaller than it
            are filled, before anything is traced. On a dither this is the control
            that decides whether a cutter receives a usable file or a hundred
            thousand specks — and the result line says how much of the picture it
            left bare.
          </p>

          {traceCost === null ? null : (
            <div className="xp__notice">
              <b>{traceCost.headline}</b>
              <br />
              {traceCost.mechanism}
              <ul className="xp__fixes">
                {traceCost.fixes.map((fix) => (
                  <li key={fix}>{fix}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="xp__row">
            <span className="ui-label">stroke</span>
            <div className="xp__group">
              <button
                type="button"
                className="ui-button"
                aria-pressed={settings.trace.strokeOnly}
                disabled={running}
                title="Outlines only — fill=none plus a stroke, for cutting and embroidery paths"
                onClick={() => setTrace({ strokeOnly: !settings.trace.strokeOnly })}
              >
                {settings.trace.strokeOnly ? "outlines only" : "filled"}
              </button>
            </div>
            {settings.trace.strokeOnly ? (
              <React.Fragment>
                <input
                  className="xp__slider"
                  type="range"
                  min={0.1}
                  max={MAX_STROKE_WIDTH}
                  step={0.1}
                  value={settings.trace.strokeWidth}
                  disabled={running}
                  aria-label="Stroke width"
                  onChange={(event) => setTrace({ strokeWidth: Number(event.target.value) })}
                />
                <span className="xp__value">{settings.trace.strokeWidth.toFixed(1)} px</span>
              </React.Fragment>
            ) : null}
          </div>
        </React.Fragment>
      ) : (
        <div className="xp__row">
          <span className="ui-label">scale</span>
          <div className="xp__group">
            <button
              type="button"
              className="ui-button"
              disabled={settings.scale <= 1 || running}
              title="Lower the multiplier"
              onClick={() => setScale(settings.scale - 1)}
            >
              −
            </button>
            <span className="xp__value">{settings.scale}x</span>
            <button
              type="button"
              className="ui-button"
              disabled={settings.scale >= maxScale || running}
              title={
                settings.scale >= maxScale
                  ? `${maxScale}x is the largest this frame can be exported at.`
                  : "Raise the multiplier"
              }
              onClick={() => setScale(settings.scale + 1)}
            >
              +
            </button>
          </div>
          <span className="xp__note">
            {output.width} x {output.height}, nearest-neighbour
          </span>
        </div>
      )}

      <div className="xp__readout">
        <span className="xp__size">
          {frameError !== null
            ? "—"
            : preparing
              ? "rendering…"
              : estimating || estimate === null
                ? "measuring…"
                : `${estimate.exact ? "" : "≈ "}${formatBytes(estimate.bytes)}`}
        </span>
        <span className="xp__note">
          {estimate === null
            ? "The estimate encodes the real picture, so it needs one render first."
            : estimate.exact
              ? "Exact: the whole image was encoded to measure it."
              : `Estimated from ${estimate.sampledRows} of ${estimate.totalRows} rows, ` +
                `encoded for real. Runs slightly high.`}
        </span>
        {estimate?.indexed === true ? (
          <span className="xp__note">
            {info.vector
              ? `${estimate.paletteEntries} colours in the picture, so ${estimate.paletteEntries} layers.`
              : `Indexed PNG, ${estimate.paletteEntries} colours — what the format is for.`}
          </span>
        ) : null}
      </div>

      {traceable ? null : (
        <p className="xp__notice xp__notice--error">
          This picture has more than 256 distinct colours, so there is nothing to
          trace: an SVG layer is a colour, and quantizing here would be a second
          dither the document never asked for. Put a quantizing node in the stack,
          or export PNG.
        </p>
      )}

      {subject.soloNodeName === null ? null : (
        <p className="xp__notice">
          Solo is on: the render stops after “{subject.soloNodeName}”, and the
          export is that same picture. Clear solo in the stack to export the
          whole stack.
        </p>
      )}

      {!info.alpha && !opaque ? (
        <p className="xp__notice">
          {info.vector
            ? "This picture has transparency, and an SVG layer is a fill colour with " +
              "nowhere to put per-pixel coverage. Each palette entry will be " +
              "composited onto black, in linear light, before it is traced."
            : `This picture has transparency and ${info.label} has no alpha channel. ` +
              "Transparent pixels will be composited onto black, in linear light, " +
              "before the encode."}
        </p>
      ) : null}

      {frameError === null ? null : (
        <p className="xp__notice xp__notice--error">{frameError}</p>
      )}
      {failure === null ? null : (
        <p className="xp__notice xp__notice--error">{failure}</p>
      )}
      {notice === null ? null : <p className="xp__notice xp__notice--ok">{notice}</p>}

      {running ? (
        <div className="xp__progress">
          <progress max={1} value={progress?.completed ?? 0} />
          <span className="xp__note">{progress?.detail ?? "starting"}</span>
        </div>
      ) : null}

      <div className="xp__actions">
        <button
          type="button"
          className="ui-button ui-button--primary"
          disabled={!ready || running || !encodable || !traceable}
          title={
            !encodable
              ? `This browser cannot encode ${info.mime}.`
              : !traceable
                ? "This picture has more than 256 colours and cannot be traced."
                : `Write a ${info.label} file`
          }
          onClick={() => {
            void onExport();
          }}
        >
          export
        </button>
        <button
          type="button"
          className="ui-button"
          disabled={!ready || running || !clipboard.available}
          title={clipboard.detail}
          onClick={onCopy}
        >
          copy PNG
        </button>
        <span className="xp__spacer" />
        {running ? (
          <button
            type="button"
            className="ui-button"
            title="Stop the export. Nothing is written."
            onClick={() => jobRef.current?.abort()}
          >
            cancel
          </button>
        ) : null}
      </div>

      <p className="xp__detail">{delivery.detail}</p>
    </div>
  );
}
