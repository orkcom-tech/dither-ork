import React from "react";

import { formatBytes } from "../../export";
import type { BatchItem, BatchItemStage } from "../../batch";

/**
 * F-BA-06's visible queue.
 *
 * One row per input, always — nothing is filtered out of this list, including
 * the file that failed. That is the requirement stated as a component: *one
 * corrupt file in a folder of two hundred must not vanish silently*, and the
 * way a file vanishes silently is by a list that only shows successes.
 *
 * ## Every row says three things
 *
 * What it was (the input path, with the folder it came from), what happened to
 * it (the state, and while it is running, the stage), and what came of it — the
 * output name and size, or the error. The error is rendered in full rather than
 * truncated: it is the one piece of text on the screen that a person has to be
 * able to act on, and "decode failed…" with an ellipsis is not actionable.
 *
 * ## Rows are keyed by the input's own id
 *
 * Minted by a counter in `batch/input.ts`, never by index and never randomly:
 * keying by index re-uses a row's DOM for a different file when the queue is
 * filtered, and keying randomly re-mounts every row on every render, which for
 * two hundred rows is a visibly janky list.
 */
export interface QueueListProps {
  readonly items: readonly BatchItem[];
  /** Remove one item. Absent while a run is going, because the queue is fixed then. */
  readonly onRemove?: (id: string) => void;
}

const STAGE_LABEL: Readonly<Record<BatchItemStage, string>> = {
  waiting: "waiting",
  decoding: "decoding",
  palette: "extracting palette",
  rendering: "rendering",
  encoding: "encoding",
  writing: "writing",
  finished: "",
};

function statusOf(item: BatchItem): string {
  switch (item.state) {
    case "pending":
      return "queued";
    case "running":
      return STAGE_LABEL[item.stage];
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

/** The folder an input came from, so two files with one name are still distinct. */
function folderOf(path: string): string | null {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : null;
}

function fileOf(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

export function QueueList({ items, onRemove }: QueueListProps): React.ReactElement {
  if (items.length === 0) {
    return (
      <p className="bx__detail">
        Nothing queued yet. Add files, or drop images or a folder onto this dialog.
      </p>
    );
  }

  return (
    <ol className="bx__queue" aria-label="Batch queue">
      {items.map((item) => (
        <li key={item.id} className="bx__row" data-state={item.state}>
          <span className="bx__row-mark" aria-hidden="true" />
          <span className="bx__row-name" title={item.path}>
            {fileOf(item.path)}
            {folderOf(item.path) === null ? null : (
              <span className="bx__row-folder"> in {folderOf(item.path)}</span>
            )}
          </span>
          <span className="bx__row-status">{statusOf(item)}</span>
          <span className="bx__row-out">
            {item.outputName === null
              ? ""
              : `${item.outputName}${
                  item.width === null ? "" : ` · ${item.width}x${item.height}`
                }${item.outputBytes === null ? "" : ` · ${formatBytes(item.outputBytes)}`}`}
          </span>
          {onRemove === undefined ? null : (
            <button
              type="button"
              className="ui-button bx__row-drop"
              title={`Take “${fileOf(item.path)}” out of the queue`}
              onClick={() => onRemove(item.id)}
            >
              ×
            </button>
          )}
          {item.error === null ? null : (
            <p className="bx__row-error" role="alert">
              {item.error}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
