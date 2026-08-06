import React from "react";

import { formatHex } from "./color";
import { Action, Field, NumberField, Section } from "./controls";
import type { Swatch } from "./model";
import { SORT_KEYS, canSortBy, sortKeyLabel } from "./order";
import type { SortKey } from "./order";
import { RAMP_STEP_RANGE, canRamp, rampDistance } from "./ramp";

/**
 * Ordering and ramp generation — F-CO-06.
 *
 * Both of these are the reason the store emits a permutation. A sort does not
 * produce a new palette; it produces a new *order* over the same colours, and
 * everything indexed by palette position travels with it. That is invisible in
 * this file by design — the button dispatches a sort and the store does the
 * rest — but it is why there is no "sorted copy" anywhere in the panel.
 *
 * The ramp replaces the span between two swatches and keeps both ends exactly
 * as they were, so a colour taken off a datasheet at either end survives having
 * a ramp run through it.
 */

export interface OrderSectionProps {
  readonly swatches: readonly Swatch[];
  readonly onSort: (key: SortKey) => void;
  readonly onRamp: (from: number, to: number, steps: number) => void;
}

export function OrderSection({
  swatches,
  onSort,
  onRamp,
}: OrderSectionProps): React.ReactElement {
  const [from, setFrom] = React.useState(0);
  const [to, setTo] = React.useState(1);
  const [steps, setSteps] = React.useState(5);

  const last = swatches.length - 1;
  const safeFrom = Math.min(from, last);
  const safeTo = Math.min(to, last);
  const allowed = canRamp(swatches.length, safeFrom, safeTo, steps);

  const a = swatches[safeFrom];
  const b = swatches[safeTo];
  const distance = a === undefined || b === undefined ? 0 : rampDistance(a.rgb, b.rgb);

  return (
    <Section title="order" note={`${swatches.length} entries`}>
      <Field label="sort by" hint="a reorder, not a rewrite: index maps travel with it">
        <div className="pal__row">
          {SORT_KEYS.map((key) => {
            const verdict = canSortBy(swatches, key);
            return (
              <Action
                key={key}
                label={sortKeyLabel(key)}
                title={`order the palette by ${sortKeyLabel(key)}`}
                onClick={() => onSort(key)}
                {...(verdict.ok ? {} : { blocked: verdict.reason })}
              />
            );
          })}
        </div>
      </Field>

      <div className="pal__row pal__row--wrap">
        <SwatchSelect
          label="from"
          swatches={swatches}
          value={safeFrom}
          onChange={setFrom}
        />
        <SwatchSelect label="to" swatches={swatches} value={safeTo} onChange={setTo} />
        <NumberField
          label="steps"
          value={steps}
          min={RAMP_STEP_RANGE.min}
          max={RAMP_STEP_RANGE.max}
          hint="colours the span becomes, both ends included"
          onCommit={setSteps}
        />
      </div>

      <div className="pal__row">
        <Action
          label="ramp"
          title="replace the span between the two swatches with an OKLab ramp"
          onClick={() => onRamp(safeFrom, safeTo, steps)}
          {...(allowed.ok ? {} : { blocked: allowed.reason })}
        />
        <span className="pal__note">
          {distance.toFixed(3)} OKLab apart · span of{" "}
          {Math.abs(safeTo - safeFrom) + 1} becomes {steps}
        </span>
      </div>

      <p className="pal__prose">
        Interpolated in OKLab, not in linear light: a linear-light ramp between two
        saturated colours passes through a desaturated middle. Both ends are kept byte
        for byte.
      </p>
    </Section>
  );
}

function SwatchSelect({
  label,
  swatches,
  value,
  onChange,
}: {
  readonly label: string;
  readonly swatches: readonly Swatch[];
  readonly value: number;
  readonly onChange: (index: number) => void;
}): React.ReactElement {
  return (
    <Field label={label}>
      <select
        className="pal__input pal__select"
        value={value}
        onChange={(event) => onChange(Number.parseInt(event.target.value, 10))}
      >
        {swatches.map((swatch, index) => (
          <option key={index} value={index}>
            {index} · {formatHex(swatch.rgb)}
          </option>
        ))}
      </select>
    </Field>
  );
}
