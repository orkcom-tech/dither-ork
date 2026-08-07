/**
 * `.dork` on the way out and on the way in (F-DO-01, F-DO-08).
 *
 * Writing is `JSON.stringify` and needs no help. **Reading is where the work
 * is**, and the rule it follows is the one the schema section of docs/API.md
 * states: a document that cannot be read as what it says it is, is refused
 * rather than repaired. A loader that patches around a missing field produces a
 * document that renders — just not the one that was saved — and there is no
 * later point at which anyone finds out.
 *
 * Three refusals in particular are load-bearing:
 *
 * - **A newer `schema` is refused, not read on a best-effort basis** (F-DO-08).
 *   A build that guesses at a field it does not know about turns a forward
 *   migration into a silent data loss.
 * - **An effect the catalogue does not have is refused.** Rendering the rest of
 *   the stack would produce a plausible picture with one node missing, which is
 *   the failure nobody can see.
 * - **Parameters go through the registry's `coerceParams`**, the same call
 *   `setNodeParam` makes. A value outside its range is clamped to the
 *   descriptor's bound and the adjustment is logged; a key the effect no longer
 *   declares is dropped and logged. Both are stated, neither is silent.
 */

import type {
  Binding,
  BlendMode,
  Clock,
  DitherDocument,
  ModulatorShape,
  Palette,
  SourceRef,
  StackNode,
} from "../types/document";
import { DOCUMENT_SCHEMA_VERSION } from "../types/document";
import type { EffectRegistry } from "../registry";
import { coerceParams } from "../registry";
import { logger } from "../lib/log";
import { DocumentError } from "./errors";

const log = logger("app");

// The accepted set, in the order `graph/blend.ts` numbers them. A `.dork`
// naming anything else is rejected rather than defaulted to `normal`: a blend
// mode a build does not have is a document from a newer build, and rendering it
// as normal would show a picture the file does not describe.
const BLEND_MODES: readonly BlendMode[] = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "hard-light",
  "soft-light",
  "darken",
  "lighten",
  "difference",
  "exclusion",
  "add",
  "subtract",
];

const MODULATOR_SHAPES: readonly ModulatorShape[] = [
  "sine",
  "triangle",
  "saw",
  "square",
  "smooth-noise",
  "stepped-random",
];

/** The document as a `.dork` file's bytes. */
export function encodeDocument(document: DitherDocument): string {
  return JSON.stringify(document);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(source: Record<string, unknown>, key: string, where: string): unknown {
  if (!(key in source)) {
    throw new DocumentError(
      "malformed-document",
      `${where} has no "${key}"`,
      { where, key },
    );
  }
  return source[key];
}

function asNumber(value: unknown, where: string, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DocumentError(
      "malformed-document",
      `${where}.${key} is ${JSON.stringify(value)}; expected a finite number`,
      { where, key },
    );
  }
  return value;
}

function asString(value: unknown, where: string, key: string): string {
  if (typeof value !== "string") {
    throw new DocumentError(
      "malformed-document",
      `${where}.${key} is ${JSON.stringify(value)}; expected a string`,
      { where, key },
    );
  }
  return value;
}

function asBoolean(value: unknown, where: string, key: string): boolean {
  if (typeof value !== "boolean") {
    throw new DocumentError(
      "malformed-document",
      `${where}.${key} is ${JSON.stringify(value)}; expected a boolean`,
      { where, key },
    );
  }
  return value;
}

/**
 * Parse a document.
 *
 * `value` is whatever `JSON.parse` produced — this does the parsing of the
 * *shape*, which is the part a JSON parser cannot do.
 */
export function decodeDocument(
  value: unknown,
  registry: EffectRegistry,
): DitherDocument {
  if (!isRecord(value)) {
    throw new DocumentError(
      "malformed-document",
      `a .dork document is a JSON object; got ${Array.isArray(value) ? "an array" : typeof value}`,
    );
  }

  const schema = asNumber(field(value, "schema", "document"), "document", "schema");
  if (schema > DOCUMENT_SCHEMA_VERSION) {
    throw new DocumentError(
      "future-schema",
      `this document is schema ${schema} and this build understands ${DOCUMENT_SCHEMA_VERSION}. ` +
        `It is refused rather than read as far as it goes, because a field this build ` +
        `does not know about would be dropped on the next save.`,
      { schema, understood: DOCUMENT_SCHEMA_VERSION },
    );
  }
  if (schema !== DOCUMENT_SCHEMA_VERSION) {
    // Schema 1 is the only version there has ever been, so there is no
    // migration to run and nothing to migrate from. When there is a second, the
    // migration goes here and this message stops being reachable.
    throw new DocumentError(
      "malformed-document",
      `schema ${schema} is not a version this build has a migration from`,
      { schema },
    );
  }

  const document: DitherDocument = {
    schema: DOCUMENT_SCHEMA_VERSION,
    source: decodeSource(field(value, "source", "document")),
    stack: decodeStack(field(value, "stack", "document"), registry),
    palette: decodePalette(field(value, "palette", "document")),
    clock: decodeClock(field(value, "clock", "document")),
    bindings: decodeBindings(field(value, "bindings", "document")),
    ...(typeof value["surpriseSeed"] === "string"
      ? { surpriseSeed: value["surpriseSeed"] }
      : {}),
  };

  for (const binding of document.bindings) {
    if (document.stack.some((node) => node.id === binding.nodeId)) continue;
    throw new DocumentError(
      "unknown-node",
      `a binding targets node "${binding.nodeId}", which is not in this document's stack`,
      { nodeId: binding.nodeId, param: binding.param },
    );
  }

  log.info("document decoded", {
    nodes: document.stack.length,
    bindings: document.bindings.length,
    palette: document.palette.id,
    source: document.source?.name ?? "<none>",
  });
  return document;
}

function decodeSource(value: unknown): SourceRef | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new DocumentError(
      "malformed-document",
      `document.source is ${typeof value}; expected an object or null`,
    );
  }
  const ref: SourceRef = {
    name: asString(field(value, "name", "source"), "source", "name"),
    width: asNumber(field(value, "width", "source"), "source", "width"),
    height: asNumber(field(value, "height", "source"), "source", "height"),
    ...(typeof value["dataUrl"] === "string" ? { dataUrl: value["dataUrl"] } : {}),
  };
  return ref;
}

function decodeStack(value: unknown, registry: EffectRegistry): readonly StackNode[] {
  if (!Array.isArray(value)) {
    throw new DocumentError("malformed-document", "document.stack is not an array");
  }

  const seen = new Set<string>();
  const stack: StackNode[] = [];
  for (const [index, raw] of value.entries()) {
    const where = `stack[${index}]`;
    if (!isRecord(raw)) {
      throw new DocumentError("malformed-document", `${where} is not an object`);
    }

    const id = asString(field(raw, "id", where), where, "id");
    if (seen.has(id)) {
      throw new DocumentError(
        "malformed-document",
        `two nodes share the id "${id}"; every edge and every binding referring to it would be ambiguous`,
        { nodeId: id },
      );
    }
    seen.add(id);

    const effect = asString(field(raw, "effect", where), where, "effect");
    const descriptor = registry.get(effect);
    if (descriptor === undefined) {
      throw new DocumentError(
        "unknown-effect",
        `node "${id}" names effect "${effect}", which this build's catalogue does not have. ` +
          `The document is refused rather than rendered with one node missing.`,
        { nodeId: id, effect },
      );
    }

    const blend = asString(field(raw, "blend", where), where, "blend");
    if (!BLEND_MODES.includes(blend as BlendMode)) {
      throw new DocumentError(
        "malformed-document",
        `${where}.blend is "${blend}"; expected one of ${BLEND_MODES.join(", ")}`,
        { nodeId: id, blend },
      );
    }

    const params = field(raw, "params", where);
    if (!isRecord(params)) {
      throw new DocumentError("malformed-document", `${where}.params is not an object`);
    }

    stack.push({
      id,
      effect,
      enabled: asBoolean(field(raw, "enabled", where), where, "enabled"),
      opacity: asNumber(field(raw, "opacity", where), where, "opacity"),
      blend: blend as BlendMode,
      params: coerceParams(descriptor, params).values,
      seed: asNumber(field(raw, "seed", where), where, "seed"),
    });
  }
  return stack;
}

function decodePalette(value: unknown): Palette {
  if (!isRecord(value)) {
    throw new DocumentError("malformed-document", "document.palette is not an object");
  }
  const colors = field(value, "colors", "palette");
  if (!Array.isArray(colors) || colors.length === 0 || colors.length % 3 !== 0) {
    throw new DocumentError(
      "malformed-document",
      `palette.colors is not a non-empty multiple of three packed sRGB components`,
    );
  }
  const components: number[] = [];
  for (const [index, component] of colors.entries()) {
    if (
      typeof component !== "number" ||
      !Number.isInteger(component) ||
      component < 0 ||
      component > 255
    ) {
      throw new DocumentError(
        "malformed-document",
        `palette.colors[${index}] is ${JSON.stringify(component)}; expected an integer in 0..255`,
        { index },
      );
    }
    components.push(component);
  }

  const metric = asString(field(value, "metric", "palette"), "palette", "metric");
  if (metric !== "oklab" && metric !== "srgb") {
    throw new DocumentError(
      "malformed-document",
      `palette.metric is "${metric}"; expected "oklab" or "srgb"`,
      { metric },
    );
  }

  return {
    id: asString(field(value, "id", "palette"), "palette", "id"),
    name: asString(field(value, "name", "palette"), "palette", "name"),
    colors: components,
    metric,
  };
}

function decodeClock(value: unknown): Clock {
  if (!isRecord(value)) {
    throw new DocumentError("malformed-document", "document.clock is not an object");
  }
  const frames = asNumber(field(value, "frames", "clock"), "clock", "frames");
  const fps = asNumber(field(value, "fps", "clock"), "clock", "fps");
  if (!Number.isInteger(frames) || frames < 1) {
    throw new DocumentError(
      "malformed-document",
      `clock.frames is ${frames}; normalized time is frame / frames, so it must be a positive integer`,
      { frames },
    );
  }
  if (fps <= 0) {
    throw new DocumentError("malformed-document", `clock.fps is ${fps}; expected positive`, {
      fps,
    });
  }
  return { frames, fps };
}

function decodeBindings(value: unknown): readonly Binding[] {
  if (!Array.isArray(value)) {
    throw new DocumentError("malformed-document", "document.bindings is not an array");
  }
  const bindings: Binding[] = [];
  for (const [index, raw] of value.entries()) {
    const where = `bindings[${index}]`;
    if (!isRecord(raw)) {
      throw new DocumentError("malformed-document", `${where} is not an object`);
    }
    const shape = asString(field(raw, "shape", where), where, "shape");
    if (!MODULATOR_SHAPES.includes(shape as ModulatorShape)) {
      throw new DocumentError(
        "malformed-document",
        `${where}.shape is "${shape}"; expected one of ${MODULATOR_SHAPES.join(", ")}`,
        { shape },
      );
    }
    const cyclesPerLoop = asNumber(
      field(raw, "cyclesPerLoop", where),
      where,
      "cyclesPerLoop",
    );
    if (!Number.isInteger(cyclesPerLoop)) {
      throw new DocumentError(
        "malformed-document",
        `${where}.cyclesPerLoop is ${cyclesPerLoop}; a non-integer means frame N does not equal frame 0 and the loop does not close`,
        { cyclesPerLoop },
      );
    }
    bindings.push({
      nodeId: asString(field(raw, "nodeId", where), where, "nodeId"),
      param: asString(field(raw, "param", where), where, "param"),
      shape: shape as ModulatorShape,
      amount: asNumber(field(raw, "amount", where), where, "amount"),
      cyclesPerLoop,
      phase: asNumber(field(raw, "phase", where), where, "phase"),
      bipolar: asBoolean(field(raw, "bipolar", where), where, "bipolar"),
    });
  }
  return bindings;
}
