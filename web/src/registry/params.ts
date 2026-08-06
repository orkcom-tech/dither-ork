/**
 * Parameter defaults, validation and coercion.
 *
 * These are the three things the document layer needs from the registry: build
 * the parameters for a freshly added node, check the parameters of a node that
 * came out of a `.dork` file, and make a set that failed that check usable.
 *
 * Coercion is separate from validation because they answer different questions.
 * Loading a document asks "is this file what it claims to be" — that is
 * `validateParams`, and its answer is reported, not acted on. Rendering asks
 * "what value does this node actually use" — that is `coerceParams`, which
 * always produces something legal and **logs every adjustment it makes**. A
 * value silently snapped to a bound is a document that no longer round-trips,
 * and the user is the last person to find out.
 *
 * There is no per-effect logic here. Everything is driven off the descriptor,
 * so an effect added tomorrow is handled by the code written today.
 */

import { logger } from "../lib/log";
import type { ParameterValue } from "../types/document";
import {
  SEED_RANGE,
  type CurvePoint,
  type EffectDescriptor,
  type ParamDescriptor,
  type SrgbTriplet,
} from "../types/registry";

const log = logger("app");

/**
 * A parameter value as the registry describes it.
 *
 * Wider than the document's `ParameterValue`, which is `number | boolean |
 * string` and therefore cannot carry the `color` and `curve` parameter kinds
 * the descriptor contract declares. Nothing is invented here to bridge that —
 * inventing a packing would put a serialisation decision in the wrong file. See
 * the note in the module that owns `.dork`.
 */
export type EffectParamValue =
  | ParameterValue
  | SrgbTriplet
  | readonly CurvePoint[];

export type EffectParams = Readonly<Record<string, EffectParamValue>>;

export type ParamIssueCode =
  | "missing"
  | "unknown-key"
  | "wrong-type"
  | "out-of-legal-range"
  | "non-integer"
  | "unknown-option"
  | "malformed";

export interface ParamIssue {
  readonly effect: string;
  readonly key: string;
  readonly code: ParamIssueCode;
  readonly message: string;
}

export interface ParamSetValidation {
  readonly ok: boolean;
  readonly issues: readonly ParamIssue[];
}

export type ParamAdjustmentKind =
  /** Key absent from the set; the descriptor default was used. */
  | "missing"
  /** Key not declared by the effect; dropped rather than passed to the kernel. */
  | "unknown-key"
  /** Value of the wrong kind entirely; replaced by the default. */
  | "wrong-type"
  /** Numeric value outside the legal range; moved to the nearest bound. */
  | "clamped"
  /** Non-integer where the descriptor requires one. */
  | "rounded"
  /** Seed outside the 32-bit space; wrapped rather than clamped. */
  | "wrapped"
  /** Enum value the effect does not declare; replaced by the default. */
  | "unknown-option"
  /** Structurally invalid colour or curve; replaced by the default. */
  | "malformed";

export interface ParamAdjustment {
  readonly effect: string;
  readonly key: string;
  readonly kind: ParamAdjustmentKind;
  /** Rendered for the log; diagnostics only, not for programmatic use. */
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

export interface ParamCoercion {
  /** Always passes {@link validateParams} against the same descriptor. */
  readonly values: EffectParams;
  readonly adjustments: readonly ParamAdjustment[];
}

// --- shared predicates --------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** An 8-bit sRGB triplet, as the document palette and the WASM boundary want it. */
function isSrgbTriplet(value: unknown): value is SrgbTriplet {
  if (!Array.isArray(value)) return false;
  const components = value as readonly unknown[];
  return (
    components.length === 3 &&
    components.every(
      (c) => typeof c === "number" && Number.isInteger(c) && c >= 0 && c <= 255,
    )
  );
}

/**
 * A usable transfer curve: at least two points, inside the unit square,
 * strictly increasing in `x`, spanning the whole domain. The domain condition
 * is the one that matters — a curve that stops short of `x = 1` leaves the
 * brightest pixels with no defined output.
 */
function isCurve(value: unknown): value is readonly CurvePoint[] {
  if (!Array.isArray(value)) return false;
  const points = value as readonly unknown[];
  if (points.length < 2) return false;

  const xs: number[] = [];
  let previousX = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (typeof point !== "object" || point === null) return false;
    const x: unknown = (point as { x?: unknown }).x;
    const y: unknown = (point as { y?: unknown }).y;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return false;
    if (x < 0 || x > 1 || y < 0 || y > 1) return false;
    if (x <= previousX) return false;
    previousX = x;
    xs.push(x);
  }
  return xs[0] === 0 && xs[xs.length - 1] === 1;
}

/** Stable, non-throwing rendering of an arbitrary value for a log field. */
function describe(value: unknown): string {
  if (value === null || typeof value !== "object") return String(value);
  if (!Array.isArray(value)) return "object";
  const items = value as readonly unknown[];
  if (items.length <= 4 && items.every((v) => typeof v === "number")) {
    return `[${items.join(", ")}]`;
  }
  return `array(${items.length})`;
}

// --- defaults -----------------------------------------------------------

/**
 * The descriptor's default, copied.
 *
 * Composite defaults are copied rather than shared: one descriptor is the
 * default for every instance of that effect in every open document, and handing
 * out its array would let one node's edit rewrite the default for all of them.
 */
function defaultOf(param: ParamDescriptor): EffectParamValue {
  switch (param.type) {
    case "float":
    case "int":
    case "seed":
      return param.default;
    case "bool":
      return param.default;
    case "enum":
      return param.default;
    case "color":
      return [param.default[0], param.default[1], param.default[2]];
    case "curve":
      return param.default.map((point) => ({ x: point.x, y: point.y }));
  }
}

/** Build the parameter set a freshly added node starts with. */
export function defaultParams(effect: EffectDescriptor): EffectParams {
  const values: Record<string, EffectParamValue> = {};
  for (const param of effect.params) values[param.key] = defaultOf(param);
  log.debug("default parameters built", {
    effect: effect.id,
    params: effect.params.length,
  });
  return values;
}

// --- validation ---------------------------------------------------------

function issue(
  effect: string,
  key: string,
  code: ParamIssueCode,
  message: string,
): ParamIssue {
  return { effect, key, code, message };
}

function checkValue(
  effectId: string,
  param: ParamDescriptor,
  value: unknown,
  issues: ParamIssue[],
): void {
  const key = param.key;
  switch (param.type) {
    case "float": {
      if (!isFiniteNumber(value)) {
        issues.push(issue(effectId, key, "wrong-type", `${describe(value)} is not a finite number`));
        return;
      }
      const [min, max] = param.legal;
      if (value < min || value > max) {
        issues.push(
          issue(effectId, key, "out-of-legal-range", `${value} is outside [${min}, ${max}]`),
        );
      }
      return;
    }
    case "int": {
      if (!isFiniteNumber(value)) {
        issues.push(issue(effectId, key, "wrong-type", `${describe(value)} is not a finite number`));
        return;
      }
      if (!Number.isInteger(value)) {
        issues.push(issue(effectId, key, "non-integer", `${value} is not an integer`));
      }
      const [min, max] = param.legal;
      if (value < min || value > max) {
        issues.push(
          issue(effectId, key, "out-of-legal-range", `${value} is outside [${min}, ${max}]`),
        );
      }
      return;
    }
    case "seed": {
      const [min, max] = SEED_RANGE;
      if (!isFiniteNumber(value)) {
        issues.push(issue(effectId, key, "wrong-type", `${describe(value)} is not a finite number`));
        return;
      }
      if (!Number.isInteger(value)) {
        issues.push(issue(effectId, key, "non-integer", `seed ${value} is not an integer`));
      }
      if (value < min || value > max) {
        issues.push(
          issue(effectId, key, "out-of-legal-range", `seed ${value} is not a 32-bit unsigned integer`),
        );
      }
      return;
    }
    case "bool": {
      if (typeof value !== "boolean") {
        issues.push(issue(effectId, key, "wrong-type", `${describe(value)} is not a boolean`));
      }
      return;
    }
    case "enum": {
      if (typeof value !== "string") {
        issues.push(issue(effectId, key, "wrong-type", `${describe(value)} is not a string`));
        return;
      }
      if (!param.values.some((option) => option.value === value)) {
        issues.push(
          issue(effectId, key, "unknown-option", `"${value}" is not one of this effect's options`),
        );
      }
      return;
    }
    case "color": {
      if (!isSrgbTriplet(value)) {
        issues.push(
          issue(effectId, key, "malformed", `${describe(value)} is not an 8-bit [r, g, b] triplet`),
        );
      }
      return;
    }
    case "curve": {
      if (!isCurve(value)) {
        issues.push(
          issue(
            effectId,
            key,
            "malformed",
            "not a curve: needs two or more points in the unit square, strictly increasing in x, spanning x = 0 to x = 1",
          ),
        );
      }
      return;
    }
  }
}

/**
 * Check a loaded parameter set against its descriptor.
 *
 * Reports rather than repairs. A caller that wants a usable set calls
 * {@link coerceParams} instead — and gets told what was changed.
 */
export function validateParams(
  effect: EffectDescriptor,
  params: Readonly<Record<string, unknown>>,
): ParamSetValidation {
  const issues: ParamIssue[] = [];
  const declared = new Set<string>();

  for (const param of effect.params) {
    declared.add(param.key);
    if (!(param.key in params)) {
      issues.push(issue(effect.id, param.key, "missing", "parameter is not present in the set"));
      continue;
    }
    checkValue(effect.id, param, params[param.key], issues);
  }

  for (const key of Object.keys(params)) {
    if (!declared.has(key)) {
      issues.push(
        issue(effect.id, key, "unknown-key", "not a parameter this effect declares"),
      );
    }
  }

  return { ok: issues.length === 0, issues };
}

// --- coercion -----------------------------------------------------------

function adjust(
  adjustments: ParamAdjustment[],
  effect: string,
  key: string,
  kind: ParamAdjustmentKind,
  from: unknown,
  to: unknown,
  reason: string,
): void {
  const record: ParamAdjustment = {
    effect,
    key,
    kind,
    from: describe(from),
    to: describe(to),
    reason,
  };
  adjustments.push(record);
  // Warn, not debug: this is the document not surviving a round trip, and it
  // has to be visible without turning verbose logging on.
  log.warn("parameter coerced", {
    effect: record.effect,
    param: record.key,
    kind: record.kind,
    from: record.from,
    to: record.to,
    reason: record.reason,
  });
}

function coerceOne(
  effectId: string,
  param: ParamDescriptor,
  value: unknown,
  adjustments: ParamAdjustment[],
): EffectParamValue {
  const key = param.key;

  switch (param.type) {
    case "float": {
      if (!isFiniteNumber(value)) {
        const fallback = param.default;
        adjust(adjustments, effectId, key, "wrong-type", value, fallback, "not a finite number");
        return fallback;
      }
      const [min, max] = param.legal;
      // `step` is deliberately not applied. It is the UI's drag quantum, not a
      // legality constraint, and snapping a loaded value to it would silently
      // edit a number the user typed.
      const clamped = clamp(value, min, max);
      if (clamped !== value) {
        adjust(adjustments, effectId, key, "clamped", value, clamped, `legal range is [${min}, ${max}]`);
      }
      return clamped;
    }

    case "int": {
      if (!isFiniteNumber(value)) {
        const fallback = param.default;
        adjust(adjustments, effectId, key, "wrong-type", value, fallback, "not a finite number");
        return fallback;
      }
      let result = value;
      if (!Number.isInteger(result)) {
        const rounded = Math.round(result);
        adjust(adjustments, effectId, key, "rounded", result, rounded, "parameter is an integer");
        result = rounded;
      }
      const [min, max] = param.legal;
      // Bounds are integral (the registry validator enforces it), so clamping
      // after rounding cannot reintroduce a fraction.
      const clamped = clamp(result, min, max);
      if (clamped !== result) {
        adjust(adjustments, effectId, key, "clamped", result, clamped, `legal range is [${min}, ${max}]`);
      }
      return clamped;
    }

    case "seed": {
      if (!isFiniteNumber(value)) {
        const fallback = param.default;
        adjust(adjustments, effectId, key, "wrong-type", value, fallback, "not a finite number");
        return fallback;
      }
      let result = value;
      if (!Number.isInteger(result)) {
        const truncated = Math.trunc(result);
        adjust(adjustments, effectId, key, "rounded", result, truncated, "a seed is an integer");
        result = truncated;
      }
      const [min, max] = SEED_RANGE;
      if (result < min || result > max) {
        // Wrapped, not clamped. A seed has no ordering — one is no closer to
        // "right" than another — so clamping would collapse every out-of-range
        // seed onto the same value and make distinct documents render
        // identically. Wrapping is what a u32 does anyway.
        const wrapped = result >>> 0;
        adjust(adjustments, effectId, key, "wrapped", result, wrapped, "seeds are 32-bit unsigned");
        result = wrapped;
      }
      return result;
    }

    case "bool": {
      if (typeof value !== "boolean") {
        const fallback = param.default;
        adjust(adjustments, effectId, key, "wrong-type", value, fallback, "not a boolean");
        return fallback;
      }
      return value;
    }

    case "enum": {
      if (typeof value !== "string") {
        const fallback = param.default;
        adjust(adjustments, effectId, key, "wrong-type", value, fallback, "not a string");
        return fallback;
      }
      if (!param.values.some((option) => option.value === value)) {
        const fallback = param.default;
        adjust(
          adjustments,
          effectId,
          key,
          "unknown-option",
          value,
          fallback,
          `options are ${param.values.map((o) => o.value).join(", ")}`,
        );
        return fallback;
      }
      return value;
    }

    case "color": {
      // A non-array cannot have three components, so it takes the same branch.
      const components: readonly unknown[] = Array.isArray(value)
        ? (value as readonly unknown[])
        : [];
      if (
        components.length !== 3 ||
        !components.every((c) => isFiniteNumber(c))
      ) {
        const fallback = defaultOf(param);
        adjust(adjustments, effectId, key, "malformed", value, fallback, "not an [r, g, b] triplet");
        return fallback;
      }
      // Exactly three finite numbers, established immediately above.
      const [r, g, b] = components as readonly [number, number, number];
      const fixed: SrgbTriplet = [
        clamp(Math.round(r), 0, 255),
        clamp(Math.round(g), 0, 255),
        clamp(Math.round(b), 0, 255),
      ];
      if (fixed[0] !== r || fixed[1] !== g || fixed[2] !== b) {
        adjust(adjustments, effectId, key, "clamped", value, fixed, "components are 8-bit sRGB");
      }
      return fixed;
    }

    case "curve": {
      if (!isCurve(value)) {
        // Replaced whole, not repaired. Sorting the points or moving the
        // endpoints onto 0 and 1 would invent a transfer function the user
        // never drew, and a curve is a look decision.
        const fallback = defaultOf(param);
        adjust(
          adjustments,
          effectId,
          key,
          "malformed",
          value,
          fallback,
          "not a monotonic curve spanning x = 0 to x = 1",
        );
        return fallback;
      }
      return value.map((point) => ({ x: point.x, y: point.y }));
    }
  }
}

/**
 * Make a parameter set usable against its descriptor.
 *
 * Every declared parameter comes back present and legal; every undeclared key
 * is dropped; every change is recorded in `adjustments` and logged as a
 * warning. The result always passes {@link validateParams}, which is what lets
 * the graph treat coerced parameters as a precondition rather than re-checking
 * them per node execution.
 */
export function coerceParams(
  effect: EffectDescriptor,
  params: Readonly<Record<string, unknown>>,
): ParamCoercion {
  const adjustments: ParamAdjustment[] = [];
  const values: Record<string, EffectParamValue> = {};
  const declared = new Set<string>();

  for (const param of effect.params) {
    declared.add(param.key);
    if (!(param.key in params)) {
      const fallback = defaultOf(param);
      adjust(adjustments, effect.id, param.key, "missing", "<absent>", fallback, "absent from the set");
      values[param.key] = fallback;
      continue;
    }
    values[param.key] = coerceOne(effect.id, param, params[param.key], adjustments);
  }

  for (const key of Object.keys(params)) {
    if (declared.has(key)) continue;
    // Dropped rather than passed through: a parameter this effect no longer
    // declares is either a rename or a different effect's, and forwarding it to
    // the kernel is how one of those becomes a bug that looks like the other.
    adjust(adjustments, effect.id, key, "unknown-key", params[key], "<dropped>", "not declared by this effect");
  }

  if (adjustments.length === 0) {
    log.debug("parameters accepted unchanged", {
      effect: effect.id,
      params: effect.params.length,
    });
  } else {
    log.warn("parameter set required coercion", {
      effect: effect.id,
      adjustments: adjustments.length,
    });
  }

  return { values, adjustments };
}
