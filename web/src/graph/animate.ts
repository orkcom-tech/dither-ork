/**
 * Animated evaluation.
 *
 * Walking `t` across the loop re-evaluates only the nodes that move. Unbound
 * nodes render once and are reused for all `N` frames, which is the entire
 * reason an N-frame export is far cheaper than N renders.
 *
 * The mechanism is already in the hash and needs no binding table here.
 * `ContentHashInput` deliberately excludes the frame index, and bound
 * parameters arrive as the concrete numbers the modulator produced, so a node
 * whose parameters do not move hashes identically on every frame and is a cache
 * hit from frame 1 onward. A node downstream of one that does move folds the
 * changed hash in through its inputs and re-runs, exactly as it must.
 *
 * What this module adds is the part the cache cannot infer on its own: **the
 * invariant prefix has to survive**. Each frame produces a full set of
 * intermediates, and an LRU under budget pressure would happily evict the
 * upstream buffers that all N frames share in order to hold one frame's
 * throwaway tail — turning the cheap export back into N renders with extra
 * steps. So every frame is hashed up front, the nodes whose hash never changes
 * are identified by comparison rather than by asking what is bound, and those
 * are pinned for the duration and marked non-transient while everything else is
 * marked transient.
 *
 * Comparing hashes rather than reading `Binding[]` is deliberate: it needs no
 * second source of truth about what animates, and it stays correct for any
 * future thing that makes a parameter move — keyframes (F-AN-08), global speed
 * (F-AN-10), temporal variation (F-AN-04) — without this file learning about it.
 */

import type { Palette } from "../types/document";
import type { ContentHash, FrameBuffer, RenderGraph } from "../types/graph";
import { logger } from "../lib/log";
import type { PreparedGraph } from "./plan";
import { prepareGraph } from "./plan";
import type { RenderDeps, RenderStats } from "./render";
import { renderPrepared } from "./render";
import { GraphError, expect } from "./errors";

export interface AnimatedRequest {
  /** Frame count `N`. Normalized time is `frame / N`, so `t` never reaches 1. */
  readonly frames: number;
  /**
   * The graph for one frame, with every bound parameter already resolved to the
   * concrete value the modulator produced. Called once per frame, before
   * anything renders.
   */
  readonly graphForFrame: (frame: number) => RenderGraph;
  readonly source: FrameBuffer;
  readonly palette: Palette;
  /**
   * Receives each finished frame, in order.
   *
   * Awaited before the next frame starts, because the buffer is cache-owned and
   * the next frame may evict it. Encode or copy inside this callback; do not
   * hold the reference past it, and do not release it.
   */
  readonly onFrame: (
    frame: number,
    buffer: FrameBuffer,
    stats: RenderStats,
  ) => Promise<void> | void;
}

export interface AnimationOutcome {
  readonly frames: number;
  readonly ms: number;
  readonly nodesExecuted: number;
  readonly cacheHits: number;
  readonly boundaryBytes: number;
  /** Nodes whose hash never changed across the loop; rendered once, reused N times. */
  readonly invariantNodes: readonly string[];
  /** Nodes that had to be re-evaluated per frame. */
  readonly animatedNodes: readonly string[];
}

export async function renderAnimation(
  request: AnimatedRequest,
  deps: RenderDeps,
): Promise<AnimationOutcome> {
  const log = logger("graph", deps.correlationId);
  const { frames, source, palette } = request;

  if (!Number.isInteger(frames) || frames < 1) {
    throw new GraphError(
      "invalid-frame-count",
      `frame count ${String(frames)} is not a positive integer`,
      { frames: String(frames) },
    );
  }

  const startedAt = performance.now();

  // Every frame prepared before any of it renders. Hashing is cheap next to
  // rendering, and the answer to "which nodes never move" is not available any
  // other way without a second source of truth about what is bound.
  const prepared: PreparedGraph[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    const graph = request.graphForFrame(frame);
    if (graph.frame !== frame) {
      throw new GraphError(
        "frame-mismatch",
        `graphForFrame(${frame}) returned a graph reporting frame ${graph.frame}; the frame index is what resolved its bound parameters, so a mismatch means the wrong values were baked in`,
        { asked: frame, got: graph.frame },
      );
    }
    prepared.push(prepareGraph(graph, source.hash, palette, deps.effects, deps.assets));
  }

  const first = expect(prepared[0], "invariant", "no frames were prepared");
  const invariantHashes = new Set<ContentHash>();
  const invariantNodes: string[] = [];
  const animatedNodes: string[] = [];

  for (const [nodeId, hash] of first.hashes) {
    let moves = false;
    for (let frame = 1; frame < frames; frame += 1) {
      const other = expect(
        prepared[frame],
        "invariant",
        `frame ${frame} was not prepared`,
      ).hashes.get(nodeId);
      if (other === undefined) {
        throw new GraphError(
          "node-set-mismatch",
          `node ${nodeId} exists on frame 0 but not on frame ${frame}; every frame of one animation must be the same document`,
          { nodeId, frame },
        );
      }
      if (other !== hash) {
        moves = true;
        break;
      }
    }
    if (moves) animatedNodes.push(nodeId);
    else {
      invariantHashes.add(hash);
      invariantNodes.push(nodeId);
    }
  }

  log.info("animation plan", {
    frames,
    nodes: first.hashes.size,
    invariant: invariantNodes.length,
    animated: animatedNodes.length,
  });
  if (animatedNodes.length === first.hashes.size && first.hashes.size > 0) {
    // Worth saying out loud: nothing is shared, so this export costs N full
    // renders. Usually it means a modulator is bound to the first node in the
    // stack, which taints everything after it.
    log.warn("no node is frame-invariant; every frame re-renders the whole stack", {
      frames,
      nodes: first.hashes.size,
    });
  }

  const retain = { kind: "only", hashes: invariantHashes } as const;
  const pinnedHere = new Set<ContentHash>();

  let nodesExecuted = 0;
  let cacheHits = 0;
  let boundaryBytes = 0;

  try {
    for (let frame = 0; frame < frames; frame += 1) {
      const outcome = await renderPrepared(
        {
          prepared: expect(prepared[frame], "invariant", `frame ${frame} was not prepared`),
          source,
          retain,
        },
        deps,
      );

      nodesExecuted += outcome.stats.nodesExecuted;
      cacheHits += outcome.stats.cacheHits;
      boundaryBytes += outcome.stats.boundaryBytes;

      // Pinned the moment they exist. `renderPrepared` unpins its live set on
      // the way out, so between that and the next frame the invariant prefix is
      // evictable; claiming it here closes that window.
      for (const hash of invariantHashes) {
        if (pinnedHere.has(hash)) continue;
        if (!deps.cache.has(hash)) continue;
        deps.cache.pin(hash);
        pinnedHere.add(hash);
      }

      // Awaited: the buffer belongs to the cache and the next frame may evict it.
      await request.onFrame(frame, outcome.buffer, outcome.stats);
      log.debug("frame delivered", {
        frame,
        ms: outcome.stats.ms,
        executed: outcome.stats.nodesExecuted,
        hits: outcome.stats.cacheHits,
      });
    }
  } finally {
    for (const hash of pinnedHere) deps.cache.unpin(hash);
    pinnedHere.clear();
  }

  const ms = Math.round((performance.now() - startedAt) * 100) / 100;
  log.info("animation complete", {
    frames,
    ms,
    nodesExecuted,
    cacheHits,
    boundaryBytes,
    invariant: invariantNodes.length,
    animated: animatedNodes.length,
  });

  return {
    frames,
    ms,
    nodesExecuted,
    cacheHits,
    boundaryBytes,
    invariantNodes,
    animatedNodes,
  };
}
