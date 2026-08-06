# WGSL conventions

Roughly 48 of the 63 effects run as WebGPU compute passes. Five of them exist so
far; the rest are added against the rules below. They are rules rather than
suggestions because the alternative is 48 shaders that each need to be read
before they can be bound.

The contract these implement is `web/src/types/gpu.ts`. Read it first.

---

## One file per effect

`web/src/shaders/<effect-id>.wgsl`, where `<effect-id>` is the registry
descriptor's `id` — `bayer-8.wgsl`, `halftone-cmyk.wgsl`. A multi-pass effect
keeps all its passes in that one file with one entry point each.

The file is imported with Vite's `?raw` query and handed to the pass compiler
verbatim:

```ts
import wgsl from "../../shaders/bayer-8.wgsl?raw";
```

## No includes, no assembly

**The WGSL is complete and constant.** Nothing is concatenated, templated or
substituted at runtime. Two things depend on that:

- a module is compiled once and cached by `ComputePass.id`, which is what keeps
  a slider drag from recompiling a shader every frame;
- a compilation error names a line in a real file, which is what makes
  `getCompilationInfo()` worth reading.

The cost is duplication: the OKLab conversion and the palette search are copied
into every shader that quantizes. That is deliberate. Blocks that are shared
are fenced so the copies can be diffed mechanically:

```wgsl
// --- shared: linear -> OKLab (keep identical across shaders) -------------
...
// --- end shared ---------------------------------------------------------
```

If the duplication ever becomes the thing that breaks, the fix is a build-time
include step that rewrites line numbers, not runtime string assembly — and it is
a decision to take deliberately rather than by drift.

## Bind group 0, fixed role numbering

All bindings sit in group 0, and **the binding number of a role is the same in
every shader**, so any shader can be read without cross-referencing its
descriptor. An effect omits the roles it does not use; the numbers do not close
up.

| Binding | Role | WGSL declaration |
| --- | --- | --- |
| 0 | `input-color` | `var src : texture_2d<f32>` |
| 1 | `output-color` | `var dst : texture_storage_2d<rgba16float, write>` |
| 2 | `input-index` | `var src_index : texture_2d<u32>` |
| 3 | `output-index` | `var dst_index : texture_storage_2d<r32uint, write>` |
| 4 | `palette` | `var<storage, read> palette : PaletteData` |
| 5 | `uniforms` | `var<uniform> params : Params` |
| 6… | `table`, `scratch` | effect-specific, in declaration order |

Colour is read with `textureLoad`, never sampled: the working format is
linear-light `rgba16float` and every access is at integer coordinates, so no
sampler and no filtering is involved.

Input and output are always different textures. `PassAccess` permits a
`pointwise` pass to alias them, but WebGPU does not: one texture cannot be bound
as both a sampled texture and a writable storage texture in a single dispatch,
and `rgba16float` has no read-write storage access. The scheduler ping-pongs
instead (`web/src/gpu/resources.ts`).

## The palette buffer

```wgsl
struct PaletteEntry {
  linear : vec4<f32>,   // linear light, what gets written out
  match_ : vec4<f32>,   // coordinates the metric measures in
};

struct PaletteData {
  count   : u32,
  metric  : u32,        // 0 = OKLab, 1 = sRGB Euclidean
  pad0    : u32,
  pad1    : u32,
  entries : array<PaletteEntry>,
};
```

`match_` is precomputed on the CPU, so a shader converts only its own pixel per
invocation instead of the pixel and every palette entry. `metric` travels in the
buffer rather than in the uniform block because it is a property of the palette,
not of the node — a palette swap cannot leave a stale metric behind, and no
effect has to declare a uniform field for it.

`match` is a WGSL reserved word; the trailing underscore is not decoration.

## Uniforms

The uniform block's field offsets are declared in TypeScript
(`UniformLayout.fields`) and restated as a `struct Params` here. **The two must
agree byte for byte.** WGSL's uniform address space is std140-like — a `vec3f`
occupies 12 bytes but aligns to 16, and the struct rounds up to 16 — so a field
written one byte off produces a wrong-looking image and no error anywhere.

Two habits keep them honest:

- Explicit `pad0`, `pad1`, … members so the struct's size is visible in the
  file rather than inferred from a rounding rule.
- Scalars grouped so no padding is implicit. Put `u32`/`f32` fields in runs and
  vectors on 16-byte boundaries.

`web/src/gpu/uniforms.ts` validates alignment, overlap and total size and throws
naming the field. It runs on every pack; it costs a few dozen integer
comparisons.

Builtins the compiler supplies — `width`, `height`, `normalized-time`, `seed`,
`palette-size` — are declared in the layout like any other field. **Animated
parameters do not read `normalized-time`**: a bound parameter arrives as the
concrete number the modulator produced, so an animating shader reads the same
field it always did.

## Dispatch and bounds

`@workgroup_size(8, 8, 1)` for per-pixel passes: 64 invocations, comfortably
under the 256 that `MAX_PORTABLE_WORKGROUP_INVOCATIONS` guarantees everywhere.
Per-row and per-column passes use `@workgroup_size(64, 1, 1)`.

Every per-pixel entry point starts with the bounds check, because the dispatch
is rounded up to whole workgroups:

```wgsl
if (gid.x >= params.width || gid.y >= params.height) {
  return;
}
```

## Determinism

**No unseeded randomness, ever.** A shader that needs noise derives it from the
`seed` builtin and the pixel coordinate — never from a clock, a frame counter
used as an entropy source, or a hash of `normalized-time` alone. Animation noise
must be periodic in the loop length, or the loop seam test fails and the export
is refused.

## Colour

Everything is linear light. sRGB transfer is removed on load and reapplied on
export, and nothing in between converts. Where a shader needs a perceptual
space it converts to OKLab with the coefficients in `core/.../color.rs` — the
copies in `web/src/gpu/resources.ts` and in each shader are the same numbers,
and they have to be, or the CPU and GPU halves of one stack pick different
palette entries at the boundaries and the seam shows.
