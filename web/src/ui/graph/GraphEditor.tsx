import React from "react";

import { logger } from "../../lib/log";
import { validateGraph, type EffectRegistry } from "../../registry";
import { draftOf, type GraphDraft } from "../../graph/edit";
import { AddNodePicker } from "../stack/AddNodePicker";
import { insertionIndex, stackRefs } from "../stack/model";
import type { DocumentStore } from "../stack/store";
// `.badge` and `.field__note` live there and this panel wears both, the same
// reason the stack panel and the picker import it.
import "../properties/properties.css";
import { GraphNodeCard } from "./GraphNodeCard";
import {
  IDENTITY_VIEW,
  ZOOM_STEP,
  boundsOf,
  feedbackPath,
  fitView,
  panBy,
  toWorld,
  wirePath,
  zoomAt,
  zoomByStep,
  type Point,
  type ViewTransform,
} from "./geometry";
import { SHORTCUTS, firstConnectable, stepSelection, stepTarget, type Direction } from "./keyboard";
import {
  IMAGE_MASK,
  buildEditorGraph,
  dropTargetAt,
  dropTargets,
  type DropTarget,
} from "./model";
import "./graph.css";

const log = logger("app");

/**
 * Padding around the graph when it is fitted, in screen pixels.
 *
 * Small, because the panel is a band: on a short editor every pixel of padding
 * comes straight off the zoom, and a fit that pads generously and then renders
 * the node names at six pixels has helped nobody.
 */
const FIT_PADDING = 16;

export interface GraphEditorProps {
  readonly store: DocumentStore;
  readonly registry: EffectRegistry;
}

/**
 * What the pointer or the keyboard is in the middle of.
 *
 * One value rather than four booleans, because the states are exclusive and a
 * combination of them is not a state the editor has: you cannot be panning and
 * wiring at once, and a pair of booleans that says you are is a bug that only
 * appears when a pointer is lost mid-drag.
 */
type Interaction =
  | { readonly kind: "idle" }
  | { readonly kind: "pan"; readonly pointerId: number; readonly x: number; readonly y: number }
  /** A wire out of `from`, following the pointer. */
  | {
      readonly kind: "wire";
      readonly pointerId: number;
      readonly from: string;
      readonly at: Point;
      readonly target: DropTarget | null;
    }
  /**
   * A wire out of `from`, choosing its port from a list with the arrow keys.
   *
   * The list itself is **not** held here — only the position in it. The targets
   * are derived from the document on every render, so a cursor left open while
   * an undo changes the graph underneath it points at the graph as it is now
   * rather than at a snapshot of how it was.
   */
  | { readonly kind: "keyboard-wire"; readonly from: string; readonly index: number };

const IDLE: Interaction = { kind: "idle" };

/**
 * The node editor — the wiring, drawn and edited.
 *
 * ## Why this is a panel under the viewport and not a mode over it
 *
 * The picture has to stay live while the graph is being wired. Wiring a mask and
 * only finding out what it did after closing an editor is the difference between
 * a tool you compose in and a tool you configure. So the editor is a band under
 * the viewport, which is where every node tool that also has a picture puts it,
 * and the viewport above it is never unmounted — the canvas belongs to
 * `Viewport` for its whole life (`app/ViewportHost.tsx`), and taking it down to
 * show a graph would drop the render and cost a full re-render to come back.
 *
 * ## What it does not offer
 *
 * **Nodes cannot be dragged to a new position.** Positions are computed from the
 * wiring (`layout.ts`) and no document has anywhere to store one, so a drag
 * would move a card until the next reload and then lose it. The editor says so
 * in its own bar rather than offering the gesture — the same rule that removed
 * the opacity and blend sliders while they were inert.
 *
 * ## Refusals
 *
 * Every sentence a user reads while wiring comes from `graph/edit.ts`, which is
 * where the rules are. This component decides nothing about legality: it asks
 * on every pointer move, shows the answer under the cursor, and shows it again
 * in the bar when a drop is refused. That is the same arrangement the effect
 * picker uses for an effect that cannot go where the caret is, and deliberately
 * the same voice.
 */
export function GraphEditor({ store, registry }: GraphEditorProps): React.ReactElement {
  const subscribe = React.useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  );
  const getSnapshot = React.useCallback(() => store.getSnapshot(), [store]);
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot);

  const canvas = React.useRef<HTMLDivElement | null>(null);
  const [size, setSize] = React.useState({ width: 0, height: 0 });
  const [view, setView] = React.useState<ViewTransform>(IDENTITY_VIEW);
  const [interaction, setInteraction] = React.useState<Interaction>(IDLE);
  /** The last refusal, kept on screen until the next successful edit. */
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  /** Cleared once the first non-empty measurement has been fitted. */
  const fitted = React.useRef(false);

  const document_ = snapshot.document;
  const draft: GraphDraft = React.useMemo(() => draftOf(document_), [document_]);
  const graph = React.useMemo(
    () => buildEditorGraph(draft, registry),
    [draft, registry],
  );

  const issues = React.useMemo(() => {
    const validation = validateGraph(registry, {
      nodes: draft.stack,
      edges: draft.edges,
      output: draft.output,
    });
    const byNode = new Map<string, string>();
    for (const issue of validation.issues) {
      if (!byNode.has(issue.nodeId)) byNode.set(issue.nodeId, issue.message);
    }
    return byNode;
  }, [registry, draft]);

  // --- measuring ---------------------------------------------------------

  React.useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect === undefined) return;
      setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Fit once, on the first measurement that has a size and a graph in it. Doing
  // it on every change would fight the user's own pan; doing it never would open
  // the editor scrolled to a corner of a graph nobody has placed.
  React.useEffect(() => {
    if (fitted.current) return;
    if (size.width <= 0 || graph.nodes.length === 0) return;
    fitted.current = true;
    setView(fitView(graph.bounds, size, FIT_PADDING));
  }, [size, graph]);

  const fit = React.useCallback(() => {
    setView(fitView(graph.bounds, size, FIT_PADDING, IDENTITY_VIEW));
  }, [graph, size]);

  // Wheel zoom, attached natively so it can be prevented: React's own wheel
  // listener is passive, and a passive handler cannot stop the page from
  // scrolling underneath the editor while somebody is zooming it.
  React.useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      // A ratio per notch rather than a factor proportional to `deltaY`, so a
      // trackpad's fine-grained events and a mouse wheel's coarse ones both zoom
      // by a predictable amount.
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      setView((current) => zoomAt(current, anchor, factor));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  // --- committing --------------------------------------------------------

  const pointOf = React.useCallback((event: React.PointerEvent): Point => {
    const element = canvas.current;
    if (element === null) return { x: 0, y: 0 };
    const rect = element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  /**
   * Commit one drop, whichever gesture asked for it.
   *
   * Both paths end here, so the grammar is consulted once and a refusal reads
   * the same however it was provoked — the same rule the stack panel's reorder
   * follows, and for the same reason: two code paths would eventually be two
   * answers to "may this be wired".
   */
  const commit = React.useCallback(
    (from: string, target: DropTarget, how: string): void => {
      if (target.refusal !== null) {
        log.warn("connection refused", {
          from,
          to: target.to,
          port: target.port.key,
          code: target.refusal.code,
          how,
        });
        setRefusal(target.refusal.message);
        return;
      }
      try {
        if (target.mask?.kind === "enable") {
          // The two-part gesture: image coverage and the edge, one undo step.
          // See `model.ts` for why the editor completes it rather than refusing.
          store.maskNodeWith(from, target.to, IMAGE_MASK);
        } else {
          store.connect(from, target.to, target.port.key);
        }
        log.info("edge committed", { from, to: target.to, port: target.port.key, how });
        setRefusal(null);
      } catch (error) {
        // Reached only if the document changed between the check and the
        // commit. The message is the one `connectionProblem` would have given,
        // and it is shown rather than swallowed.
        const message = error instanceof Error ? error.message : String(error);
        log.error("connection failed at commit", {
          from,
          to: target.to,
          port: target.port.key,
          how,
          error: message,
        });
        setRefusal(message);
      }
    },
    [store],
  );

  // --- pointer -----------------------------------------------------------

  const startWire = (event: React.PointerEvent, from: string): void => {
    event.preventDefault();
    event.stopPropagation();
    const element = canvas.current;
    element?.setPointerCapture(event.pointerId);
    store.selectNode(from);
    setInteraction({ kind: "wire", pointerId: event.pointerId, from, at: toWorld(view, pointOf(event)), target: null });
    log.info("wire started", { from, how: "pointer" });
  };

  const onPointerDown = (event: React.PointerEvent): void => {
    if (interaction.kind !== "idle") return;
    const target = event.target;
    // A press that lands on a card is the card's business — selecting it, or
    // pulling a wire out of its output. Only the background pans.
    if (target instanceof Element && target.closest(".gnode") !== null) return;
    canvas.current?.setPointerCapture(event.pointerId);
    setInteraction({
      kind: "pan",
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    });
  };

  const onPointerMove = (event: React.PointerEvent): void => {
    if (interaction.kind === "pan") {
      if (event.pointerId !== interaction.pointerId) return;
      setView((current) =>
        panBy(current, event.clientX - interaction.x, event.clientY - interaction.y),
      );
      setInteraction({ ...interaction, x: event.clientX, y: event.clientY });
      return;
    }
    if (interaction.kind !== "wire" || event.pointerId !== interaction.pointerId) return;
    const at = toWorld(view, pointOf(event));
    setInteraction({
      ...interaction,
      at,
      target: dropTargetAt(graph, draft, registry, interaction.from, at),
    });
  };

  const onPointerUp = (event: React.PointerEvent): void => {
    if (interaction.kind === "idle") return;
    if (interaction.kind !== "keyboard-wire" && event.pointerId !== interaction.pointerId) {
      return;
    }
    canvas.current?.releasePointerCapture(event.pointerId);
    if (interaction.kind === "wire") {
      if (interaction.target === null) {
        // Dropped on open canvas. Not a failure and not silent: a wire that
        // simply vanishes reads as a gesture the editor did not notice.
        log.info("wire abandoned: nothing within reach of the drop", {
          from: interaction.from,
        });
      } else {
        commit(interaction.from, interaction.target, "pointer");
      }
    }
    setInteraction(IDLE);
  };

  // --- keyboard ----------------------------------------------------------

  const startKeyboardWire = React.useCallback(
    (from: string): void => {
      const targets = dropTargets(graph, draft, registry, from);
      if (targets.length === 0) {
        setRefusal("There is no other node to wire this into. Add one first.");
        return;
      }
      store.selectNode(from);
      setInteraction({ kind: "keyboard-wire", from, index: firstConnectable(targets) });
      log.info("wire started", { from, how: "keyboard", targets: targets.length });
    },
    [graph, draft, registry, store],
  );

  const selected = snapshot.selectedNodeId;

  /** The node a wire is being pulled out of, whichever gesture is pulling it. */
  const wireFrom =
    interaction.kind === "wire" || interaction.kind === "keyboard-wire"
      ? interaction.from
      : null;

  /**
   * Every port that wire could land on, judged, in reading order.
   *
   * Derived rather than captured when the wire starts, so it stays true if the
   * document moves underneath an open cursor — an undo while a keyboard
   * connection is in progress is the case that makes a captured list wrong. It
   * is memoized on the document rather than on the interaction, so following a
   * pointer across the canvas does not re-judge every port sixty times a second.
   */
  const liveTargets = React.useMemo(
    () => (wireFrom === null ? [] : dropTargets(graph, draft, registry, wireFrom)),
    [wireFrom, graph, draft, registry],
  );

  const onKeyDown = (event: React.KeyboardEvent): void => {
    // The picker, and any control with its own text handling, keeps its keys.
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT")
    ) {
      return;
    }

    const arrow: Record<string, Direction> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    };
    const direction = arrow[event.key];

    if (interaction.kind === "keyboard-wire") {
      if (direction !== undefined) {
        event.preventDefault();
        const delta = direction === "right" || direction === "down" ? 1 : -1;
        setInteraction({
          ...interaction,
          index: stepTarget(liveTargets, interaction.index, delta),
        });
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const target_ = liveTargets[interaction.index];
        if (target_ !== undefined) commit(interaction.from, target_, "keyboard");
        setInteraction(IDLE);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        log.info("wire abandoned", { from: interaction.from, how: "keyboard" });
        setInteraction(IDLE);
        return;
      }
      return;
    }

    if (direction !== undefined) {
      event.preventDefault();
      const next = stepSelection(graph, selected, direction);
      if (next !== null) store.selectNode(next);
      return;
    }

    if (event.key === "Escape" && interaction.kind !== "idle") {
      event.preventDefault();
      setInteraction(IDLE);
      return;
    }

    if (selected === null) return;

    switch (event.key) {
      case "c":
      case "C": {
        event.preventDefault();
        startKeyboardWire(selected);
        return;
      }
      case "x":
      case "X": {
        event.preventDefault();
        disconnectAll(selected);
        return;
      }
      case "Enter": {
        event.preventDefault();
        store.setOutput(selected);
        setRefusal(null);
        return;
      }
      case "d":
      case "D": {
        event.preventDefault();
        store.selectNode(store.duplicateNode(selected));
        setRefusal(null);
        return;
      }
      case "Delete":
      case "Backspace": {
        event.preventDefault();
        store.removeNode(selected);
        setRefusal(null);
        return;
      }
      case "+":
      case "=": {
        event.preventDefault();
        setView((current) => zoomByStep(current, 1, size));
        return;
      }
      case "-": {
        event.preventDefault();
        setView((current) => zoomByStep(current, -1, size));
        return;
      }
      case "0": {
        event.preventDefault();
        fit();
        return;
      }
      default:
        return;
    }
  };

  /**
   * Clear every wired input of one node.
   *
   * One key for all of them rather than one per port: a node has at most three,
   * clearing them is what "unwire this" means, and each is still individually
   * clearable by pressing Enter on its own port.
   */
  const disconnectAll = (nodeId: string): void => {
    const node = graph.byId.get(nodeId);
    if (node === undefined) return;
    let cleared = 0;
    for (const port of node.ports) {
      if (port.feedback || port.from === null) continue;
      store.disconnect(nodeId, port.key);
      cleared += 1;
    }
    if (cleared === 0) {
      setRefusal("That node has nothing wired into it.");
      return;
    }
    log.info("node inputs cleared", { nodeId, cleared });
    setRefusal(null);
  };

  // --- adding ------------------------------------------------------------

  const refs = React.useMemo(() => stackRefs(document_.stack), [document_.stack]);
  const insertAt = insertionIndex(document_.stack, selected);

  const add = (effectId: string): void => {
    const created = store.addNode(effectId, insertAt);
    store.selectNode(created);
    setAdding(false);
    setRefusal(null);
    log.info("node added from the editor", { effect: effectId, at: insertAt, node: created });
  };

  // --- drawing -----------------------------------------------------------

  const activeTarget: DropTarget | null =
    interaction.kind === "wire"
      ? interaction.target
      : interaction.kind === "keyboard-wire"
        ? (liveTargets[interaction.index] ?? null)
        : null;

  /** Every port's verdict while a wire is in hand, keyed by port on its node. */
  const targetsByNode = React.useMemo(() => {
    const byNode = new Map<string, Map<string, DropTarget>>();
    for (const target of liveTargets) {
      const ports = byNode.get(target.to);
      if (ports === undefined) byNode.set(target.to, new Map([[target.port.key, target]]));
      else ports.set(target.port.key, target);
    }
    return byNode;
  }, [liveTargets]);

  const bounds = boundsOf(graph.nodes.map((node) => node.layout));
  const wireEnd: Point | null =
    interaction.kind === "wire"
      ? (interaction.target?.port.point ?? interaction.at)
      : interaction.kind === "keyboard-wire"
        ? (activeTarget?.port.point ?? null)
        : null;
  const wireStart = wireFrom === null ? null : (graph.byId.get(wireFrom)?.outputPoint ?? null);

  return (
    <div className="geditor">
      <div className="geditor__bar">
        <button
          type="button"
          className="ui-button"
          aria-pressed={adding}
          onClick={() => setAdding((open) => !open)}
        >
          add node
        </button>
        <button type="button" className="ui-button" onClick={fit} title="Fit the whole graph (0)">
          fit
        </button>
        <button
          type="button"
          className="ui-button"
          onClick={() => setView((current) => zoomByStep(current, -1, size))}
          aria-label="Zoom out"
          title="Zoom out (-)"
        >
          −
        </button>
        <span className="geditor__zoom">{Math.round(view.scale * 100)}%</span>
        <button
          type="button"
          className="ui-button"
          onClick={() => setView((current) => zoomByStep(current, 1, size))}
          aria-label="Zoom in"
          title="Zoom in (+)"
        >
          +
        </button>
        <span className="geditor__count">
          {graph.nodes.length} node{graph.nodes.length === 1 ? "" : "s"} ·{" "}
          {graph.edges.length} edge{graph.edges.length === 1 ? "" : "s"}
        </span>
        <span className="geditor__spacer" />
        {/*
          Stated where it would otherwise be discovered by trying. A drag that
          moved a card until the next reload would be a control that appears to
          work and does not.
        */}
        <span
          className="geditor__note"
          title="Positions come from the wiring, so the same document lays out the same way on every machine. Nothing to arrange, and nothing to lose."
        >
          layout follows the wiring
        </span>
      </div>

      {refusal === null ? null : (
        <div className="geditor__refusal" role="status">
          <span>{refusal}</span>
          <button type="button" className="ui-button" onClick={() => setRefusal(null)}>
            ok
          </button>
        </div>
      )}

      {adding ? (
        <div className="geditor__picker">
          <AddNodePicker
            registry={registry}
            stack={refs}
            insertAt={insertAt}
            onPick={add}
            onClose={() => setAdding(false)}
          />
        </div>
      ) : null}

      <div
        className={`geditor__canvas${interaction.kind === "pan" ? " geditor__canvas--panning" : ""}`}
        ref={canvas}
        role="application"
        aria-label="Node editor. Arrow keys move between nodes; C starts a connection."
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {graph.nodes.length === 0 ? (
          <p className="field__note geditor__empty">
            This document has no nodes. Add one to start building a graph.
          </p>
        ) : null}

        <div
          className="geditor__world"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
        >
          <svg
            className="geditor__wires"
            // Sized to the graph's own extent, offset so a node at a negative
            // coordinate is still inside it. Never `overflow: hidden`.
            style={{
              left: bounds.x - 200,
              top: bounds.y - 200,
              width: bounds.width + 400,
              height: bounds.height + 400,
            }}
            viewBox={`${bounds.x - 200} ${bounds.y - 200} ${bounds.width + 400} ${bounds.height + 400}`}
            aria-hidden="true"
          >
            {graph.edges.map((edge) => (
              <path
                key={`${edge.to} ${edge.port}`}
                className={`gwire gwire--${edge.role}`}
                d={wirePath(edge.a, edge.b)}
              />
            ))}
            {graph.loops.map((loop) => {
              const node = graph.byId.get(loop.nodeId);
              if (node === undefined) return null;
              return (
                <path
                  key={`${loop.nodeId} ${loop.port}`}
                  className="gwire gwire--feedback"
                  d={feedbackPath(node.layout, loop.portIndex)}
                />
              );
            })}
            {wireStart !== null && wireEnd !== null ? (
              <path
                className={`gwire gwire--live${
                  activeTarget?.refusal != null ? " gwire--refused" : ""
                }`}
                d={wirePath(wireStart, wireEnd)}
              />
            ) : null}
          </svg>

          {graph.nodes.map((node) => (
            <GraphNodeCard
              key={node.id}
              node={node}
              selected={node.id === selected}
              soloed={node.id === snapshot.soloNodeId}
              wiring={wireFrom === node.id}
              targets={targetsByNode.get(node.id) ?? EMPTY_TARGETS}
              activePort={
                activeTarget !== null && activeTarget.to === node.id
                  ? activeTarget.port.key
                  : null
              }
              issue={issues.get(node.id) ?? null}
              onSelect={() => store.selectNode(node.id)}
              onToggleEnabled={() => store.setNodeEnabled(node.id, !node.node.enabled)}
              onSetOutput={() => {
                store.setOutput(node.id);
                setRefusal(null);
              }}
              onToggleSolo={() =>
                store.setSolo(snapshot.soloNodeId === node.id ? null : node.id)
              }
              onStartWire={(event) => startWire(event, node.id)}
              onStartWireByKeyboard={() => startKeyboardWire(node.id)}
              onDisconnect={(port) => {
                store.disconnect(node.id, port);
                setRefusal(null);
              }}
            />
          ))}
        </div>

        {/*
          What the wire in hand would do, under the cursor and in the same words
          the refusal would use. This is the only thing on screen that is not
          either a node or a wire, and it is here because a target that is legal
          says nothing for itself — "this will replace what is on that port" and
          "this will mask that node with this picture" are both consequences
          worth reading before letting go.
        */}
        {activeTarget === null ? null : (
          <div
            className={`geditor__verdict${
              activeTarget.refusal === null ? "" : " geditor__verdict--refused"
            }`}
            role="status"
          >
            {activeTarget.refusal !== null
              ? activeTarget.refusal.message
              : describeDrop(activeTarget, graph.byId.get(activeTarget.to)?.effect?.name ?? activeTarget.to)}
          </div>
        )}
      </div>

      <ul className="geditor__keys" aria-label="Keyboard shortcuts">
        {SHORTCUTS.map((shortcut) => (
          <li key={shortcut.keys}>
            <kbd>{shortcut.keys}</kbd> {shortcut.what}
          </li>
        ))}
      </ul>
    </div>
  );
}

const EMPTY_TARGETS: ReadonlyMap<string, DropTarget> = new Map();

/**
 * What letting go here would do, when it is allowed.
 *
 * Three sentences and no more, because there are exactly three outcomes: it
 * wires, it replaces an edge, or it masks a node that was not masked. Each one
 * is something the user would otherwise find out afterwards.
 */
function describeDrop(target: DropTarget, name: string): string {
  if (target.mask?.kind === "enable") {
    return `Mask ${name} with this picture — its coverage is set to read the picture, and the two are one undo step.`;
  }
  const whose = `${possessive(name)} "${target.port.label}" input`;
  return target.occupied ? `Replace what is on ${whose}.` : `Wire into ${whose}.`;
}

/**
 * `Levels'`, not `Levels's`.
 *
 * Six of the shipped effects end in an `s` — Levels, Curves, Scanlines and the
 * rest — and they are among the most-used, so the naive apostrophe-s turns up
 * constantly. A sentence a person reads is worth the two lines.
 */
function possessive(name: string): string {
  return name.endsWith("s") || name.endsWith("S") ? `${name}'` : `${name}'s`;
}
