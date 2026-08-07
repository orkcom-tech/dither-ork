/**
 * The render worker's wire format.
 *
 * One file, imported by both sides, so the two halves of every call are written
 * next to each other and cannot drift. Nothing here executes: it is types plus
 * two helpers for turning an `Error` into something `postMessage` will carry and
 * back again.
 *
 * ## Why this and not Comlink
 *
 * docs/ARCHITECTURE.md names Comlink, and the interfaces in docs/API.md section
 * 9 are written as Comlink proxies. Three properties this seam needs are ones a
 * proxy cannot express, and all three are load-bearing here:
 *
 * - **Cancellation of work already running.** Comlink marshals a call and waits
 *   for its return; there is no channel for "abandon call 41, I have sent 42".
 *   A parameter drag issues renders faster than they complete, so the ability to
 *   name an in-flight call and abort it is the whole point of the exercise.
 * - **Explicit transfer on the way back.** Comlink transfers what you tell it to
 *   via `transfer()`, but the interesting object here — the finished frame — is
 *   produced inside the call and has to be transferred out of it. Writing the
 *   `postMessage` by hand is how the `ImageBitmap` gets moved rather than
 *   structured-cloned, and how the byte cost of the move gets measured (it is
 *   the same instrumentation the GPU/CPU boundary already carries).
 * - **A lane discipline.** Preview and export are two priorities over one GPU
 *   device, and the queue that arbitrates them is worker-side state, not a
 *   remote object graph.
 *
 * The shape of the RPC is otherwise exactly what section 9 describes — a typed
 * call table, one message per call, results keyed by id — so the thing Comlink
 * would have generated is here, written out, with the three additions above. Not
 * taking the dependency also keeps `npm i` out of a build whose one hard
 * requirement is that it runs locally.
 */

import type { RenderDiagnostics, RenderStats } from "../graph";
import type { VectorTraceReport, VectorTraceSettings } from "../export";
import type { Capability } from "../lib/capabilities";
import type { SourceImage } from "../io";
import type { DitherDocument } from "../types/document";
import type { RenderQuality } from "../types/graph";

/**
 * The capability report as the worker can receive it.
 *
 * `CapabilityReport` carries a live `GPUAdapterInfo`, which is a platform object
 * and not structured-cloneable — posting one throws a `DataCloneError`. Only the
 * verdict crosses, which is all `acquireGpuContext` reads; the worker requests
 * its own adapter anyway, because an adapter is invalidated once a device has
 * been taken from it.
 */
export interface WorkerCapabilityReport {
  readonly capabilities: readonly Capability[];
  readonly fatalFailures: readonly Capability[];
  readonly usable: boolean;
}

/** One entry of the core's kernel table, as the UI lists it. */
export interface WorkerKernel {
  readonly id: string;
  readonly name: string;
}

/** What the worker reports once its device and core are up. */
export interface InitResult {
  readonly coreVersion: string;
  readonly kernels: readonly WorkerKernel[];
  /**
   * The largest 2D texture the worker's device will allocate. The main thread
   * sizes its image limits from this (F-IN-05), so the number a refusal quotes
   * is the number the renderer will actually honour — and after this change the
   * device lives over there, so it has to be reported rather than read.
   */
  readonly maxTextureDimension2D: number;
  /** For the status bar. Strings, because `GPUAdapterInfo` cannot cross. */
  readonly adapter: {
    readonly vendor: string;
    readonly architecture: string;
    readonly device: string;
    readonly description: string;
  };
  /** Milliseconds from worker start to a usable device and core. */
  readonly ms: number;
}

export interface SetSourceParams {
  readonly source: SourceImage | null;
}

export interface SetSourceResult {
  /** Bytes of pixel data the message carried. Zero when clearing. */
  readonly bytes: number;
  /** Milliseconds the worker spent receiving and filing it. */
  readonly ms: number;
}

/**
 * Which queue a render joins.
 *
 * `preview` is superseded by a newer preview and yields to an export.
 * `export` is never superseded and never yields — it is a file somebody asked
 * for, and it is the one render whose result must be exact.
 */
export type RenderLane = "preview" | "export";

/** How the finished frame comes back. */
export type PresentAs = "bitmap" | "bytes";

export interface RenderParams {
  readonly document: DitherDocument;
  /** Render up to and including this node (F-ST-02). */
  readonly solo: string | null;
  readonly quality: RenderQuality;
  /**
   * Fraction of document resolution to render at, in (0, 1] — F-UI-03. The
   * worker resamples the source to that extent and the whole graph runs there,
   * so the returned frame is genuinely smaller and the viewport's badge is
   * describing something that happened.
   */
  readonly factor: number;
  readonly lane: RenderLane;
  readonly present: PresentAs;
}

export type RenderedImage =
  | { readonly kind: "bitmap"; readonly bitmap: ImageBitmap }
  | {
      readonly kind: "bytes";
      readonly data: Uint8ClampedArray;
    };

export interface RenderResult {
  readonly image: RenderedImage;
  /** The extent the graph actually ran at. Below the document's when degraded. */
  readonly width: number;
  readonly height: number;
  readonly documentWidth: number;
  readonly documentHeight: number;
  readonly quality: RenderQuality;
  readonly correlationId: string;
  /** Absent when the stack was empty and the source itself is the picture. */
  readonly stats: RenderStats | null;
  readonly diagnostics: RenderDiagnostics | null;
  /** Milliseconds inside the worker, from the call to the finished frame. */
  readonly totalMs: number;
  /** Of which, presenting: readback plus sRGB encode plus the bitmap. */
  readonly presentMs: number;
  /** Bytes the reply carries across the worker boundary. */
  readonly transferBytes: number;
}

export interface TraceParams {
  readonly indices: Uint16Array;
  readonly width: number;
  readonly height: number;
  readonly paletteRgb: Uint8Array;
  readonly settings: VectorTraceSettings;
}

export interface TraceResult {
  readonly svg: string;
  readonly report: VectorTraceReport;
  readonly ms: number;
}

/**
 * Every call the worker answers, as one table.
 *
 * A map rather than a union of message shapes, because the client's `call`
 * needs the result type to follow from the call name, and a union would make
 * that a cast at every site.
 */
export interface WorkerCalls {
  init: { readonly params: WorkerCapabilityReport; readonly result: InitResult };
  "set-source": { readonly params: SetSourceParams; readonly result: SetSourceResult };
  render: { readonly params: RenderParams; readonly result: RenderResult };
  trace: { readonly params: TraceParams; readonly result: TraceResult };
  dispose: { readonly params: null; readonly result: null };
}

export type WorkerCallKind = keyof WorkerCalls;
export type CallParams<K extends WorkerCallKind> = WorkerCalls[K]["params"];
export type CallResult<K extends WorkerCallKind> = WorkerCalls[K]["result"];

export interface CallMessage<K extends WorkerCallKind = WorkerCallKind> {
  readonly channel: "call";
  readonly id: number;
  readonly kind: K;
  readonly params: CallParams<K>;
}

/**
 * Abandon a call already sent.
 *
 * Not a call of its own: it carries no id of its own and is never answered, so
 * a cancel can never itself be queued behind the render it is trying to stop.
 */
export interface CancelMessage {
  readonly channel: "cancel";
  readonly target: number;
}

export type WorkerInbound = CallMessage | CancelMessage;

export type WorkerOutbound =
  | { readonly channel: "result"; readonly id: number; readonly value: unknown }
  | { readonly channel: "error"; readonly id: number; readonly error: SerialisedError };

/**
 * Why a call did not produce a result.
 *
 * `superseded` and `cancelled` are ordinary outcomes of an interactive editor
 * and are not failures: the first means a newer render replaced this one, the
 * second means somebody asked for it to stop. They are named so the caller can
 * tell them from a stack it cannot render, which is a failure and reaches the UI.
 */
export type WorkerErrorCode = "superseded" | "cancelled" | "failed";

export interface SerialisedError {
  readonly code: WorkerErrorCode;
  readonly name: string;
  readonly message: string;
  /** The worker-side stack, kept so a failure in there is debuggable from here. */
  readonly stack: string | undefined;
}

/**
 * A render that was abandoned rather than one that went wrong.
 *
 * A distinct class rather than a flag, so the one place that must not treat it
 * as a failure — the session's error banner — can say so in a type test rather
 * than by string matching.
 */
export class RenderAbandoned extends Error {
  readonly code: "superseded" | "cancelled";

  constructor(code: "superseded" | "cancelled", message: string) {
    super(message);
    this.name = "RenderAbandoned";
    this.code = code;
  }
}

export function serialiseError(error: unknown): SerialisedError {
  if (error instanceof RenderAbandoned) {
    return {
      code: error.code,
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  if (error instanceof Error) {
    return { code: "failed", name: error.name, message: error.message, stack: error.stack };
  }
  return { code: "failed", name: "Error", message: String(error), stack: undefined };
}

/**
 * The error back on the calling side.
 *
 * The worker's stack is appended rather than dropped: without it a failure
 * inside a compute pass reports as one line with no frames, which is the
 * "silently dying" failure the GPU layer already refuses to allow.
 */
export function reviveError(error: SerialisedError): Error {
  if (error.code === "superseded" || error.code === "cancelled") {
    return new RenderAbandoned(error.code, error.message);
  }
  const revived = new Error(error.message);
  revived.name = error.name;
  if (error.stack !== undefined) revived.stack = `${error.name}: ${error.message}\n${error.stack}`;
  return revived;
}

/** Bytes of pixel data a source image carries, for the transfer instrumentation. */
export function sourceBytes(source: SourceImage): number {
  const surface = source.surface;
  return (
    surface.r.byteLength + surface.g.byteLength + surface.b.byteLength + surface.a.byteLength
  );
}
