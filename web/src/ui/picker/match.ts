/**
 * Why a result appeared, in a form the panel can draw (F-ST-08, F-UI-15).
 *
 * `registry/search.ts` ranks an effect against every field it carries — name,
 * keywords, id, summary, family, requirement, concept, slot, execution and the
 * whole description. That is what makes "bloom" find Epsilon glow. It also means
 * a row can appear for a reason that is nowhere on the row: the reader typed
 * "bloom", the list says "Epsilon glow", and the connection between the two is
 * invisible.
 *
 * An unexplained result is only slightly better than no result. The reader has
 * to decide whether the search understood them, and with nothing to go on they
 * do what the owner did — retype the query another way. So this module answers
 * the same question the ranking answers, but keeps the *evidence*: which spans
 * of the name and summary matched, and, when neither did, which keyword or which
 * sentence of the description is the reason the row is there.
 *
 * It is a second implementation of the matching rules rather than a hook into
 * the scorer, and that is deliberate. The scorer returns one number per effect;
 * recovering spans from a number is not possible, and changing it to carry them
 * would push a presentation concern into the thing Surprise Me and the guide
 * also call. The rules it duplicates are three lines long — a token matches a
 * word it starts, or failing that a substring anywhere — and `match.test.ts`
 * pins them against `searchEffects` so the two cannot drift into disagreeing
 * about whether something matched at all.
 */

import type { EffectDescriptor } from "../../types/registry";

/** A run of text, either matched by the query or not. */
export interface Segment {
  readonly text: string;
  readonly match: boolean;
}

/**
 * Cut a query the way `registry/search.ts` cuts it: case folded, every run of
 * punctuation or whitespace a separator, empties dropped.
 */
export function tokenize(query: string): readonly string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((token) => token.length > 0);
}

/**
 * A whole spec requirement id, typed as one.
 *
 * Mirrors `REQUIREMENT_QUERY` in `registry/search.ts`, and for a reason specific
 * to this file: `F-ED-01` tokenizes to `f`, `ed` and `01`, and highlighting
 * those would paint an `f` inside half the words on screen. The search treats an
 * id as an exact key rather than as text, so the highlighter must not treat it
 * as text either.
 */
const REQUIREMENT_QUERY = /^\s*F-[A-Z]{2}-[A-Z0-9]{2,3}\s*$/i;

/**
 * The tokens a query should highlight — empty for a requirement id, which is
 * looked up rather than ranked.
 */
export function highlightTokens(query: string): readonly string[] {
  return REQUIREMENT_QUERY.test(query) ? [] : tokenize(query);
}

function isWordChar(code: number): boolean {
  // 0-9, a-z. The haystack is lower-cased before this is asked.
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
}

function occurrences(haystack: string, token: string): readonly number[] {
  const at: number[] = [];
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(token, from);
    if (index === -1) break;
    at.push(index);
    from = index + 1;
  }
  return at;
}

function atWordStart(haystack: string, index: number): boolean {
  return index === 0 || !isWordChar(haystack.charCodeAt(index - 1));
}

/**
 * Where `token` matches in `text`, as `[start, end)` pairs.
 *
 * Word starts win: `bay` marks the head of `Bayer` and not the `bay` inside a
 * longer word elsewhere in the same string, which is the same preference the
 * scorer expresses by paying more for a prefix than for a substring. Only when
 * there is no word start anywhere does it fall back to marking substrings, so
 * that a match the scorer counted is never left invisible.
 */
function rangesOf(text: string, token: string): readonly (readonly [number, number])[] {
  const haystack = text.toLowerCase();
  const all = occurrences(haystack, token);
  if (all.length === 0) return [];
  const starts = all.filter((index) => atWordStart(haystack, index));
  const chosen = starts.length > 0 ? starts : all;
  return chosen.map((index) => [index, index + token.length] as const);
}

/** Whether the query token appears in this text at all. */
export function contains(text: string, token: string): boolean {
  return text.toLowerCase().includes(token);
}

/**
 * Split `text` into matched and unmatched runs.
 *
 * Overlapping ranges from different tokens are merged, so `red re` marks `red`
 * once rather than nesting two marks — an emphasis inside an emphasis reads as
 * neither.
 */
export function highlight(text: string, tokens: readonly string[]): readonly Segment[] {
  if (text.length === 0) return [];
  if (tokens.length === 0) return [{ text, match: false }];

  const ranges = tokens.flatMap((token) => rangesOf(text, token));
  if (ranges.length === 0) return [{ text, match: false }];

  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && start <= last[1]) {
      last[1] = Math.max(last[1], end);
      continue;
    }
    merged.push([start, end]);
  }

  const segments: Segment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}

/** Whether any segment in this run was marked. */
export function hasMatch(segments: readonly Segment[]): boolean {
  return segments.some((segment) => segment.match);
}

/**
 * The descriptor field a result is explained by.
 *
 * Closed, because each one is drawn with its own caption and a field nobody
 * wrote a caption for would render as an empty label.
 */
export type MatchField =
  | "keywords"
  | "family"
  | "concept"
  | "slot"
  | "execution"
  | "id"
  | "requirement"
  | "description";

/** One reason a row is on screen, ready to draw. */
export interface MatchReason {
  readonly field: MatchField;
  /** The caption, e.g. `also called`. */
  readonly label: string;
  readonly segments: readonly Segment[];
}

export interface EffectMatch {
  /** The name, with the query marked in it. */
  readonly name: readonly Segment[];
  /** The summary, with the query marked in it. */
  readonly summary: readonly Segment[];
  /**
   * Why the row appeared, when the name and summary do not show it.
   *
   * Empty for an empty query and empty whenever the visible text already
   * explains itself — a reason line under "Epsilon glow" for the query "glow"
   * is noise, and noise on sixty-seven rows is what makes a panel unreadable.
   */
  readonly reasons: readonly MatchReason[];
}

/** How much of a description to quote around a match, in characters either side. */
const SNIPPET_RADIUS = 70;

/**
 * A readable window of `text` around the first token in it.
 *
 * Snapped outwards to whitespace so the quote never starts mid-word, and marked
 * with an ellipsis on whichever side was cut. Returns null when no token is
 * present, which is how the caller decides there is nothing to quote.
 */
function snippetAround(text: string, tokens: readonly string[]): string | null {
  const haystack = text.toLowerCase();
  let first = -1;
  for (const token of tokens) {
    const index = haystack.indexOf(token);
    if (index !== -1 && (first === -1 || index < first)) first = index;
  }
  if (first === -1) return null;

  let start = Math.max(0, first - SNIPPET_RADIUS);
  let end = Math.min(text.length, first + SNIPPET_RADIUS);
  while (start > 0 && text[start - 1] !== " ") start -= 1;
  while (end < text.length && text[end] !== " ") end += 1;

  const head = start > 0 ? "…" : "";
  const tail = end < text.length ? "…" : "";
  return `${head}${text.slice(start, end).trim()}${tail}`;
}

interface StructuralField {
  readonly field: MatchField;
  readonly label: string;
  readonly value: string;
}

/**
 * The structural fields the scorer reads, in the order they explain a match
 * best.
 *
 * The raw descriptor value is what is shown rather than the pretty label the row
 * badges use, because the raw value is what matched: a query of `wasm` finds an
 * effect whose badge reads `cpu`, and quoting the badge back would explain the
 * result with a word that is not in the query.
 */
function structuralFields(effect: EffectDescriptor): readonly StructuralField[] {
  return [
    { field: "family", label: "family", value: effect.family },
    { field: "concept", label: "concept", value: effect.concept ?? "" },
    { field: "slot", label: "slot", value: effect.slot },
    { field: "execution", label: "runs on", value: effect.execution },
    { field: "id", label: "id", value: effect.id },
    // Last, and present at all only so that nothing the ranker returns is left
    // unexplained: the id is already on the row as a badge, so this line is
    // usually redundant and is usually never reached.
    { field: "requirement", label: "requirement", value: effect.requirement },
  ];
}

/**
 * Mark the query in an effect's visible text, and account for whatever it did
 * not appear in.
 *
 * The order of the reasons is the order they are worth reading. Keywords first:
 * that field exists precisely for the query the name does not answer, so it is
 * the likeliest explanation and the shortest. Structural fields next, because
 * one word explains them completely. The description last, since it costs a
 * quoted sentence to read and is the only one that ever needs eliding.
 */
export function explainMatch(
  effect: EffectDescriptor,
  tokens: readonly string[],
): EffectMatch {
  const name = highlight(effect.name, tokens);
  const summary = highlight(effect.summary, tokens);
  if (tokens.length === 0) return { name, summary, reasons: [] };

  const visible = `${effect.name} ${effect.summary}`;
  let unexplained = tokens.filter((token) => !contains(visible, token));
  if (unexplained.length === 0) return { name, summary, reasons: [] };

  const reasons: MatchReason[] = [];

  const hitKeywords = effect.keywords.filter((keyword) =>
    unexplained.some((token) => contains(keyword, token)),
  );
  if (hitKeywords.length > 0) {
    reasons.push({
      field: "keywords",
      label: "also called",
      segments: highlight(hitKeywords.join(", "), tokens),
    });
    unexplained = unexplained.filter(
      (token) => !hitKeywords.some((keyword) => contains(keyword, token)),
    );
  }

  for (const structural of structuralFields(effect)) {
    if (unexplained.length === 0) break;
    if (structural.value.length === 0) continue;
    if (!unexplained.some((token) => contains(structural.value, token))) continue;
    reasons.push({
      field: structural.field,
      label: structural.label,
      segments: highlight(structural.value, tokens),
    });
    unexplained = unexplained.filter((token) => !contains(structural.value, token));
  }

  if (unexplained.length > 0) {
    const snippet = snippetAround(effect.description, unexplained);
    if (snippet !== null) {
      reasons.push({
        field: "description",
        label: "described as",
        segments: highlight(snippet, tokens),
      });
    }
  }

  return { name, summary, reasons };
}
