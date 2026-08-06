import React from "react";

/**
 * The small controls the palette sections share.
 *
 * Two conventions run through all of them and both come from the panel's own
 * requirement that nothing happen silently:
 *
 * - **A control that cannot act is disabled and says why.** Every disabled
 *   state here takes a `reason`, which becomes the tooltip. A greyed button
 *   with no explanation is the same dead end as a button that does nothing.
 * - **A numeric field commits on blur or Enter, never per keystroke.** Typing
 *   "16" passes through "1", and a field that committed on every keystroke
 *   would regenerate a palette at "1" and refuse it. An out-of-range value is
 *   shown as invalid and reverted on blur with the reason stated, rather than
 *   clamped into something the user did not type.
 */

export interface SectionProps {
  readonly title: string;
  readonly open?: boolean;
  /** Shown greyed beside the title — an entry count, a status word. */
  readonly note?: string;
  readonly children: React.ReactNode;
}

export function Section({ title, open, note, children }: SectionProps): React.ReactElement {
  return (
    <details className="pal__section" open={open === true}>
      <summary className="pal__summary">
        <span>{title}</span>
        {note === undefined ? null : <span className="pal__note">{note}</span>}
      </summary>
      <div className="pal__section-body">{children}</div>
    </details>
  );
}

export interface FieldProps {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly hint?: string;
}

export function Field({ label, children, hint }: FieldProps): React.ReactElement {
  return (
    <label className="pal__field" title={hint ?? undefined}>
      <span className="ui-label pal__field-label">{label}</span>
      {children}
    </label>
  );
}

export interface NumberFieldProps {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onCommit: (value: number) => void;
  readonly disabled?: boolean;
  readonly hint?: string;
}

export function NumberField({
  label,
  value,
  min,
  max,
  onCommit,
  disabled,
  hint,
}: NumberFieldProps): React.ReactElement {
  const [draft, setDraft] = React.useState(String(value));
  const [error, setError] = React.useState<string | null>(null);

  // The committed value is the authority: a refused edit, an undo or a palette
  // arriving from a document all move it, and the field follows.
  React.useEffect(() => {
    setDraft(String(value));
    setError(null);
  }, [value]);

  const commit = (): void => {
    const parsed = Number(draft);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      setError(`whole number, ${min} to ${max}`);
      setDraft(String(value));
      return;
    }
    setError(null);
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <div className="pal__field-group">
      <Field label={label} {...(hint === undefined ? {} : { hint })}>
        <input
          className="pal__input pal__input--number"
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={draft}
          disabled={disabled === true}
          aria-invalid={error !== null}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
        />
      </Field>
      {error === null ? null : <p className="pal__error">{error}</p>}
    </div>
  );
}

export interface ChoiceProps<T extends string> {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
  readonly disabled?: boolean;
}

/** A radio group drawn as buttons. `aria-pressed` is what the theme styles. */
export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: ChoiceProps<T>): React.ReactElement {
  return (
    <div className="pal__choice" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="ui-button pal__choice-button"
          aria-pressed={option.value === value}
          disabled={disabled === true}
          onClick={() => {
            if (option.value !== value) onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface ActionProps {
  readonly label: string;
  readonly onClick: () => void;
  /** When present the button is disabled and this is its tooltip. */
  readonly blocked?: string;
  readonly title?: string;
}

export function Action({ label, onClick, blocked, title }: ActionProps): React.ReactElement {
  return (
    <button
      type="button"
      className="ui-button"
      disabled={blocked !== undefined}
      title={blocked ?? title ?? label}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
