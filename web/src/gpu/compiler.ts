/**
 * The pass compiler.
 *
 * Turns a `ComputePass` — WGSL, an entry point, a binding list and a uniform
 * layout — into a runnable pipeline, and keeps it. The keeping is the point: a
 * slider drag re-runs the stack dozens of times a second, and recompiling a
 * shader module on every one of those is the difference between a live preview
 * and a slideshow. Nothing about a pipeline depends on a parameter value, so
 * nothing about it needs to be rebuilt when one changes.
 *
 * Everything a pass declares is checked here rather than left to the driver:
 * duplicate bindings, an index-map binding on an effect that has no index map,
 * a workgroup larger than the portable minimum, a uniform block whose offsets
 * do not line up. Each of those is a validation error somewhere far from its
 * cause if it is allowed through, and several are not errors at all — just a
 * wrong picture.
 */

import type { EffectDescriptor } from "../types/registry";
import {
  MAX_PORTABLE_WORKGROUP_INVOCATIONS,
  type ComputePass,
  type GpuEffect,
  type PassBinding,
  type ScratchSize,
} from "../types/gpu";
import { logger } from "../lib/log";
import type { GpuContext, GpuLimits } from "./device";
import type { BufferCache } from "./resources";
import { validateUniformLayout } from "./uniforms";

const log = logger("gpu");

export class PassCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PassCompileError";
  }
}

/** Where each role sits in the pass's single bind group. `null` means absent. */
export interface BindingPlan {
  readonly inputColor: number | null;
  readonly outputColor: number | null;
  readonly inputIndex: number | null;
  readonly outputIndex: number | null;
  readonly palette: number | null;
  readonly uniforms: number | null;
  readonly scratch: readonly ScratchBinding[];
  readonly tables: readonly TableBinding[];
}

export interface ScratchBinding {
  readonly binding: number;
  readonly slot: string;
  readonly access: "read" | "read-write";
  readonly size: ScratchSize;
}

export interface TableBinding {
  readonly binding: number;
  readonly buffer: GPUBuffer;
}

export interface CompiledPass {
  readonly pass: ComputePass;
  readonly pipeline: GPUComputePipeline;
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly plan: BindingPlan;
}

export interface CompiledEffect {
  readonly effect: string;
  readonly passes: readonly CompiledPass[];
}

interface MutablePlan {
  inputColor: number | null;
  outputColor: number | null;
  inputIndex: number | null;
  outputIndex: number | null;
  palette: number | null;
  uniforms: number | null;
  readonly scratch: ScratchBinding[];
  readonly tables: { binding: number; data: Uint8Array }[];
}

function claim(
  current: number | null,
  role: string,
  binding: number,
  passId: string,
): number {
  if (current !== null) {
    throw new PassCompileError(
      `pass ${passId}: role "${role}" is declared twice (bindings ${current} and ${binding})`,
    );
  }
  return binding;
}

/**
 * Read the binding list into a role→index plan, rejecting anything the rest of
 * the layer would have to guess about later.
 */
function planBindings(
  descriptor: EffectDescriptor,
  pass: ComputePass,
): { plan: MutablePlan; entries: GPUBindGroupLayoutEntry[] } {
  const plan: MutablePlan = {
    inputColor: null,
    outputColor: null,
    inputIndex: null,
    outputIndex: null,
    palette: null,
    uniforms: null,
    scratch: [],
    tables: [],
  };
  const entries: GPUBindGroupLayoutEntry[] = [];
  const seen = new Set<number>();
  const slots = new Set<string>();

  for (const binding of pass.bindings as readonly PassBinding[]) {
    if (!Number.isInteger(binding.binding) || binding.binding < 0) {
      throw new PassCompileError(
        `pass ${pass.id}: binding index ${binding.binding} is not a non-negative integer`,
      );
    }
    if (seen.has(binding.binding)) {
      throw new PassCompileError(
        `pass ${pass.id}: binding ${binding.binding} is declared more than once`,
      );
    }
    seen.add(binding.binding);

    const base = { binding: binding.binding, visibility: GPUShaderStage.COMPUTE };

    switch (binding.role) {
      case "input-color":
        plan.inputColor = claim(plan.inputColor, "input-color", binding.binding, pass.id);
        // Sampled, not storage: the input is read with `textureLoad` at integer
        // coordinates, so no sampler is involved and no filtering is wanted.
        entries.push({ ...base, texture: { sampleType: "float", viewDimension: "2d" } });
        break;

      case "output-color":
        plan.outputColor = claim(plan.outputColor, "output-color", binding.binding, pass.id);
        entries.push({
          ...base,
          storageTexture: { access: "write-only", format: "rgba16float", viewDimension: "2d" },
        });
        break;

      case "input-index":
        if (!descriptor.requiresIndexMap) {
          // Binding an empty texture here would make an index-map consumer look
          // like it worked and quietly read zeroes — every pixel palette entry 0.
          throw new PassCompileError(
            `pass ${pass.id}: binds input-index, but effect "${descriptor.id}" does not declare requiresIndexMap`,
          );
        }
        plan.inputIndex = claim(plan.inputIndex, "input-index", binding.binding, pass.id);
        entries.push({ ...base, texture: { sampleType: "uint", viewDimension: "2d" } });
        break;

      case "output-index":
        if (!descriptor.producesIndexMap) {
          throw new PassCompileError(
            `pass ${pass.id}: binds output-index, but effect "${descriptor.id}" does not declare producesIndexMap`,
          );
        }
        plan.outputIndex = claim(plan.outputIndex, "output-index", binding.binding, pass.id);
        entries.push({
          ...base,
          storageTexture: { access: "write-only", format: "r32uint", viewDimension: "2d" },
        });
        break;

      case "palette":
        plan.palette = claim(plan.palette, "palette", binding.binding, pass.id);
        entries.push({ ...base, buffer: { type: "read-only-storage" } });
        break;

      case "uniforms":
        plan.uniforms = claim(plan.uniforms, "uniforms", binding.binding, pass.id);
        // minBindingSize makes a short uniform buffer a creation-time error
        // rather than an out-of-bounds read the shader cannot detect.
        entries.push({
          ...base,
          buffer: { type: "uniform", minBindingSize: pass.uniforms.sizeBytes },
        });
        break;

      case "scratch": {
        if (binding.slot.length === 0) {
          throw new PassCompileError(`pass ${pass.id}: a scratch binding has an empty slot name`);
        }
        if (slots.has(binding.slot)) {
          throw new PassCompileError(
            `pass ${pass.id}: scratch slot "${binding.slot}" is bound twice in one pass`,
          );
        }
        slots.add(binding.slot);
        plan.scratch.push({
          binding: binding.binding,
          slot: binding.slot,
          access: binding.access,
          size: binding.size,
        });
        entries.push({
          ...base,
          buffer: { type: binding.access === "read" ? "read-only-storage" : "storage" },
        });
        break;
      }

      case "table":
        plan.tables.push({ binding: binding.binding, data: binding.data });
        entries.push({ ...base, buffer: { type: "read-only-storage" } });
        break;
    }
  }

  return { plan, entries };
}

function validateShape(pass: ComputePass, limits: GpuLimits): void {
  const [x, y, z] = pass.workgroupSize;
  for (const [axis, value] of [["x", x], ["y", y], ["z", z]] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new PassCompileError(
        `pass ${pass.id}: workgroup size ${axis}=${value} is not a positive integer`,
      );
    }
  }
  const invocations = x * y * z;
  if (invocations > MAX_PORTABLE_WORKGROUP_INVOCATIONS) {
    // Rejected against the portable minimum rather than this device's limit, so
    // a pass that runs here runs everywhere instead of failing on one vendor.
    throw new PassCompileError(
      `pass ${pass.id}: ${x}x${y}x${z} is ${invocations} invocations, over the portable maximum of ${MAX_PORTABLE_WORKGROUP_INVOCATIONS}`,
    );
  }
  if (
    x > limits.maxComputeWorkgroupSizeX ||
    y > limits.maxComputeWorkgroupSizeY ||
    z > limits.maxComputeWorkgroupSizeZ
  ) {
    throw new PassCompileError(
      `pass ${pass.id}: workgroup ${x}x${y}x${z} exceeds this device's per-axis limits`,
    );
  }
  if (pass.entryPoint.length === 0) {
    throw new PassCompileError(`pass ${pass.id}: entryPoint is empty`);
  }
  if (pass.wgsl.length === 0) {
    throw new PassCompileError(`pass ${pass.id}: wgsl is empty`);
  }
}

/**
 * How many workgroups to dispatch for a pass at a given resolution.
 *
 * `per-row` and `per-column` divide by the *whole* workgroup, not by its x
 * extent: a row-parallel pass declares `@workgroup_size(64)` and gets one
 * invocation per row, so the invocation count is what the dispatch has to
 * cover.
 */
export function dispatchCounts(
  pass: ComputePass,
  width: number,
  height: number,
  limits: GpuLimits,
): readonly [number, number, number] {
  const [wx, wy, wz] = pass.workgroupSize;
  const perWorkgroup = wx * wy * wz;

  let counts: readonly [number, number, number];
  switch (pass.dispatch.kind) {
    case "per-pixel":
      counts = [Math.ceil(width / wx), Math.ceil(height / wy), 1];
      break;
    case "per-row":
      counts = [Math.ceil(height / perWorkgroup), 1, 1];
      break;
    case "per-column":
      counts = [Math.ceil(width / perWorkgroup), 1, 1];
      break;
    case "fixed":
      counts = [
        pass.dispatch.workgroups[0],
        pass.dispatch.workgroups[1],
        pass.dispatch.workgroups[2],
      ];
      break;
  }

  const max = limits.maxComputeWorkgroupsPerDimension;
  if (counts[0] > max || counts[1] > max || counts[2] > max) {
    throw new PassCompileError(
      `pass ${pass.id}: dispatch ${counts.join("x")} at ${width}x${height} exceeds maxComputeWorkgroupsPerDimension ${max}`,
    );
  }
  return counts;
}

/**
 * Compiles and caches pipelines, keyed on `ComputePass.id`.
 *
 * The id is enough because the contract makes the WGSL complete and constant —
 * a pass is the same program every time it is scheduled, and only its uniform
 * values and bound resources change.
 */
export class PassCompiler {
  readonly #ctx: GpuContext;
  readonly #buffers: BufferCache;
  readonly #compiled = new Map<string, CompiledPass>();
  readonly #inFlight = new Map<string, Promise<CompiledPass>>();
  readonly #modules = new Map<string, GPUShaderModule>();
  #compiles = 0;
  #hits = 0;

  constructor(ctx: GpuContext, buffers: BufferCache) {
    this.#ctx = ctx;
    this.#buffers = buffers;
  }

  /** Compile every pass of an effect, or return the cached pipelines. */
  async compile(descriptor: EffectDescriptor, gpu: GpuEffect): Promise<CompiledEffect> {
    if (descriptor.id !== gpu.effect) {
      throw new PassCompileError(
        `descriptor "${descriptor.id}" and GpuEffect "${gpu.effect}" are different effects`,
      );
    }
    if (descriptor.execution !== "gpu") {
      throw new PassCompileError(
        `effect "${descriptor.id}" declares execution "${descriptor.execution}"; only gpu effects have compute passes`,
      );
    }
    if (gpu.passes.length === 0) {
      throw new PassCompileError(`effect "${descriptor.id}" declares no passes`);
    }

    const passes: CompiledPass[] = [];
    for (const pass of gpu.passes) {
      passes.push(await this.#compilePass(descriptor, pass));
    }
    return { effect: descriptor.id, passes };
  }

  async #compilePass(descriptor: EffectDescriptor, pass: ComputePass): Promise<CompiledPass> {
    const cached = this.#compiled.get(pass.id);
    if (cached !== undefined) {
      this.#hits += 1;
      log.debug("pipeline cache hit", { pass: pass.id });
      return cached;
    }
    // Two nodes of the same effect scheduled in one frame must not race into
    // two compiles of the same module.
    const pending = this.#inFlight.get(pass.id);
    if (pending !== undefined) return pending;

    const promise = this.#build(descriptor, pass);
    this.#inFlight.set(pass.id, promise);
    try {
      const compiled = await promise;
      this.#compiled.set(pass.id, compiled);
      return compiled;
    } finally {
      this.#inFlight.delete(pass.id);
    }
  }

  async #build(descriptor: EffectDescriptor, pass: ComputePass): Promise<CompiledPass> {
    this.#ctx.assertUsable(`compile ${pass.id}`);
    const started = performance.now();

    validateShape(pass, this.#ctx.limits);
    validateUniformLayout(pass.id, pass.uniforms);

    const { plan, entries } = planBindings(descriptor, pass);

    if (pass.uniforms.fields.length > 0 && plan.uniforms === null) {
      throw new PassCompileError(
        `pass ${pass.id}: declares ${pass.uniforms.fields.length} uniform field(s) but no uniforms binding`,
      );
    }
    const writes =
      plan.outputColor !== null ||
      plan.outputIndex !== null ||
      plan.scratch.some((s) => s.access === "read-write");
    if (!writes) {
      // A dispatch that writes nothing observable is either a mistake or a
      // pass whose real output nobody declared; both are worth stopping for.
      throw new PassCompileError(
        `pass ${pass.id}: declares no writable binding, so it cannot produce anything`,
      );
    }
    this.#checkPerStageLimits(pass, entries);

    const module = await this.#module(pass);

    const bindGroupLayout = this.#ctx.device.createBindGroupLayout({
      label: `${pass.label} layout`,
      entries,
    });
    const pipelineLayout = this.#ctx.device.createPipelineLayout({
      label: `${pass.label} pipeline layout`,
      bindGroupLayouts: [bindGroupLayout],
    });

    this.#ctx.device.pushErrorScope("validation");
    const created = await this.#ctx.device
      .createComputePipelineAsync({
        label: pass.label,
        layout: pipelineLayout,
        compute: { module, entryPoint: pass.entryPoint },
      })
      .then(
        (pipeline) => ({ ok: true, pipeline }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      );
    const scoped = await this.#ctx.device.popErrorScope();

    if (!created.ok) {
      log.error("pipeline creation failed", { pass: pass.id, error: String(created.error) });
      throw new PassCompileError(
        `pass ${pass.id}: pipeline creation failed: ${String(created.error)}`,
      );
    }
    if (scoped !== null) {
      log.error("pipeline validation error", { pass: pass.id, error: scoped.message });
      throw new PassCompileError(`pass ${pass.id}: ${scoped.message}`);
    }

    // Tables are read-only and constant, so they are uploaded once here rather
    // than re-sent with every dispatch.
    const tables: TableBinding[] = plan.tables.map((table) => ({
      binding: table.binding,
      buffer: this.#buffers.table(table.data, `${pass.id}@${table.binding}`),
    }));

    this.#compiles += 1;
    log.info("pass compiled", {
      pass: pass.id,
      effect: descriptor.id,
      entryPoint: pass.entryPoint,
      workgroup: pass.workgroupSize.join("x"),
      bindings: entries.length,
      uniformBytes: pass.uniforms.sizeBytes,
      ms: Math.round((performance.now() - started) * 100) / 100,
    });

    return {
      pass,
      pipeline: created.pipeline,
      bindGroupLayout,
      plan: {
        inputColor: plan.inputColor,
        outputColor: plan.outputColor,
        inputIndex: plan.inputIndex,
        outputIndex: plan.outputIndex,
        palette: plan.palette,
        uniforms: plan.uniforms,
        scratch: plan.scratch,
        tables,
      },
    };
  }

  /**
   * Count the bind group against the per-stage limits.
   *
   * The driver would reject an over-budget layout too, but its message names a
   * binding index rather than the effect that wrote it, and the numbers here
   * are the guaranteed minimums an author has to design against anyway.
   */
  #checkPerStageLimits(pass: ComputePass, entries: readonly GPUBindGroupLayoutEntry[]): void {
    let sampled = 0;
    let storageTextures = 0;
    let storageBuffers = 0;
    for (const entry of entries) {
      if (entry.texture !== undefined) sampled += 1;
      if (entry.storageTexture !== undefined) storageTextures += 1;
      if (entry.buffer !== undefined && entry.buffer.type !== "uniform") storageBuffers += 1;
    }
    const limits = this.#ctx.limits;
    const over: string[] = [];
    if (sampled > limits.maxSampledTexturesPerShaderStage) {
      over.push(`${sampled} sampled textures > ${limits.maxSampledTexturesPerShaderStage}`);
    }
    if (storageTextures > limits.maxStorageTexturesPerShaderStage) {
      over.push(
        `${storageTextures} storage textures > ${limits.maxStorageTexturesPerShaderStage}`,
      );
    }
    if (storageBuffers > limits.maxStorageBuffersPerShaderStage) {
      over.push(`${storageBuffers} storage buffers > ${limits.maxStorageBuffersPerShaderStage}`);
    }
    if (over.length > 0) {
      throw new PassCompileError(`pass ${pass.id}: ${over.join("; ")}`);
    }
  }

  /**
   * Create the shader module and surface its diagnostics.
   *
   * `getCompilationInfo()` is what turns "pipeline creation failed" into a line
   * and column in a real `.wgsl` file, which is the whole reason the contract
   * keeps shader source complete and constant instead of assembling it.
   */
  async #module(pass: ComputePass): Promise<GPUShaderModule> {
    const existing = this.#modules.get(pass.id);
    if (existing !== undefined) return existing;

    const module = this.#ctx.device.createShaderModule({ label: pass.id, code: pass.wgsl });
    const info = await module.getCompilationInfo();

    let errors = 0;
    for (const message of info.messages) {
      const fields = {
        pass: pass.id,
        line: message.lineNum,
        column: message.linePos,
        message: message.message,
      };
      if (message.type === "error") {
        errors += 1;
        log.error("wgsl error", fields);
      } else if (message.type === "warning") {
        log.warn("wgsl warning", fields);
      } else {
        log.debug("wgsl info", fields);
      }
    }
    if (errors > 0) {
      throw new PassCompileError(
        `pass ${pass.id}: ${errors} WGSL compilation error(s); see the gpu log for line numbers`,
      );
    }

    this.#modules.set(pass.id, module);
    return module;
  }

  /** Look up an already-compiled pass without recompiling. */
  get(passId: string): CompiledPass | undefined {
    return this.#compiled.get(passId);
  }

  stats(): { readonly compiled: number; readonly compiles: number; readonly hits: number } {
    return { compiled: this.#compiled.size, compiles: this.#compiles, hits: this.#hits };
  }

  /**
   * Drop every cached pipeline.
   *
   * Pipelines and modules have no explicit destructor in WebGPU; they are
   * released when nothing references them. Clearing the maps is the release.
   */
  clear(): void {
    log.info("pipeline cache cleared", { ...this.stats() });
    this.#compiled.clear();
    this.#modules.clear();
  }
}
