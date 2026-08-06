/**
 * Device acquisition and lifetime.
 *
 * WebGPU is a hard requirement with no WebGL2 fallback (docs/ARCHITECTURE.md,
 * "Platform support policy"), so nothing here degrades. Every failure is thrown
 * with the reason named, because the alternative — a null device flowing into
 * the pass compiler — surfaces three layers away as an unrelated symptom.
 *
 * The startup capability check lives in `web/src/lib/capabilities.ts` and is not
 * repeated here. This module *consumes* its verdict: if the report says WebGPU
 * is missing, acquisition refuses with the report's own wording, so the console
 * and the unsupported screen say the same thing.
 */

import type { CapabilityReport } from "../lib/capabilities";
import { logger } from "../lib/log";

const log = logger("gpu");

/** Thrown when WebGPU cannot be used at all. There is no second path to try. */
export class GpuUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GpuUnavailableError";
  }
}

/**
 * Thrown when work is attempted on a device the driver has taken away.
 *
 * Distinct from {@link GpuUnavailableError} because the responses differ: an
 * unavailable device means this browser cannot run the app, a lost device means
 * this session must be rebuilt and the user told why.
 */
export class GpuDeviceLostError extends Error {
  constructor(
    readonly reason: GPUDeviceLostReason,
    readonly detail: string,
  ) {
    super(`WebGPU device lost (${reason}): ${detail}`);
    this.name = "GpuDeviceLostError";
  }
}

/**
 * The subset of `GPUSupportedLimits` the renderer actually schedules against.
 *
 * Copied into a plain object rather than kept as a live `GPUSupportedLimits`
 * so it can be logged, compared and asserted against without touching the
 * device, and so a limit the compiler depends on is named in one list instead
 * of being read ad hoc from three files.
 */
export interface GpuLimits {
  readonly maxTextureDimension2D: number;
  readonly maxBufferSize: number;
  readonly maxUniformBufferBindingSize: number;
  readonly maxStorageBufferBindingSize: number;
  readonly maxComputeWorkgroupStorageSize: number;
  readonly maxComputeInvocationsPerWorkgroup: number;
  readonly maxComputeWorkgroupSizeX: number;
  readonly maxComputeWorkgroupSizeY: number;
  readonly maxComputeWorkgroupSizeZ: number;
  readonly maxComputeWorkgroupsPerDimension: number;
  readonly maxStorageTexturesPerShaderStage: number;
  readonly maxSampledTexturesPerShaderStage: number;
  readonly maxStorageBuffersPerShaderStage: number;
  readonly maxBindGroups: number;
}

function snapshotLimits(limits: GPUSupportedLimits): GpuLimits {
  return {
    maxTextureDimension2D: limits.maxTextureDimension2D,
    maxBufferSize: limits.maxBufferSize,
    maxUniformBufferBindingSize: limits.maxUniformBufferBindingSize,
    maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
    maxComputeWorkgroupStorageSize: limits.maxComputeWorkgroupStorageSize,
    maxComputeInvocationsPerWorkgroup: limits.maxComputeInvocationsPerWorkgroup,
    maxComputeWorkgroupSizeX: limits.maxComputeWorkgroupSizeX,
    maxComputeWorkgroupSizeY: limits.maxComputeWorkgroupSizeY,
    maxComputeWorkgroupSizeZ: limits.maxComputeWorkgroupSizeZ,
    maxComputeWorkgroupsPerDimension: limits.maxComputeWorkgroupsPerDimension,
    maxStorageTexturesPerShaderStage: limits.maxStorageTexturesPerShaderStage,
    maxSampledTexturesPerShaderStage: limits.maxSampledTexturesPerShaderStage,
    maxStorageBuffersPerShaderStage: limits.maxStorageBuffersPerShaderStage,
    maxBindGroups: limits.maxBindGroups,
  };
}

export interface GpuContextOptions {
  /** Result of `checkCapabilities()`. Not re-run; only read. */
  readonly report: CapabilityReport;
  readonly powerPreference?: GPUPowerPreference;
  /**
   * Optional features. Every one is verified against the adapter before the
   * device is requested, so a missing feature is an error naming the feature
   * rather than a device that quietly lacks it.
   */
  readonly requiredFeatures?: readonly GPUFeatureName[];
  /**
   * Called when the driver takes the device away — a TDR, a laptop switching
   * GPUs, a browser tab evicted from the GPU process. The renderer cannot
   * recover silently; the callback exists so the UI can say so.
   */
  readonly onDeviceLost?: (info: GPUDeviceLostInfo) => void;
  readonly label?: string;
}

/**
 * An acquired device plus everything the rest of the GPU layer needs to reason
 * about it.
 *
 * Held as one object because a device, its limits and its feature set are only
 * meaningful together: a pipeline validated against one device's limits is not
 * portable to another.
 */
export class GpuContext {
  readonly device: GPUDevice;
  readonly adapterInfo: GPUAdapterInfo;
  readonly limits: GpuLimits;
  readonly features: readonly GPUFeatureName[];

  #lost: GPUDeviceLostInfo | null = null;
  #destroyed = false;
  readonly #onDeviceLost: ((info: GPUDeviceLostInfo) => void) | undefined;

  constructor(
    device: GPUDevice,
    adapterInfo: GPUAdapterInfo,
    onDeviceLost: ((info: GPUDeviceLostInfo) => void) | undefined,
  ) {
    this.device = device;
    this.adapterInfo = adapterInfo;
    this.limits = snapshotLimits(device.limits);
    this.features = Array.from(device.features) as readonly GPUFeatureName[];
    this.#onDeviceLost = onDeviceLost;
    this.#watchLost();
    this.#watchUncapturedErrors();
  }

  /** Non-null once the device has gone away. */
  get lostInfo(): GPUDeviceLostInfo | null {
    return this.#lost;
  }

  get isLost(): boolean {
    return this.#lost !== null;
  }

  /**
   * Guard placed at the head of every operation that touches the device.
   *
   * Without it a lost device turns every subsequent call into a validation
   * error with no mention of the actual cause, which is the "silently dying"
   * failure this module exists to prevent.
   */
  assertUsable(operation: string): void {
    const lost = this.#lost;
    if (lost !== null) {
      log.error("operation on a lost device", { operation, reason: lost.reason });
      throw new GpuDeviceLostError(lost.reason, lost.message);
    }
  }

  #watchLost(): void {
    this.device.lost
      .then((info) => {
        // A device we destroyed ourselves also resolves this promise. That is
        // an orderly shutdown, not a crash, and reporting it as one would train
        // people to ignore the message that matters.
        if (this.#destroyed) {
          log.info("device released", { reason: info.reason });
          return;
        }
        this.#lost = info;
        log.error("device lost", {
          reason: info.reason,
          message: info.message,
          vendor: this.adapterInfo.vendor,
          architecture: this.adapterInfo.architecture,
        });
        if (this.#onDeviceLost !== undefined) this.#onDeviceLost(info);
      })
      .catch((error: unknown) => {
        // device.lost is specified never to reject; if it ever does, that is
        // itself worth seeing rather than dropping on the floor.
        log.error("device.lost rejected", { error: String(error) });
      });
  }

  #watchUncapturedErrors(): void {
    // Errors raised outside an error scope are otherwise printed by the browser
    // with no correlation to what the renderer was doing. Routing them through
    // the gpu channel puts them next to the pass that caused them.
    this.device.onuncapturederror = (event) => {
      log.error("uncaptured device error", {
        error: String(event.error),
        kind: event.error.constructor.name,
      });
    };
  }

  /** Orderly shutdown. Marks the loss as intentional before it is reported. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    log.info("destroying device");
    this.device.destroy();
  }
}

/**
 * Acquire a device, or throw naming the reason.
 *
 * The adapter is requested again here rather than carried on the capability
 * report: the report holds a `GPUAdapterInfo`, not a live `GPUAdapter`, and an
 * adapter is invalidated once a device has been requested from it. Re-requesting
 * is the specified way to get a usable handle and is not a duplicate check —
 * the *verdict* still comes from the report.
 */
export async function acquireGpuContext(
  options: GpuContextOptions,
): Promise<GpuContext> {
  const webgpu = options.report.capabilities.find((c) => c.id === "webgpu");
  if (webgpu === undefined) {
    throw new GpuUnavailableError(
      "capability report contains no webgpu entry; checkCapabilities() must run before acquireGpuContext()",
    );
  }
  if (webgpu.state !== "ok") {
    log.error("refusing to acquire a device", { detail: webgpu.detail });
    throw new GpuUnavailableError(webgpu.detail);
  }

  const gpu = navigator.gpu as GPU | undefined;
  if (gpu === undefined) {
    throw new GpuUnavailableError(
      "navigator.gpu disappeared between the capability check and device acquisition",
    );
  }

  const adapterOptions: GPURequestAdapterOptions =
    options.powerPreference === undefined
      ? {}
      : { powerPreference: options.powerPreference };

  let adapter: GPUAdapter | null;
  try {
    adapter = await gpu.requestAdapter(adapterOptions);
  } catch (error) {
    log.error("requestAdapter threw", { error: String(error) });
    throw new GpuUnavailableError(`requestAdapter threw: ${String(error)}`);
  }
  if (adapter === null) {
    log.error("requestAdapter returned null after the capability check passed");
    throw new GpuUnavailableError(
      "no adapter was returned — the GPU became unavailable after the startup check",
    );
  }

  const requested = options.requiredFeatures ?? [];
  const missing = requested.filter((f) => !adapter.features.has(f));
  if (missing.length > 0) {
    // Dropping an unsupported feature and carrying on is how a shader ends up
    // compiled against a capability the device does not have.
    log.error("adapter is missing required features", { missing: missing.join(", ") });
    throw new GpuUnavailableError(
      `adapter does not support required feature(s): ${missing.join(", ")}`,
    );
  }

  // No raised limits are requested. The compiler validates every pass against
  // MAX_PORTABLE_WORKGROUP_INVOCATIONS and the baseline limits, so a pass that
  // runs on the developer's machine runs on the user's; asking for more here
  // would move that failure to a stranger's driver.
  const descriptor: GPUDeviceDescriptor = {
    label: options.label ?? "dither-ork",
    requiredFeatures: requested,
  };

  let device: GPUDevice;
  try {
    device = await adapter.requestDevice(descriptor);
  } catch (error) {
    log.error("requestDevice threw", { error: String(error) });
    throw new GpuUnavailableError(`requestDevice threw: ${String(error)}`);
  }

  const context = new GpuContext(device, adapter.info, options.onDeviceLost);

  log.info("device acquired", {
    vendor: context.adapterInfo.vendor,
    architecture: context.adapterInfo.architecture,
    device: context.adapterInfo.device,
    description: context.adapterInfo.description,
    features: context.features.length > 0 ? context.features.join(",") : "(none)",
  });
  log.info("device limits", { ...context.limits });

  return context;
}
