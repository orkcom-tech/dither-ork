/**
 * The shared SDF block, checked against every copy of it.
 *
 * `shaders/CONVENTIONS.md` states the rule the whole shader layer runs on:
 * **the WGSL is complete and constant**, so nothing is concatenated or
 * templated at runtime, and the cost of that is duplication of the blocks
 * several shaders need. The convention asks for those blocks to be fenced "so
 * the copies can be diffed mechanically". Nothing had been diffing them, and
 * the file says out loud what that cost — the seeded hash exists in four
 * variants, "each self-consistent within its own group".
 *
 * This is that diff, automated, for the block F-INF-01 introduces. A shader
 * that carries the fence and has drifted fails here rather than in a picture
 * nobody can attribute, and a shader that pastes the block without the fence is
 * caught too — the check runs over the text, not over a list of files somebody
 * has to remember to extend.
 */

import { describe, expect, it } from "vitest";

import {
  SDF_FENCE_CLOSE,
  SDF_FENCE_OPEN,
  SDF_JFA_LEVELS,
  SDF_MASK_SMOOTH_MAX,
  SDF_MASK_SOURCES,
  SDF_SEED_BYTES_PER_PIXEL,
  SDF_SEED_ENTRY_POINT,
  SDF_SHAPES,
  SDF_SMOOTH_ENTRY_POINTS,
  SDF_TRANSFORM_BINDING,
  SDF_TRANSFORM_BINDINGS,
  SDF_TRANSFORM_FENCE_CLOSE,
  SDF_TRANSFORM_FENCE_OPEN,
  SDF_TRANSFORM_UNIFORM_BYTES,
  SDF_TRANSFORM_WGSL,
  SDF_WGSL,
  sdfJfaEntryPoint,
  sdfMaskSourceOrdinal,
  sdfShapeOrdinal,
  sdfTransformPasses,
  sdfTransformUniformFields,
} from "./sdf";

/** Every shader the build ships, by file name. */
const SHADERS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(
    import.meta.glob("../shaders/*.wgsl", { eager: true, query: "?raw", import: "default" }),
  ).map(([path, source]) => [path.replace(/^.*\//, ""), source as string]),
);

/**
 * The text between the SDF fences, or `null` when this shader does not carry
 * the block.
 *
 * The closing fence is the generic one every shared block in this repository
 * uses, so it is found relative to the opening one rather than searched for
 * globally — a shader may hold several blocks, and the first `--- end shared`
 * after the opening fence is this block's.
 */
function blockBetween(source: string, open: string, close: string): string | null {
  const start = source.indexOf(open);
  if (start < 0) return null;
  const after = start + open.length;
  const end = source.indexOf(close, after);
  expect(
    end,
    `a shader opens an SDF fence and never closes it; the block has no end to diff against`,
  ).toBeGreaterThan(after);
  return source.slice(after, end).trim();
}

function fencedBlock(source: string): string | null {
  return blockBetween(source, SDF_FENCE_OPEN, SDF_FENCE_CLOSE);
}

function transformBlock(source: string): string | null {
  return blockBetween(source, SDF_TRANSFORM_FENCE_OPEN, SDF_TRANSFORM_FENCE_CLOSE);
}

describe("the shared signed distance field block", () => {
  it("is carried by at least one shader", () => {
    // If nothing carries it, the diff below passes vacuously and the canonical
    // text could rot untouched. The count is not asserted — shaders will adopt
    // it — but its being non-zero is what makes the rest of this file mean
    // something.
    const carriers = Object.entries(SHADERS).filter(([, source]) => fencedBlock(source) !== null);
    expect(carriers.map(([name]) => name)).toContain("gen-shape.wgsl");
  });

  it("is byte-identical in every shader that carries it", () => {
    const canonical = SDF_WGSL.trim();
    for (const [name, source] of Object.entries(SHADERS)) {
      const block = fencedBlock(source);
      if (block === null) continue;
      expect(block, `${name} has drifted from the canonical SDF block in gpu/sdf.ts`).toBe(
        canonical,
      );
    }
  });

  it("is not pasted into a shader without the fence", () => {
    // The check above can only see fenced copies. This is what stops the block
    // arriving unfenced, where it would drift silently: every shader
    // *declaring* one of the block's functions must also declare the fence.
    const marker = "fn sdf_shape(";
    for (const [name, source] of Object.entries(SHADERS)) {
      if (!source.includes(marker)) continue;
      expect(
        source.includes(SDF_FENCE_OPEN),
        `${name} declares ${marker} but does not open the SDF fence, so no diff can reach it`,
      ).toBe(true);
    }
  });

  it("numbers the shapes the same way the shader does", () => {
    // The ordinal a shape crosses to a shader as is its position in
    // SDF_SHAPES, and the block restates that numbering as a `const` list.
    // Two hand-written numberings would agree until somebody added a shape.
    for (const shape of SDF_SHAPES) {
      const ordinal = sdfShapeOrdinal(shape);
      expect(ordinal).toBeGreaterThanOrEqual(0);
      const name = `SDF_SHAPE_${shape.toUpperCase()}`;
      expect(SDF_WGSL, `${name} is not declared in the shared block`).toContain(
        `const ${name}${" ".repeat(Math.max(1, 10 - shape.length))}: u32 = ${ordinal}u;`,
      );
    }
  });

  it("returns a distance in texels with the stated sign", () => {
    // Not executable here — this is WGSL — so what is asserted is the contract
    // the consumers were written against, in the one place a reader would look
    // for it. The behaviour itself is measured in the browser.
    expect(SDF_WGSL).toContain("negative inside the shape");
  });
});

/**
 * The transform half (F-INF-01's second producer).
 *
 * Same job as the block above and four more things to check, because this block
 * is not just functions: it declares entry points, it reads two storage buffers
 * at fixed binding numbers, and it reads three uniform fields by name out of a
 * struct it does not own. Every one of those is a way for a carrier and the
 * canonical text to disagree silently.
 */
describe("the shared signed distance transform block", () => {
  it("is carried by at least one shader", () => {
    const carriers = Object.entries(SHADERS).filter(
      ([, source]) => transformBlock(source) !== null,
    );
    expect(carriers.map(([name]) => name)).toContain("wave-field.wgsl");
  });

  it("is byte-identical in every shader that carries it", () => {
    const canonical = SDF_TRANSFORM_WGSL.trim();
    for (const [name, source] of Object.entries(SHADERS)) {
      const block = transformBlock(source);
      if (block === null) continue;
      expect(
        block,
        `${name} has drifted from the canonical SDF transform block in gpu/sdf.ts`,
      ).toBe(canonical);
    }
  });

  it("is not pasted into a shader without the fence", () => {
    const marker = "fn sdf_field(";
    for (const [name, source] of Object.entries(SHADERS)) {
      if (!source.includes(marker)) continue;
      expect(
        source.includes(SDF_TRANSFORM_FENCE_OPEN),
        `${name} declares ${marker} but does not open the SDF transform fence, so no diff can reach it`,
      ).toBe(true);
    }
  });

  it("numbers the mask sources the same way the shader does", () => {
    for (const source of SDF_MASK_SOURCES) {
      const name = `SDF_MASK_${source.toUpperCase()}`;
      expect(
        SDF_TRANSFORM_WGSL,
        `${name} is not declared in the transform block`,
      ).toContain(`const ${name}`);
      expect(SDF_TRANSFORM_WGSL).toMatch(
        new RegExp(`const ${name}\\s+: u32 = ${sdfMaskSourceOrdinal(source)}u;`),
      );
    }
  });

  it("declares the smoothing pair the schedule dispatches", () => {
    for (const entry of SDF_SMOOTH_ENTRY_POINTS) {
      expect(SDF_TRANSFORM_WGSL, `${entry} is scheduled but not declared`).toContain(
        `fn ${entry}(`,
      );
    }
    // Radius 0 has to be the identity, or a consumer that wants the raw
    // threshold cannot ask for it. `2 * 0 + 1` is a window of one.
    expect(SDF_TRANSFORM_WGSL).toContain("let n = f32(2 * r + 1);");
    // The threshold is taken on the smoothed buffer, never on the texture. This
    // is the whole of "a subject is a shape, not a texel's brightness".
    expect(SDF_TRANSFORM_WGSL).toMatch(
      /fn sdf_subject\(p : vec2<i32>\) -> bool \{\s*\n\s*let inside = sdf_mask\[/,
    );
  });

  it("declares one entry point per flood level, and no more", () => {
    for (let level = 0; level < SDF_JFA_LEVELS; level += 1) {
      expect(
        SDF_TRANSFORM_WGSL,
        `${sdfJfaEntryPoint(level)} is scheduled but not declared`,
      ).toContain(`fn ${sdfJfaEntryPoint(level)}(`);
    }
    // An entry point the schedule does not reach is a level that silently never
    // runs, which is a field that is one round short everywhere.
    const declared = SDF_TRANSFORM_WGSL.match(/fn sdf_jfa_\d\d\(/g) ?? [];
    expect(declared).toHaveLength(SDF_JFA_LEVELS);
    expect(SDF_TRANSFORM_WGSL).toContain(`fn ${SDF_SEED_ENTRY_POINT}(`);
  });

  it("alternates the ping-pong so the answer lands where sdf_field reads it", () => {
    // The one bug in this construction that produces a plausible picture: an
    // even level count leaves the flood's last write in buffer A while
    // `sdf_field` reads B, so the field is one round out of date everywhere.
    expect(SDF_JFA_LEVELS % 2).toBe(1);
    expect(SDF_TRANSFORM_WGSL).toContain("fn sdf_field(");
    expect(SDF_TRANSFORM_WGSL).toMatch(/fn sdf_field\([^)]*\)[^{]*\{[^}]*sdf_seed_b/);

    for (let level = 0; level < SDF_JFA_LEVELS; level += 1) {
      const body = new RegExp(
        `fn ${sdfJfaEntryPoint(level)}\\([\\s\\S]*?sdf_jfa\\([^;]*?, ${level}u, (true|false)\\)`,
      ).exec(SDF_TRANSFORM_WGSL);
      expect(body, `${sdfJfaEntryPoint(level)} does not call sdf_jfa with its own level`)
        .not.toBeNull();
      // Even levels read A, odd read B. Written out rather than derived, so
      // that a hand-edited entry point disagreeing with the schedule fails.
      expect(body?.[1], `${sdfJfaEntryPoint(level)} reads the wrong buffer`).toBe(
        level % 2 === 0 ? "true" : "false",
      );
    }
  });

  it("declares the two seed buffers at the bindings the block hard-codes", () => {
    const carrier = SHADERS["wave-field.wgsl"] ?? "";
    expect(carrier).toContain(
      `@group(0) @binding(${SDF_TRANSFORM_BINDING.seedA}) var<storage, read_write> sdf_seed_a : array<u32>;`,
    );
    expect(carrier).toContain(
      `@group(0) @binding(${SDF_TRANSFORM_BINDING.seedB}) var<storage, read_write> sdf_seed_b : array<u32>;`,
    );
    for (const binding of SDF_TRANSFORM_BINDINGS) {
      expect(binding.role).toBe("scratch");
      if (binding.role !== "scratch") continue;
      // Both read-write in every pass: one WGSL declaration per variable, and a
      // shader's access mode has to match the layout's buffer type everywhere.
      expect(binding.access).toBe("read-write");
      expect(binding.size).toEqual({
        kind: "per-pixel",
        bytesPerPixel: SDF_SEED_BYTES_PER_PIXEL,
      });
    }
  });

  it("requires of a carrier the three uniform fields it reads by name", () => {
    const fields = sdfTransformUniformFields(64, {
      source: "maskSource",
      threshold: "maskThreshold",
      invert: "maskInvert",
      smooth: "maskSmoothing",
    });
    expect(fields.map((f) => f.offset)).toEqual([64, 68, 72, 76]);
    expect(fields.map((f) => f.type)).toEqual(["u32", "f32", "u32", "f32"]);
    expect(fields.at(-1)!.offset + 4 - 64).toBe(SDF_TRANSFORM_UNIFORM_BYTES);

    // The names the block hard-codes. A carrier renaming one of these compiles
    // to nothing here and fails in the browser at pipeline creation.
    for (const member of [
      "params.sdf_source",
      "params.sdf_threshold",
      "params.sdf_invert",
      "params.sdf_smooth",
    ]) {
      expect(SDF_TRANSFORM_WGSL).toContain(member);
    }
    // The shader clamps to the same ceiling the descriptor's legal range has to
    // declare; the running sum's precision argument depends on both.
    expect(SDF_TRANSFORM_WGSL).toContain(`clamp(params.sdf_smooth, 0.0, ${SDF_MASK_SMOOTH_MAX}.0)`);
    expect(() =>
      sdfTransformUniformFields(3, { source: "a", threshold: "b", invert: "c", smooth: "d" }),
    ).toThrow(/multiple of 4/);
  });

  it("schedules a seed pass and one pass per level, in that order", () => {
    const passes = sdfTransformPasses({
      effect: "test-effect",
      wgsl: "// not compiled here",
      uniforms: { sizeBytes: 16, fields: [] },
    });
    // Two smoothing passes, the seed, then the flood.
    expect(passes).toHaveLength(SDF_JFA_LEVELS + 3);
    expect(passes[0]?.entryPoint).toBe(SDF_SMOOTH_ENTRY_POINTS[0]);
    expect(passes[1]?.entryPoint).toBe(SDF_SMOOTH_ENTRY_POINTS[1]);
    expect(passes[2]?.entryPoint).toBe(SDF_SEED_ENTRY_POINT);
    // The smoothing is separable and runs one invocation per line, which is what
    // makes it O(1) per texel at any radius.
    expect(passes[0]?.dispatch).toEqual({ kind: "per-row" });
    expect(passes[1]?.dispatch).toEqual({ kind: "per-column" });
    expect(passes.map((p) => p.id).every((id) => id.startsWith("test-effect/"))).toBe(true);
    // Ids are unique across the whole GPU layer; the module cache keys on them.
    expect(new Set(passes.map((p) => p.id)).size).toBe(passes.length);

    for (let level = 0; level < SDF_JFA_LEVELS; level += 1) {
      expect(passes[level + 3]?.entryPoint).toBe(sdfJfaEntryPoint(level));
    }

    // Exactly one pass reads the picture, and it is the first. Everything after
    // it reads buffers — which is not tidiness: `gpu/compiler.ts` reads the
    // first `input-color` binding to decide which pass reads the node's input,
    // and a later one would move that answer.
    expect(passes[0]?.bindings.some((b) => b.role === "input-color")).toBe(true);
    for (const pass of passes.slice(1)) {
      expect(pass.bindings.some((b) => b.role === "input-color")).toBe(false);
    }
    // None of them writes a colour surface, so the node's own draw pass still
    // reads the node's input.
    for (const pass of passes) {
      expect(pass.bindings.some((b) => b.role === "output-color")).toBe(false);
    }
  });
});
