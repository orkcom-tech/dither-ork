import React from "react";

import { Action, Field, Section } from "./controls";
import { unpackColors, formatHex } from "./color";
import type { BuiltinPalette } from "./library";
import { paletteSize, searchPalettes } from "./library";
import type { LibraryStatus } from "./store";

/**
 * The built-in hardware library — F-CO-04, with the search F-CO-14 wants over
 * the shipped half.
 *
 * The list is read from the core at the WASM boundary, never from a table in
 * the web layer. That is not tidiness: these are factual hardware colour
 * specifications, the renderer matches against the core's copy, and a second
 * copy in TypeScript would be a set of numbers that can silently stop being the
 * ones the picture is made from.
 *
 * A library that fails to load says so and offers a retry. It never presents as
 * an empty list, which is indistinguishable from a build with no palettes in it.
 */

export interface LibrarySectionProps {
  readonly library: readonly BuiltinPalette[];
  readonly status: LibraryStatus;
  readonly currentId: string;
  readonly onPick: (palette: BuiltinPalette) => void;
  readonly onRetry: () => void;
}

export function LibrarySection({
  library,
  status,
  currentId,
  onPick,
  onRetry,
}: LibrarySectionProps): React.ReactElement {
  const [query, setQuery] = React.useState("");
  const matches = searchPalettes(library, query);

  return (
    <Section
      title="library"
      note={status.kind === "ready" ? `${library.length} hardware` : status.kind}
    >
      {status.kind === "failed" ? (
        <div className="pal__row">
          <p className="pal__error">the core could not be read: {status.message}</p>
          <Action label="retry" onClick={onRetry} />
        </div>
      ) : null}

      {status.kind === "loading" ? <p className="pal__note">reading the core…</p> : null}

      {status.kind === "ready" ? (
        <React.Fragment>
          <Field label="filter">
            <input
              className="pal__input"
              type="search"
              spellCheck={false}
              value={query}
              placeholder="game boy, cga, c64…"
              aria-label="filter the built-in palettes"
              onChange={(event) => setQuery(event.target.value)}
            />
          </Field>

          {matches.length === 0 ? (
            <p className="pal__note">nothing in the library matches “{query}”</p>
          ) : (
            <ul className="pal__library">
              {matches.map((palette) => (
                <li key={palette.id}>
                  <button
                    type="button"
                    className="pal__library-item"
                    aria-pressed={palette.id === currentId}
                    title={`${palette.name} — ${paletteSize(palette)} colours`}
                    onClick={() => onPick(palette)}
                  >
                    <span className="pal__library-strip">
                      {unpackColors(palette.colors).map((rgb, index) => (
                        <span
                          key={index}
                          className="pal__library-chip"
                          style={{ background: formatHex(rgb) }}
                        />
                      ))}
                    </span>
                    <span className="pal__library-name">{palette.name}</span>
                    <span className="pal__note">{paletteSize(palette)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <p className="pal__prose">
            Hardware colour specifications only. Community palettes are not bundled —
            they are imported at runtime, which removes the licence question per palette
            rather than answering it.
          </p>
        </React.Fragment>
      ) : null}
    </Section>
  );
}
