/**
 * Who frees a buffer.
 *
 * The node cache owns everything offered to it and frees it through this
 * (`graph/cache.ts`, "Ownership"), because a GPU texture and a JS typed array
 * are freed differently and neither is the graph's business. This is that one
 * callback, and it is the only place in the render path a texture goes back to
 * the pool.
 *
 * A CPU buffer needs nothing: its planes are ordinary garbage the moment the
 * cache drops its reference. Saying so explicitly, rather than leaving the
 * branch out, is the difference between "nothing to do here" and "somebody
 * forgot the other case".
 */

import type { FrameBuffer } from "../../types/graph";
import type { TexturePool } from "../../gpu";
import { logger } from "../../lib/log";

const log = logger("gpu");

export class RenderSurfaces {
  readonly #textures: TexturePool;
  #released = 0;

  constructor(textures: TexturePool) {
    this.#textures = textures;
  }

  get releasedCount(): number {
    return this.#released;
  }

  release(buffer: FrameBuffer): void {
    if (buffer.color.residency === "gpu") {
      this.#textures.release(buffer.color.texture);
      this.#released += 1;
    }
    if (
      buffer.quantization.kind === "indexed" &&
      buffer.quantization.indices.residency === "gpu"
    ) {
      this.#textures.release(buffer.quantization.indices.texture);
      this.#released += 1;
    }
    log.debug("surface released", {
      residency: buffer.color.residency,
      width: buffer.width,
      height: buffer.height,
      indexed: buffer.quantization.kind === "indexed",
    });
  }
}
