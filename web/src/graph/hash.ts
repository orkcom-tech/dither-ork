/**
 * Content hashing.
 *
 * A node's hash covers its parameters, its seed and its inputs' hashes, so
 * editing one parameter invalidates that node and everything downstream while
 * nothing upstream re-runs. Everything else in the graph — the cache, the
 * earliest-changed-position re-render (F-ST-01), the reuse of unbound nodes
 * across an animation — is a consequence of that one property, which is why
 * this file has to be boring and exactly right.
 *
 * Three things it must not do, because each makes the hash unstable, and a
 * cache keyed on an unstable hash fails silently rather than loudly:
 *
 * - **No object key iteration order.** Parameter keys are sorted by code unit
 *   before they are written, so two documents with the same parameters hash the
 *   same however their objects happened to be built.
 * - **No `Math.random`, no `Date.now`.** Nothing here reads anything outside its
 *   argument.
 * - **No `JSON.stringify`.** It preserves insertion order, has no defined
 *   encoding for `-0`, and once two values are in a record it cannot tell the
 *   string `"1"` from the number `1`. What is written instead is a tagged byte
 *   stream: every value carries its type, every string carries its length, and
 *   every number is written as its IEEE-754 bits, so two distinct inputs cannot
 *   produce the same bytes.
 */

import type { Palette, ParameterValue } from "../types/document";
import type { ContentHash, ContentHashFn, ContentHashInput } from "../types/graph";
import { GraphError } from "./errors";
import { sha256Hex } from "./sha256";

/**
 * Bumped when the encoding below changes.
 *
 * It is written into every stream, so a build with a different encoding cannot
 * produce a hash colliding with this one's. Hashes are not persisted, but they
 * do travel between a worker and the main thread, and a mismatched pair of
 * builds is exactly where a silent collision would be hardest to find.
 */
const HASH_FORMAT_VERSION = 1;

const TAG_STRING = 0x01;
const TAG_NUMBER = 0x02;
const TAG_BOOL = 0x03;

const UTF8 = new TextEncoder();

/** Growable byte sink. Doubling keeps hashing a node allocation-light. */
class ByteWriter {
  private data: Uint8Array;
  private view: DataView;
  private length = 0;

  constructor(capacity = 256) {
    this.data = new Uint8Array(capacity);
    this.view = new DataView(this.data.buffer);
  }

  private ensure(extra: number): void {
    if (this.length + extra <= this.data.length) return;
    let capacity = this.data.length * 2;
    while (capacity < this.length + extra) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.data.subarray(0, this.length));
    this.data = grown;
    this.view = new DataView(grown.buffer);
  }

  u8(value: number): void {
    this.ensure(1);
    this.view.setUint8(this.length, value);
    this.length += 1;
  }

  /** Big-endian, so the stream does not depend on the host's byte order. */
  u32(value: number): void {
    this.ensure(4);
    this.view.setUint32(this.length, value, false);
    this.length += 4;
  }

  f64(value: number): void {
    this.ensure(8);
    this.view.setFloat64(this.length, value, false);
    this.length += 8;
  }

  bytes(value: Uint8Array): void {
    this.ensure(value.length);
    this.data.set(value, this.length);
    this.length += value.length;
  }

  take(): Uint8Array {
    return this.data.subarray(0, this.length);
  }
}

function writeString(writer: ByteWriter, value: string): void {
  writer.u8(TAG_STRING);
  const encoded = UTF8.encode(value);
  // Length-prefixed rather than terminated: a parameter value may legally
  // contain any character, including whatever separator we might pick.
  writer.u32(encoded.length);
  writer.bytes(encoded);
}

function writeNumber(writer: ByteWriter, value: number, what: string): void {
  if (!Number.isFinite(value)) {
    throw new GraphError(
      "non-finite-parameter",
      `${what} is ${String(value)}; a node whose parameters are not finite can neither be hashed nor rendered`,
      { value: String(value) },
    );
  }
  writer.u8(TAG_NUMBER);
  // `value === 0` is true for -0, which collapses the two zeroes. They are the
  // same pixel result and so must be the same hash; IEEE-754 gives them
  // different bits.
  writer.f64(value === 0 ? 0 : value);
}

function writeBool(writer: ByteWriter, value: boolean): void {
  writer.u8(TAG_BOOL);
  writer.u8(value ? 1 : 0);
}

function writeParameter(writer: ByteWriter, key: string, value: ParameterValue): void {
  writeString(writer, key);
  switch (typeof value) {
    case "number":
      writeNumber(writer, value, `parameter ${key}`);
      return;
    case "boolean":
      writeBool(writer, value);
      return;
    case "string":
      writeString(writer, value);
      return;
    default:
      throw new GraphError(
        "unsupported-parameter",
        `parameter ${key} is a ${typeof value}; ParameterValue is number, boolean or string`,
        { key },
      );
  }
}

/**
 * Code-unit order, stated explicitly rather than left to the default
 * comparator, so the sort can never pick up a locale.
 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The key the palette digest is folded in under.
 *
 * `ContentHashInput` has no palette field, but the palette changes the pixels a
 * quantizing node emits, so leaving it out would let a palette edit show a
 * stale cached frame — the same defect the type's own comment warns about for
 * `opacity`. Until the type carries one, the planner writes the digest in as a
 * parameter. The `@` prefix is not a legal registry parameter key, so it cannot
 * collide with a real one.
 */
export const PALETTE_PARAM_KEY = "@palette";

// --- the hashes the graph mints -----------------------------------------

/**
 * The node content hash (docs/ARCHITECTURE.md, "Render graph").
 *
 * The field order below is fixed and the whole record goes into one stream, so
 * no rearrangement of the input object can change the result.
 */
export const contentHash: ContentHashFn = (input: ContentHashInput): ContentHash => {
  const writer = new ByteWriter();
  writer.u8(HASH_FORMAT_VERSION);
  writeString(writer, "node");
  writeString(writer, input.effect);
  writeNumber(writer, input.seed, "seed");
  writeNumber(writer, input.opacity, "opacity");
  writeString(writer, input.blend);
  writeNumber(writer, input.width, "width");
  writeNumber(writer, input.height, "height");

  writer.u32(input.inputs.length);
  for (const upstream of input.inputs) {
    writeString(writer, upstream);
  }

  const keys = Object.keys(input.params).sort(byCodeUnit);
  writer.u32(keys.length);
  for (const key of keys) {
    const value = input.params[key];
    if (value === undefined) {
      // Reachable in the types only, because of `noUncheckedIndexedAccess`; a
      // key that came out of Object.keys is present by construction. Skipping
      // it would drop a parameter from the hash, so it is an error rather than
      // a continue.
      throw new GraphError(
        "unsupported-parameter",
        `parameter ${key} is undefined; every declared parameter must carry a value`,
        { key },
      );
    }
    writeParameter(writer, key, value);
  }

  return sha256Hex(writer.take()) as ContentHash;
};

/**
 * Mint a hash for something outside the graph — in practice the decoded source
 * image, whose hash roots every chain.
 *
 * Exported because `ContentHash` is branded and this module is the only place
 * that casts to it. Without this the loader could not produce the
 * `FrameBuffer.hash` the graph reads.
 *
 * Hashing megabytes of pixels is not free. It happens once per image load, not
 * once per frame.
 */
export function hashBytes(label: string, bytes: Uint8Array): ContentHash {
  // Digested first and then folded into the header stream, rather than copied
  // into it, so a 100 MB image is not duplicated in memory to be hashed.
  const body = sha256Hex(bytes);
  const writer = new ByteWriter(128);
  writer.u8(HASH_FORMAT_VERSION);
  writeString(writer, "bytes");
  writeString(writer, label);
  writer.u32(bytes.length);
  writeString(writer, body);
  return sha256Hex(writer.take()) as ContentHash;
}

/**
 * Digest of the palette's *pixel-affecting* content.
 *
 * `id` and `name` are deliberately left out: renaming a palette changes no
 * output pixel, and folding the name in would invalidate the stack on every
 * keystroke in the palette editor. The colours and the matching metric are in,
 * because both change the result.
 *
 * A plain hex string rather than a `ContentHash`, because it is not a node's
 * output identity — it is folded into the hashes of the nodes that consume it.
 */
export function paletteDigest(palette: Palette): string {
  const writer = new ByteWriter(128);
  writer.u8(HASH_FORMAT_VERSION);
  writeString(writer, "palette");
  writeString(writer, palette.metric);
  writer.u32(palette.colors.length);
  for (const component of palette.colors) {
    writeNumber(writer, component, "palette colour component");
  }
  return sha256Hex(writer.take());
}
