import React from "react";

import {
  ANIMATED_FORMATS,
  LoopSeamError,
  MAX_ANIMATED_SCALE,
  MAX_SHEET_COLUMNS,
  animatedFileName,
  animatedFormatInfo,
  gifDelayFor,
  gifPlaybackFps,
  isCancellation,
  runAnimatedExport,
  videoEncodingAvailable,
  type AnimatedFrameSource,
  type AnimatedProgress,
  type AnimatedSettings,
  type AnimatedSubject,
  type GifCore,
} from "../../export/animated";
import { chooseDestinationForType, formatBytes } from "../../export";
import type { SeamIssue, SeamReport } from "../../animation";
import { logger } from "../../lib/log";
import "./export.css";

const log = logger("export");

/**
 * The animated half of the export dialog — F-EX-04, F-EX-05, F-EX-06, F-AN-06.
 *
 * ## The loop is checked before the format list is usable
 *
 * F-AN-06 says an export must not write a loop that does not close, and this is
 * where the person finds out. The check runs when the panel opens and again
 * whenever the document or the tracks move; it costs two graph preparations and
 * no rendering at all, so it is cheap enough to be automatic and there is no
 * reason to make somebody press a button for it.
 *
 * An **error** disables the export button and says which binding caused it, by
 * name. A **warning** does not: a modulator sampled below Nyquist, a binding the
 * clamp flattens, a temporal hold that does not divide the frame count — each of
 * those is a loop that closes and looks like something a person may well have
 * chosen. They are shown beside the button and carried into the result notes.
 *
 * ## There is no size estimate here, and that is deliberate
 *
 * The still panel measures one frame through the real encoder, which costs one
 * render. The animated equivalent is `estimateAnimatedSize`, which costs three
 * real renders through the real encoder every time a control moves — on a large
 * document that is seconds of work for a number that is a sample rather than the
 * answer. Rather than run it automatically and make the panel feel broken, or
 * model a size (LZW over a dither has no formula — `dither-core/src/encode.rs`
 * says so at length), the panel states the frame count and the extent and lets
 * the export report the measured size when it is done.
 */
export interface AnimatedExportPanelProps {
  readonly source: AnimatedFrameSource;
  /** The render worker's GIF encoder. Only the GIF format reads it. */
  readonly gif: GifCore;
  readonly settings: AnimatedSettings;
  readonly onSettings: (settings: AnimatedSettings) => void;
  /** Called with a cancel while a job runs, and `null` when it stops. */
  readonly onRunning: (cancel: (() => void) | null) => void;
  /**
   * Why there is nothing to export, or `null` when there is.
   *
   * A function rather than a string, read during render: the component already
   * subscribes to the stores this reads, through `source.subscribe`. It exists
   * because `subject()` returns `null` for three different situations and
   * telling somebody "there is nothing to animate" when the truth is "your
   * binding has a fractional cycle count" sends them to the wrong control.
   */
  readonly blockReason: () => string | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The largest whole multiplier that keeps a frame under the pixel ceiling. */
function maxScaleFor(width: number, height: number): number {
  let scale = 1;
  while (scale < MAX_ANIMATED_SCALE) {
    const next = scale + 1;
    if (width * next * height * next > 33_554_432) break;
    scale = next;
  }
  return scale;
}

export function AnimatedExportPanel({
  source,
  gif,
  settings,
  onSettings,
  onRunning,
  blockReason,
}: AnimatedExportPanelProps): React.ReactElement {
  const subject = React.useSyncExternalStore(source.subscribe, () => source.subject());

  const [seam, setSeam] = React.useState<SeamReport | null>(null);
  const [seamError, setSeamError] = React.useState<string | null>(null);
  const [checking, setChecking] = React.useState(false);

  const [progress, setProgress] = React.useState<AnimatedProgress | null>(null);
  const [running, setRunning] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [notes, setNotes] = React.useState<readonly string[]>([]);

  const jobRef = React.useRef<AbortController | null>(null);
  const revision = subject?.revision ?? -1;

  React.useEffect(() => {
    return () => {
      jobRef.current?.abort();
    };
  }, []);

  // The seam check. Re-run whenever what would be exported changes; the
  // controller is the cancel path, and React's cleanup is what fires it.
  React.useEffect(() => {
    if (subject === null) {
      setSeam(null);
      setSeamError(null);
      return;
    }
    const controller = new AbortController();
    setChecking(true);
    source
      .validateLoop(controller.signal)
      .then((report) => {
        if (controller.signal.aborted) return;
        setSeam(report);
        setSeamError(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // Not swallowed and not shown as "ok": a loop that could not be checked
        // is not a loop that closes, and the export button stays off.
        setSeam(null);
        setSeamError(messageOf(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => controller.abort();
  }, [source, revision, subject === null]);

  const startJob = (): AbortController => {
    const controller = new AbortController();
    jobRef.current = controller;
    setRunning(true);
    setProgress(null);
    setNotice(null);
    setFailure(null);
    setNotes([]);
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
    if (subject === null) return;
    const info = animatedFormatInfo(settings.format);
    const name = animatedFileName(subject.name, settings, subject.frames);

    // The picker first, inside the click's user activation — an animated encode
    // outlives it by a long way. See `export/destination.ts`.
    let destination;
    try {
      destination = await chooseDestinationForType(name, {
        label: info.label,
        mime: info.mime,
        extension: info.extension,
      });
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
      const result = await runAnimatedExport({
        source,
        settings,
        destination,
        gif,
        signal: controller.signal,
        onProgress: setProgress,
      });
      setNotes(result.notes);
      setNotice(
        `${result.frames} frames, ${result.width} x ${result.height}, ` +
          `${formatBytes(result.bytes)}` +
          (result.indexed ? `, indexed with ${result.paletteEntries} colours` : "") +
          `, plays at ${result.playbackFps.toFixed(2)} fps, in ${result.ms} ms.`,
      );
    } catch (error) {
      if (isCancellation(error)) {
        setNotice("Export cancelled. Nothing was written.");
      } else if (error instanceof LoopSeamError) {
        // The check the panel already ran, run again inside the job and lost
        // this time. Both the message and the report are shown.
        setSeam(error.report);
        setFailure(error.message);
      } else {
        log.error("the animated export failed", { error: messageOf(error) });
        setFailure(messageOf(error));
      }
    } finally {
      endJob();
    }
  };

  // --- rendering ---------------------------------------------------------

  if (subject === null) {
    const reason = blockReason();
    return (
      <div className="xp">
        <p className={reason !== null && reason.startsWith("This document") ? "xp__error" : "xp__detail"}>
          {reason ??
            "There is nothing to export yet."}
        </p>
      </div>
    );
  }

  const info = animatedFormatInfo(settings.format);
  const maxScale = maxScaleFor(subject.width, subject.height);
  const width = subject.width * settings.scale;
  const height = subject.height * settings.scale;

  const errors = seam?.issues.filter((issue) => issue.severity === "error") ?? [];
  const warnings = seam?.issues.filter((issue) => issue.severity === "warning") ?? [];
  const blocked = seamError !== null || errors.length > 0 || seam === null;
  const videoUnavailable =
    (settings.format === "webm" || settings.format === "mp4") && !videoEncodingAvailable();

  const gifDelay = gifDelayFor(subject.fps);

  return (
    <div className="xp">
      <p className="xp__detail">
        {subject.frames} frames at {subject.fps} fps — {(subject.frames / subject.fps).toFixed(2)}s
        a loop. Output {width} x {height}.
        {subject.soloNodeName === null
          ? ""
          : ` Soloed at ${subject.soloNodeName}, so that is what is written.`}
      </p>

      <div className="xp__row">
        <span className="ui-label">format</span>
        <div className="xp__group">
          {ANIMATED_FORMATS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="ui-button"
              aria-pressed={settings.format === entry.id}
              disabled={running}
              title={entry.detail}
              onClick={() => onSettings({ ...settings, format: entry.id })}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      <p className="xp__detail">{info.detail}</p>

      {videoUnavailable ? (
        <p className="xp__warn">
          This browser has no WebCodecs `VideoEncoder`, so it cannot write a video
          file. Choose GIF, APNG, WebP or a PNG sequence.
        </p>
      ) : null}

      {settings.format === "gif" && Math.abs(gifPlaybackFps(gifDelay) - subject.fps) > 0.1 ? (
        <p className="xp__warn">
          GIF stores a frame delay as a whole number of hundredths of a second, so
          {" "}
          {subject.fps} fps cannot be written. This file will play at{" "}
          {gifPlaybackFps(gifDelay).toFixed(2)} fps.
        </p>
      ) : null}

      <div className="xp__row">
        <label className="ui-label" htmlFor="axp-scale">
          scale
        </label>
        <input
          id="axp-scale"
          className="xp__slider"
          type="range"
          min={1}
          max={maxScale}
          step={1}
          value={Math.min(settings.scale, maxScale)}
          disabled={running}
          onChange={(event) =>
            onSettings({ ...settings, scale: Number(event.target.value) })
          }
        />
        <span className="xp__value">{settings.scale}x</span>
      </div>

      {info.lossy ? (
        <div className="xp__row">
          <label className="ui-label" htmlFor="axp-quality">
            quality
          </label>
          <input
            id="axp-quality"
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

      {info.id === "sprite-sheet" ? (
        <div className="xp__row">
          <label className="ui-label" htmlFor="axp-columns">
            columns
          </label>
          <input
            id="axp-columns"
            className="xp__slider"
            type="range"
            min={1}
            max={Math.min(MAX_SHEET_COLUMNS, subject.frames)}
            step={1}
            value={settings.columns}
            disabled={running}
            onChange={(event) =>
              onSettings({ ...settings, columns: Number(event.target.value) })
            }
          />
          <span className="xp__value">{settings.columns}</span>
        </div>
      ) : null}

      {info.loops ? (
        <div className="xp__row">
          <span className="ui-label">repeat</span>
          <div className="xp__group">
            <button
              type="button"
              className="ui-button"
              aria-pressed={settings.loop}
              disabled={running}
              onClick={() => onSettings({ ...settings, loop: true })}
            >
              forever
            </button>
            <button
              type="button"
              className="ui-button"
              aria-pressed={!settings.loop}
              disabled={running}
              onClick={() => onSettings({ ...settings, loop: false })}
            >
              once
            </button>
          </div>
        </div>
      ) : null}

      <div className="xp__panel">
        {checking ? (
          <p className="xp__detail">checking that the loop closes…</p>
        ) : seamError !== null ? (
          <p className="xp__error">The loop could not be checked: {seamError}</p>
        ) : errors.length > 0 ? (
          <React.Fragment>
            <p className="xp__error">
              This loop does not close, so it will not be exported. Frame{" "}
              {seam?.frames} would not be frame 0 and the animation would visibly
              jump every time it repeated.
            </p>
            <SeamIssueList issues={errors} />
          </React.Fragment>
        ) : (
          <p className="xp__detail">
            The loop closes: frame {seam?.frames} is frame 0.
            {warnings.length === 0 ? "" : " There are notes below."}
          </p>
        )}
        {warnings.length > 0 ? <SeamIssueList issues={warnings} /> : null}
      </div>

      {progress === null ? null : (
        <div className="xp__row">
          <span className="ui-label">{progress.stage}</span>
          <progress className="xp__progress" max={1} value={progress.completed} />
          <span className="xp__value">{progress.detail}</span>
        </div>
      )}

      <div className="xp__actions">
        <button
          type="button"
          className="ui-button ui-button--primary"
          disabled={running || blocked || videoUnavailable}
          title={
            blocked
              ? "The loop has to close before it can be written"
              : `Write a ${info.label} of the whole loop`
          }
          onClick={() => void onExport()}
        >
          export
        </button>
        {running ? (
          <button
            type="button"
            className="ui-button"
            onClick={() => jobRef.current?.abort()}
          >
            cancel
          </button>
        ) : null}
      </div>

      {notice === null ? null : <p className="xp__detail">{notice}</p>}
      {notes.map((note) => (
        <p key={note} className="xp__warn">
          {note}
        </p>
      ))}
      {failure === null ? null : <p className="xp__error">{failure}</p>}
    </div>
  );
}

function SeamIssueList({ issues }: { readonly issues: readonly SeamIssue[] }): React.ReactElement {
  return (
    <ul className="xp__issues">
      {issues.map((issue) => (
        <li key={`${issue.code}:${issue.source}:${issue.message}`}>
          {/* The binding by name, which is the half of F-AN-06 that says
              "report which binding broke periodicity". */}
          <b>{issue.source}</b> — {issue.message}
        </li>
      ))}
    </ul>
  );
}
