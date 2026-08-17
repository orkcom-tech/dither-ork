import React from "react";

import { helpFor } from "../help";
import { EXECUTION_COST, EXECUTION_LABEL, SLOT_LABEL } from "../stack/model";
import { NODE_WIDTH, PORT_ROW_HEIGHT, portOffsetY } from "./metrics";
import { ROLE_LABEL, ROOT_INPUT_NOTE, type DropTarget, type EditorNode, type EditorPort } from "./model";

export interface GraphNodeCardProps {
  readonly node: EditorNode;
  readonly selected: boolean;
  readonly soloed: boolean;
  /** The wire in hand comes from this node. */
  readonly wiring: boolean;
  /**
   * How this node's ports are judged right now, keyed by port key. Empty when no
   * wire is in hand — a port is only a target while something could land on it.
   */
  readonly targets: ReadonlyMap<string, DropTarget>;
  /** The port the wire would land on if it were released now. */
  readonly activePort: string | null;
  readonly onSelect: () => void;
  readonly onToggleEnabled: () => void;
  readonly onSetOutput: () => void;
  readonly onToggleSolo: () => void;
  /** Pointer went down on the output port: a wire is being pulled out. */
  readonly onStartWire: (event: React.PointerEvent) => void;
  /** Enter or space on the output port: the same wire, chosen with the keyboard. */
  readonly onStartWireByKeyboard: () => void;
  readonly onDisconnect: (port: string) => void;
  /** A grammar issue this node is the subject of, ready to show. */
  readonly issue: string | null;
}

/**
 * One node, drawn.
 *
 * Every interactive part is a real `<button>` inside the transformed layer
 * rather than a shape in the SVG below it. That is the whole accessibility
 * story and it is structural rather than bolted on: a port is focusable, is in
 * the tab order, carries an accessible name saying what it is and what is wired
 * to it, and can be operated with Enter — none of which is true of a circle in a
 * canvas, and all of which would otherwise have to be simulated.
 *
 * The card's size is fixed by `metrics.ts` and applied as inline width and
 * height, because `layout.ts` has already spaced the columns and rows by exactly
 * those numbers. A card that sized itself to its content would drift from the
 * layout that placed it, and every wire would land beside its port.
 */
export function GraphNodeCard({
  node,
  selected,
  soloed,
  wiring,
  targets,
  activePort,
  onSelect,
  onToggleEnabled,
  onSetOutput,
  onToggleSolo,
  onStartWire,
  onStartWireByKeyboard,
  onDisconnect,
  issue,
}: GraphNodeCardProps): React.ReactElement {
  const effect = node.effect;
  const name = effect?.name ?? node.node.effect;

  const className = [
    "gnode",
    selected ? "gnode--selected" : "",
    node.node.enabled ? "" : "gnode--off",
    node.isOutput ? "gnode--output" : "",
    issue === null ? "" : "gnode--issue",
    // Not in the picture: the same dimming the stack panel gives a row below
    // the solo point, because it is the same fact and it is not an error.
    node.reachesOutput ? "" : "gnode--unreached",
    wiring ? "gnode--wiring" : "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");

  return (
    <div
      className={className}
      style={{
        left: node.layout.x,
        top: node.layout.y,
        width: NODE_WIDTH,
        height: node.layout.height,
      }}
      data-node={node.id}
    >
      <div className="gnode__head">
        <button
          type="button"
          className="gnode__enable"
          aria-pressed={node.node.enabled}
          title={node.node.enabled ? "Disable this node" : "Enable this node"}
          onClick={onToggleEnabled}
        >
          {node.node.enabled ? "◉" : "○"}
        </button>
        {/*
          The node's id, on the card.

          Not decoration and not a debugging leftover. Every refusal the engine
          writes names the nodes it is about by id — "n2 already feeds n4, so this
          edge would close a loop" — because `graph/edit.ts` is reasoning about a
          document rather than about a screen. Printing the id here is what makes
          those sentences resolvable: the reader looks at the card the message
          names instead of working it out from the wiring. It is the same job the
          position number does on a stack row, and it costs three characters.
        */}
        <span className="gnode__id">{node.id}</span>
        <button
          type="button"
          className="gnode__name"
          title={name}
          {...(effect === undefined ? {} : helpFor({ kind: "effect", effect: effect.id }))}
          onClick={onSelect}
        >
          <span className="gnode__title">{name}</span>
        </button>
        {/*
          A grammar issue is a mark rather than a sentence, because the card has
          no room for one and the sentence is on the row in the stack panel and
          in the editor's own bar. The mark is what makes the node findable in a
          graph that does not fit on screen.
        */}
        {issue === null ? null : (
          <span className="gnode__issue" title={issue} aria-label={issue}>
            !
          </span>
        )}
        {effect === undefined ? (
          <span className="badge badge--warn">unknown</span>
        ) : (
          <>
            <span className="badge badge--slot">{SLOT_LABEL[effect.slot]}</span>
            <span
              className={`badge badge--exec badge--exec-${effect.execution}`}
              title={EXECUTION_COST[effect.execution]}
            >
              {EXECUTION_LABEL[effect.execution]}
            </span>
          </>
        )}
      </div>

      <ul className="gnode__ports">
        {node.ports.map((port, index) => (
          <PortRow
            key={port.key}
            node={node}
            port={port}
            index={index}
            target={targets.get(port.key) ?? null}
            active={activePort === port.key}
            onDisconnect={() => onDisconnect(port.key)}
          />
        ))}
      </ul>

      {/*
        The output port, and the two marks that are about the output rather than
        about the effect. They sit on the first port row because that is where a
        wire leaves the card, and because a card with a fixed height has no
        second place to put them.
      */}
      <div className="gnode__out" style={{ top: portOffsetY(0) - PORT_ROW_HEIGHT / 2 }}>
        <button
          type="button"
          className="gnode__solo"
          aria-pressed={soloed}
          title={
            soloed
              ? "Stop soloing — render the document's own output"
              : "Solo — render up to this node without changing the document"
          }
          onClick={onToggleSolo}
        >
          S
        </button>
        <button
          type="button"
          className={`gnode__picture${node.isOutput ? " gnode__picture--on" : ""}`}
          aria-pressed={node.isOutput}
          title={
            node.isOutput
              ? "This node's output is the document's picture"
              : "Make this node's output the document's picture"
          }
          onClick={onSetOutput}
        >
          ▣
        </button>
        <button
          type="button"
          className="gnode__port gnode__port--out"
          aria-label={`Output of ${name}. Drag, or press Enter, to wire it into another node.`}
          title={`Output of ${name} — drag to a port, or press Enter to choose one with the keyboard`}
          onPointerDown={onStartWire}
          // Enter and space, handled here and not as a click, so that the
          // keyboard path and the pointer path cannot both fire for one
          // gesture: a button turns Enter into a click, and a click arriving
          // after a drag has finished would start a second wire out of the port
          // the first one just left.
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onStartWireByKeyboard();
          }}
        />
      </div>
    </div>
  );
}

interface PortRowProps {
  readonly node: EditorNode;
  readonly port: EditorPort;
  readonly index: number;
  readonly target: DropTarget | null;
  readonly active: boolean;
  readonly onDisconnect: () => void;
}

/**
 * One input port.
 *
 * The port dot is a button with a real accessible name, and its label carries
 * the port's own `description` from the registry as its title — the editor never
 * writes a second explanation of what a port does, for the same reason nothing
 * else in this application does (F-UI-15).
 */
function PortRow({
  node,
  port,
  index,
  target,
  active,
  onDisconnect,
}: PortRowProps): React.ReactElement {
  const wired = port.from !== null;
  const refused = target !== null && target.refusal !== null;
  const className = [
    "gport",
    `gport--${port.role}`,
    wired ? "gport--wired" : "",
    port.required && !wired ? "gport--needed" : "",
    target === null ? "" : refused ? "gport--refused" : "gport--legal",
    active ? "gport--active" : "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");

  // What clicking the dot does when no wire is in hand: clear the port. A wired
  // port is the only one with anything to clear, so an unwired one is inert and
  // says so rather than being a button that does nothing.
  const dotLabel = wired
    ? `${port.label} of ${node.effect?.name ?? node.node.effect}, wired from ${port.from ?? ""}. Press Enter to disconnect.`
    : `${port.label} of ${node.effect?.name ?? node.node.effect}, not wired. ${port.description}`;

  return (
    <li className={className} style={{ height: PORT_ROW_HEIGHT }} data-port={port.key}>
      <button
        type="button"
        className="gport__dot"
        aria-label={dotLabel}
        title={port.feedback ? port.description : wired ? "Disconnect this input" : port.description}
        disabled={!wired || port.feedback}
        onClick={onDisconnect}
      />
      <span className="gport__label" title={port.description}>
        {port.label}
      </span>
      {/*
        The role, but only when the port's own label does not already say it.
        Every node's mask port is labelled "Mask", and a tag reading "mask" beside
        it is a word spent twice on a 176px card — while a port labelled "Second
        picture" genuinely needs to say that what arrives there is a layer rather
        than coverage.
      */}
      {port.role === "image" || ROLE_LABEL[port.role] === port.label.toLowerCase() ? null : (
        <span className="gport__role">{ROLE_LABEL[port.role]}</span>
      )}
      {/*
        The one thing an empty port cannot say for itself. An unwired `in` is not
        an unfinished connection — it is a root, and it reads the image the
        document opened. Every other node editor's empty port means the opposite,
        so this is stated rather than left to be inferred.
      */}
      {index === 0 && port.role === "image" && !wired ? (
        <span className="gport__source" title={ROOT_INPUT_NOTE}>
          source
        </span>
      ) : null}
    </li>
  );
}
