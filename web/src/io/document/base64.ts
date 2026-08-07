/**
 * Bytes to text and back — for the embedded image (F-DO-02) and the share
 * fragment (F-DO-06).
 *
 * Two alphabets, because the two destinations have different forbidden
 * characters and picking one for both would break the other:
 *
 * - **Standard base64** for `data:` URLs, which is what the syntax specifies and
 *   what every image decoder expects.
 * - **base64url** for the share fragment. `+`, `/` and `=` all have meaning in a
 *   URL — `+` is a space in a query, `/` invites a path split by anything that
 *   rewrites links, `=` is the pair separator — and a link that survives being
 *   pasted into a chat window is the entire point of F-DO-06. The padding is
 *   dropped as well, since the length is recoverable from the data.
 *
 * `btoa`/`atob` are used rather than a hand-written table. They are latin-1 in
 * and out, which is exactly the mapping wanted here — one byte per code unit —
 * and the failure mode of a hand-rolled encoder is a picture that is subtly
 * wrong rather than an exception.
 */

import { DocumentFileError } from "./errors";

/** One byte per code unit, which is what `btoa` reads. */
function latin1(bytes: Uint8Array): string {
  // Chunked rather than one `String.fromCharCode(...bytes)` spread: an embedded
  // image is megabytes, and a spread of a megabyte-long array overflows the
  // argument stack. 8k is comfortably under every engine's limit.
  const CHUNK = 0x2000;
  let text = "";
  for (let at = 0; at < bytes.length; at += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return text;
}

function bytesOfLatin1(text: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

export function base64Encode(bytes: Uint8Array): string {
  return btoa(latin1(bytes));
}

export function base64Decode(text: string, what: string): Uint8Array<ArrayBuffer> {
  try {
    return bytesOfLatin1(atob(text));
  } catch (error) {
    throw new DocumentFileError(
      "bad-data-url",
      `${what} is not valid base64: ${String(error)}`,
      { chars: text.length },
    );
  }
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string, what: string): Uint8Array<ArrayBuffer> {
  const standard = text.replaceAll("-", "+").replaceAll("_", "/");
  // `atob` requires the padding even though it carries no information.
  const padding = (4 - (standard.length % 4)) % 4;
  try {
    return bytesOfLatin1(atob(standard + "=".repeat(padding)));
  } catch (error) {
    throw new DocumentFileError(
      "bad-share-link",
      `${what} is not valid base64url — the link was probably truncated on its way here: ${String(error)}`,
      { chars: text.length },
    );
  }
}

export interface DataUrl {
  readonly mime: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

export function encodeDataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${base64Encode(bytes)}`;
}

/**
 * Read a base64 `data:` URL.
 *
 * Only the base64 form is accepted. The percent-encoded form is legal syntax
 * and this layer never writes one, so accepting it would mean carrying a second
 * decoder for a case that can only arrive from a hand-edited file — and getting
 * that decoder subtly wrong shows up as a corrupt image rather than an error.
 */
export function parseDataUrl(text: string): DataUrl {
  const match = /^data:([^,;]*)(;[^,]*)?;base64,(.*)$/s.exec(text);
  if (match === null) {
    throw new DocumentFileError(
      "bad-data-url",
      `the embedded image is not a base64 "data:" URL. This build writes and reads only that form.`,
      { chars: text.length, head: text.slice(0, 32) },
    );
  }
  const mime = match[1] ?? "";
  const payload = match[3] ?? "";
  if (payload.length === 0) {
    throw new DocumentFileError("bad-data-url", `the embedded image carries no data.`, {
      mime,
    });
  }
  return { mime, bytes: base64Decode(payload, "the embedded image") };
}
