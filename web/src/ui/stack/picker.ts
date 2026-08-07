/**
 * The picker's model, re-exported under the path the stack editor knows it by.
 *
 * The model moved to `web/src/ui/picker/model.ts` along with the component — see
 * `./AddNodePicker.tsx` for why. Kept as a re-export rather than deleted so that
 * this panel's barrel and its tests go on naming one module, and so that the
 * move is a fact readers can find rather than a set of import paths that
 * silently changed.
 *
 * Nothing is declared here. Anything that would be added to the picker's model
 * belongs in `../picker/model.ts`.
 */

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
} from "../picker/model";
