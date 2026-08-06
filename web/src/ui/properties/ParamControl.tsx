import React from "react";

import { logger } from "../../lib/log";
import type { EffectParamValue } from "../../registry";
import type { CommitOptions } from "../stack/store";
import type { CurvePoint, SrgbTriplet } from "../../types/document";
import type { ParamDescriptor } from "../../types/registry";
import { ColorField } from "./ColorField";
import { CurveEditor } from "./CurveEditor";
import { NumberField } from "./NumberField";
import { SeedField } from "./SeedField";

const log = logger("app");

export interface ParamControlProps {
  readonly nodeId: string;
  readonly effectId: string;
  readonly param: ParamDescriptor;
  /** Already through `coerceParams`, so it matches the descriptor's kind. */
  readonly value: EffectParamValue;
  /**
   * `options.continuous` is set by the controls that emit a value per pointer
   * move, so the store folds a drag into one undo step whose starting point is
   * where the drag began. It is *not* set by the discrete controls: a checkbox
   * that coalesced would let two clicks collapse into a step that undoes both.
   */
  readonly onChange: (value: EffectParamValue, options?: CommitOptions) => void;
}

/**
 * Records a value that does not match its descriptor and falls back to the
 * descriptor's own default.
 *
 * `coerceParams` guarantees this cannot happen — the properties panel runs it
 * over the node's parameters before rendering any of them — so reaching here at
 * all means the coercion contract is broken. That is a defect to be *seen*,
 * which is why it logs at error level; rendering the default keeps the panel
 * usable while it is seen, and refusing to render would take the whole
 * application down over one parameter.
 */
function mistyped(
  effectId: string,
  param: ParamDescriptor,
  value: EffectParamValue,
): void {
  log.error("parameter value does not match its descriptor", {
    effect: effectId,
    param: param.key,
    expected: param.type,
    actual: typeof value === "object" ? "array" : typeof value,
  });
}

function numberOr(
  effectId: string,
  param: ParamDescriptor,
  value: EffectParamValue,
  fallback: number,
): number {
  if (typeof value === "number") return value;
  mistyped(effectId, param, value);
  return fallback;
}

/**
 * One parameter, one control, chosen by the descriptor's declared kind and by
 * nothing else.
 *
 * **There is no effect id in this file.** Every control below is built from
 * `ParamDescriptor` alone — legal range, step, default, options, label, hint —
 * which is the payoff the descriptor design was for: an effect added tomorrow
 * gets a complete properties panel without a line being written here.
 */
export function ParamControl({
  nodeId,
  effectId,
  param,
  value,
  onChange,
}: ParamControlProps): React.ReactElement {
  const interaction = `param:${nodeId}.${param.key}`;
  /** For the pointer-driven controls; see {@link ParamControlProps.onChange}. */
  const dragged = (value: EffectParamValue): void => onChange(value, { continuous: true });

  switch (param.type) {
    case "float":
      return (
        <NumberField
          label={param.label}
          hint={param.hint}
          value={numberOr(effectId, param, value, param.default)}
          min={param.legal[0]}
          max={param.legal[1]}
          step={param.step}
          interaction={interaction}
          onChange={dragged}
        />
      );

    case "int":
      return (
        <NumberField
          label={param.label}
          hint={param.hint}
          value={numberOr(effectId, param, value, param.default)}
          min={param.legal[0]}
          max={param.legal[1]}
          integer
          interaction={interaction}
          onChange={dragged}
        />
      );

    case "seed":
      return (
        <SeedField
          label={param.label}
          hint={param.hint}
          value={numberOr(effectId, param, value, param.default)}
          interaction={interaction}
          onChange={onChange}
        />
      );

    case "bool": {
      const checked = typeof value === "boolean" ? value : param.default;
      if (typeof value !== "boolean") mistyped(effectId, param, value);
      return (
        <div className="field field--inline">
          <label className="toggle" title={param.hint ?? param.label}>
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => onChange(event.target.checked)}
            />
            <span>{param.label}</span>
          </label>
        </div>
      );
    }

    case "enum": {
      const selected =
        typeof value === "string" && param.values.some((o) => o.value === value)
          ? value
          : param.default;
      if (typeof value !== "string") mistyped(effectId, param, value);
      return (
        <div className="field">
          <div className="field__label" title={param.hint ?? param.label}>
            {param.label}
          </div>
          <select
            className="select"
            aria-label={param.label}
            value={selected}
            onChange={(event) => onChange(event.target.value)}
          >
            {param.values.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      );
    }

    case "color": {
      const triplet = isTriplet(value) ? value : param.default;
      if (!isTriplet(value)) mistyped(effectId, param, value);
      return (
        <ColorField
          label={param.label}
          hint={param.hint}
          value={triplet}
          interaction={interaction}
          onChange={dragged}
        />
      );
    }

    case "curve": {
      const points = isCurvePoints(value) ? value : param.default;
      if (!isCurvePoints(value)) mistyped(effectId, param, value);
      return (
        <CurveEditor
          label={param.label}
          hint={param.hint}
          value={points}
          fallback={param.default}
          interaction={interaction}
          onChange={dragged}
        />
      );
    }
  }
}

// `Array.isArray` is deliberately not used to narrow these: its signature is
// `arg is any[]`, and a `readonly` tuple is not assignable to `any[]`, so on a
// union of readonly array types the true branch narrows to `never`. The scalar
// members are excluded by `typeof` instead, which leaves exactly the two
// composite kinds.

function isTriplet(value: EffectParamValue): value is SrgbTriplet {
  if (typeof value !== "object" || value === null) return false;
  const components = value as readonly unknown[];
  return (
    components.length === 3 &&
    components.every((component) => typeof component === "number")
  );
}

function isCurvePoints(value: EffectParamValue): value is readonly CurvePoint[] {
  if (typeof value !== "object" || value === null) return false;
  const points = value as readonly unknown[];
  return (
    points.length >= 2 &&
    points.every(
      (point) =>
        typeof point === "object" &&
        point !== null &&
        typeof (point as CurvePoint).x === "number" &&
        typeof (point as CurvePoint).y === "number",
    )
  );
}
