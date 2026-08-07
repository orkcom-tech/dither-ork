import React from "react";

import { logger } from "../../lib/log";
import { coerceParams, type EffectRegistry } from "../../registry";
import { helpFor } from "../help";
import { EXECUTION_LABEL, SLOT_LABEL, nodeById } from "../stack/model";
import type { DocumentStore } from "../stack/store";
import { ParamControl } from "./ParamControl";
import { SeedField } from "./SeedField";
import "./properties.css";

const log = logger("app");

export interface PropertiesPanelProps {
  readonly store: DocumentStore;
  readonly registry: EffectRegistry;
}

/**
 * The properties panel — generated entirely from the registry descriptor.
 *
 * Every control on it comes from `ParamDescriptor`, and **no effect is named
 * anywhere in this directory**. That is the whole return on the descriptor
 * design: the legal range, the step, the default, an enum's options and the
 * one-line hint are declared once, next to the shader that reads them, and
 * spent here.
 *
 * Values are put through `coerceParams` before anything is drawn. That is not
 * defensive decoration — a document from an older build can carry a parameter
 * whose legal range has since narrowed, and a slider whose value sits outside
 * its own track is a control that cannot be returned to where it was. Coercion
 * logs every adjustment, so the change is visible rather than silent.
 */
export function PropertiesPanel({
  store,
  registry,
}: PropertiesPanelProps): React.ReactElement {
  // Wrapped rather than passed as bare method references: `useSyncExternalStore`
  // calls them unbound, and the store is somebody else's object.
  const subscribe = React.useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  );
  const getSnapshot = React.useCallback(() => store.getSnapshot(), [store]);
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot);

  const node = nodeById(snapshot.document.stack, snapshot.selectedNodeId);
  const effect = node === undefined ? undefined : registry.get(node.effect);

  // Memoized on the parameter object's identity: the store hands out a new one
  // per edit and the same one otherwise, so this runs once per actual change
  // rather than once per render — and `coerceParams` warns on every adjustment,
  // which would otherwise be a warning per frame of a slider drag.
  const coerced = React.useMemo(() => {
    if (node === undefined || effect === undefined) return null;
    return coerceParams(effect, node.params);
  }, [node, effect]);

  if (node === undefined) {
    return (
      <div className="properties properties--empty">
        <p className="field__note">
          Nothing selected. Pick a node in the stack to edit what it does.
        </p>
      </div>
    );
  }

  if (effect === undefined || coerced === null) {
    // A document naming an effect this build does not have. Said once, plainly,
    // with the id — the fix is either a build or an edit to the document, and
    // both need the id.
    log.error("selected node names an unknown effect", {
      node: node.id,
      effect: node.effect,
    });
    return (
      <div className="properties properties--empty">
        <p className="field__note field__note--fail">
          This node runs <b>{node.effect}</b>, which this build does not have.
        </p>
      </div>
    );
  }

  return (
    <div className="properties">
      {/*
        The header is the effect's own help anchor (F-UI-13): the name, the slot
        badge and the execution badge are exactly the three things somebody
        points at when asking "what is this node doing", and one attribute on the
        header covers all three because help resolves with `closest()`.
      */}
      <header
        className="properties__header"
        {...helpFor({ kind: "effect", effect: effect.id })}
      >
        <div className="properties__name">{effect.name}</div>
        <div className="properties__meta">
          <span className="badge badge--slot">{SLOT_LABEL[effect.slot]}</span>
          <span className={`badge badge--exec badge--exec-${effect.execution}`}>
            {EXECUTION_LABEL[effect.execution]}
          </span>
          <span className="badge badge--req">{effect.requirement}</span>
        </div>
      </header>

      <div className="properties__body">
        {/*
          Two groups, and only two, because only two are true. The seed belongs
          to the *node* — it survives the effect being swapped and it is not one
          of the effect's declared parameters — and everything below belongs to
          the effect. `ParamDescriptor` carries no group field, so any finer
          division would be a taxonomy invented here and contradicted by the
          next effect somebody adds.
        */}
        <h3 className="properties__group">Node</h3>
        {/*
          The node seed is not one of the effect's declared parameters, so there
          is no descriptor to read help off. It is a concept, and it has an entry
          in `ui/help/concepts.ts` — which is why this one wrapper names a
          concept where every control below it names a parameter.
        */}
        <div className="param" {...helpFor({ kind: "concept", concept: "node-seed" })}>
          <SeedField
            label="Node seed"
            hint="Every stochastic node reads this. The same seed renders the same picture."
            value={node.seed}
            interaction={`node:${node.id}.seed`}
            onChange={(seed) => store.setNodeSeed(node.id, seed)}
          />
        </div>

        <h3 className="properties__group">
          <span>Parameters</span>
          {/* The count before the list, so a fifteen-parameter effect says so
              rather than being discovered by scrolling. */}
          <span className="properties__count">{effect.params.length}</span>
        </h3>

        {effect.params.length === 0 ? (
          <p className="field field__note">This effect has no parameters.</p>
        ) : (
          effect.params.map((param) => {
            const value = coerced.values[param.key];
            if (value === undefined) {
              // `coerceParams` returns every declared key, so this is a broken
              // contract rather than a state to render around. Logged, and the
              // control is left out rather than invented.
              log.error("coerced parameter set is missing a declared key", {
                effect: effect.id,
                param: param.key,
              });
              return null;
            }
            return (
              <ParamControl
                key={param.key}
                nodeId={node.id}
                effectId={effect.id}
                param={param}
                value={value}
                onChange={(next, options) =>
                  store.setNodeParam(node.id, param.key, next, options)
                }
              />
            );
          })
        )}
      </div>
    </div>
  );
}
