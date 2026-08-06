/**
 * The arithmetic behind every numeric control — F-UI-06.
 *
 * "Numeric entry on every slider, plus shift/alt fine and coarse drag" is three
 * separate things that all have to land on the same value: a pointer on a
 * track, a pointer dragging a number with a modifier held, and a typed string.
 * If they disagree, the one that disagrees is a slider that will not settle on
 * the number the user typed into it a moment ago.
 *
 * So the whole of it is here, pure, and tested without a DOM. The components
 * are the part that reads pointer events and draws a rectangle.
 *
 * ## The re-anchoring rule
 *
 * A modifier pressed *during* a drag must not move the value. Fine drag is a
 * different mapping from pixels to units, so continuing to measure from the
 * original grab point would multiply the distance already travelled by ten and
 * throw the value across its range. {@link continueDrag} therefore re-anchors
 * at the current pointer position and the current value whenever the precision
 * changes, which makes the transition exactly continuous.
 */

/** How far a pixel of pointer movement goes. */
export type DragPrecision = "normal" | "fine" | "coarse";

/**
 * Shift is fine and alt is coarse, and shift wins when both are held.
 *
 * The two directions are asymmetric on purpose: the reason to reach for a
 * modifier mid-drag is nearly always that the value is close and needs to be
 * nudged, so the one that is easiest to hold is the one that slows things down.
 */
export const PRECISION_FACTOR: Record<DragPrecision, number> = {
  normal: 1,
  fine: 0.1,
  coarse: 10,
};

export interface Modifiers {
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

export function precisionFor(modifiers: Modifiers): DragPrecision {
  if (modifiers.shiftKey) return "fine";
  if (modifiers.altKey) return "coarse";
  return "normal";
}

/**
 * A parameter's numeric shape, as the control needs it.
 *
 * `span` is the pixel distance that covers the whole range at normal precision.
 * For a track it is the track's width, so the pointer lands where it is
 * pointing; for a number being dragged there is no track, so it is a constant.
 */
export interface NumericSpec {
  readonly min: number;
  readonly max: number;
  /** Drag and entry quantum. `undefined` means continuous. */
  readonly step?: number | undefined;
  readonly integer: boolean;
  readonly span: number;
}

/** Pixels that cover the whole range when dragging a number rather than a track. */
export const VALUE_DRAG_SPAN = 240;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Decimal places `value` is written with. Handles exponent notation. */
export function decimalsOf(value: number): number {
  if (!Number.isFinite(value) || Number.isInteger(value)) return 0;
  const text = value.toString();
  const exponentAt = text.indexOf("e");
  if (exponentAt === -1) {
    const dot = text.indexOf(".");
    return dot === -1 ? 0 : text.length - dot - 1;
  }
  const mantissa = text.slice(0, exponentAt);
  const exponent = Number(text.slice(exponentAt + 1));
  const dot = mantissa.indexOf(".");
  const mantissaDecimals = dot === -1 ? 0 : mantissa.length - dot - 1;
  return Math.max(0, mantissaDecimals - exponent);
}

/** How many decimals a control shows, given its quantum. */
export function decimalsFor(spec: NumericSpec): number {
  if (spec.integer) return 0;
  if (spec.step === undefined) return CONTINUOUS_DECIMALS;
  return decimalsOf(spec.step);
}

/**
 * A parameter with no declared step is continuous, and a control still has to
 * print it as something. Three places is finer than any of the declared steps
 * in the catalogue and coarse enough that binary representation error never
 * reaches the display.
 */
const CONTINUOUS_DECIMALS = 3;

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Snap to the parameter's quantum, then clamp.
 *
 * Snapping is measured **from `min`**, not from zero. A step of 0.25 on a range
 * starting at 0.1 has to be able to produce 0.1 itself; snapping from zero
 * would make the parameter's own minimum unreachable from the slider.
 */
export function quantize(value: number, spec: NumericSpec): number {
  if (!Number.isFinite(value)) return spec.min;
  const step = spec.integer ? (spec.step ?? 1) : spec.step;
  if (step === undefined || step <= 0) {
    return clamp(spec.integer ? Math.round(value) : value, spec.min, spec.max);
  }
  const steps = Math.round((value - spec.min) / step);
  // Re-rounded to the step's own precision: `min + steps * step` accumulates
  // binary error that shows up as 0.30000000000000004 in the entry field.
  const snapped = roundTo(spec.min + steps * step, decimalsOf(step) + decimalsOf(spec.min));
  return clamp(spec.integer ? Math.round(snapped) : snapped, spec.min, spec.max);
}

/** `0` at `min`, `1` at `max`. Used to draw the fill and to place the thumb. */
export function normalized(value: number, spec: NumericSpec): number {
  const range = spec.max - spec.min;
  if (range <= 0) return 0;
  return clamp((value - spec.min) / range, 0, 1);
}

// --- text ---------------------------------------------------------------

/** What the entry field shows when it is not being typed into. */
export function formatValue(value: number, spec: NumericSpec): string {
  if (!Number.isFinite(value)) return "";
  const decimals = decimalsFor(spec);
  const fixed = value.toFixed(decimals);
  // Trailing zeros are kept when a step declares them — a step of 0.01 reading
  // "0.50" is easier to scan in a column than "0.5" — and dropped when the
  // decimals were this module's guess rather than the descriptor's.
  if (spec.step !== undefined || spec.integer) return fixed;
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/**
 * Read a typed value. `null` means "not a number", which the caller turns into
 * reverting the field rather than into a guess.
 */
export function parseValue(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Accept a typed value: parse, snap, clamp. `null` if it was not a number. */
export function commitText(text: string, spec: NumericSpec): number | null {
  const parsed = parseValue(text);
  return parsed === null ? null : quantize(parsed, spec);
}

// --- dragging -----------------------------------------------------------

export interface DragState {
  readonly anchorX: number;
  readonly anchorValue: number;
  readonly precision: DragPrecision;
  /**
   * True when the pointer maps straight onto the value at normal precision —
   * that is, when there is a track under it. A bare number has no position to
   * map from, so it is always relative.
   */
  readonly absolute: boolean;
  /** Client x of the track's left edge. Meaningless unless `absolute`. */
  readonly origin: number;
}

export interface DragResult {
  readonly state: DragState;
  readonly value: number;
}

function absoluteValue(x: number, state: DragState, spec: NumericSpec): number {
  const fraction = spec.span <= 0 ? 0 : (x - state.origin) / spec.span;
  return quantize(spec.min + fraction * (spec.max - spec.min), spec);
}

function relativeValue(
  x: number,
  state: DragState,
  spec: NumericSpec,
): number {
  const unitsPerPixel = spec.span <= 0 ? 0 : (spec.max - spec.min) / spec.span;
  const delta = (x - state.anchorX) * unitsPerPixel * PRECISION_FACTOR[state.precision];
  return quantize(state.anchorValue + delta, spec);
}

export interface BeginDragArgs {
  readonly x: number;
  /** The value before the pointer went down. */
  readonly current: number;
  readonly precision: DragPrecision;
  readonly absolute: boolean;
  readonly origin: number;
  readonly spec: NumericSpec;
}

/**
 * Start a drag.
 *
 * A track grabbed without a modifier jumps to where it was clicked, which is
 * what a slider is for. A track grabbed *with* a modifier does not jump: the
 * modifier was pressed in order to adjust the value that is already there.
 */
export function beginDrag(args: BeginDragArgs): DragResult {
  const state: DragState = {
    anchorX: args.x,
    anchorValue: args.current,
    precision: args.precision,
    absolute: args.absolute,
    origin: args.origin,
  };
  if (args.absolute && args.precision === "normal") {
    return { state, value: absoluteValue(args.x, state, args.spec) };
  }
  return { state, value: quantize(args.current, args.spec) };
}

export interface ContinueDragArgs {
  readonly state: DragState;
  readonly x: number;
  readonly precision: DragPrecision;
  /** The value the control is showing right now. */
  readonly current: number;
  readonly spec: NumericSpec;
}

/** Continue a drag, re-anchoring if the modifiers changed since the last move. */
export function continueDrag(args: ContinueDragArgs): DragResult {
  const state: DragState =
    args.precision === args.state.precision
      ? args.state
      : {
          ...args.state,
          anchorX: args.x,
          anchorValue: args.current,
          precision: args.precision,
        };

  const value =
    state.absolute && state.precision === "normal"
      ? absoluteValue(args.x, state, args.spec)
      : relativeValue(args.x, state, args.spec);
  return { state, value };
}

// --- keyboard -----------------------------------------------------------

/**
 * One arrow key's worth of movement.
 *
 * A parameter with no declared step gets one percent of its range, so a
 * continuous control is not either unusable or unreachable depending on how
 * wide it happens to be.
 */
export function keyStep(spec: NumericSpec, precision: DragPrecision): number {
  const base = spec.integer
    ? (spec.step ?? 1)
    : (spec.step ?? (spec.max - spec.min) / 100);
  const scaled = base * PRECISION_FACTOR[precision];
  return spec.integer ? Math.max(1, Math.round(scaled)) : scaled;
}

/** Apply an arrow key: move by `direction` steps and re-snap. */
export function nudge(
  value: number,
  direction: number,
  spec: NumericSpec,
  precision: DragPrecision,
): number {
  return quantize(value + direction * keyStep(spec, precision), spec);
}
