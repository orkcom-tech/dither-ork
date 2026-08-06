/**
 * The properties panel — every control on it generated from the registry
 * descriptor, with no per-effect code anywhere in this directory.
 *
 * Wiring it in is one call, from wherever the document store is created:
 *
 * ```ts
 * import { registerPropertiesPanel } from "./ui/properties";
 * registerPropertiesPanel({ store, registry });
 * ```
 *
 * The store contract is `../stack/store.ts`, which both panels share.
 */

import React from "react";

import { registerPanel } from "../../app";
import { logger } from "../../lib/log";
import type { PanelDependencies } from "../stack/store";
import { PropertiesPanel } from "./PropertiesPanel";

const log = logger("app");

/**
 * Register the properties panel into the shell's right region.
 *
 * Call once. A second call is a duplicate slot registration and the shell
 * throws.
 */
export function registerPropertiesPanel(dependencies: PanelDependencies): void {
  registerPanel({
    id: "properties",
    title: "Properties",
    region: "right",
    order: 0,
    component: () => React.createElement(PropertiesPanel, dependencies),
  });
  log.info("properties panel registered", {
    effects: dependencies.registry.size,
  });
}

export { PropertiesPanel, type PropertiesPanelProps } from "./PropertiesPanel";
export { ParamControl, type ParamControlProps } from "./ParamControl";
export { NumberField, type NumberFieldProps } from "./NumberField";
export { ColorField, type ColorFieldProps } from "./ColorField";
export { SeedField, type SeedFieldProps } from "./SeedField";
export { CurveEditor, type CurveEditorProps } from "./CurveEditor";
export {
  PRECISION_FACTOR,
  VALUE_DRAG_SPAN,
  beginDrag,
  clamp,
  commitText,
  continueDrag,
  decimalsFor,
  decimalsOf,
  formatValue,
  keyStep,
  normalized,
  nudge,
  parseValue,
  precisionFor,
  quantize,
  type DragPrecision,
  type DragResult,
  type DragState,
  type NumericSpec,
} from "./numeric";
export {
  CHANNEL_LABEL,
  clampComponent,
  fromHex,
  toHex,
  withComponent,
} from "./color";
export {
  MIN_POINT_GAP,
  copyCurve,
  evaluateCurve,
  insertCurvePoint,
  moveCurvePoint,
  nearestPoint,
  removeCurvePoint,
  sampleCurve,
  type CurveInsertion,
} from "./curve";
export { randomSeed } from "./seed";
