/**
 * Per-node bulk data, on the graph's side of the line.
 *
 * The GPU layer knows how to turn a node's own state into the bytes its shader
 * reads (`gpu/instance.ts`). What it cannot do is account for bytes that never
 * were a parameter: F-PP-07 takes a **threshold map from an uploaded image**,
 * and `ParameterValue` is a number, a boolean, a string, a colour or a curve —
 * there is nowhere in a node's parameters for a decoded image to live.
 *
 * That is a cache-correctness problem before it is a plumbing problem. A node's
 * content hash covers its parameters, its seed and its inputs; bytes outside
 * all three change the picture without changing the hash, and the renderer
 * happily shows the frame from before the upload. So an asset is registered
 * with a **digest computed once**, and the digest — not the bytes — is what the
 * hash folds in.
 *
 * Once, at registration, and not per render: the whole point of hashing the
 * asset is to notice when it changes, and re-digesting a decoded image on every
 * frame of a playing animation would cost more than the node it belongs to.
 *
 * Nothing here decodes anything. An asset arrives as bytes in whatever layout
 * the effect's builder expects, which keeps image decoding — a browser concern
 * with a dozen formats and an async API — out of the render graph entirely.
 */

import type { ContentHash } from "../types/graph";
import type { Logger } from "../lib/log";
import { logger } from "../lib/log";
import { GraphError } from "./errors";
import { hashBytes } from "./hash";

/** One node's bytes for one instance-data slot. */
export interface NodeAsset {
  readonly nodeId: string;
  /** Matches an `InstanceDataBinding.slot` on one of the effect's passes. */
  readonly slot: string;
  /** Where the bytes came from — a file name. Diagnostics and the digest label. */
  readonly label: string;
  readonly bytes: Uint8Array;
  /** Computed once, when the asset is registered. */
  readonly digest: ContentHash;
}

/**
 * The read side, which is all the graph and the GPU layer need.
 *
 * An interface rather than the class, so a document loader can supply assets
 * from wherever it holds them without the graph knowing about that store.
 */
export interface NodeAssets {
  /** Bytes for one slot, in the shape `gpu/prepare.ts` wants them. */
  slotsFor(nodeId: string): ReadonlyMap<string, Uint8Array> | undefined;
  /**
   * One digest covering every slot of one node, or `null` when it has none.
   *
   * Slots are folded in sorted order so the value does not depend on the order
   * they were registered in — the same rule, and the same reason, as the
   * parameter-key sort in `hash.ts`.
   */
  digestOf(nodeId: string): string | null;
}

interface NodeEntry {
  readonly assets: Map<string, NodeAsset>;
  /** Recomputed only when a slot of this node changes. */
  digest: string | null;
}

export interface NodeAssetStoreOptions {
  readonly log?: Logger;
}

/**
 * The write side: register, replace and drop a node's bulk data.
 *
 * Registration is where the cost is paid — one digest over the bytes — and it
 * is logged, because an application that re-registers an unchanged image on
 * every render would otherwise look identical from the outside to one that
 * does not, right up until the cache stops hitting.
 */
export class NodeAssetStore implements NodeAssets {
  readonly #nodes = new Map<string, NodeEntry>();
  readonly #log: Logger;

  constructor(options: NodeAssetStoreOptions = {}) {
    this.#log = options.log ?? logger("graph");
  }

  get nodeCount(): number {
    return this.#nodes.size;
  }

  /** Total bytes held. The UI's memory readout counts these alongside the cache. */
  get bytes(): number {
    let total = 0;
    for (const entry of this.#nodes.values()) {
      for (const asset of entry.assets.values()) total += asset.bytes.byteLength;
    }
    return total;
  }

  /**
   * Register or replace one node's bytes for one slot.
   *
   * Empty bytes are refused rather than stored: an effect whose binding is
   * `supplied: "required"` would receive a zero-length buffer and either fail
   * far from here or render a black tile, and both are worse than a message
   * naming the node and the slot.
   */
  set(nodeId: string, slot: string, label: string, bytes: Uint8Array): NodeAsset {
    if (nodeId.length === 0 || slot.length === 0) {
      throw new GraphError(
        "invalid-asset",
        `an asset needs a node id and a slot name; got "${nodeId}" / "${slot}"`,
        { nodeId, slot },
      );
    }
    if (bytes.byteLength === 0) {
      throw new GraphError(
        "invalid-asset",
        `asset "${label}" for node ${nodeId} slot "${slot}" is empty`,
        { nodeId, slot, label },
      );
    }

    const started = performance.now();
    const digest = hashBytes(`asset:${slot}:${label}`, bytes);
    const asset: NodeAsset = { nodeId, slot, label, bytes, digest };

    const entry = this.#nodes.get(nodeId) ?? { assets: new Map(), digest: null };
    const previous = entry.assets.get(slot);
    entry.assets.set(slot, asset);
    entry.digest = null;
    this.#nodes.set(nodeId, entry);

    this.#log.info("node asset registered", {
      nodeId,
      slot,
      label,
      bytes: bytes.byteLength,
      digest,
      replaced: previous !== undefined,
      unchanged: previous?.digest === digest,
      ms: Math.round((performance.now() - started) * 100) / 100,
    });
    return asset;
  }

  /** Drop one slot. Returns whether there was one. */
  delete(nodeId: string, slot: string): boolean {
    const entry = this.#nodes.get(nodeId);
    if (entry === undefined) return false;
    const removed = entry.assets.delete(slot);
    if (!removed) return false;
    entry.digest = null;
    if (entry.assets.size === 0) this.#nodes.delete(nodeId);
    this.#log.info("node asset dropped", { nodeId, slot });
    return true;
  }

  /** Drop everything a node holds — what removing it from the stack means. */
  deleteNode(nodeId: string): boolean {
    const removed = this.#nodes.delete(nodeId);
    if (removed) this.#log.info("node assets dropped", { nodeId });
    return removed;
  }

  clear(): void {
    const nodes = this.#nodes.size;
    this.#nodes.clear();
    this.#log.info("node assets cleared", { nodes });
  }

  /** Every asset one node holds, for diagnostics. */
  assetsOf(nodeId: string): readonly NodeAsset[] {
    const entry = this.#nodes.get(nodeId);
    return entry === undefined ? [] : [...entry.assets.values()];
  }

  slotsFor(nodeId: string): ReadonlyMap<string, Uint8Array> | undefined {
    const entry = this.#nodes.get(nodeId);
    if (entry === undefined) return undefined;
    const slots = new Map<string, Uint8Array>();
    for (const [slot, asset] of entry.assets) slots.set(slot, asset.bytes);
    return slots;
  }

  digestOf(nodeId: string): string | null {
    const entry = this.#nodes.get(nodeId);
    if (entry === undefined) return null;
    if (entry.digest !== null) return entry.digest;

    const slots = [...entry.assets.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    // The slot names go in beside the digests: two nodes holding the same image
    // under different slots are two different nodes, and a digest list alone
    // would call them equal.
    const parts: string[] = [];
    for (const slot of slots) {
      const asset = entry.assets.get(slot);
      if (asset === undefined) continue;
      parts.push(`${slot}=${asset.digest}`);
    }
    const digest = parts.join(";");
    entry.digest = digest;
    return digest;
  }
}
