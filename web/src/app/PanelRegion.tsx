import React from "react";

import {
  MIN_PANEL_PX,
  panelState,
  regionExtent,
  resizeAdjacentPanels,
  setRegionCollapsed,
  togglePanel,
  type PanelRegion as Region,
  type ShellLayout,
} from "./layout";
import type { PanelDefinition } from "./slots";
import { Splitter } from "./Splitter";

export interface PanelRegionProps {
  readonly region: Region;
  readonly panels: readonly PanelDefinition[];
  readonly layout: ShellLayout;
  readonly onLayout: (next: ShellLayout) => void;
}

/**
 * One docked region and the panels in it.
 *
 * Panels stack along the region's cross axis — vertically in every region,
 * including the bottom one. A row layout for the bottom strip would read better
 * with two panels in it, and there is exactly one (the timeline); a second
 * arrangement that nothing uses is a second arrangement to keep working.
 *
 * Each panel collapses to its own header, and the divider between two open
 * panels re-weights that pair only.
 */
export function PanelRegion({
  region,
  panels,
  layout,
  onLayout,
}: PanelRegionProps): React.ReactElement | null {
  const elements = React.useRef(new Map<string, HTMLDivElement>());

  if (panels.length === 0) return null;

  const collapsed = layout.regions[region].collapsed;
  const extent = regionExtent(layout, region, true);
  // The region's size is the layout model's answer, spent here and nowhere
  // else. Left and right own a width; the bottom strip owns a height.
  const sizing: React.CSSProperties =
    region === "bottom" ? { height: extent } : { width: extent };

  if (collapsed) {
    return (
      <aside className={`shell__region shell__region--${region}`} style={sizing}>
        <div className="shell__rail">
          {panels.map((panel) => (
            <button
              key={panel.id}
              type="button"
              className="shell__rail-button"
              title={`Expand ${panel.title}`}
              onClick={() => onLayout(setRegionCollapsed(layout, region, false))}
            >
              {panel.title}
            </button>
          ))}
        </div>
      </aside>
    );
  }

  const open = panels.filter((panel) => !panelState(layout, panel.id).collapsed);

  const dragBetween = (first: string, second: string, clientY: number): void => {
    const a = elements.current.get(first);
    const b = elements.current.get(second);
    if (a === undefined || b === undefined) return;
    const aRect = a.getBoundingClientRect();
    const bRect = b.getBoundingClientRect();
    onLayout(
      resizeAdjacentPanels(
        layout,
        first,
        second,
        clientY - aRect.top,
        bRect.bottom - clientY,
      ),
    );
  };

  const nudgeBetween = (first: string, second: string, delta: number): void => {
    const a = elements.current.get(first);
    const b = elements.current.get(second);
    if (a === undefined || b === undefined) return;
    const aRect = a.getBoundingClientRect();
    const bRect = b.getBoundingClientRect();
    onLayout(
      resizeAdjacentPanels(
        layout,
        first,
        second,
        aRect.height + delta,
        bRect.height - delta,
      ),
    );
  };

  return (
    <aside className={`shell__region shell__region--${region}`} style={sizing}>
      {panels.map((panel, index) => {
        const state = panelState(layout, panel.id);
        const Body = panel.component;
        // The divider goes above this panel when the one before it is also
        // open; two collapsed headers do not need one between them.
        const previousOpen = panels
          .slice(0, index)
          .reverse()
          .find((candidate) => !panelState(layout, candidate.id).collapsed);
        const showSplitter =
          !state.collapsed && previousOpen !== undefined && open.length > 1;

        return (
          <React.Fragment key={panel.id}>
            {showSplitter && previousOpen !== undefined ? (
              <Splitter
                axis="horizontal"
                label={`${previousOpen.title} and ${panel.title}`}
                onDrag={(clientY) => dragBetween(previousOpen.id, panel.id, clientY)}
                onNudge={(delta) => nudgeBetween(previousOpen.id, panel.id, delta)}
                onToggle={() => onLayout(togglePanel(layout, panel.id))}
              />
            ) : null}
            <div
              className={`panel${state.collapsed ? " panel--collapsed" : ""}`}
              style={
                state.collapsed
                  ? undefined
                  : { flex: `${state.weight} 1 0`, minHeight: MIN_PANEL_PX }
              }
              ref={(element) => {
                if (element === null) elements.current.delete(panel.id);
                else elements.current.set(panel.id, element);
              }}
            >
              <button
                type="button"
                className="panel__header"
                aria-expanded={!state.collapsed}
                onClick={() => onLayout(togglePanel(layout, panel.id))}
              >
                <span className="panel__chevron">{state.collapsed ? "▶" : "▼"}</span>
                {panel.title}
              </button>
              {state.collapsed ? null : (
                <div className="panel__body">
                  <Body />
                </div>
              )}
            </div>
          </React.Fragment>
        );
      })}
    </aside>
  );
}
