import { describe, expect, it } from "vitest";

import {
  DuplicateSlotError,
  PANEL_IDS,
  createSlotRegistry,
  panelsInRegion,
  toolbarItemsOnSide,
  type PanelDefinition,
  type ToolbarItemDefinition,
} from "./slots";

/**
 * A panel definition with a component that renders nothing. It is not a stub
 * panel — no such panel is registered into the running app — it is the smallest
 * value that satisfies the type so the registry itself can be tested.
 */
function panel(
  id: PanelDefinition["id"],
  region: PanelDefinition["region"],
  order: number,
): PanelDefinition {
  return { id, title: id, region, order, component: () => null };
}

function toolbarItem(
  id: string,
  side: ToolbarItemDefinition["side"],
  order: number,
): ToolbarItemDefinition {
  return { id, side, order, component: () => null };
}

describe("panel ids", () => {
  it("are the four panels F-UI-08 names", () => {
    expect([...PANEL_IDS]).toEqual(["stack", "properties", "palette", "timeline"]);
  });
});

describe("slot registry", () => {
  it("starts empty, so a region with nothing in it can be laid out as nothing", () => {
    expect(createSlotRegistry<PanelDefinition>("panel").all()).toEqual([]);
  });

  it("orders by the declared order", () => {
    const registry = createSlotRegistry<PanelDefinition>("panel");
    registry.register(panel("palette", "right", 20));
    registry.register(panel("properties", "right", 10));
    expect(registry.all().map((p) => p.id)).toEqual(["properties", "palette"]);
  });

  it("breaks ties by registration order", () => {
    const registry = createSlotRegistry<PanelDefinition>("panel");
    registry.register(panel("properties", "right", 0));
    registry.register(panel("palette", "right", 0));
    expect(registry.all().map((p) => p.id)).toEqual(["properties", "palette"]);
  });

  it("refuses a duplicate id rather than making one of them invisible", () => {
    const registry = createSlotRegistry<PanelDefinition>("panel");
    registry.register(panel("stack", "left", 0));
    expect(() => registry.register(panel("stack", "left", 1))).toThrow(DuplicateSlotError);
    expect(registry.all()).toHaveLength(1);
  });

  it("notifies subscribers, so a panel registered after first render appears", () => {
    const registry = createSlotRegistry<PanelDefinition>("panel");
    let notifications = 0;
    const unsubscribe = registry.subscribe(() => {
      notifications += 1;
    });
    registry.register(panel("stack", "left", 0));
    expect(notifications).toBe(1);
    unsubscribe();
    registry.register(panel("timeline", "bottom", 0));
    expect(notifications).toBe(1);
  });

  it("hands out a stable snapshot until something changes", () => {
    const registry = createSlotRegistry<PanelDefinition>("panel");
    registry.register(panel("stack", "left", 0));
    // useSyncExternalStore compares with Object.is; a fresh array every call
    // would re-render forever.
    expect(registry.all()).toBe(registry.all());
    registry.register(panel("palette", "right", 0));
    expect(registry.all()).toHaveLength(2);
  });
});

describe("selectors", () => {
  it("splits panels by region", () => {
    const panels = [
      panel("stack", "left", 0),
      panel("properties", "right", 0),
      panel("palette", "right", 1),
    ];
    expect(panelsInRegion(panels, "right").map((p) => p.id)).toEqual([
      "properties",
      "palette",
    ]);
    expect(panelsInRegion(panels, "bottom")).toEqual([]);
  });

  it("splits toolbar items by side", () => {
    const items = [toolbarItem("open", "start", 0), toolbarItem("export", "end", 0)];
    expect(toolbarItemsOnSide(items, "start").map((i) => i.id)).toEqual(["open"]);
  });
});
