import React from "react";

import { logger } from "../../lib/log";
import type { EffectRegistry } from "../../registry";
import { EffectCatalogue } from "./EffectCatalogue";
import { GUIDE_CHAPTERS, factsFor, type GuideChapter } from "./chapters";
import "./guide.css";

const log = logger("app");

/** Anchor for a chapter, shared by the contents rail and the section itself. */
function anchorFor(chapter: GuideChapter): string {
  return `guide-chapter-${chapter.id}`;
}

const CATALOGUE_ANCHOR = "guide-catalogue";

/**
 * The user guide — F-UI-14 — as a toolbar action and a dialog.
 *
 * ## Why a dialog rather than a fifth panel
 *
 * `app/slots.ts` closes the panel ids to the four names F-UI-08 gives and states
 * that a fifth is a decision rather than an accident. The guide is not one of the
 * four: it is something you open, read and close, and while it is open it should
 * have the whole window rather than a column. A native `<dialog>` with
 * `showModal` gives the focus trap, the Escape key, the inert background and the
 * top layer, every one of which a hand-built overlay gets subtly wrong.
 *
 * ## What is written here and what is generated
 *
 * The chapters are prose about the ideas the registry cannot express — the
 * pipeline, the palette, linear light, the index map, the loop, the formats.
 * Everything about an individual effect is generated from its descriptor by
 * `EffectCatalogue`, which is F-UI-15: one source for descriptive text, read by
 * the properties panel, the search box and this.
 *
 * The body is mounted only while the dialog is open. Nothing here is expensive,
 * but a guide that quietly rebuilds a sixty-seven-entry catalogue on every render
 * of the toolbar would be a cost nobody would think to look for.
 */
export function GuideDialog({
  registry,
}: {
  readonly registry: EffectRegistry;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const dialogRef = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const jumpTo = (anchor: string): void => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const target = dialog.querySelector(`#${CSS.escape(anchor)}`);
    if (target === null) {
      // A contents entry pointing at nothing is a broken guide, and silence
      // would make it look like a click that did not register.
      log.warn("the guide has no section under a contents entry", { anchor });
      return;
    }
    // No `behavior: "smooth"`. It was tried first and it does not move the
    // dialog's scroller at all in Chrome — the animation is started and never
    // advances, so the contents rail became a row of buttons that appeared to do
    // nothing. A jump that works beats an animation that sometimes does, and it
    // is also what anyone asking for reduced motion wants.
    target.scrollIntoView({ block: "start" });
  };

  return (
    <React.Fragment>
      <button
        type="button"
        className="ui-button"
        aria-pressed={open}
        title="How this works: the stack, palettes, linear light, animation, export, and every effect"
        onClick={() => {
          if (!open) log.info("guide opened", { effects: registry.size });
          setOpen(!open);
        }}
      >
        guide
      </button>

      <dialog
        ref={dialogRef}
        className="guide"
        aria-label="User guide"
        onClose={() => setOpen(false)}
      >
        <header className="guide__head">
          <h2 className="ui-label">Guide</h2>
          <button type="button" className="ui-button" onClick={() => setOpen(false)}>
            close
          </button>
        </header>

        {open ? (
          <div className="guide__body">
            <nav className="guide__contents" aria-label="Contents">
              {GUIDE_CHAPTERS.map((chapter) => (
                <button
                  type="button"
                  className="guide__contents-item"
                  key={chapter.id}
                  onClick={() => jumpTo(anchorFor(chapter))}
                >
                  {chapter.title}
                </button>
              ))}
              <button
                type="button"
                className="guide__contents-item"
                onClick={() => jumpTo(CATALOGUE_ANCHOR)}
              >
                Every effect
              </button>
            </nav>

            <div className="guide__text ui-scroll">
              {GUIDE_CHAPTERS.map((chapter) => (
                <Chapter chapter={chapter} registry={registry} key={chapter.id} />
              ))}
              <EffectCatalogue registry={registry} />
            </div>
          </div>
        ) : null}
      </dialog>
    </React.Fragment>
  );
}

function Chapter({
  chapter,
  registry,
}: {
  readonly chapter: GuideChapter;
  readonly registry: EffectRegistry;
}): React.ReactElement {
  const facts = factsFor(chapter, registry);
  return (
    <section className="guide__chapter" id={anchorFor(chapter)}>
      <h3 className="guide__chapter-title">{chapter.title}</h3>
      <p className="guide__lede">{chapter.lede}</p>

      {chapter.steps === undefined ? null : (
        <ol className="guide__steps">
          {chapter.steps.map((step) => (
            <li className="guide__step" key={step.title}>
              <span className="guide__step-title">{step.title}</span>
              <span className="guide__prose">{step.text}</span>
            </li>
          ))}
        </ol>
      )}

      {chapter.paragraphs.map((paragraph) => (
        <p className="guide__prose" key={paragraph.slice(0, 48)}>
          {paragraph}
        </p>
      ))}

      {facts.length === 0 ? null : (
        <ul className="guide__facts">
          {facts.map((fact) => (
            <li className="guide__fact" key={fact.label}>
              <span className="guide__fact-label">{fact.label}</span>
              <span className="guide__fact-value">{fact.value}</span>
            </li>
          ))}
        </ul>
      )}

      {(chapter.lists ?? []).map((list) => (
        <div className="guide__list" key={list.title}>
          <h4 className="guide__list-title">{list.title}</h4>
          <dl className="guide__controls">
            {list.entries.map((entry) => (
              <React.Fragment key={entry.term}>
                <dt className="guide__control-term">{entry.term}</dt>
                <dd className="guide__control-detail">
                  <span className="guide__prose">{entry.detail}</span>
                </dd>
              </React.Fragment>
            ))}
          </dl>
        </div>
      ))}
    </section>
  );
}
