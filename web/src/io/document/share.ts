/**
 * Sharing by URL — F-DO-06.
 *
 * ## The fragment is the feature
 *
 * The payload goes after the `#`. A URL fragment is **never sent to a server**:
 * it is not in the request line, not in a log, not in a referrer header, and not
 * in whatever analytics the host has. That is the privacy property that makes
 * sharing a recipe safe here, and it is the reason the requirement names the
 * fragment rather than leaving the placement to whoever built it.
 *
 * The corollary is that a fragment is not readable by the page's *server*
 * either, so a share link is opened, decoded and applied entirely in the
 * browser. Nothing about this feature needs a backend, and adding one would
 * throw away the property it exists for.
 *
 * ## The image is never in it
 *
 * Not "is stripped" — **cannot be present**. What is encoded is a
 * {@link Preset}, whose `document.source` is `null` by construction
 * (`presetFromDocument` builds it that way and `decodePreset` refuses one that
 * is not). So there is no path from an open image to a share link, including
 * from a self-contained `.dork` whose data URL is sitting in the document at
 * the moment the link is made. `share.test.ts` pins that with an embedded
 * document.
 *
 * ## Why it is compressed
 *
 * A stack of a dozen nodes is 3–6 KB of JSON with an enormous amount of
 * repetition — every node repeats seven field names. `deflate-raw` takes it to
 * roughly a fifth of that, and the difference decides whether the link survives
 * being pasted through a chat client that wraps or truncates long text.
 *
 * `CompressionStream` is used unconditionally and with no fallback. Every
 * browser that has WebGPU has had it for years, and WebGPU is already a hard
 * requirement checked by the startup gate (docs/ARCHITECTURE.md, "Platform
 * support policy"), so a fallback path here would be code that no supported
 * browser can reach — and an unreachable path is one nobody ever finds is
 * broken.
 *
 * ## The payload says what encoding it is
 *
 * `#p=1.<base64url>`. The `1` is the *encoding* version, not the document
 * schema and not the preset envelope — it says how the bytes were packed, and it
 * is refused rather than guessed at for the same reason F-DO-08 refuses a newer
 * document. Without it, changing the compression later would make every old link
 * decode to noise.
 */

import type { DitherDocument } from "../../types/document";
import type { EffectRegistry } from "../../registry";
import { logger } from "../../lib/log";
import { base64UrlDecode, base64UrlEncode } from "./base64";
import { DocumentFileError } from "./errors";
import { parseJsonObject } from "./file";
import {
  decodePreset,
  presetFromDocument,
  type Preset,
} from "./preset";

const log = logger("io");

/** The fragment parameter the payload travels in. */
export const SHARE_FRAGMENT_KEY = "p";

/** How the bytes are packed. Bumped only when that changes. */
export const SHARE_ENCODING_VERSION = 1 as const;

/**
 * Past this, a link is worth warning about.
 *
 * Not a limit — nothing refuses a long link, and the fragment itself has no
 * specified maximum. It is the point at which real intermediaries start to
 * damage one: mail clients wrap around 1000 characters and several chat clients
 * stop auto-linking well before 4k. A person who has built a 40-node stack
 * should be told the link is fragile rather than discovering it at the far end.
 */
export const SHARE_LINK_WARNING_CHARS = 4_000;

async function through(
  // The DOM declares these two as taking any `BufferSource` and emitting
  // `Uint8Array`, which is not a `TransformStream<Uint8Array, Uint8Array>`.
  // Naming the two concrete types is more honest than widening the alias.
  stream: CompressionStream | DecompressionStream,
  // Pinned to an `ArrayBuffer`-backed view rather than left as the default
  // `ArrayBufferLike`: `SharedArrayBuffer` is very much in scope in this build
  // (the WASM thread pool needs it) and a shared view is not a `BufferSource`.
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  // The write is not awaited before the read starts. A transform stream's
  // writable side only drains as its readable side is consumed, so awaiting the
  // write first deadlocks on any payload past the queue's high-water mark.
  const writing = (async (): Promise<void> => {
    const writer = stream.writable.getWriter();
    await writer.write(bytes);
    await writer.close();
  })().catch((error: unknown) => {
    // When the transform fails — a truncated payload is the normal case — both
    // ends reject with the same underlying error, and the read below is the one
    // that reports it with something a person can act on. This side is recorded
    // rather than rethrown, because a rejection nobody claims surfaces as an
    // unhandled error with no context attached to it at all.
    log.debug("share stream writer ended early", { error: String(error) });
  });

  const collected = new Uint8Array(await new Response(stream.readable).arrayBuffer());
  await writing;
  return collected;
}

async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return through(new CompressionStream("deflate-raw"), bytes);
}

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return await through(new DecompressionStream("deflate-raw"), bytes);
  } catch (error) {
    throw new DocumentFileError(
      "bad-share-link",
      `this share link did not decompress: ${String(error)}. It was almost certainly ` +
        `truncated — links are often cut by the application they were pasted through.`,
      { bytes: bytes.length },
    );
  }
}

/**
 * The preset a link carries.
 *
 * A preset rather than a document, because F-DO-06 is preset sharing, and
 * because the type is what guarantees no image goes with it. `id` and
 * `createdAt` travel so the far end can put it straight into a library.
 */
export async function encodeSharePayload(preset: Preset): Promise<string> {
  const json = JSON.stringify({
    id: preset.id,
    name: preset.name,
    createdAt: preset.createdAt,
    note: preset.note,
    document: preset.document,
  });
  const packed = await deflate(new TextEncoder().encode(json));
  const payload = `${SHARE_ENCODING_VERSION}.${base64UrlEncode(packed)}`;
  log.info("share payload encoded", {
    json: json.length,
    packed: packed.length,
    chars: payload.length,
    long: payload.length > SHARE_LINK_WARNING_CHARS,
  });
  return payload;
}

/** The open document's recipe, ready to share (F-DO-06). */
export async function encodeShareFragmentFor(
  document: DitherDocument,
  identity: { readonly id: string; readonly name: string; readonly createdAt: string },
): Promise<string> {
  return encodeSharePayload(presetFromDocument(document, identity));
}

export async function decodeSharePayload(
  payload: string,
  registry: EffectRegistry,
): Promise<Preset> {
  const trimmed = payload.trim();
  if (trimmed.length === 0) {
    throw new DocumentFileError("bad-share-link", `this share link carries no payload.`);
  }

  const dot = trimmed.indexOf(".");
  if (dot <= 0) {
    throw new DocumentFileError(
      "bad-share-link",
      `this share link has no encoding version in front of it, so it is not one this ` +
        `build wrote. A link looks like "#${SHARE_FRAGMENT_KEY}=${SHARE_ENCODING_VERSION}.…".`,
      { chars: trimmed.length },
    );
  }

  const version = Number.parseInt(trimmed.slice(0, dot), 10);
  if (!Number.isFinite(version)) {
    throw new DocumentFileError(
      "bad-share-link",
      `this share link's encoding version is "${trimmed.slice(0, dot)}", which is not a number.`,
    );
  }
  if (version !== SHARE_ENCODING_VERSION) {
    throw new DocumentFileError(
      version > SHARE_ENCODING_VERSION ? "future-schema" : "bad-share-link",
      `this share link is encoding ${version} and this build writes and reads ` +
        `${SHARE_ENCODING_VERSION}. It is refused rather than decoded as far as it goes, ` +
        `because the bytes past that point would be read as something they are not.`,
      { version, understood: SHARE_ENCODING_VERSION },
    );
  }

  const bytes = await inflate(base64UrlDecode(trimmed.slice(dot + 1), "this share link"));
  const value = parseJsonObject(new TextDecoder().decode(bytes), "this share link");
  const preset = decodePreset(value, registry, "this share link");
  log.info("share payload decoded", {
    chars: trimmed.length,
    nodes: preset.document.stack.length,
    name: preset.name,
  });
  return preset;
}

// --- the URL itself -------------------------------------------------------

/**
 * The link to give somebody.
 *
 * `base` is the page's own origin and path with any existing fragment and query
 * removed: a share link that carried the sender's query string would carry
 * whatever else happened to be in it.
 */
export function shareUrl(base: string, payload: string): string {
  const url = new URL(base);
  url.search = "";
  url.hash = `${SHARE_FRAGMENT_KEY}=${payload}`;
  return url.toString();
}

/**
 * The payload in a `location.hash`, or `null` if there is none.
 *
 * Pure, and takes the hash rather than reading `location`, so the parsing is
 * testable without a browser and the one place that touches `location` is the
 * UI that decided to look.
 */
export function sharePayloadInHash(hash: string): string | null {
  const withoutHash = hash.startsWith("#") ? hash.slice(1) : hash;
  if (withoutHash.length === 0) return null;
  // `URLSearchParams` rather than a split: it handles the `key=value&key=value`
  // form the hash may already carry for some other reason, and it is the same
  // parser the browser uses on a query string.
  const value = new URLSearchParams(withoutHash).get(SHARE_FRAGMENT_KEY);
  if (value === null || value.length === 0) return null;
  return value;
}
