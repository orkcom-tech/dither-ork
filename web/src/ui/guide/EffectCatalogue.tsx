import React from "react";

import { describeMiss } from "../../registry";
import type { EffectRegistry } from "../../registry";
import { EXECUTION_LABEL, SLOT_LABEL } from "../stack/model";
import { catalogueFor, type GuideEffect } from "./catalogue";

/**
 * The generated half of the guide (F-UI-14, F-UI-15).
 *
 * Every word under this heading comes from a descriptor. The component decides
 * layout and nothing else — there is no effect name, no summary and no
 * parameter list in this file, which is what makes an effect added tomorrow
 * documented tomorrow.
 *
 * ## Why there is a search box in a guide
 *
 * Because the reference is sixty-seven entries long and the question a person
 * arrives with is nearly always "what does the thing that does X do". It is the
 * registry's own search (F-ST-08), the same ranking the add-node picker uses, so
 * a spec id, a keyword or a half-remembered word all land in the same place —
 * and when it finds nothing it prints the registry's own explanation, which
 * knows the difference between a typo and a feature the spec names and this
 * build does not have.
 *
 * ## Why the controls are folded away
 *
 * There are several hundred of them. Printed flat they would bury the
 * descriptions, and the guide's job is the description; the properties panel is
 * where a control is actually reached, and it carries the same sentence beside
 * the control itself.
 */
export function EffectCatalogue({
  registry,
}: {
  readonly registry: EffectRegistry;
}): React.ReactElement {
  const [query, setQuery] = React.useState("");
  const view = React.useMemo(() => catalogueFor(registry, query), [registry, query]);

  return (
    <section className="guide__chapter" id="guide-catalogue">
      <h3 className="guide__chapter-title">Every effect</h3>
      <p className="guide__lede">
        Generated from the catalogue this build actually holds, grouped by the idea each
        family shares.
      </p>

      <div className="guide__search">
        <input
          className="guide__input"
          type="search"
          value={query}
          placeholder="search the catalogue — a name, a look, or a spec id"
          aria-label="Search the effect catalogue"
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="guide__count">
          {view.query.trim().length === 0
            ? `${view.total} effects`
            : `${view.catalogue.effects} of ${view.total}`}
        </span>
      </div>

      {view.miss === null ? null : (
        <p className="guide__miss">{describeMiss(view.miss, view.query)}</p>
      )}

      {view.catalogue.sections.map((section) => (
        <section className="guide__concept" key={section.id} id={`guide-concept-${section.id}`}>
          <h4 className="guide__concept-title">{section.title}</h4>
          <p className="guide__summary">{section.summary}</p>
          {/* Printed only in the resting state: with a query the reader is
              looking for one effect, and four paragraphs of family theory
              between them and it is noise. */}
          {view.query.trim().length === 0 ? (
            <p className="guide__prose">{section.description}</p>
          ) : null}
          {section.effects.map((effect) => (
            <EffectEntry effect={effect} key={effect.id} />
          ))}
        </section>
      ))}
    </section>
  );
}

function EffectEntry({ effect }: { readonly effect: GuideEffect }): React.ReactElement {
  const controls = effect.controls.length;
  return (
    <article className="guide__effect" id={`guide-effect-${effect.id}`}>
      <header className="guide__effect-head">
        <h5 className="guide__effect-name">{effect.name}</h5>
        <span className="guide__badges">
          {/* The same two words the stack panel puts on a row, from the same
              table, so the guide and the interface cannot disagree about what a
              node is called. */}
          <span className="guide__badge">{SLOT_LABEL[effect.slot]}</span>
          <span className="guide__badge">{EXECUTION_LABEL[effect.execution]}</span>
          {effect.producesIndexMap ? (
            <span className="guide__badge" title="Leaves a palette index per pixel behind it">
              index map
            </span>
          ) : null}
          {effect.requiresIndexMap ? (
            <span className="guide__badge" title="Only legal below a dither that writes an index map">
              needs one above it
            </span>
          ) : null}
          <span className="guide__badge guide__badge--faint">{effect.requirement}</span>
        </span>
      </header>
      <p className="guide__summary">{effect.summary}</p>
      <p className="guide__prose">{effect.description}</p>
      {controls === 0 ? (
        <p className="guide__note">No controls: it does one thing.</p>
      ) : (
        <details className="guide__details">
          <summary className="guide__details-summary">
            {controls} {controls === 1 ? "control" : "controls"}
          </summary>
          <dl className="guide__controls">
            {effect.controls.map((control) => (
              <React.Fragment key={control.key}>
                <dt className="guide__control-term">
                  {control.label}
                  {control.animatable ? (
                    <span className="guide__badge guide__badge--faint" title="Can be animated">
                      bindable
                    </span>
                  ) : null}
                </dt>
                <dd className="guide__control-detail">
                  <span className="guide__prose">{control.description}</span>
                  <span className="guide__note">{control.detail}</span>
                </dd>
              </React.Fragment>
            ))}
          </dl>
        </details>
      )}
    </article>
  );
}
