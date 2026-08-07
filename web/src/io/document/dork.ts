/**
 * The `.dork` file — F-DO-01, and its self-contained variant F-DO-02.
 *
 * `state/serialize.ts` already turns a document into JSON and, far more
 * importantly, turns JSON back into a document with every refusal F-DO-08 asks
 * for. **None of that is repeated here.** What this adds is everything that only
 * matters once a document is a file somebody keeps: canonical bytes, a name to
 * save it under, and the two-way switch between the referenced and the
 * self-contained variant.
 *
 * ## Canonical bytes, and why it is not just tidiness
 *
 * `JSON.stringify` writes keys in the order they were assigned. A document
 * assembled by `createDocument` and one rebuilt by `decodeDocument` hold the
 * same values in the same order today by coincidence — nothing enforces it, and
 * the day a mutation spreads its fields in a different order, save → load → save
 * stops being byte-identical for reasons nobody can see in a diff.
 *
 * So the encoder projects the document through a fixed field order and sorts
 * parameter keys, and the bytes then depend on the document's *values* and on
 * nothing else. Three things follow, and each is used:
 *
 * - **The round trip is byte-identical by construction**, not by luck, which is
 *   what `dork.test.ts` asserts.
 * - **Two documents are equal exactly when their bytes are**, so the share link
 *   and the preset library can compare recipes without a deep-equality walk.
 * - **The field order is the one in docs/API.md's example**, so a hand-read
 *   `.dork` looks like the documentation of it.
 *
 * ## Referenced or self-contained
 *
 * A `.dork` names its image and does not carry it. F-DO-02 adds the variant that
 * does, as `source.dataUrl` — the field `types/document.ts` already declares and
 * `decodeDocument` already reads. Producing that data URL needs a canvas and is
 * therefore in `embed.ts`; this module only moves the string in and out, which
 * keeps the format pure and testable without a browser.
 */

import type {
  Binding,
  Clock,
  CurvePoint,
  DitherDocument,
  Palette,
  ParameterValue,
  SourceRef,
  StackNode,
} from "../../types/document";
// Deep imports rather than the `state` barrel, and deliberately: that barrel
// pulls in `session.ts`, which pulls in the GPU layer and the WASM core. This
// module is a JSON codec, and so are its tests; neither should need a device.
import { decodeDocument } from "../../state/serialize";
import type { EffectRegistry } from "../../registry";
import { logger } from "../../lib/log";
import { DocumentFileError } from "./errors";
import { sniffDorkFile, type SniffedDorkFile } from "./file";

const log = logger("io");

export const DORK_EXTENSION = ".dork";

/**
 * `application/json` rather than a private type.
 *
 * The only consumers are the download the browser performs and whatever the
 * user opens the file with afterwards; a private type buys nothing from the
 * first and stops the second from syntax-highlighting it.
 */
export const DORK_MIME = "application/json";

/** For the `accept` attribute of the file input that opens one. */
export const DORK_ACCEPT = ".dork,.dorkpresets,.json,application/json";

// --- writing --------------------------------------------------------------

function canonicalCurve(points: readonly CurvePoint[]): readonly CurvePoint[] {
  return points.map((point) => ({ x: point.x, y: point.y }));
}

function canonicalParam(value: ParameterValue): ParameterValue {
  if (!Array.isArray(value)) return value;
  // A colour is three numbers and a curve is a list of objects — the two are
  // distinguishable without the descriptor, and this is the one place that
  // matters, because a curve's points each have a key order of their own.
  const first: unknown = value[0];
  if (typeof first === "object" && first !== null) {
    return canonicalCurve(value as readonly CurvePoint[]);
  }
  return value as ParameterValue;
}

function canonicalNode(node: StackNode): Record<string, unknown> {
  const params: Record<string, ParameterValue> = {};
  // Sorted, so the bytes do not depend on the order the descriptor happens to
  // declare its parameters in. Re-ordering a descriptor's `params` array is a
  // UI change; it must not rewrite every saved document.
  for (const key of Object.keys(node.params).sort()) {
    const value = node.params[key];
    if (value === undefined) continue;
    params[key] = canonicalParam(value);
  }
  return {
    id: node.id,
    effect: node.effect,
    enabled: node.enabled,
    opacity: node.opacity,
    blend: node.blend,
    params,
    seed: node.seed,
  };
}

function canonicalBinding(binding: Binding): Record<string, unknown> {
  return {
    nodeId: binding.nodeId,
    param: binding.param,
    shape: binding.shape,
    amount: binding.amount,
    cyclesPerLoop: binding.cyclesPerLoop,
    phase: binding.phase,
    bipolar: binding.bipolar,
  };
}

function canonicalPalette(palette: Palette): Record<string, unknown> {
  return {
    id: palette.id,
    name: palette.name,
    colors: [...palette.colors],
    metric: palette.metric,
  };
}

function canonicalClock(clock: Clock): Record<string, unknown> {
  return { frames: clock.frames, fps: clock.fps };
}

function canonicalSource(source: SourceRef | null): Record<string, unknown> | null {
  if (source === null) return null;
  return {
    name: source.name,
    width: source.width,
    height: source.height,
    // Last, and only when present: it is by far the largest field, and a file
    // that is readable in an editor up to the point the image starts is worth
    // more than one that opens on a megabyte of base64.
    ...(source.dataUrl === undefined ? {} : { dataUrl: source.dataUrl }),
  };
}

/** The document, projected through the fixed field order. */
export function canonicalDocument(document: DitherDocument): Record<string, unknown> {
  return {
    schema: document.schema,
    source: canonicalSource(document.source),
    palette: canonicalPalette(document.palette),
    clock: canonicalClock(document.clock),
    stack: document.stack.map(canonicalNode),
    bindings: document.bindings.map(canonicalBinding),
    ...(document.surpriseSeed === undefined ? {} : { surpriseSeed: document.surpriseSeed }),
  };
}

/**
 * The document as a `.dork` file's text.
 *
 * Indented, unlike the autosave record, which is written every 1.5 seconds and
 * never read by a person. This one is opened in editors, put in repositories and
 * diffed; two spaces costs about 15% and buys all of that.
 */
export function encodeDorkFile(document: DitherDocument): string {
  return `${JSON.stringify(canonicalDocument(document), null, 2)}\n`;
}

// --- reading --------------------------------------------------------------

/**
 * A `.dork` file's text back to a document.
 *
 * Every refusal comes from `decodeDocument`: a newer schema, an effect this
 * build does not have, a binding pointing at no node. This adds only the two
 * that are about the file rather than the document — bytes that are not JSON,
 * and JSON that is a preset library rather than a document.
 */
export function parseDorkFile(
  text: string,
  registry: EffectRegistry,
  what = "this file",
): DitherDocument {
  return decodeSniffedDocument(sniffDorkFile(text, what), registry, what);
}

/**
 * The same, for a caller that has already sniffed.
 *
 * The open control has to know which of the two shapes a file is before it can
 * decide whether to load it or import it, and a self-contained `.dork` is
 * megabytes — parsing it twice to answer one question is a visible pause on the
 * one file where it hurts most.
 */
export function decodeSniffedDocument(
  sniffed: SniffedDorkFile,
  registry: EffectRegistry,
  what = "this file",
): DitherDocument {
  if (sniffed.kind !== "document") {
    throw new DocumentFileError(
      "unrecognised-file",
      `${what} is a preset file, not a .dork document. Open it from the preset library instead.`,
    );
  }
  const document = decodeDocument(sniffed.value, registry);
  log.info("dork file parsed", {
    nodes: document.stack.length,
    selfContained: isSelfContained(document),
    source: document.source?.name ?? "<none>",
  });
  return document;
}

// --- the two variants -----------------------------------------------------

/** Whether this document carries its image (F-DO-02) rather than naming it. */
export function isSelfContained(document: DitherDocument): boolean {
  return document.source?.dataUrl !== undefined;
}

/**
 * The self-contained variant (F-DO-02).
 *
 * Refuses rather than inventing a source: a document with nothing open has
 * nothing to embed, and writing `{ name: "", width: 0 }` to make the call
 * succeed produces a file that opens to a zero-sized image.
 */
export function withEmbeddedSource(
  document: DitherDocument,
  dataUrl: string,
): DitherDocument {
  const source = document.source;
  if (source === null) {
    throw new DocumentFileError(
      "no-source",
      `a self-contained .dork carries the image, and this document has none open. ` +
        `Open an image first, or save the referenced variant.`,
    );
  }
  return { ...document, source: { ...source, dataUrl } };
}

/**
 * The referenced variant: the same document with the image taken back out.
 *
 * Used on both sides. Saving the ordinary variant strips a data URL that a
 * self-contained document was opened with, and *opening* one strips it too —
 * see `ui/documents`: the embedded bytes are unpacked into the session as a real
 * source, and leaving the base64 copy in the live document would put megabytes
 * through the autosave writer every 1.5 seconds for a picture already decoded.
 */
export function withoutEmbeddedSource(document: DitherDocument): DitherDocument {
  const source = document.source;
  if (source === null || source.dataUrl === undefined) return document;
  return {
    ...document,
    source: { name: source.name, width: source.width, height: source.height },
  };
}

// --- naming ---------------------------------------------------------------

/**
 * Characters a file name must not carry.
 *
 * The set is the union of what Windows forbids and what a POSIX path treats as
 * a separator, because the name is proposed to a download and lands on whatever
 * machine the browser is running on. Control characters go too — a name
 * containing one is either a mistake or an attempt at something.
 */
const UNSAFE_FILE_CHARS = /[\p{Cc}<>:"/\\|?*]+/gu;

export function safeFileStem(name: string, fallback: string): string {
  const withoutExtension = name.replace(/\.[^./\\]{1,8}$/, "");
  const cleaned = withoutExtension.replace(UNSAFE_FILE_CHARS, " ").trim().replace(/\s+/g, " ");
  // 96 is well inside every filesystem's limit and still long enough that a
  // truncation is rare; a name that is entirely punctuation falls back rather
  // than producing a file called ".dork".
  const clipped = cleaned.slice(0, 96).trim();
  return clipped.length === 0 ? fallback : clipped;
}

/**
 * What to call the file.
 *
 * Named after the image, because that is what the person is working on — a
 * folder of `untitled.dork` files is what happens otherwise. The self-contained
 * variant says so in the name, since the two are the same extension and differ
 * by an order of magnitude in size.
 */
export function documentFileName(
  document: DitherDocument,
  options: { readonly selfContained?: boolean } = {},
): string {
  const stem = safeFileStem(document.source?.name ?? "", "untitled");
  const suffix = options.selfContained === true ? "-embedded" : "";
  return `${stem}${suffix}${DORK_EXTENSION}`;
}
