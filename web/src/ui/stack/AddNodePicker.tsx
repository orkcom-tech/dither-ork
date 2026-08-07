/**
 * The stack editor's name for the effect picker.
 *
 * The picker itself moved to `web/src/ui/picker/`, because it stopped being a
 * detail of this panel: it is the most-used control in the application, it has a
 * model, a matcher and a stylesheet of its own, and F-UI-13's item help lives in
 * it. Nothing about it is specific to the stack list it currently opens over.
 *
 * This file stays so that the stack editor keeps importing one name from one
 * place. The props are the picker's props unchanged — a rename, not an adapter,
 * and nothing here decides anything.
 */

export {
  EffectPicker as AddNodePicker,
  type EffectPickerProps as AddNodePickerProps,
} from "../picker";
