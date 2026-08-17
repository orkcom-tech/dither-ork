/**
 * Node registry entry point.
 *
 * Two calls the application makes, in this order:
 *
 * - `loadEffectRegistry()` — discover every effect module, validate the whole
 *   catalogue, return the sealed registry.
 * - `loadGpuEffects()` — resolve every registered `gpu` effect to its compute
 *   passes, and refuse a catalogue where an effect has no way to be rendered.
 *
 * Everything else in this directory is the machinery behind those two, and is
 * exported so it can be exercised directly.
 *
 * Failure is loud and terminal in both. A registry that cannot be validated
 * throws, and startup is expected to surface that rather than continue — a build
 * whose catalogue is wrong renders wrong documents, and it does it
 * convincingly.
 */

export {
  discoverEffects,
  EffectDiscoveryError,
  type DiscoveredEffect,
} from "./discovery";
export { loadEffectRegistry } from "./load";
export {
  createEffectRegistry,
  EffectRegistryBuilder,
  RegistryValidationError,
  UnknownEffectError,
  type EffectRegistry,
} from "./registry";
export {
  createGpuEffectResolver,
  discoverGpuEffects,
  loadGpuEffects,
  validateGpuCoverage,
  GpuCoverageError,
  GpuEffectMismatchError,
  GpuEffectSourceError,
  UnknownGpuEffectError,
  type DiscoveredGpuEffect,
  type GpuCoverageIssue,
  type GpuCoverageIssueCode,
  type GpuEffectResolver,
} from "./gpu-effects";
export {
  describeMiss,
  matchesFilter,
  searchCatalogue,
  searchEffects,
  type CatalogueSearch,
  type EffectFilter,
  type EffectSearchResult,
  type SearchMiss,
} from "./search";
export {
  UNBUILT_FEATURES,
  unbuiltFor,
  type UnbuiltFeature,
} from "./unbuilt";
export {
  coerceParams,
  defaultParams,
  validateParams,
  type EffectParams,
  type EffectParamValue,
  type ParamAdjustment,
  type ParamAdjustmentKind,
  type ParamCoercion,
  type ParamIssue,
  type ParamIssueCode,
  type ParamSetValidation,
} from "./params";
export {
  analyseSources,
  validateStack,
  type ShadowedNode,
  type SourceAnalysis,
  type StackIssue,
  type StackIssueCode,
  type StackNodeComposite,
  type StackNodeRef,
  type StackValidation,
} from "./stack";
