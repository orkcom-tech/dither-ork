/**
 * `WasmBackend` — the graph's serial half.
 *
 * Error diffusion is inherently serial and is the constraint the whole renderer
 * is shaped around (docs/ARCHITECTURE.md). One node, one call into the Rust
 * core, never batched with anything.
 *
 * ## The 8-bit boundary, which is a real cost and is not hidden
 *
 * The pipeline carries **linear-light planar `f32`**. `ditherImage` at the WASM
 * boundary takes **8-bit sRGB RGBA** and returns it (docs/API.md, section 1) —
 * it decodes to linear inside, diffuses there, and re-encodes. So a diffusion
 * node in the middle of a stack costs a round trip through 8 bits: linear f32
 * out to sRGB bytes, and the result back to linear f32.
 *
 * That is not free and it is not what the architecture wants. Between two
 * parallel nodes the buffer is `rgba16float`; a diffusion node between them
 * quantizes the *carrier* to 256 levels per channel before its own quantization
 * even begins, which shows up as banding in a smooth gradient that a later node
 * then stretches. It is done this way because it is the only entry point the
 * core exposes today, and the fix is a small, well-defined one on the Rust
 * side: a `dither_linear_f32` binding taking the four planes the pipeline
 * already has. That is written down in this round's report rather than worked
 * around here, because working around it would mean a second colour path.
 *
 * ## The port
 *
 * The core is reached through {@link DiffusionPort} rather than by importing
 * the generated package, so this file has no `wasm-bindgen` handles in it and
 * can be exercised without a WASM build. `createDiffusionPort` in
 * `render/core.ts` is the one implementation, and it is where handles are freed.
 */

import type { ColorMetric, Palette, ParameterValue } from "../../types/document";
import type { CpuColorSurface, FrameBuffer } from "../../types/graph";
import type { WasmBackend, WasmNodeRequest } from "../../graph";
import { GraphError } from "../../graph";
import { linearSurfaceFromSrgbBytes, srgbBytesFromLinearSurface } from "../../io";
import { logger } from "../../lib/log";

const log = logger("wasm");

/** Which planes the error is diffused through (F-ED-CTL). */
export type DiffusionChannelMode = "per-channel" | "luma";

export interface DiffusionRequest {
  readonly kernelId: string;
  /** 8-bit sRGB RGBA, `width * height * 4`. */
  readonly rgba: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Packed 8-bit sRGB triplets. */
  readonly palette: Uint8Array;
  readonly strength: number;
  readonly serpentine: boolean;
  readonly jitter: number;
  readonly overshootLimit: number;
  readonly channels: DiffusionChannelMode;
  readonly metric: ColorMetric;
  /** 64 bits: the document's seed is 64 bits and narrowing it loses half. */
  readonly seed: bigint;
}

export interface DiffusionResult {
  /** 8-bit sRGB RGBA. */
  readonly pixels: Uint8Array;
  /** One palette index per pixel. */
  readonly indices: Uint16Array;
}

/** The only thing this backend needs from the Rust core. */
export interface DiffusionPort {
  dither(request: DiffusionRequest): DiffusionResult;
}

export class WasmRenderBackend implements WasmBackend {
  readonly #port: DiffusionPort;

  constructor(port: DiffusionPort) {
    this.#port = port;
  }

  async run(request: WasmNodeRequest): Promise<FrameBuffer> {
    const planned = request.node;
    const nodeId = planned.node.id;

    if (planned.composite !== null) {
      throw new GraphError(
        "invariant",
        `node ${nodeId} asks for opacity ${planned.composite.opacity} in blend ` +
          `"${planned.composite.blend}", and per-node compositing (F-ST-03) is not implemented ` +
          `in this build.`,
        { nodeId, effect: planned.node.effect },
      );
    }

    const input = this.#inputOf(request);
    if (input.color.residency !== "cpu") {
      throw new GraphError(
        "invariant",
        `node ${nodeId} was handed a GPU-resident input; the renderer guarantees residency before the call`,
        { nodeId },
      );
    }

    const { width, height } = input;
    const surface: CpuColorSurface = input.color;

    const encoded = srgbBytesFromLinearSurface(surface, width, height);
    const rgba = new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);

    const started = performance.now();
    const result = this.#port.dither({
      kernelId: planned.node.effect,
      rgba,
      width,
      height,
      palette: packPalette(request.palette),
      strength: numberParam(planned.node.params, "strength", 1),
      serpentine: booleanParam(planned.node.params, "serpentine", true),
      jitter: numberParam(planned.node.params, "jitter", 0),
      overshootLimit: numberParam(planned.node.params, "overshootLimit", 1),
      channels: channelParam(planned.node.params),
      // The metric belongs to the palette, not to the node: a palette swap must
      // not be able to leave a stale metric behind (see effects/error-diffusion.ts).
      metric: request.palette.metric,
      seed: BigInt(Math.trunc(planned.node.seed)),
    });

    if (result.pixels.length !== width * height * 4) {
      throw new GraphError(
        "invariant",
        `the core returned ${result.pixels.length} bytes for ${width}x${height}`,
        { nodeId, width, height },
      );
    }

    const color = linearSurfaceFromSrgbBytes(result.pixels, width, height);
    log.debug("diffusion node complete", {
      nodeId,
      kernel: planned.node.effect,
      width,
      height,
      paletteEntries: request.palette.colors.length / 3,
      ms: Math.round((performance.now() - started) * 100) / 100,
    });

    return {
      width,
      height,
      color,
      quantization: {
        kind: "indexed",
        indices: { residency: "cpu", data: result.indices },
        palette: request.palette,
      },
      hash: planned.hash,
    };
  }

  #inputOf(request: WasmNodeRequest): FrameBuffer {
    for (const input of request.node.inputs) {
      if (input.port !== "in") continue;
      if (input.origin.kind === "source") {
        if (request.source === null) {
          throw new GraphError(
            "invariant",
            `node ${request.node.node.id} reads the source but none was supplied`,
            { nodeId: request.node.node.id },
          );
        }
        return request.source;
      }
      const buffer = request.buffers.get(input.origin.nodeId);
      if (buffer === undefined) {
        throw new GraphError(
          "invariant",
          `node ${request.node.node.id} reads ${input.origin.nodeId}, which was not supplied`,
          { nodeId: request.node.node.id, from: input.origin.nodeId },
        );
      }
      return buffer;
    }
    throw new GraphError(
      "invariant",
      `node ${request.node.node.id} has no "in" input; every stack node reads one`,
    );
  }
}

/** The document's packed triplets as the bytes the boundary takes. */
export function packPalette(palette: Palette): Uint8Array {
  const bytes = new Uint8Array(palette.colors.length);
  for (const [index, component] of palette.colors.entries()) bytes[index] = component;
  return bytes;
}

function numberParam(
  params: Readonly<Record<string, ParameterValue>>,
  key: string,
  fallback: number,
): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanParam(
  params: Readonly<Record<string, ParameterValue>>,
  key: string,
  fallback: boolean,
): boolean {
  const value = params[key];
  return typeof value === "boolean" ? value : fallback;
}

/**
 * The channel mode.
 *
 * Riemersma declares no `serpentine` control and every kernel declares
 * `channels`, but reading a parameter defensively costs a line and turns a
 * descriptor change into a default rather than into `undefined` crossing the
 * WASM boundary as a number.
 */
function channelParam(
  params: Readonly<Record<string, ParameterValue>>,
): DiffusionChannelMode {
  return params["channels"] === "luma" ? "luma" : "per-channel";
}
