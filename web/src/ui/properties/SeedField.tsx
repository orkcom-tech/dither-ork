import React from "react";

import { logger } from "../../lib/log";
import { SEED_RANGE } from "../../types/registry";
import { randomSeed } from "./seed";

const log = logger("app");

export interface SeedFieldProps {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly value: number;
  readonly interaction: string;
  readonly onChange: (seed: number) => void;
}

const [SEED_MIN, SEED_MAX] = SEED_RANGE;

/**
 * The `seed` parameter kind, and the node's own seed.
 *
 * Deliberately **not** a slider. A seed has no ordering — 41 is not "between"
 * 40 and 42 in any sense the image cares about — so a track over four billion
 * values would be four billion positions none of which is nearer to the one you
 * want. What a seed needs is a way to draw a new one and a way to type a
 * remembered one back in, which is what this is.
 */
export function SeedField({
  label,
  hint,
  value,
  interaction,
  onChange,
}: SeedFieldProps): React.ReactElement {
  const [typed, setTyped] = React.useState<string | null>(null);

  const commit = (text: string): void => {
    setTyped(null);
    const parsed = Number(text.trim());
    if (!Number.isFinite(parsed)) {
      log.warn("seed entry rejected", { param: interaction, text });
      return;
    }
    // Truncated and wrapped, matching `coerceParams`: a seed is a u32, and
    // wrapping keeps distinct entries distinct where clamping would collapse
    // every out-of-range value onto the same picture.
    const seed = Math.trunc(parsed) >>> 0;
    if (seed !== parsed) {
      log.info("seed adjusted to the 32-bit range", {
        param: interaction,
        from: parsed,
        to: seed,
      });
    }
    onChange(seed);
  };

  return (
    <div className="field">
      <div className="field__label" title={hint ?? label}>
        {label}
      </div>
      <div className="seed">
        <input
          className="seed__entry"
          type="text"
          inputMode="numeric"
          spellCheck={false}
          aria-label={`${label} value`}
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
        <button
          type="button"
          className="ui-button"
          title={`Draw a new seed between ${SEED_MIN} and ${SEED_MAX}`}
          onClick={() => {
            const seed = randomSeed();
            log.info("seed rerolled", { param: interaction, seed });
            onChange(seed);
          }}
        >
          reroll
        </button>
      </div>
    </div>
  );
}
