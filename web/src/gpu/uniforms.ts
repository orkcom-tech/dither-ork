/**
 * Uniform buffer layout validation and packing.
 *
 * This is the classic silent-corruption source in a compute pipeline. WGSL's
 * uniform address space uses std140-style rules: a `vec3f` occupies 12 bytes but
 * aligns to 16, a struct's alignment is rounded up to 16, and a field written
 * one byte off the address the shader reads produces a wrong-looking image and
 * no error anywhere. `web/src/types/gpu.ts` therefore makes offsets explicit
 * rather than derived; this module is the half that checks the declaration is
 * actually legal and then writes to exactly those addresses.
 *
 * Every rejection names the field. A layout error found at compile time costs a
 * console line; the same error found by eye costs an afternoon.
 */

import type { ParameterValue } from "../types/document";
import type { ParamDescriptor } from "../types/registry";
import {
  UNIFORM_ALIGNMENT,
  type UniformField,
  type UniformFieldType,
  type UniformLayout,
} from "../types/gpu";
import { logger } from "../lib/log";

const log = logger("gpu");

export class UniformLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UniformLayoutError";
  }
}

export class UniformPackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UniformPackError";
  }
}

/** How a component is written once its numeric value is known. */
type ScalarKind = "f32" | "i32" | "u32";

interface FieldSpec {
  /** Number of scalar components. */
  readonly components: number;
  /** WGSL alignment in the uniform address space, in bytes. */
  readonly align: number;
  /** Bytes actually occupied. Note `vec3f` is 12, not 16 — the padding is external. */
  readonly size: number;
  readonly scalar: ScalarKind;
}

/**
 * WGSL alignment and size, uniform address space.
 *
 * Straight out of the WGSL memory-layout table. Written as data rather than
 * branches so the numbers are checkable against the spec at a glance.
 */
const FIELD_SPECS: Readonly<Record<UniformFieldType, FieldSpec>> = {
  f32: { components: 1, align: 4, size: 4, scalar: "f32" },
  i32: { components: 1, align: 4, size: 4, scalar: "i32" },
  u32: { components: 1, align: 4, size: 4, scalar: "u32" },
  vec2f: { components: 2, align: 8, size: 8, scalar: "f32" },
  vec3f: { components: 3, align: 16, size: 12, scalar: "f32" },
  vec4f: { components: 4, align: 16, size: 16, scalar: "f32" },
};

function describe(field: UniformField): string {
  return field.source.kind === "param"
    ? `param "${field.source.key}" (${field.type} @ ${field.offset})`
    : `builtin "${field.source.name}" (${field.type} @ ${field.offset})`;
}

/**
 * Reject a layout the shader cannot read correctly.
 *
 * Checks, in order: the struct size is a legal uniform struct size, every field
 * sits at an address its type permits, every field fits, and no two fields
 * overlap. Overlap is checked because a hand-written offset table is exactly
 * the kind of thing that develops a collision when a field is inserted, and the
 * collision is invisible from either side.
 */
export function validateUniformLayout(label: string, layout: UniformLayout): void {
  const problems: string[] = [];

  if (!Number.isInteger(layout.sizeBytes) || layout.sizeBytes <= 0) {
    problems.push(`sizeBytes ${layout.sizeBytes} is not a positive integer`);
  } else if (layout.sizeBytes % UNIFORM_ALIGNMENT !== 0) {
    problems.push(
      `sizeBytes ${layout.sizeBytes} is not a multiple of ${UNIFORM_ALIGNMENT}; WGSL rounds a uniform struct up to that`,
    );
  }

  // occupancy[i] is the index of the field owning byte i, or -1.
  const owner = new Int32Array(Math.max(layout.sizeBytes, 0)).fill(-1);

  layout.fields.forEach((field, index) => {
    const spec = FIELD_SPECS[field.type];
    if (!Number.isInteger(field.offset) || field.offset < 0) {
      problems.push(`${describe(field)}: offset is not a non-negative integer`);
      return;
    }
    if (field.offset % spec.align !== 0) {
      problems.push(
        `${describe(field)}: ${field.type} requires ${spec.align}-byte alignment`,
      );
      return;
    }
    if (field.offset + spec.size > layout.sizeBytes) {
      problems.push(
        `${describe(field)}: extends past the declared size ${layout.sizeBytes}`,
      );
      return;
    }
    for (let byte = field.offset; byte < field.offset + spec.size; byte += 1) {
      const previous = owner[byte];
      if (previous !== undefined && previous >= 0) {
        const other = layout.fields[previous];
        problems.push(
          `${describe(field)}: overlaps ${other === undefined ? "an earlier field" : describe(other)} at byte ${byte}`,
        );
        return;
      }
      owner[byte] = index;
    }
  });

  if (problems.length > 0) {
    log.error("uniform layout rejected", { pass: label, problems: problems.join("; ") });
    throw new UniformLayoutError(
      `uniform layout for ${label} is invalid: ${problems.join("; ")}`,
    );
  }

  log.debug("uniform layout validated", {
    pass: label,
    bytes: layout.sizeBytes,
    fields: layout.fields.length,
  });
}

/**
 * Everything a uniform field may be filled from.
 *
 * `paramTypes` is needed only for enum parameters, whose document value is a
 * string and whose numeric form is its position in the descriptor's `values`
 * list. It is passed as a map rather than looked up from a global registry so
 * the packer stays a pure function — the determinism tests render the same
 * frame in two workers and compare bytes, and a packer reading ambient state
 * would make that comparison meaningless.
 */
export interface UniformContext {
  readonly params: Readonly<Record<string, ParameterValue>>;
  readonly paramTypes: ReadonlyMap<string, ParamDescriptor>;
  /** The extent the pass reads. */
  readonly width: number;
  readonly height: number;
  /**
   * The extent the pass writes, when a {@link PassExtent} makes it different.
   *
   * Optional, and absent means "the same as the input", which is what every
   * pass in the catalogue but a resampler means. Optional rather than required
   * because making it required would have edited 48 effect modules to restate a
   * number they already pass.
   */
  readonly outputWidth?: number;
  readonly outputHeight?: number;
  /** `frame / clock.frames`; never reaches 1, so a shader animating on it loops. */
  readonly normalizedTime: number;
  /** The node's resolved document seed. */
  readonly seed: number;
  readonly paletteSize: number;
}

function resolveBuiltin(field: UniformField, ctx: UniformContext): readonly number[] {
  if (field.source.kind !== "builtin") {
    throw new UniformPackError("resolveBuiltin called on a param field");
  }
  switch (field.source.name) {
    case "width":
      return [ctx.width];
    case "height":
      return [ctx.height];
    case "output-width":
      return [ctx.outputWidth ?? ctx.width];
    case "output-height":
      return [ctx.outputHeight ?? ctx.height];
    case "normalized-time":
      return [ctx.normalizedTime];
    case "seed":
      return [ctx.seed];
    case "palette-size":
      return [ctx.paletteSize];
  }
}

function resolveParam(field: UniformField, ctx: UniformContext): readonly number[] {
  if (field.source.kind !== "param") {
    throw new UniformPackError("resolveParam called on a builtin field");
  }
  const key = field.source.key;
  const value = ctx.params[key];
  if (value === undefined) {
    throw new UniformPackError(
      `${describe(field)}: no value for parameter "${key}" on this node`,
    );
  }
  if (typeof value === "number") return [value];
  if (typeof value === "boolean") return [value ? 1 : 0];

  // The two composite `ParameterValue` members are refused by name rather than
  // guessed at. Both refusals are the honest answer to a question nobody has
  // decided yet, and both name where the answer would go.
  if (Array.isArray(value)) {
    const descriptor = ctx.paramTypes.get(key);
    if (descriptor?.type === "curve") {
      // A curve is 2..N control points and a shader wants a resampled LUT. That
      // is bulk data per node, which is what an `instance-data` binding is for
      // (F-PP-05); flattening the points into a uniform block would make the
      // block's size depend on the document.
      throw new UniformPackError(
        `${describe(field)}: parameter "${key}" is a curve, which does not go in a uniform block — declare an instance-data binding and build the LUT there`,
      );
    }
    throw new UniformPackError(
      `${describe(field)}: parameter "${key}" is a ${descriptor?.type ?? "composite"} value, and this packer writes scalars and vectors of scalars only; nothing decides here whether an sRGB triplet reaches a shader as 0..255, 0..1 or linear light, and guessing is a look decision taken by accident`,
    );
  }

  // A string value is an enum, and its numeric form is its ordinal. The
  // descriptor is the only thing that knows the order, so without it the value
  // is refused rather than guessed.
  const descriptor = ctx.paramTypes.get(key);
  if (descriptor === undefined) {
    throw new UniformPackError(
      `${describe(field)}: value is the string "${value}" and no registry descriptor was supplied to resolve it`,
    );
  }
  if (descriptor.type !== "enum") {
    throw new UniformPackError(
      `${describe(field)}: parameter is declared "${descriptor.type}" but holds the string "${value}"`,
    );
  }
  const ordinal = descriptor.values.findIndex((option) => option.value === value);
  if (ordinal < 0) {
    throw new UniformPackError(
      `${describe(field)}: "${value}" is not one of the declared enum values`,
    );
  }
  // Shaders see the ordinal, so enum values are append-only: inserting one in
  // the middle silently renumbers every document already saved.
  return [ordinal];
}

function writeComponents(
  view: DataView,
  field: UniformField,
  spec: FieldSpec,
  components: readonly number[],
): void {
  for (let i = 0; i < spec.components; i += 1) {
    const value = components[i];
    if (value === undefined || !Number.isFinite(value)) {
      throw new UniformPackError(
        `${describe(field)}: component ${i} is ${String(value)}, which is not a finite number`,
      );
    }
    const at = field.offset + i * 4;
    // Little-endian explicitly. WebGPU buffer contents are host-endian and every
    // platform WebGPU ships on is little-endian, but writing the flag out means
    // the assumption is stated rather than inherited from a default.
    switch (spec.scalar) {
      case "f32":
        view.setFloat32(at, value, true);
        break;
      case "i32":
        if (!Number.isInteger(value)) {
          throw new UniformPackError(
            `${describe(field)}: ${value} is not an integer; an i32 field would truncate it silently`,
          );
        }
        view.setInt32(at, value, true);
        break;
      case "u32":
        if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
          throw new UniformPackError(
            `${describe(field)}: ${value} is not a 32-bit unsigned integer`,
          );
        }
        view.setUint32(at, value, true);
        break;
    }
  }
}

/**
 * Pack one node's parameters into the bytes the shader reads.
 *
 * The layout is validated first every time. It is cheap — a few dozen integer
 * comparisons — and it is the only thing standing between a mistyped offset and
 * an image that is subtly wrong for a week.
 */
export function packUniforms(
  label: string,
  layout: UniformLayout,
  ctx: UniformContext,
): ArrayBuffer {
  validateUniformLayout(label, layout);

  const buffer = new ArrayBuffer(layout.sizeBytes);
  const view = new DataView(buffer);

  for (const field of layout.fields) {
    const spec = FIELD_SPECS[field.type];
    const components =
      field.source.kind === "builtin" ? resolveBuiltin(field, ctx) : resolveParam(field, ctx);

    if (components.length !== spec.components) {
      throw new UniformPackError(
        `${describe(field)}: source produced ${components.length} component(s), ${field.type} needs ${spec.components}`,
      );
    }
    writeComponents(view, field, spec, components);
  }

  return buffer;
}

/** Byte size a `UniformFieldType` occupies. Exported for layout authors. */
export function uniformFieldSize(type: UniformFieldType): number {
  return FIELD_SPECS[type].size;
}

/** WGSL alignment a `UniformFieldType` requires in the uniform address space. */
export function uniformFieldAlignment(type: UniformFieldType): number {
  return FIELD_SPECS[type].align;
}
