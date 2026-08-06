import React from "react";

import type { ColorMetric } from "../../types/document";
import { Choice, Field, NumberField, Section } from "./controls";
import type { OutputMode, OutputModeKind } from "./modes";
import {
  GREY_LEVEL_RANGE,
  OUTPUT_MODE_KINDS,
  PALETTE_SIZE_WARNING,
  RGB_LEVEL_RANGE,
  entryCount,
  modeLabel,
  modeOfKind,
} from "./modes";

/**
 * Output mode (F-CO-01) and the distance metric (F-CO-03).
 *
 * They sit together because they are the two controls that decide what the
 * palette *means* rather than what is in it: the mode decides which colours
 * exist, the metric decides which of them a pixel is sent to.
 *
 * **The metric is presented as a look control, because that is what it is.**
 * Neither setting is a fallback for a browser or a device that cannot do the
 * other. OKLab measures distance the way an eye does; sRGB Euclidean measures
 * it in gamma space, which is what period-accurate tools did, and choosing it
 * is choosing that look. The copy in this section says so, because a control
 * labelled only "oklab / srgb" invites the reading that one of them is the
 * broken one.
 */

export interface OutputSectionProps {
  readonly mode: OutputMode;
  readonly metric: ColorMetric;
  readonly entries: number;
  readonly onMode: (mode: OutputMode) => void;
  readonly onMetric: (metric: ColorMetric) => void;
}

export function OutputSection({
  mode,
  metric,
  entries,
  onMode,
  onMetric,
}: OutputSectionProps): React.ReactElement {
  const produced = entryCount(mode, entries);

  return (
    <Section title="output" open note={`${produced} entries`}>
      <Choice<OutputModeKind>
        label="output mode"
        value={mode.kind}
        options={OUTPUT_MODE_KINDS.map((kind) => ({ value: kind, label: modeLabel(kind) }))}
        onChange={(kind) => onMode(modeOfKind(kind, mode))}
      />

      {mode.kind === "greyscale" ? (
        <NumberField
          label="levels"
          value={mode.levels}
          min={GREY_LEVEL_RANGE.min}
          max={GREY_LEVEL_RANGE.max}
          hint="evenly spaced sRGB code values — the states an N-level device can show"
          onCommit={(levels) => onMode({ kind: "greyscale", levels })}
        />
      ) : null}

      {mode.kind === "rgb" ? (
        <div className="pal__row pal__row--wrap">
          <NumberField
            label="red"
            value={mode.red}
            min={RGB_LEVEL_RANGE.min}
            max={RGB_LEVEL_RANGE.max}
            onCommit={(red) => onMode({ ...mode, red })}
          />
          <NumberField
            label="green"
            value={mode.green}
            min={RGB_LEVEL_RANGE.min}
            max={RGB_LEVEL_RANGE.max}
            onCommit={(green) => onMode({ ...mode, green })}
          />
          <NumberField
            label="blue"
            value={mode.blue}
            min={RGB_LEVEL_RANGE.min}
            max={RGB_LEVEL_RANGE.max}
            onCommit={(blue) => onMode({ ...mode, blue })}
          />
        </div>
      ) : null}

      <p className="pal__prose">
        {mode.kind === "indexed"
          ? "The palette below is the output: every pixel becomes one of its entries."
          : `Generated: ${produced} entries. Editing a swatch by hand switches the mode to indexed, because a generated list that has been edited is no longer generated.`}
      </p>

      {produced > PALETTE_SIZE_WARNING ? (
        <p className="pal__warn">
          {produced} entries — the nearest-colour search is a linear scan per pixel, so
          this palette costs about {Math.round(produced / PALETTE_SIZE_WARNING)}x the
          matching time of a {PALETTE_SIZE_WARNING}-entry one.
        </p>
      ) : null}

      <Field label="distance metric" hint="a look control, not a correctness switch">
        <Choice<ColorMetric>
          label="distance metric"
          value={metric}
          options={[
            { value: "oklab", label: "oklab" },
            { value: "srgb", label: "srgb euclidean" },
          ]}
          onChange={onMetric}
        />
      </Field>

      <p className="pal__prose">
        {metric === "oklab"
          ? "OKLab: distance measured the way an eye judges it. The default, and what makes a photographic palette land on the colours a person would have picked."
          : "sRGB Euclidean: distance measured in gamma space. Not a fallback — it is what period-accurate tools did, and it picks harder, more contrasted matches."}
      </p>
    </Section>
  );
}
