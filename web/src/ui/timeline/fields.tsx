import React from "react";

import { logger } from "../../lib/log";

const log = logger("app");

export interface IntEntryProps {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly title?: string | undefined;
  readonly wide?: boolean | undefined;
  readonly onCommit: (value: number) => void;
}

/**
 * A whole-number entry for the transport's own fields.
 *
 * `NumberField` (F-UI-06) is the control for a *parameter*: it drags, it has a
 * track, and it reports an interaction to the adaptive preview. None of that
 * suits a frame count, whose legal range reaches `MAX_FRAMES` — a drag track
 * across a hundred thousand frames cannot be aimed, and there is no picture to
 * degrade while it moves. So this is a typed entry and nothing else.
 *
 * Out-of-range or unparseable text **reverts** rather than being clamped or
 * guessed at, and says so on the console: clamping 0 frames to 1 would silently
 * write a loop nobody asked for, which is the argument `animation/cycles.ts`
 * makes about rounding a fractional cycle count.
 */
export function IntEntry({
  label,
  value,
  min,
  max,
  title,
  wide,
  onCommit,
}: IntEntryProps): React.ReactElement {
  const [typed, setTyped] = React.useState<string | null>(null);

  const commit = (text: string): void => {
    setTyped(null);
    const parsed = Number(text.trim());
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      log.warn("timeline entry rejected", { field: label, text, min, max });
      return;
    }
    if (parsed === value) return;
    onCommit(parsed);
  };

  return (
    <label className="timeline__entry" title={title ?? `${label} (${min}–${max})`}>
      {label}
      <input
        type="text"
        inputMode="numeric"
        className={wide === true ? "timeline__entry--wide" : undefined}
        value={typed ?? String(value)}
        onChange={(event) => setTyped(event.target.value)}
        onBlur={(event) => {
          if (typed !== null) commit(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit(event.currentTarget.value);
          } else if (event.key === "Escape") {
            event.preventDefault();
            setTyped(null);
          }
        }}
      />
    </label>
  );
}

export interface FloatEntryProps {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly className?: string | undefined;
  readonly title?: string | undefined;
  readonly onCommit: (value: number) => void;
}

/**
 * A bare numeric entry with no track — for the per-track amount (F-AN-11),
 * which has to fit in a 188-pixel head beside four buttons.
 *
 * Same refusal policy as {@link IntEntry}: text that is not a number in range
 * reverts to the value that is actually set, and says so on the console.
 */
export function FloatEntry({
  label,
  value,
  min,
  max,
  className,
  title,
  onCommit,
}: FloatEntryProps): React.ReactElement {
  const [typed, setTyped] = React.useState<string | null>(null);

  const commit = (text: string): void => {
    setTyped(null);
    const parsed = Number(text.trim());
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      log.warn("timeline entry rejected", { field: label, text, min, max });
      return;
    }
    if (parsed === value) return;
    onCommit(parsed);
  };

  return (
    <input
      className={className}
      type="text"
      inputMode="decimal"
      aria-label={label}
      title={title ?? `${label} (${min}–${max})`}
      value={typed ?? String(value)}
      onChange={(event) => setTyped(event.target.value)}
      onBlur={(event) => {
        if (typed !== null) commit(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit(event.currentTarget.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          setTyped(null);
        }
      }}
    />
  );
}
