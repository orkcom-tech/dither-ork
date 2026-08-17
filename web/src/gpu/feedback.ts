/**
 * The feedback frame store.
 *
 * A feedback node reads **its own output from the previous frame**. Nothing
 * else in the pipeline does, and everything that makes the rest of the renderer
 * correct — the content-hash cache, the loop-closure guarantee, a scrub that
 * renders one frame — is a consequence of nodes being pure functions of their
 * inputs. This file is where that stops being true, so it is written to make
 * every consequence explicit rather than to hide the exception.
 *
 * ## What the buffer holds at frame 0, stated rather than inherited
 *
 * **Zero: transparent black, cleared explicitly, every time a chain begins.**
 * Not "whatever the pool handed back", which for a recycled texture is the tail
 * of some other node's output and would make frame 0 of a document depend on
 * what the user rendered a minute earlier.
 *
 * Zero is not an arbitrary neutral. It is the value that says *there is no
 * previous frame*, and it makes one property true that a reader can check:
 * **at frame 0 a feedback node's history contributes nothing**, whatever the
 * decay, so frame 0 is the node's input put through the blend against black.
 * For the default `add`/`screen`-shaped uses that is the input exactly. The
 * clear is a real `GPUCommandEncoder.clearBuffer`-equivalent — a render pass
 * with `loadOp: "clear"` — rather than a promise that new textures are zeroed,
 * because a pooled texture is not new.
 *
 * ## Two slots, because re-rendering one frame must not advance the trail
 *
 * The obvious store is one texture per node, overwritten after each frame. It
 * is wrong for the case that happens constantly: the viewport re-renders the
 * *same* frame when the preview scale changes, when the window resizes, when a
 * drag ends. With one slot, rendering frame 7 twice runs the trail forward
 * twice and the second picture is not the one the export would produce.
 *
 * So a node holds two entries:
 *
 * - `history` — what frame `historyFrame` reads. Stable across any number of
 *   renders of that frame.
 * - `pending` — what frame `historyFrame + 1` will read, written after frame
 *   `historyFrame` ran. Overwritten, harmlessly, by every re-render of the same
 *   frame.
 *
 * Advancing is therefore a swap, and re-rendering is idempotent. Rendering
 * frame 7 twice gives byte-identical pictures; that is asserted in
 * `feedback.test.ts` at the store level and measured in the browser.
 *
 * ## What it refuses
 *
 * Frame N is the product of frames 0..N. A store asked for a frame it cannot
 * serve — a jump forward, a scrub backwards — **refuses, naming the frame it
 * can serve**. It does not fabricate a history and it does not silently reset
 * to zero, because both produce a frame the export would not produce, which is
 * the worst outcome available (docs/dither-ork-node-graph.md, decision 3). The
 * caller replays from zero; `state/render/renderer.ts` and
 * `ui/timeline/preview.ts` are the two that do.
 *
 * ## Extent
 *
 * Keyed per node **and** per extent. A preview at 68% and a full render are
 * different pixel grids and a trail accumulated at one is not the trail at the
 * other, so a change of extent resets that node's chain to frame 0 rather than
 * scaling a history that was never rendered at the new size. That is stated in
 * the log line, because a preview that silently restarts its trail on every
 * resize would otherwise look like a bug in the effect.
 */

import type { Extent } from "../types/gpu";
import { logger } from "../lib/log";
import type { GpuContext } from "./device";
import { assertExtent, describeExtent, extentsEqual } from "./extent";
import type { TexturePool } from "./resources";

const log = logger("gpu");

export class FeedbackStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedbackStoreError";
  }
}

interface Slot {
  readonly texture: GPUTexture;
  readonly extent: Extent;
}

interface Chain {
  /** The frame `history` is the input for. */
  frame: number;
  history: Slot;
  /** Written by frame `frame`; becomes `history` when frame `frame + 1` starts. */
  pending: Slot | null;
}

export interface FeedbackStoreStats {
  readonly chains: number;
  /** Live textures across every chain — one or two per node. */
  readonly textures: number;
  readonly bytes: number;
  readonly clears: number;
  readonly advances: number;
  readonly resets: number;
}

/** `rgba16float`: four channels, two bytes each. Same number as `cache.ts`. */
const RGBA16F_BYTES_PER_TEXEL = 8;

/**
 * Previous-frame textures, one chain per feedback node instance.
 *
 * Lives on the `GpuLayer` beside the texture pool it allocates from, so it is
 * created and destroyed with the device. The renderer resets it when the source
 * changes; the GPU backend reads and writes it while a node runs.
 */
export class FeedbackStore {
  readonly #ctx: GpuContext;
  readonly #pool: TexturePool;
  readonly #chains = new Map<string, Chain>();
  #clears = 0;
  #advances = 0;
  #resets = 0;

  constructor(ctx: GpuContext, pool: TexturePool) {
    this.#ctx = ctx;
    this.#pool = pool;
  }

  /**
   * The texture frame `frame` reads for this node.
   *
   * Advances the chain by one when `frame` is the one after the frame the store
   * holds, returns the held history unchanged when `frame` is that frame, and
   * throws otherwise. Nothing here writes: the output is handed back through
   * {@link record} after the node has run.
   */
  historyFor(nodeId: string, frame: number, extent: Extent): GPUTexture {
    this.#ctx.assertUsable("FeedbackStore.historyFor");
    assertExtent(`feedback history ${nodeId}`, extent);
    if (!Number.isInteger(frame) || frame < 0) {
      throw new FeedbackStoreError(
        `feedback node ${nodeId}: frame ${frame} is not a non-negative integer`,
      );
    }

    const existing = this.#chains.get(nodeId);
    if (existing !== undefined && !extentsEqual(existing.history.extent, extent)) {
      // Stated out loud. A trail accumulated at 68% is not the trail at 100%,
      // and a preview whose history silently restarts on every resize looks
      // like a defect in the effect rather than a property of the store.
      log.info("feedback chain reset on extent change", {
        nodeId,
        from: describeExtent(existing.history.extent),
        to: describeExtent(extent),
        atFrame: existing.frame,
      });
      this.#drop(nodeId);
    }

    // Frame 0 restarts the chain unconditionally, even when one is running.
    // Its history is transparent black by definition, so there is nothing a
    // held chain could contribute — and this is what lets a replay *begin*
    // while the store is sitting at frame 40, which is the whole render-from-
    // zero path. Continuing an existing chain here instead would make frame 0
    // depend on where the playhead happened to be, which is the one thing
    // frame 0 must not do.
    if (frame === 0 && this.#chains.has(nodeId)) this.#drop(nodeId);

    const chain = this.#chains.get(nodeId);
    if (chain === undefined) {
      if (frame !== 0) {
        throw new FeedbackStoreError(
          `feedback node ${nodeId}: asked for frame ${frame} with no history at ${describeExtent(extent)}; frame N is the product of frames 0..N, so the chain can only start at 0. Render from zero.`,
        );
      }
      const started: Chain = {
        frame: 0,
        history: this.#blank(nodeId, extent, "frame 0"),
        pending: null,
      };
      this.#chains.set(nodeId, started);
      return started.history.texture;
    }

    if (chain.frame === frame) return chain.history.texture;

    const pending = chain.pending;
    if (pending !== null && chain.frame + 1 === frame) {
      this.#release(chain.history);
      chain.history = pending;
      chain.pending = null;
      chain.frame = frame;
      this.#advances += 1;
      return chain.history.texture;
    }

    throw new FeedbackStoreError(
      `feedback node ${nodeId}: asked for frame ${frame}, but its history is at frame ${chain.frame}${pending === null ? "" : ` (and frame ${chain.frame + 1} is ready)`}. Frame N is the product of frames 0..N; the store will not invent one. Render from zero.`,
    );
  }

  /**
   * Take a copy of what the node produced, as the input for the next frame.
   *
   * A copy rather than the texture itself. The node's output is a live buffer
   * the render still owns and the viewport is about to present, and handing the
   * same texture to the store would have two owners for one allocation and a
   * history that changes under the next frame's feet. One full-surface copy per
   * feedback node per frame is the honest cost, and it is logged at debug with
   * its size so it is readable rather than mysterious.
   */
  record(nodeId: string, frame: number, output: GPUTexture, extent: Extent): void {
    this.#ctx.assertUsable("FeedbackStore.record");
    const chain = this.#chains.get(nodeId);
    if (chain === undefined) {
      throw new FeedbackStoreError(
        `feedback node ${nodeId}: record() before historyFor(); there is no chain to write into`,
      );
    }
    if (chain.frame !== frame) {
      throw new FeedbackStoreError(
        `feedback node ${nodeId}: record() for frame ${frame} while the chain is at frame ${chain.frame}`,
      );
    }
    if (!extentsEqual(chain.history.extent, extent)) {
      throw new FeedbackStoreError(
        `feedback node ${nodeId}: record() at ${describeExtent(extent)} while the chain holds ${describeExtent(chain.history.extent)}`,
      );
    }

    // Re-rendering the same frame overwrites the pending slot rather than
    // allocating a second one. That is what makes a re-render idempotent
    // instead of leaking a texture per repeat.
    const target = chain.pending ?? this.#acquire(nodeId, extent, "pending");
    const encoder = this.#ctx.device.createCommandEncoder({
      label: `feedback record ${nodeId}@${frame}`,
    });
    encoder.copyTextureToTexture(
      { texture: output },
      { texture: target.texture },
      { width: extent.width, height: extent.height, depthOrArrayLayers: 1 },
    );
    this.#ctx.device.queue.submit([encoder.finish()]);
    chain.pending = target;

    log.debug("feedback frame recorded", {
      nodeId,
      frame,
      extent: describeExtent(extent),
      bytes: extent.width * extent.height * RGBA16F_BYTES_PER_TEXEL,
    });
  }

  /**
   * Forget one node's history, or every node's.
   *
   * Called when the source changes, when a document loses its feedback nodes,
   * and by the replay path before it renders frame 0 — a replay that reused a
   * stale chain would produce a different frame 0 than a cold one.
   */
  reset(nodeId?: string): void {
    if (nodeId !== undefined) {
      if (!this.#chains.has(nodeId)) return;
      this.#drop(nodeId);
      this.#resets += 1;
      log.info("feedback chain reset", { nodeId });
      return;
    }
    const chains = this.#chains.size;
    if (chains === 0) return;
    for (const id of [...this.#chains.keys()]) this.#drop(id);
    this.#resets += 1;
    log.info("feedback store reset", { chains });
  }

  /**
   * Drop every chain whose node is not in `live`.
   *
   * A feedback node deleted from the stack, or a document replaced by another,
   * would otherwise hold one or two full working surfaces for a node that no
   * longer exists. Named rather than silent for the same reason a cache
   * eviction is.
   */
  retain(live: Iterable<string>): void {
    const keep = new Set(live);
    for (const nodeId of [...this.#chains.keys()]) {
      if (keep.has(nodeId)) continue;
      this.#drop(nodeId);
      log.info("feedback chain dropped; its node is no longer in the stack", { nodeId });
    }
  }

  stats(): FeedbackStoreStats {
    let textures = 0;
    let bytes = 0;
    for (const chain of this.#chains.values()) {
      for (const slot of [chain.history, chain.pending]) {
        if (slot === null) continue;
        textures += 1;
        bytes += slot.extent.width * slot.extent.height * RGBA16F_BYTES_PER_TEXEL;
      }
    }
    return {
      chains: this.#chains.size,
      textures,
      bytes,
      clears: this.#clears,
      advances: this.#advances,
      resets: this.#resets,
    };
  }

  /** Hand every texture back to the pool. The pool is destroyed by the layer. */
  destroy(): void {
    const stats = this.stats();
    for (const nodeId of [...this.#chains.keys()]) this.#drop(nodeId);
    log.info("feedback store destroyed", { ...stats });
  }

  // --- internals ---------------------------------------------------------

  #acquire(nodeId: string, extent: Extent, role: string): Slot {
    const texture = this.#pool.acquire(
      "rgba16float",
      extent.width,
      extent.height,
      `feedback/${nodeId}/${role}`,
    );
    return { texture, extent };
  }

  /**
   * A texture guaranteed to be zero.
   *
   * A render pass with `loadOp: "clear"` and no draw call, which is the only
   * portable way to fill a texture with a known value in WebGPU without a
   * compute program of its own — `rgba16float` is renderable, so this needs no
   * shader and no pipeline. The texture comes from the pool and may hold
   * another node's pixels, which is exactly why the clear is not optional.
   */
  #blank(nodeId: string, extent: Extent, why: string): Slot {
    const slot = this.#acquire(nodeId, extent, "history");
    const encoder = this.#ctx.device.createCommandEncoder({
      label: `feedback clear ${nodeId}`,
    });
    const pass = encoder.beginRenderPass({
      label: `feedback clear ${nodeId}`,
      colorAttachments: [
        {
          view: slot.texture.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.end();
    this.#ctx.device.queue.submit([encoder.finish()]);
    this.#clears += 1;
    log.info("feedback buffer cleared to transparent black", {
      nodeId,
      why,
      extent: describeExtent(extent),
    });
    return slot;
  }

  #drop(nodeId: string): void {
    const chain = this.#chains.get(nodeId);
    if (chain === undefined) return;
    this.#chains.delete(nodeId);
    this.#release(chain.history);
    if (chain.pending !== null) this.#release(chain.pending);
  }

  #release(slot: Slot): void {
    this.#pool.release(slot.texture);
  }
}
