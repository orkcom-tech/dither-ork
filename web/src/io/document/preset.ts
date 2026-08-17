/**
 * Presets — F-DO-03 (save the stack without the image, named) and F-DO-05
 * (import and export as a single file).
 *
 * ## A preset is a document with no picture in it
 *
 * That is the whole definition, and it is a definition rather than a
 * resemblance: `Preset.document` is a real {@link DitherDocument} whose `source`
 * is `null`. Everything follows from it.
 *
 * **Nothing here re-validates a stack.** Decoding a preset calls
 * `decodeDocument`, so a preset naming an effect this build does not have is
 * refused with the same message a `.dork` gets, a preset from a newer document
 * schema is refused by F-DO-08's rule, and a parameter outside its range is
 * coerced and logged by the registry rather than by a second copy of that logic
 * living over here. A separate preset validator would be a second opinion about
 * what a stack is, and the two would disagree the first time the schema moved.
 *
 * **A preset carrying a source is refused, not stripped.** Writing one is
 * impossible — {@link presetFromDocument} drops the reference — so a preset with
 * an image in it came from somewhere that thinks presets carry images, and
 * silently removing it would hide that. The rule this project follows is that a
 * file which is not what it says it is gets refused rather than repaired.
 *
 * ## The envelope has its own version
 *
 * The preset *file* is versioned separately from the document schema, because
 * they change for different reasons: a new document field is a change to what a
 * stack is, and a new envelope field is a change to what a library is. Both
 * refuse a version from the future rather than reading what they recognise —
 * a preset file half-read is a stack that renders and is not the one that was
 * saved.
 */

import type { DitherDocument } from "../../types/document";
import { DOCUMENT_SCHEMA_VERSION } from "../../types/document";
// Deep imports rather than the `state` barrel — see the note in `dork.ts`.
import { decodeDocument } from "../../state/serialize";
import type { EffectRegistry } from "../../registry";
import { logger } from "../../lib/log";
import { DocumentFileError } from "./errors";
import { PRESET_FILE_KIND, isRecord, sniffDorkFile } from "./file";

const log = logger("io");

/** The preset *file* envelope's version. Not the document schema's. */
export const PRESET_FILE_SCHEMA_VERSION = 1 as const;

export const PRESET_EXTENSION = ".dorkpresets";

/** A preset file is JSON, and is offered to the same open control as a `.dork`. */
export const PRESET_MIME = "application/json";

export interface Preset {
  /** Stable handle. Not shown; the name is what a person sees. */
  readonly id: string;
  readonly name: string;
  /** ISO 8601, from the library's clock. Sorts the list. */
  readonly createdAt: string;
  /** One line about what it is for. The starter set carries one; saves need not. */
  readonly note: string | null;
  /**
   * Part of the shipped starter set (F-DO-04) rather than something stored.
   *
   * Not written to a file and never read from one: it is a fact about where this
   * build got the preset, so a library that stored it could come back claiming
   * a deleted starter preset is still built in.
   */
  readonly builtin: boolean;
  /** The stack, palette, clock and bindings. `source` is always `null`. */
  readonly document: DitherDocument;
}

// --- from and to a document ----------------------------------------------

export interface PresetIdentity {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly note?: string | null;
}

/**
 * Take the recipe out of a document (F-DO-03).
 *
 * The image reference goes — that is what makes it a preset — and `surpriseSeed`
 * stays, because it reproduces the recipe and the recipe is exactly what is
 * being kept.
 */
export function presetFromDocument(
  document: DitherDocument,
  identity: PresetIdentity,
): Preset {
  const name = requireName(identity.name);
  return {
    id: identity.id,
    name,
    createdAt: identity.createdAt,
    note: identity.note ?? null,
    builtin: false,
    document: { ...document, source: null },
  };
}

/**
 * Put a preset onto the document that is open (F-DO-03, "apply").
 *
 * The source stays. Applying a preset is a change of recipe, not a change of
 * picture, and a person who applies one to the image they have open expects to
 * see that image treated differently — not to lose it.
 */
export function applyPreset(preset: Preset, document: DitherDocument): DitherDocument {
  const { source } = document;
  const next = preset.document;
  return {
    schema: next.schema,
    source,
    stack: next.stack,
    // The wiring travels with the recipe, because it *is* part of the recipe
    // now: a preset that carried its nodes and not its edges would apply as a
    // chain whatever graph it was saved from.
    edges: next.edges,
    output: next.output,
    palette: next.palette,
    clock: next.clock,
    bindings: next.bindings,
    ...(next.surpriseSeed === undefined ? {} : { surpriseSeed: next.surpriseSeed }),
  };
}

/** The preset as a document in its own right — nothing open, just the stack. */
export function documentFromPreset(preset: Preset): DitherDocument {
  return preset.document;
}

// --- names and ids --------------------------------------------------------

/**
 * A name, or a refusal.
 *
 * An empty name is refused rather than replaced with "Untitled": a library of
 * things called Untitled is a library nobody can use, and the moment to say so
 * is while the person is still looking at the box they typed it into.
 */
export function requireName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) {
    throw new DocumentFileError("empty-name", `a preset needs a name.`);
  }
  // Long enough for a sentence, short enough to render in a list row.
  return trimmed.slice(0, 80);
}

const PRESET_ID_PATTERN = /^p(\d+)$/;

/**
 * The next free preset id.
 *
 * Derived from the ids in hand rather than from a counter or a random draw, for
 * the same reason `nextNodeId` is: the library is rebuilt from a file on every
 * load, and a counter would hand out an id the file already contains. It also
 * keeps the library reproducible, which is what lets its tests assert on whole
 * files rather than on shapes.
 */
export function nextPresetId(existing: Iterable<string>): string {
  let highest = 0;
  for (const id of existing) {
    const match = PRESET_ID_PATTERN.exec(id);
    if (match === null) continue;
    const index = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(index) && index > highest) highest = index;
  }
  return `p${highest + 1}`;
}

// --- the file (F-DO-05) ---------------------------------------------------

function canonicalPreset(preset: Preset): Record<string, unknown> {
  return {
    id: preset.id,
    name: preset.name,
    createdAt: preset.createdAt,
    note: preset.note,
    // `builtin` is not written: see the field's note.
    document: preset.document,
  };
}

/**
 * One or many presets as one file (F-DO-05).
 *
 * One format for both, rather than a single-preset format and a library format:
 * "export this preset" and "export my library" are the same operation over a
 * different selection, and two formats would mean an import that has to guess
 * which it was handed.
 */
export function encodePresetFile(presets: readonly Preset[]): string {
  const file = {
    schema: PRESET_FILE_SCHEMA_VERSION,
    kind: PRESET_FILE_KIND,
    presets: presets.map(canonicalPreset),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function decodePresetFile(
  text: string,
  registry: EffectRegistry,
  what = "this file",
): readonly Preset[] {
  const sniffed = sniffDorkFile(text, what);
  if (sniffed.kind !== "preset-library") {
    throw new DocumentFileError(
      "unrecognised-file",
      `${what} is a .dork document, not a preset file. Open it as a document instead.`,
    );
  }
  return decodePresetRecord(sniffed.value, registry, what);
}

/** The envelope, already parsed. Shared by the file and the stored library. */
export function decodePresetRecord(
  value: Record<string, unknown>,
  registry: EffectRegistry,
  what: string,
): readonly Preset[] {
  const schema = value["schema"];
  if (typeof schema !== "number" || !Number.isFinite(schema)) {
    throw new DocumentFileError(
      "malformed-preset",
      `${what} has no numeric "schema".`,
      { schema: String(schema) },
    );
  }
  if (schema > PRESET_FILE_SCHEMA_VERSION) {
    throw new DocumentFileError(
      "future-schema",
      `${what} is preset-file schema ${schema} and this build understands ` +
        `${PRESET_FILE_SCHEMA_VERSION}. It is refused rather than read as far as it goes, ` +
        `because a field this build does not know about would be dropped the next time the ` +
        `library is written.`,
      { schema, understood: PRESET_FILE_SCHEMA_VERSION },
    );
  }
  if (schema !== PRESET_FILE_SCHEMA_VERSION) {
    // Version 1 is the only version there has ever been, so there is nothing to
    // migrate from. When there is a second, the migration goes here and this
    // message stops being reachable.
    throw new DocumentFileError(
      "malformed-preset",
      `${what} is preset-file schema ${schema}, which this build has no migration from.`,
      { schema },
    );
  }

  const raw = value["presets"];
  if (!Array.isArray(raw)) {
    throw new DocumentFileError("malformed-preset", `${what} has no "presets" array.`);
  }

  const presets: Preset[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const preset = decodePreset(entry, registry, `${what}: preset ${index + 1}`);
    if (seen.has(preset.id)) {
      throw new DocumentFileError(
        "malformed-preset",
        `${what} has two presets with the id "${preset.id}"; every reference to it would be ambiguous.`,
        { id: preset.id },
      );
    }
    seen.add(preset.id);
    presets.push(preset);
  }

  log.info("preset file decoded", { presets: presets.length, what });
  return presets;
}

export function decodePreset(
  value: unknown,
  registry: EffectRegistry,
  what: string,
): Preset {
  if (!isRecord(value)) {
    throw new DocumentFileError("malformed-preset", `${what} is not an object.`);
  }

  const id = value["id"];
  const name = value["name"];
  const createdAt = value["createdAt"];
  if (typeof id !== "string" || id.length === 0) {
    throw new DocumentFileError("malformed-preset", `${what} has no "id".`);
  }
  if (typeof name !== "string") {
    throw new DocumentFileError("malformed-preset", `${what} has no "name".`);
  }
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
    throw new DocumentFileError(
      "malformed-preset",
      `${what} has no readable "createdAt" timestamp.`,
      { createdAt: String(createdAt) },
    );
  }

  const note = value["note"];
  if (note !== null && note !== undefined && typeof note !== "string") {
    throw new DocumentFileError("malformed-preset", `${what} has a "note" that is not text.`);
  }

  // Every refusal a `.dork` gets, from the one decoder that has them.
  const document = decodeDocument(value["document"], registry);
  if (document.source !== null) {
    throw new DocumentFileError(
      "preset-carries-a-source",
      `${what} carries an image reference ("${document.source.name}"). A preset is a stack ` +
        `without a picture (F-DO-03); a file that keeps one is not a preset and is refused ` +
        `rather than quietly emptied.`,
      { source: document.source.name },
    );
  }
  if (document.schema !== DOCUMENT_SCHEMA_VERSION) {
    // Unreachable while `decodeDocument` normalises to the current version; kept
    // because the day it migrates instead, this is the assumption that broke.
    throw new DocumentFileError(
      "malformed-preset",
      `${what} decoded to document schema ${document.schema}, not ${DOCUMENT_SCHEMA_VERSION}.`,
    );
  }

  return {
    id,
    name: requireName(name),
    createdAt,
    note: typeof note === "string" ? note : null,
    builtin: false,
    document,
  };
}
