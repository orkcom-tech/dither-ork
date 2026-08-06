/**
 * The panel layout model — F-UI-08.
 *
 * Pure, immutable, and free of React and the DOM, for the same reason the view
 * transform is: a layout bug that can only be reproduced by dragging a splitter
 * is a layout bug nobody fixes. Everything that decides *how big a region is
 * allowed to be* is here and is tested; the components measure rectangles and
 * call these functions.
 *
 * Two axes of adjustment, and they are different things:
 *
 * - **A region** — the left column, the right column, the bottom strip — has a
 *   size in CSS pixels along its own axis, and collapses to a rail.
 * - **A panel** inside a region has a *weight*, not a size. Weights rather than
 *   pixels because the region's own size changes underneath them, and pixel
 *   sizes that do not add up to the region are a source of drift that shows as
 *   a one-pixel gap that grows every time you drag.
 *
 * Layout is **not persisted**. Restoring it across reloads is step 14 of the
 * build order along with themes and shortcuts, and a half-persisted layout —
 * regions restored, panel weights not — would be worse than none.
 */

export type PanelRegion = "left" | "right" | "bottom";

export const PANEL_REGIONS: readonly PanelRegion[] = ["left", "right", "bottom"];

export interface RegionState {
  /** Size along the region's own axis, CSS pixels. Width for left/right. */
  readonly size: number;
  readonly collapsed: boolean;
}

export interface PanelState {
  readonly collapsed: boolean;
  /** Share of its region's free space. Only ratios between siblings matter. */
  readonly weight: number;
}

export interface ShellLayout {
  readonly regions: Readonly<Record<PanelRegion, RegionState>>;
  readonly panels: Readonly<Record<string, PanelState>>;
}

export interface RegionLimits {
  readonly min: number;
  readonly max: number;
  readonly initial: number;
}

export const REGION_LIMITS: Readonly<Record<PanelRegion, RegionLimits>> = {
  left: { min: 180, max: 520, initial: 260 },
  right: { min: 220, max: 560, initial: 300 },
  bottom: { min: 120, max: 480, initial: 180 },
};

/** The viewport never gets squeezed below this, whatever a splitter is told. */
export const MIN_CENTRE = 280;

/** A panel never shrinks below its own header plus a usable sliver. */
export const MIN_PANEL_PX = 96;

/** Width of the rail a collapsed region leaves behind, CSS pixels. */
export const RAIL_SIZE = 28;

export const DEFAULT_PANEL_STATE: PanelState = { collapsed: false, weight: 1 };

export const DEFAULT_LAYOUT: ShellLayout = {
  regions: {
    left: { size: REGION_LIMITS.left.initial, collapsed: false },
    right: { size: REGION_LIMITS.right.initial, collapsed: false },
    bottom: { size: REGION_LIMITS.bottom.initial, collapsed: false },
  },
  panels: {},
};

export function regionState(layout: ShellLayout, region: PanelRegion): RegionState {
  return layout.regions[region];
}

/**
 * Replace one region, keeping the record's exact shape.
 *
 * Written out rather than `{ ...regions, [region]: next }` because a computed
 * key whose type is a union widens the result to an index signature, and the
 * shell would then be reading regions that the type system no longer promises
 * exist.
 */
function withRegion(
  regions: Readonly<Record<PanelRegion, RegionState>>,
  region: PanelRegion,
  next: RegionState,
): Record<PanelRegion, RegionState> {
  return {
    left: region === "left" ? next : regions.left,
    right: region === "right" ? next : regions.right,
    bottom: region === "bottom" ? next : regions.bottom,
  };
}

export function panelState(layout: ShellLayout, panelId: string): PanelState {
  return layout.panels[panelId] ?? DEFAULT_PANEL_STATE;
}

/**
 * Clamp a region size against its own limits and, when the caller knows it,
 * the space actually available.
 *
 * `available` is the full extent of the axis the region sits on, so the second
 * clamp is what stops a wide left column from leaving the viewport four pixels
 * wide on a small window.
 */
export function clampRegionSize(
  region: PanelRegion,
  size: number,
  available?: number,
): number {
  const limits = REGION_LIMITS[region];
  const ceiling =
    available === undefined
      ? limits.max
      : Math.min(limits.max, Math.max(limits.min, available - MIN_CENTRE));
  if (!Number.isFinite(size)) return limits.initial;
  return Math.min(ceiling, Math.max(limits.min, size));
}

export function resizeRegion(
  layout: ShellLayout,
  region: PanelRegion,
  size: number,
  available?: number,
): ShellLayout {
  const clamped = clampRegionSize(region, size, available);
  const current = layout.regions[region];
  if (current.size === clamped && !current.collapsed) return layout;
  // Dragging a collapsed region's rail expands it; a splitter that moves but
  // changes nothing visible is the worse alternative.
  return {
    ...layout,
    regions: withRegion(layout.regions, region, { size: clamped, collapsed: false }),
  };
}

export function setRegionCollapsed(
  layout: ShellLayout,
  region: PanelRegion,
  collapsed: boolean,
): ShellLayout {
  const current = layout.regions[region];
  if (current.collapsed === collapsed) return layout;
  return {
    ...layout,
    regions: withRegion(layout.regions, region, { ...current, collapsed }),
  };
}

export function toggleRegion(layout: ShellLayout, region: PanelRegion): ShellLayout {
  return setRegionCollapsed(layout, region, !layout.regions[region].collapsed);
}

/** Extent a region occupies on screen: its size, or the rail when collapsed. */
export function regionExtent(
  layout: ShellLayout,
  region: PanelRegion,
  hasPanels: boolean,
): number {
  // A region nothing has registered into takes no space at all. That is what
  // makes the slots fillable one at a time without the shell showing an empty
  // box where a panel is going to be.
  if (!hasPanels) return 0;
  const state = layout.regions[region];
  return state.collapsed ? RAIL_SIZE : state.size;
}

export function setPanelCollapsed(
  layout: ShellLayout,
  panelId: string,
  collapsed: boolean,
): ShellLayout {
  const current = panelState(layout, panelId);
  if (current.collapsed === collapsed) return layout;
  return {
    ...layout,
    panels: { ...layout.panels, [panelId]: { ...current, collapsed } },
  };
}

export function togglePanel(layout: ShellLayout, panelId: string): ShellLayout {
  return setPanelCollapsed(layout, panelId, !panelState(layout, panelId).collapsed);
}

/**
 * Re-weight two adjacent panels from the pixel sizes a splitter drag implies.
 *
 * The pair's combined weight is preserved, so panels elsewhere in the region
 * are untouched — dragging the divider between properties and palette must not
 * move anything above them. Both sides are held at {@link MIN_PANEL_PX}, which
 * is enforced here rather than in CSS so that the state and the picture cannot
 * disagree.
 */
export function resizeAdjacentPanels(
  layout: ShellLayout,
  first: string,
  second: string,
  firstPx: number,
  secondPx: number,
): ShellLayout {
  const total = firstPx + secondPx;
  if (!Number.isFinite(total) || total <= 0) return layout;

  const a = panelState(layout, first);
  const b = panelState(layout, second);
  const combined = a.weight + b.weight;
  if (combined <= 0) return layout;

  const minShare = Math.min(MIN_PANEL_PX / total, 0.5);
  const share = Math.min(1 - minShare, Math.max(minShare, firstPx / total));

  return {
    ...layout,
    panels: {
      ...layout.panels,
      [first]: { ...a, weight: combined * share },
      [second]: { ...b, weight: combined * (1 - share) },
    },
  };
}
