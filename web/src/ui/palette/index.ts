/**
 * The palette system — F-CO-01 through F-CO-06.
 *
 * Importing this module registers the palette panel into the shell's `palette`
 * slot. That import is the whole integration, and `app/main.tsx` does it.
 *
 * # How it reaches the document
 *
 * `paletteStore` owns the *editor's* state — swatches, locks, output mode,
 * extraction settings — which is more than a colour list, and the document owns
 * the `Palette` a render reads and a `.dork` writes, which has to be undoable
 * with every other edit. `state/session.ts` bridges the two in both directions,
 * with a re-entrance guard, because each direction's write is the other's
 * notification. Read {@link store} for the four-call contract; the part that is
 * not obvious is `change.permutation`, which is non-null exactly when a reorder
 * left the colours alone and moved only their positions, and which every index
 * map must be put through with {@link remapIndices} or it silently addresses
 * the wrong entries.
 *
 * # What is here and what is not
 *
 * Built: the editor (add, remove, reorder, hex, picker, locks — F-CO-05), the
 * hardware library read from the core (F-CO-04), extraction with all three
 * algorithms and selectable K (F-CO-02), sorting and OKLab ramps (F-CO-06),
 * output modes as palette generators (F-CO-01), and the distance metric as the
 * look control it is (F-CO-03).
 *
 * Not built, and deliberately: CMYK separation, the fifth output mode F-CO-01
 * names — it is four separations at four screen angles, not a colour list, so
 * it cannot honestly be a palette generator. Per-node palette override
 * (F-CO-07), alpha handling (F-CO-08), hue-targeted recolour (F-CO-09), the
 * index remap table (F-CO-10), import/export (F-CO-11) and sharing (F-CO-12)
 * are separate requirements and are not in this round.
 */

import { registerPanel } from "../../app";
import { PalettePanel } from "./PalettePanel";

registerPanel({
  id: "palette",
  title: "Palette",
  region: "right",
  order: 1,
  component: PalettePanel,
});

export { PalettePanel } from "./PalettePanel";

export {
  clampByte,
  formatHex,
  hueAngle,
  inkOn,
  linearToByte,
  oklabToLinear,
  packColors,
  parseHex,
  tripletToLinear,
  tripletToOklab,
  unpackColors,
  type Oklab,
} from "./color";

export {
  CUSTOM_PALETTE_ID,
  MAX_SWATCHES,
  MIN_SWATCHES,
  documentPalette,
  initialPaletteState,
  reduce,
  type PaletteChange,
  type PaletteChangeReason,
  type PaletteEdit,
  type PaletteEditOutcome,
  type PaletteState,
  type Swatch,
} from "./model";

export {
  SORT_KEYS,
  applyPermutation,
  assertPermutation,
  canSortBy,
  identityOrder,
  invertPermutation,
  isIdentity,
  isPermutation,
  moveOrder,
  remapIndices,
  sortKeyLabel,
  sortOrder,
  PermutationError,
  type SortKey,
} from "./order";

export { RAMP_STEP_RANGE, RampError, canRamp, oklabRamp, rampDistance, type Ramp } from "./ramp";

export {
  GREY_LEVEL_RANGE,
  OUTPUT_MODE_KINDS,
  PALETTE_SIZE_WARNING,
  RGB_LEVEL_RANGE,
  OutputModeError,
  derivedColors,
  describeMode,
  entryCount,
  levelValues,
  modeLabel,
  modeOfKind,
  type OutputMode,
  type OutputModeKind,
} from "./modes";

export {
  DEFAULT_EXTRACT_SETTINGS,
  EXTRACT_METHODS,
  K_RANGE,
  canExtract,
  entriesToExtract,
  lockedCount,
  mergeLocked,
  methodLabel,
  sourceToSrgbBytes,
  type ExtractMethodId,
  type ExtractSettings,
  type ExtractionReport,
  type PaletteSource,
} from "./extract";

export { paletteSize, searchPalettes, type BuiltinPalette } from "./library";

export {
  createPaletteStore,
  paletteStore,
  type LibraryStatus,
  type PaletteListener,
  type PaletteSnapshot,
  type PaletteStore,
} from "./store";

export { extractFromSource, fetchBuiltinPalettes, loadCore, type CoreExtraction } from "./core";
