/**
 * F-BA-05 — filename templating.
 *
 * Pure string arithmetic over a context, and tested as such. It carries more
 * weight in a batch than it does for a single export, for two reasons that both
 * end in lost work:
 *
 * - **A batch can write two hundred files into a directory the user chose**,
 *   which may well be the directory the inputs came from. A template that
 *   expands to the input's own name overwrites the originals, two hundred at a
 *   time, with no dialog in the way. Hence `DEFAULT_TEMPLATE` carries the same
 *   `-dither` marker `export/filename.ts` argues for, and hence
 *   {@link collisionsIn} exists.
 * - **Two inputs can produce one name.** `holiday/beach.png` and
 *   `work/beach.png` are different files and `{name}` is `beach` for both. The
 *   second write silently replaces the first. So the names are computed for the
 *   whole queue *before* the run starts and a collision is refused with the
 *   colliding name in the message — not renamed behind the user's back, because
 *   a file that quietly became `beach-2` is a file they cannot find.
 *
 * ## An unknown token is an error, not a literal
 *
 * `{naem}` left in the output would produce two hundred files with a brace in
 * the name and no indication that anything went wrong. {@link unknownTokensIn}
 * finds them and the panel refuses to start, naming the tokens that do exist.
 */

import { baseName, formatInfo } from "../export";
import type { ExportFormat } from "../export";

/** One substitution the template understands. */
export interface NameToken {
  /** Without the braces. */
  readonly id: string;
  /** One line for the panel's token list. */
  readonly detail: string;
}

/**
 * The tokens, in the order the panel lists them.
 *
 * F-BA-05 names four — original name, index, preset name, dimensions — and
 * `{format}` is the fifth because a person who exports the same folder as PNG
 * and again as SVG otherwise gets one set of files overwriting the other, and
 * the extension alone does not save them under a directory handle that
 * distinguishes files by full name.
 */
export const NAME_TOKENS: readonly NameToken[] = [
  { id: "name", detail: "the input file's name, without its extension" },
  { id: "index", detail: "position in the queue from 1, zero-padded to the queue's width" },
  { id: "preset", detail: "the open document's name" },
  { id: "width", detail: "output width in pixels, after the scale multiplier" },
  { id: "height", detail: "output height in pixels" },
  { id: "format", detail: "png, jpeg, webp or svg" },
];

/**
 * `{name}-dither`.
 *
 * The marker is not decoration: see the note at the top, and the same argument
 * at the top of `export/filename.ts`. A default of `{name}` would make the
 * first run of the feature a way to destroy the input folder.
 */
export const DEFAULT_TEMPLATE = "{name}-dither";

/** The longest a single output name may be, before the extension. */
const MAX_NAME_LENGTH = 120;

/**
 * The punctuation Windows reserves, plus the two macOS reserves, which are both
 * in this list. Applied to the *expanded* name: `{name}` is already stripped by
 * `baseName`, but the template itself is typed by a person and can contain
 * anything.
 */
const RESERVED = '<>:"/\\|?*';
const FIRST_PRINTABLE = 0x20;
const DELETE = 0x7f;

/** What a name falls back to when the template expands to nothing usable. */
export const UNTITLED_OUTPUT = "untitled";

export interface NameContext {
  /** The input file's name as it arrived, path and extension included. */
  readonly sourceName: string;
  /** Zero-based position in the queue. `{index}` shows it one-based. */
  readonly index: number;
  /** How many items are in the queue, which is what `{index}` pads against. */
  readonly total: number;
  readonly presetName: string;
  /** Output extent, after F-EX-12's multiplier. */
  readonly width: number;
  readonly height: number;
  readonly format: ExportFormat;
}

const TOKEN_PATTERN = /\{([^{}]*)\}/g;

/**
 * Drop what a filesystem will not take.
 *
 * A scan rather than a character class, for the reason `export/filename.ts`
 * gives: a class containing the control range is one typo away from eating most
 * of ASCII while looking entirely reasonable.
 */
function stripIllegal(name: string): string {
  let out = "";
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code < FIRST_PRINTABLE || code === DELETE) continue;
    if (RESERVED.includes(character)) continue;
    out += character;
  }
  return out;
}

/**
 * A name a filesystem and a ZIP central directory will both accept.
 *
 * Leading dots are removed as well as illegal characters: a file called
 * `.dither` is hidden on every Unix-like system, which for the output of a
 * batch is indistinguishable from the run having done nothing.
 */
export function sanitiseName(name: string): string {
  const cleaned = stripIllegal(name).trim().replace(/^\.+/, "").trimEnd();
  if (cleaned.length === 0) return UNTITLED_OUTPUT;
  return cleaned.slice(0, MAX_NAME_LENGTH);
}

/** How many digits `{index}` is padded to, so 010 sorts before 100. */
export function indexWidth(total: number): number {
  return Math.max(1, String(Math.max(1, total)).length);
}

function expandToken(id: string, context: NameContext): string | null {
  switch (id) {
    case "name":
      return baseName(context.sourceName);
    case "index":
      return String(context.index + 1).padStart(indexWidth(context.total), "0");
    case "preset":
      return context.presetName;
    case "width":
      return String(context.width);
    case "height":
      return String(context.height);
    case "format":
      return context.format;
    default:
      return null;
  }
}

/**
 * Tokens the template uses that do not exist.
 *
 * Returned rather than thrown so the panel can list every one of them at once
 * — a person fixing a template wants all their typos, not the first.
 */
export function unknownTokensIn(template: string): readonly string[] {
  const unknown: string[] = [];
  for (const match of template.matchAll(TOKEN_PATTERN)) {
    const id = match[1] ?? "";
    if (NAME_TOKENS.some((token) => token.id === id)) continue;
    if (!unknown.includes(id)) unknown.push(id);
  }
  return unknown;
}

/** The stem, with tokens expanded and the result made safe. No extension. */
export function applyTemplate(template: string, context: NameContext): string {
  const expanded = template.replace(TOKEN_PATTERN, (whole, id: string) => {
    const value = expandToken(id, context);
    // An unknown token is left exactly as written rather than blanked, so that
    // a caller which skipped `unknownTokensIn` produces a visibly wrong name
    // instead of a plausible one. `sanitiseName` then removes the braces, which
    // are legal on every filesystem here but are the loudest possible signal.
    return value ?? whole;
  });
  return sanitiseName(expanded);
}

/** The full output file name, extension included. */
export function outputFileName(template: string, context: NameContext): string {
  return `${applyTemplate(template, context)}.${formatInfo(context.format).extension}`;
}

/**
 * Names produced more than once, in first-seen order.
 *
 * The comparison is case-insensitive because Windows and the default macOS
 * volume are, and a batch that works on Linux and silently loses half its
 * output on a Mac is the worst of the three outcomes.
 */
export function collisionsIn(names: readonly string[]): readonly string[] {
  const seen = new Map<string, number>();
  const collided: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count === 2) collided.push(name);
  }
  return collided;
}

/**
 * Whether the name depends on the *output* extent.
 *
 * The one question that decides whether output names can be known before the
 * run: `{width}` and `{height}` are only certain once a frame has been encoded,
 * so a template using either cannot be checked for collisions up front. See
 * `plan.ts`.
 */
export function templateUsesExtent(template: string): boolean {
  for (const match of template.matchAll(TOKEN_PATTERN)) {
    const id = match[1] ?? "";
    if (id === "width" || id === "height") return true;
  }
  return false;
}

/** Why a template cannot be used, or `null` when it can. */
export function templateRefusal(template: string): string | null {
  if (template.trim().length === 0) {
    return "The name template is empty. Every file would be called “untitled”.";
  }
  const unknown = unknownTokensIn(template);
  if (unknown.length > 0) {
    const listed = unknown.map((id) => `{${id}}`).join(", ");
    const known = NAME_TOKENS.map((token) => `{${token.id}}`).join(", ");
    return `${listed} ${unknown.length === 1 ? "is not a token" : "are not tokens"}. Available: ${known}.`;
  }
  return null;
}
