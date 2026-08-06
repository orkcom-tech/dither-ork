import React from "react";

import { Action, Choice, Field, NumberField, Section } from "./controls";
import type { ExtractMethodId, ExtractSettings, ExtractionReport, PaletteSource } from "./extract";
import { EXTRACT_METHODS, K_RANGE, canExtract, entriesToExtract, lockedCount, methodLabel } from "./extract";
import type { Swatch } from "./model";

/**
 * Automatic palette extraction from the source — F-CO-02.
 *
 * The report is the reason this section is more than a button. An extraction
 * that comes back with eleven colours after being asked for sixteen has a
 * cause, and `occupiedBins` is it: the image does not hold sixteen
 * distinguishable colours at the histogram resolution the core clusters at.
 * Without that number on screen a short palette looks like a bug in the
 * extractor, and the next thing anyone does is change the algorithm.
 *
 * The seed is a field rather than a hidden constant because every extraction
 * records one, even the two methods that do not draw from it today. That is
 * what makes a `.dork` document reproduce its own palette, and what makes a
 * later change that adds a stochastic step unable to become quietly unseeded.
 */

export interface ExtractSectionProps {
  readonly swatches: readonly Swatch[];
  readonly settings: ExtractSettings;
  readonly source: PaletteSource | null;
  readonly running: boolean;
  readonly error: string | null;
  readonly report: ExtractionReport | null;
  readonly onSettings: (settings: ExtractSettings) => void;
  readonly onExtract: () => void;
}

export function ExtractSection({
  swatches,
  settings,
  source,
  running,
  error,
  report,
  onSettings,
  onExtract,
}: ExtractSectionProps): React.ReactElement {
  const allowed = canExtract(swatches, settings, source);
  const locked = lockedCount(swatches);
  const asked = entriesToExtract(swatches, settings);

  const blocked = running
    ? "an extraction is already running"
    : allowed.ok
      ? undefined
      : allowed.reason;

  return (
    <Section
      title="extract"
      note={source === null ? "no image" : `${source.width}x${source.height}`}
    >
      <Choice<ExtractMethodId>
        label="algorithm"
        value={settings.method}
        options={EXTRACT_METHODS.map((m) => ({ value: m, label: methodLabel(m) }))}
        onChange={(method) => onSettings({ ...settings, method })}
      />

      <div className="pal__row pal__row--wrap">
        <NumberField
          label="k"
          value={settings.k}
          min={K_RANGE.min}
          max={K_RANGE.max}
          hint="palette size, locked swatches included"
          onCommit={(k) => onSettings({ ...settings, k })}
        />
        <NumberField
          label="iterations"
          value={settings.maxIterations}
          min={1}
          max={512}
          hint="Lloyd ceiling; the single-pass methods ignore it"
          onCommit={(maxIterations) => onSettings({ ...settings, maxIterations })}
        />
      </div>

      <Field label="seed" hint="explicit, so the same document extracts the same palette">
        <div className="pal__row">
          <input
            className="pal__input pal__input--number"
            type="text"
            inputMode="numeric"
            spellCheck={false}
            value={settings.seed.toString()}
            aria-label="extraction seed"
            onChange={(event) => {
              const text = event.target.value.trim();
              // Digits only: the seed is 64-bit and arrives as a BigInt, and a
              // field that accepted "1e9" would hand the core a value nobody typed.
              if (!/^\d*$/.test(text)) return;
              onSettings({ ...settings, seed: text === "" ? 0n : BigInt(text) });
            }}
          />
          <Action
            label="+1"
            title="step the seed — deterministic, unlike a dice button"
            onClick={() => onSettings({ ...settings, seed: settings.seed + 1n })}
          />
        </div>
      </Field>

      <div className="pal__row">
        <Action
          label={running ? "extracting…" : "extract"}
          title={`ask the core for ${asked} colours`}
          onClick={onExtract}
          {...(blocked === undefined ? {} : { blocked })}
        />
        {locked > 0 ? (
          <span className="pal__note">
            {locked} locked · {asked} asked of the core
          </span>
        ) : null}
      </div>

      {error === null ? null : <p className="pal__error">extraction failed: {error}</p>}

      {report === null ? null : (
        <dl className="pal__report">
          <dt>method</dt>
          <dd>{methodLabel(report.method)}</dd>
          <dt>source</dt>
          <dd>{report.sourceName}</dd>
          <dt>asked / got</dt>
          <dd>
            {report.askedOfCore} / {report.paletteLen}
            {report.lockedKept > 0 ? ` (+${report.lockedKept} locked)` : ""}
          </dd>
          <dt>occupied bins</dt>
          <dd title="the ceiling on palette size for this image">{report.occupiedBins}</dd>
          <dt>iterations</dt>
          <dd>{report.iterations}</dd>
          <dt>empty clusters</dt>
          <dd>
            {report.emptyClusterRepairs} repaired · {report.emptyClustersDropped} dropped
          </dd>
          <dt>took</dt>
          <dd>{report.ms} ms</dd>
        </dl>
      )}

      {report !== null && report.paletteLen < report.askedOfCore ? (
        <p className="pal__warn">
          Short by {report.askedOfCore - report.paletteLen}: this image holds{" "}
          {report.occupiedBins} distinguishable colours at the clustering resolution, which
          is the ceiling on what any algorithm can return.
        </p>
      ) : null}
    </Section>
  );
}
