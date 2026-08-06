/**
 * Per-node bulk data: from a node's own state to the bytes its shader reads.
 *
 * `table` bindings carry data the **effect** ships — one blue-noise tile shared
 * by every node that uses it, uploaded once at compile time. This is the other
 * channel: data that belongs to **one node instance** and changes when that
 * node's own state changes. F-PP-05's transfer LUT is built from the node's
 * `curve` parameter; F-PP-07's threshold tile is decoded from an image the user
 * uploaded for that node and has no parameter representation at all.
 *
 * Three properties are what make this safe rather than merely possible.
 *
 * **The builder is pure and its output is checked.** Bytes must be non-empty
 * and a multiple of four, because WGSL reads them as `array<f32>` or
 * `array<u32>` and `arrayLength` on a trailing partial word is not a thing. A
 * builder that returns nothing is a node that renders as though its LUT were
 * whatever the buffer held last.
 *
 * **The bytes are digested, and the digest is what the buffer keys on.** A
 * slider drag that leaves the curve alone produces identical bytes, identical
 * digest, and no upload. A curve edit produces different bytes and exactly one.
 *
 * **The digest is SHA-256, the same function the content hash uses.** Not a
 * checksum: the digest decides whether a buffer is rewritten, so a collision is
 * a stale LUT rendered with no error anywhere — the same failure mode, and the
 * same argument, as `graph/sha256.ts` makes for the node hash. That module
 * imports nothing and is arithmetic over bytes, which is why reaching across to
 * it costs the GPU layer no dependency worth naming.
 */

import type {
  InstanceData,
  InstanceDataBinding,
  InstanceDataInput,
  PassBinding,
} from "../types/gpu";
import { logger } from "../lib/log";
import { sha256Hex } from "../graph/sha256";

const log = logger("gpu");

export class InstanceDataError extends Error {
  readonly slot: string;

  constructor(slot: string, message: string) {
    super(message);
    this.name = "InstanceDataError";
    this.slot = slot;
  }
}

/** Every instance-data binding a pass declares, in declaration order. */
export function instanceBindingsOf(
  bindings: readonly PassBinding[],
): readonly InstanceDataBinding[] {
  return bindings.filter(
    (binding): binding is InstanceDataBinding => binding.role === "instance-data",
  );
}

/**
 * Run one binding's builder and check what it produced.
 *
 * Every refusal names the pass and the slot, because a builder failure is an
 * effect-authoring mistake and the author is looking at one file.
 */
export function resolveInstanceData(
  passId: string,
  binding: InstanceDataBinding,
  input: InstanceDataInput,
): InstanceData {
  const where = `pass ${passId}, node ${input.nodeId}, slot "${binding.slot}"`;

  if (binding.supplied === "required" && input.supplied === null) {
    throw new InstanceDataError(
      binding.slot,
      `${where}: the binding declares supplied "required" but the node carries no bytes for this slot; nothing is substituted for an image the user has not chosen`,
    );
  }
  if (binding.supplied === "none" && input.supplied !== null) {
    // Not ignored. Bytes filed under a slot the pass does not take mean the
    // caller and the effect disagree about what this node holds, and rendering
    // past it hides the disagreement behind a picture that looks fine.
    throw new InstanceDataError(
      binding.slot,
      `${where}: the binding declares supplied "none" but the node carries ${input.supplied.byteLength} bytes for this slot`,
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = binding.build(input);
  } catch (error) {
    log.error("instance data builder threw", {
      pass: passId,
      node: input.nodeId,
      slot: binding.slot,
      error: String(error),
    });
    throw error;
  }

  if (!(bytes instanceof Uint8Array)) {
    throw new InstanceDataError(
      binding.slot,
      `${where}: the builder returned ${typeof bytes} rather than a Uint8Array`,
    );
  }
  if (bytes.byteLength === 0) {
    throw new InstanceDataError(binding.slot, `${where}: the builder returned no bytes`);
  }
  if (bytes.byteLength % 4 !== 0) {
    throw new InstanceDataError(
      binding.slot,
      `${where}: the builder returned ${bytes.byteLength} bytes, which is not a multiple of 4; WGSL reads this buffer as words and a trailing partial word has no length`,
    );
  }

  const digest = sha256Hex(bytes);
  log.debug("instance data built", {
    pass: passId,
    node: input.nodeId,
    slot: binding.slot,
    bytes: bytes.byteLength,
    digest,
  });
  return { slot: binding.slot, bytes, digest };
}

/**
 * Resolve every instance-data binding of one pass.
 *
 * `supplied` is looked up by slot. A slot the caller has bytes for but the pass
 * does not declare is not an error here — a document may legitimately carry an
 * asset for a node whose effect was changed since — but it is logged, because
 * an asset that silently stops being read is indistinguishable from one that
 * was never registered.
 */
export function resolvePassInstances(
  passId: string,
  bindings: readonly PassBinding[],
  input: Omit<InstanceDataInput, "supplied">,
  supplied: ReadonlyMap<string, Uint8Array> | undefined,
): readonly InstanceData[] {
  const declared = instanceBindingsOf(bindings);
  if (declared.length === 0) {
    if (supplied !== undefined && supplied.size > 0) {
      log.debug("node carries bulk data no pass of it declares", {
        pass: passId,
        node: input.nodeId,
        slots: [...supplied.keys()].join(","),
      });
    }
    return [];
  }

  return declared.map((binding) =>
    resolveInstanceData(passId, binding, {
      ...input,
      supplied: supplied?.get(binding.slot) ?? null,
    }),
  );
}
