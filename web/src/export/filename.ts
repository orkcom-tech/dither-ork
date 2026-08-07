/**
 * The name the file is offered under.
 *
 * Pure string arithmetic, and tested as such. It matters more than it looks:
 * the name is what `showSaveFilePicker` opens with and what a download lands
 * under, and the one thing it must never be is the source image's own name —
 * a picker pre-filled with `photo.png` sitting in the folder the person opened
 * `photo.png` from is one Enter key away from overwriting the original.
 *
 * Hence the `-dither` marker, which is not decoration.
 *
 * The `@4x` suffix is the convention every asset pipeline already uses for a
 * pixel multiplier, so a person exporting the same document at two scales gets
 * two files rather than one file twice.
 */

import { formatInfo } from "./settings";
import type { ExportSettings } from "./types";

/**
 * The punctuation Windows reserves in a file name. macOS reserves only the
 * slash and the colon, both of which are in here, so one list covers both
 * target platforms.
 */
const RESERVED = '<>:"/\\|?*';

/** The first printable code point. Anything below it is a C0 control. */
const FIRST_PRINTABLE = 0x20;
const DELETE = 0x7f;

/**
 * Drop what a filesystem will not take.
 *
 * A scan rather than a regular expression, because the control range has to be
 * written as an escape inside a character class and an escape there is one typo
 * away from a range that eats most of ASCII — a class beginning at a space
 * rather than at NUL silently removes every printable character up to the next
 * bound, and looks entirely reasonable while doing it.
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

/** What an export is called when no image is open under it. */
export const UNTITLED_BASE = "untitled";

/**
 * The stem of a source file name.
 *
 * Only the last extension is removed: `portrait.v2.png` is `portrait.v2`, not
 * `portrait`, because the middle dot is part of somebody's naming scheme.
 */
export function baseName(sourceName: string | null): string {
  if (sourceName === null) return UNTITLED_BASE;
  const withoutPath = sourceName.split(/[/\\]/).pop() ?? sourceName;
  const dot = withoutPath.lastIndexOf(".");
  const stem = dot > 0 ? withoutPath.slice(0, dot) : withoutPath;
  const cleaned = stripIllegal(stem).trim();
  // A name made entirely of characters that had to be removed leaves nothing,
  // and an empty stem produces a file called ".png" which most systems hide.
  return cleaned.length === 0 ? UNTITLED_BASE : cleaned.slice(0, 96);
}

export function exportFileName(
  sourceName: string | null,
  settings: ExportSettings,
): string {
  const scale = settings.scale > 1 ? `@${settings.scale}x` : "";
  return `${baseName(sourceName)}-dither${scale}.${formatInfo(settings.format).extension}`;
}
