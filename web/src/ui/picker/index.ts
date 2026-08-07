/**
 * The effect picker — F-ST-08, plus the search and item-help halves of F-UI-13
 * and F-UI-15.
 *
 * A component and its model, not a registered panel: the picker has no place of
 * its own in the shell. It is opened by whatever is adding a node — today the
 * stack editor, which renders it in place of its list — so it takes the stack it
 * is judging against and the insertion point as props rather than reaching for a
 * store.
 *
 * ```tsx
 * <EffectPicker
 *   registry={registry}
 *   stack={refs}
 *   insertAt={insertAt}
 *   onPick={add}
 *   onClose={close}
 * />
 * ```
 */

export { EffectPicker, type EffectPickerProps } from "./EffectPicker";
export {
  buildPicker,
  entryOf,
  firstAvailable,
  flatten,
  stepHighlight,
  unbuiltNamedBy,
  type PickerEntry,
  type PickerGroup,
  type PickerModel,
  type PickerRequest,
} from "./model";
export {
  contains,
  explainMatch,
  hasMatch,
  highlight,
  highlightTokens,
  tokenize,
  type EffectMatch,
  type MatchField,
  type MatchReason,
  type Segment,
} from "./match";
