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

import { SDF_FENCE_CLOSE, SDF_FENCE_OPEN, SDF_SHAPES, SDF_WGSL, sdfShapeOrdinal } from "./sdf";

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
function fencedBlock(source: string): string | null {
  const start = source.indexOf(SDF_FENCE_OPEN);
  if (start < 0) return null;
  const after = start + SDF_FENCE_OPEN.length;
  const end = source.indexOf(SDF_FENCE_CLOSE, after);
  expect(
    end,
    `a shader opens the SDF fence and never closes it; the block has no end to diff against`,
  ).toBeGreaterThan(after);
  return source.slice(after, end).trim();
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
