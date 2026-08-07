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
 * Where the source lives. Taken from the repository's own remote, so it is the
 * address of the thing the user is running rather than a guess.
 */
const SOURCE_URL = "https://github.com/orkcom-tech/dither-ork";

/**
 * The documentation.
 *
 * There is no separate documentation *site* yet, so this points at the docs
 * directory in the source repository, which is where docs/ARCHITECTURE.md,
 * docs/API.md and docs/DEVELOPMENT.md actually are. When a site exists this is
 * the one line that changes. Inventing a hostname that resolves to nothing
 * would be worse than linking somewhere real and slightly less convenient.
 */
const DOCS_URL = "https://github.com/orkcom-tech/dither-ork/tree/main/docs";

/**
 * The attribution copy.
 *
 * The second clause is required and is the whole reason the line is worth
 * showing: somebody who arrives at a free tool from a company that sells things
 * is entitled to know, without asking, that the free thing is free and that it
 * is not a demo of something else.
 */
const ATTRIBUTION =
  "dither-ork is free; the other products are not, and none of them require this one.";

/**
 * The status bar, and the place non-fatal capability degradation is stated for
 * the whole session (F-UI-12). OPFS or File System Access being absent never
 * stops anything, and it never goes unsaid either.
 *
 * ## Why the ORKCOM mark is not drawn here
 *
 * The visual direction asks for the company logo in this bar, linking to the
 * company site. Two inputs for that do not exist yet, and neither can be
 * invented without shipping something false.
 *
 * **The link has no destination.** No company URL appears in the README, the
 * package manifest, the docs or the git remote. A hostname guessed from the
 * GitHub organisation is a link that may 404, which is worse than no link.
 *
 * **The mark has no web-ready asset.** The design does exist, at
 * `docs/images/orkcom.jpeg`, but it is a JPEG on an opaque white ground with
 * roughly a third of the frame as margin. Dropped into a 24px dark bar it is a
 * white rectangle with a four-pixel mark inside it. Cropping and keying out the
 * white would be producing a *different* file and calling it the logo, which is
 * the one thing the direction says not to do.
 *
 * So the attribution ships as words, which is true and which works. When a
 * transparent SVG or PNG lands under `web/public/` and the company URL is
 * known, this span becomes an `<a href={COMPANY_URL}>` with an `<img>` of the
 * mark in front of the words; nothing else in this file has to move.
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
      <Stat label="zoom" value={view === null ? "—" : formatZoom(view.effectiveScale)} />
      {/*
        F-UI-03. `quality.degraded` is what the worker actually did, not an
        intention: it is true only while a frame is being shown at a reduced
        resolution. It must stay that way — a badge that is on when the preview
        is full is a badge nobody believes the next time it is right.
      */}
      <Stat
        label="preview"
        value={
          quality === null
            ? "—"
            : quality.degraded
              ? `reduced ${Math.round(quality.displayedScale * 100)}%`
              : "full"
        }
        warn={quality?.degraded === true}
      />
      <Stat label="effects" value={String(registry.size)} />
      {report.adapterInfo === undefined ? null : (
        <Stat label="gpu" value={describeAdapter(report.adapterInfo)} />
      )}

      <span className="shell__spacer" />

      {degraded.map((capability) => (
        <span key={capability.id} className="shell__status-warn" title={capability.detail}>
          {capability.label} unavailable
        </span>
      ))}

      <nav className="shell__status-links" aria-label="About dither-ork">
        <a
          className="shell__status-link"
          href={SOURCE_URL}
          target="_blank"
          rel="noreferrer"
          title="The source of the build you are running"
        >
          source
        </a>
        <a
          className="shell__status-link"
          href={DOCS_URL}
          target="_blank"
          rel="noreferrer"
          title="Architecture, API and development docs"
        >
          docs
        </a>
        <span className="shell__made-by" title={ATTRIBUTION}>
          Made by ORKCOM
        </span>
      </nav>
    </footer>
  );
}

/** One readout: a sans label naming the quantity, a mono value carrying it. */
function Stat({
  label,
  value,
  warn,
}: {
  readonly label: string;
  readonly value: string;
  readonly warn?: boolean;
}): React.ReactElement {
  return (
    <span className="shell__stat">
      <span className="shell__stat-label">{label}</span>
      <span
        className={
          warn === true ? "shell__stat-value shell__status-warn" : "shell__stat-value"
        }
      >
        {value}
      </span>
    </span>
  );
}

function describeAdapter(info: GPUAdapterInfo): string {
  const parts = [info.vendor, info.architecture].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join(" ") : "adapter";
}
