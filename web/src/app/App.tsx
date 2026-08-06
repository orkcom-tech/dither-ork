import React from "react";

import type { CapabilityReport } from "../lib/capabilities";
import { logger } from "../lib/log";
import type { EffectRegistry } from "../registry";
import { formatZoom, type QualityEvent, type ViewEvent, type Viewport } from "../viewport";
import { PanelRegion } from "./PanelRegion";
import { Splitter } from "./Splitter";
import { ViewportContext, ViewportHost } from "./ViewportHost";
import {
  DEFAULT_LAYOUT,
  resizeRegion,
  toggleRegion,
  type PanelRegion as Region,
  type ShellLayout,
} from "./layout";
import {
  panelSlots,
  panelsInRegion,
  toolbarItemsOnSide,
  toolbarSlots,
  type ToolbarItemDefinition,
} from "./slots";
import { labelForMode, type ThemeController } from "./theme";
import "../ui/theme.css";
import "./app.css";

const log = logger("app");

export interface AppProps {
  readonly report: CapabilityReport;
  readonly registry: EffectRegistry;
  readonly theme: ThemeController;
  /** Called with the viewport as it mounts and unmounts. */
  readonly onViewport?: (viewport: Viewport | null) => void;
}

/**
 * The application shell — F-UI-08.
 *
 * Four docked regions around a viewport, every one of them resizable and
 * collapsible, and every one of them **filled by somebody else**: this file
 * imports no panel. Panels arrive through `slots.ts`, which is what lets the
 * stack editor, the properties panel and the palette editor be written in
 * parallel with this and with each other.
 *
 * A region nothing has registered into is not rendered. There is no empty box
 * and no "coming soon" strip — the shell shows what exists.
 */
export function App({
  report,
  registry,
  theme,
  onViewport,
}: AppProps): React.ReactElement {
  const [layout, setLayout] = React.useState<ShellLayout>(DEFAULT_LAYOUT);
  const [viewport, setViewport] = React.useState<Viewport | null>(null);
  const shell = React.useRef<HTMLDivElement | null>(null);
  const body = React.useRef<HTMLDivElement | null>(null);

  const panels = React.useSyncExternalStore(panelSlots.subscribe, () => panelSlots.all());
  const toolbarItems = React.useSyncExternalStore(toolbarSlots.subscribe, () =>
    toolbarSlots.all(),
  );

  const handleViewport = React.useCallback(
    (next: Viewport | null) => {
      setViewport(next);
      onViewport?.(next);
    },
    [onViewport],
  );

  const left = panelsInRegion(panels, "left");
  const right = panelsInRegion(panels, "right");
  const bottom = panelsInRegion(panels, "bottom");

  const resize = (region: Region, size: number, available: number): void => {
    setLayout((current) => resizeRegion(current, region, size, available));
  };

  const dragRegion = (region: Region, clientPosition: number): void => {
    const container = region === "bottom" ? shell.current : body.current;
    if (container === null) return;
    const rect = container.getBoundingClientRect();
    if (region === "left") resize("left", clientPosition - rect.left, rect.width);
    else if (region === "right") resize("right", rect.right - clientPosition, rect.width);
    else resize("bottom", rect.bottom - clientPosition, rect.height);
  };

  const nudgeRegion = (region: Region, delta: number): void => {
    // "Grow" is the direction away from the viewport, so the right column and
    // the bottom strip take the opposite sign to the left column.
    const signed = region === "left" ? delta : -delta;
    setLayout((current) =>
      resizeRegion(current, region, current.regions[region].size + signed),
    );
  };

  const collapse = (region: Region): void => {
    // The log line sits here rather than inside the state updater: React calls
    // an updater twice in development to prove it is pure, and a log line in
    // one is both a lie about how often it happened and an impurity.
    const next = toggleRegion(layout, region);
    log.info("region " + (next.regions[region].collapsed ? "collapsed" : "expanded"), {
      region,
    });
    setLayout(next);
  };

  return (
    <ViewportContext.Provider value={viewport}>
      <div className="shell" ref={shell}>
        <header className="shell__toolbar">
          <div className="shell__brand">dither-ork</div>
          <ToolbarGroup items={toolbarItemsOnSide(toolbarItems, "start")} />
          <div className="shell__spacer" />
          <ToolbarGroup items={toolbarItemsOnSide(toolbarItems, "end")} />
          <ThemeControl theme={theme} />
        </header>

        <div className="shell__body" ref={body}>
          <PanelRegion
            region="left"
            panels={left}
            layout={layout}
            onLayout={setLayout}
          />
          {left.length > 0 && !layout.regions.left.collapsed ? (
            <Splitter
              axis="vertical"
              label="the left panel"
              onDrag={(x) => dragRegion("left", x)}
              onNudge={(delta) => nudgeRegion("left", delta)}
              onToggle={() => collapse("left")}
            />
          ) : null}

          <main className="shell__centre">
            <ViewportHost onViewport={handleViewport} />
          </main>

          {right.length > 0 && !layout.regions.right.collapsed ? (
            <Splitter
              axis="vertical"
              label="the right panel"
              onDrag={(x) => dragRegion("right", x)}
              onNudge={(delta) => nudgeRegion("right", delta)}
              onToggle={() => collapse("right")}
            />
          ) : null}
          <PanelRegion
            region="right"
            panels={right}
            layout={layout}
            onLayout={setLayout}
          />
        </div>

        {bottom.length > 0 && !layout.regions.bottom.collapsed ? (
          <Splitter
            axis="horizontal"
            label="the bottom panel"
            onDrag={(y) => dragRegion("bottom", y)}
            onNudge={(delta) => nudgeRegion("bottom", delta)}
            onToggle={() => collapse("bottom")}
          />
        ) : null}
        <PanelRegion
          region="bottom"
          panels={bottom}
          layout={layout}
          onLayout={setLayout}
        />

        <StatusBar viewport={viewport} report={report} registry={registry} />
      </div>
    </ViewportContext.Provider>
  );
}

function ToolbarGroup({
  items,
}: {
  readonly items: readonly ToolbarItemDefinition[];
}): React.ReactElement | null {
  if (items.length === 0) return null;
  return (
    <div className="shell__toolbar-group">
      {items.map((item) => {
        const Item = item.component;
        return <Item key={item.id} />;
      })}
    </div>
  );
}

function ThemeControl({ theme }: { readonly theme: ThemeController }): React.ReactElement {
  const mode = React.useSyncExternalStore(theme.subscribe, () => theme.mode);
  const resolved = React.useSyncExternalStore(theme.subscribe, () => theme.theme);
  return (
    <button
      type="button"
      className="ui-button"
      title={`${labelForMode(mode, resolved)} — click to change`}
      onClick={() => theme.cycle()}
    >
      {mode === "system" ? `sys/${resolved}` : mode}
    </button>
  );
}

/**
 * The status bar, and the place non-fatal capability degradation is stated for
 * the whole session (F-UI-12). OPFS or File System Access being absent never
 * stops anything, and it never goes unsaid either.
 */
function StatusBar({
  viewport,
  report,
  registry,
}: {
  readonly viewport: Viewport | null;
  readonly report: CapabilityReport;
  readonly registry: EffectRegistry;
}): React.ReactElement {
  const [view, setView] = React.useState<ViewEvent | null>(null);
  const [quality, setQuality] = React.useState<QualityEvent | null>(null);

  React.useEffect(() => {
    if (viewport === null) return;
    const offs = [
      viewport.on("view", setView),
      viewport.on("quality", setQuality),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [viewport]);

  const degraded = report.capabilities.filter(
    (c) => !c.fatal && c.state === "missing",
  );

  return (
    <footer className="shell__status">
      <span>
        zoom <b>{view === null ? "—" : formatZoom(view.effectiveScale)}</b>
      </span>
      <span>
        preview{" "}
        <b className={quality?.degraded === true ? "shell__status-warn" : undefined}>
          {quality === null
            ? "—"
            : quality.degraded
              ? `reduced (${Math.round(quality.displayedScale * 100)}%)`
              : "full"}
        </b>
      </span>
      <span>
        effects <b>{registry.size}</b>
      </span>
      {report.adapterInfo === undefined ? null : (
        <span>
          gpu <b>{describeAdapter(report.adapterInfo)}</b>
        </span>
      )}
      <span className="shell__spacer" />
      {degraded.map((capability) => (
        <span key={capability.id} className="shell__status-warn" title={capability.detail}>
          {capability.label} unavailable
        </span>
      ))}
    </footer>
  );
}

function describeAdapter(info: GPUAdapterInfo): string {
  const parts = [info.vendor, info.architecture].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join(" ") : "adapter";
}
