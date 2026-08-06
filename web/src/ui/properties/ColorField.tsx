import React from "react";

import { logger } from "../../lib/log";
import type { SrgbTriplet } from "../../types/document";
import { NumberField } from "./NumberField";
import { CHANNEL_LABEL, fromHex, toHex, withComponent } from "./color";

const log = logger("app");

export interface ColorFieldProps {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly value: SrgbTriplet;
  readonly interaction: string;
  readonly onChange: (next: SrgbTriplet) => void;
}

/**
 * The `color` parameter kind.
 *
 * Three ways to say the same three numbers, because three different people
 * arrive with them in three different forms: the platform picker for choosing
 * one by eye, a hex field for the value pasted out of a palette, and the
 * channels themselves for the case where one of them needs to move by two.
 *
 * The channels are ordinary numeric controls, so they drag with the same
 * modifiers as everything else (F-UI-06) rather than being a special case.
 */
export function ColorField({
  label,
  hint,
  value,
  interaction,
  onChange,
}: ColorFieldProps): React.ReactElement {
  const [typedHex, setTypedHex] = React.useState<string | null>(null);
  const hex = toHex(value);

  const commitHex = (text: string): void => {
    const parsed = fromHex(text);
    setTypedHex(null);
    if (parsed === null) {
      log.warn("hex colour rejected", { param: interaction, text });
      return;
    }
    onChange(parsed);
  };

  return (
    <div className="field">
      <div className="field__label" title={hint ?? label}>
        {label}
      </div>

      <div className="colour">
        <input
          className="colour__swatch"
          type="color"
          aria-label={`${label} swatch`}
          value={hex}
          onChange={(event) => {
            const parsed = fromHex(event.target.value);
            if (parsed === null) {
              // The platform control cannot emit anything but #rrggbb; if it
              // does, the value is not a colour and must not reach the document.
              log.error("colour input produced a value that is not a colour", {
                param: interaction,
                text: event.target.value,
              });
              return;
            }
            onChange(parsed);
          }}
        />
        <input
          className="colour__hex"
          type="text"
          aria-label={`${label} hex`}
          spellCheck={false}
          value={typedHex ?? hex}
          onChange={(event) => setTypedHex(event.target.value)}
          onBlur={(event) => {
            if (typedHex !== null) commitHex(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitHex(event.currentTarget.value);
            } else if (event.key === "Escape") {
              event.preventDefault();
              setTypedHex(null);
            }
          }}
        />
      </div>

      <div className="colour__channels">
        {CHANNEL_LABEL.map((channel, index) => (
          <NumberField
            key={channel}
            dense
            label={channel}
            value={value[index] ?? 0}
            min={0}
            max={255}
            step={1}
            integer
            interaction={`${interaction}.${channel.toLowerCase()}`}
            onChange={(next) =>
              onChange(withComponent(value, index as 0 | 1 | 2, next))
            }
          />
        ))}
      </div>
    </div>
  );
}
