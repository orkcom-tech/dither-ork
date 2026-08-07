/**
 * Surprise Me — F-SM-01 through F-SM-12.
 *
 * Generates a complete random document: palette, stack composition, node order,
 * every parameter, node seeds and (once the modulator core exists) animation
 * bindings. It is a first-class feature rather than a toy, and everything in
 * here is pure: it reads the node registry, draws from a seeded PCG32, and emits
 * a `.dork` document. It never touches a pixel, a device or the DOM.
 *
 * ```ts
 * import { decidePalette, generateSurprise, mintSeed, NO_LOCKS } from "../surprise";
 *
 * const seed = mintSeed();                       // the one unseeded draw
 * const decision = decidePalette(seed, { library });
 * const palette = await resolve(decision);       // extraction needs the image
 * const { document, summary } = generateSurprise({
 *   seed, registry, chaos: 0.35, locks: NO_LOCKS,
 *   base: store.document, palette, animate: false,
 * });
 * store.loadDocument(document, "Surprise Me");
 * ```
 *
 * What lives where:
 *
 * - `rng.ts`        PCG32, byte-identical to `core/…/rng.rs`, and named streams.
 * - `seed.ts`       the 64-bit seed: its text form, and the one place a fresh
 *                   one is minted.
 * - `sample.ts`     the distributions the registry's surprise metadata declares.
 * - `oklab.ts`      OKLCh to sRGB with gamut-safe chroma reduction.
 * - `grammar.ts`    the stack grammar (F-SM-03) and the chaos ends (F-SM-07).
 * - `params.ts`     a node's parameters, one stream per key (F-SM-04).
 * - `palette.ts`    the three palette modes (F-SM-05).
 * - `animation.ts`  modulator bindings (F-SM-09), and what it assumes.
 * - `generate.ts`   the document, the locks (F-SM-06), per-node reroll (F-SM-08).
 * - `history.ts`    the last N surprises (F-SM-10).
 *
 * The UI half — the button, the panel, the shortcut, the thumbnails — is
 * `web/src/ui/surprise/`.
 */

export {
  ANIMATION_CHAOS,
  MAX_BINDINGS,
  isBindable,
  retainBindings,
  sampleBindings,
  type BindingRequest,
} from "./animation";

export {
  NO_LOCKS,
  SurpriseError,
  generateSurprise,
  rerollNodeParams,
  type SurpriseLocks,
  type SurpriseRequest,
  type SurpriseResult,
  type SurpriseSummary,
} from "./generate";

export {
  CHAOS,
  GrammarError,
  composeStack,
  lerp,
  type ComposedStack,
  type StackGrammarOptions,
} from "./grammar";

export {
  HISTORY_LIMIT,
  describeEntry,
  pushSurprise,
  withThumbnail,
  type SurpriseHistoryEntry,
} from "./history";

export {
  chromaTaper,
  evenLightness,
  maxChroma,
  oklchToSrgb,
  type Oklch,
} from "./oklab";

export {
  PaletteSurpriseError,
  decidePalette,
  describePaletteDecision,
  paletteFromExtraction,
  paletteFromLibrary,
  synthesizePalette,
  type ColorScheme,
  type PaletteDecision,
  type PaletteDecisionOptions,
} from "./palette";

export {
  PARAM_CHAOS,
  sampleNodeParams,
  sampleNodeSeed,
  type NodeParamRequest,
} from "./params";

export {
  Pcg32,
  RngRangeError,
  seededPcg32,
  streamFor,
  streamOf,
} from "./rng";

export {
  CURVE_ARCHETYPES,
  SAMPLE_QUANTUM,
  SampleError,
  quantise,
  sampleBool,
  sampleColor,
  sampleCurve,
  sampleEnum,
  sampleHue,
  sampleNumeric,
  standardNormal,
  towardDefault,
  weightedChoice,
} from "./sample";

export {
  SEED_TEXT_PATTERN,
  formatSeed,
  mintSeed,
  parseSeed,
  seedOfDocument,
} from "./seed";
