/**
 * The application shell — what a panel author needs from it.
 *
 * A panel is a module that calls {@link registerPanel} at import time and
 * exports nothing the shell has to know about:
 *
 * ```ts
 * import { registerPanel } from "../app";
 *
 * registerPanel({
 *   id: "stack",            // one of PANEL_IDS
 *   title: "Stack",
 *   region: "left",
 *   order: 0,
 *   component: StackPanel,
 * });
 * ```
 *
 * The shell imports no panel, so nothing central is edited and two panels
 * written in parallel cannot conflict. The integration step is one import of
 * the panel's module from `main.tsx`.
 *
 * Conventions this shell sets, and which everything mounted into it follows:
 *
 * - **Every `.tsx` file imports React**: `import React from "react"`. The build
 *   uses the classic JSX transform — `web/tsconfig.json` declares no `jsx`
 *   option, so esbuild emits `React.createElement` and `npm run typecheck`
 *   passes `--jsx react` to agree with it. A file that forgets the import fails
 *   to type-check rather than failing at runtime.
 * - **No colour literals.** Every colour is a custom property from
 *   `src/ui/theme/tokens.css`; that is what makes both themes work and what
 *   F-UI-09 builds on. The chrome is neutral graphite and the ork green is a
 *   *state* colour — selected, live, playing — so a panel that reaches for
 *   `--accent` to decorate something is reaching for the wrong token.
 * - **Sans for labels, mono for values.** `--font-sans` is the document
 *   default; apply `--font-mono` (or the `.mono` class) to the digits, ids and
 *   codes a reader compares, and to nothing else.
 * - **The viewport is not React.** Reach it with {@link useViewport} and call
 *   methods on it. Before dragging a control that changes the picture, call
 *   `beginInteraction("param:<node>.<key>")` and end it on release — that is
 *   F-UI-03's adaptive preview, and the badge names what is degraded.
 */

export { App, type AppProps } from "./App";
export {
  boot,
  classifyBoot,
  describeStartupError,
  type BootOutcome,
  type StartupErrorDescription,
} from "./boot";
export { Splitter, type SplitterProps } from "./Splitter";
export {
  StartupFailureScreen,
  type StartupFailure,
  type StartupFailureScreenProps,
} from "./StartupFailureScreen";
export { UnsupportedScreen } from "./UnsupportedScreen";
export { ViewportContext, ViewportHost, useViewport } from "./ViewportHost";
export {
  DEFAULT_LAYOUT,
  DEFAULT_PANEL_STATE,
  MIN_CENTRE,
  MIN_PANEL_PX,
  PANEL_REGIONS,
  RAIL_SIZE,
  REGION_LIMITS,
  clampRegionSize,
  panelState,
  regionExtent,
  regionState,
  resizeAdjacentPanels,
  resizeRegion,
  setPanelCollapsed,
  setRegionCollapsed,
  togglePanel,
  toggleRegion,
  type PanelRegion,
  type PanelState,
  type RegionState,
  type ShellLayout,
} from "./layout";
export {
  DuplicateSlotError,
  PANEL_IDS,
  createSlotRegistry,
  panelSlots,
  panelsInRegion,
  registerPanel,
  registerToolbarItem,
  toolbarItemsOnSide,
  toolbarSlots,
  type PanelDefinition,
  type PanelId,
  type SlotRegistry,
  type ToolbarItemDefinition,
} from "./slots";
export {
  DEFAULT_MODE,
  THEME_MODES,
  applyTheme,
  createThemeController,
  isThemeMode,
  labelForMode,
  nextMode,
  resolveTheme,
  type Theme,
  type ThemeController,
  type ThemeMode,
} from "./theme";
