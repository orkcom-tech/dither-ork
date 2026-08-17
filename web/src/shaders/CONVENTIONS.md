# WGSL conventions

58 of the catalogue's 73 effects run as WebGPU compute passes, and all 58 exist.
They are rules rather than suggestions because the alternative is 53 shaders
that each need to be read before they can be bound.

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

The blocks that exist, and what each one is:

| Fence name | Shaders | Contents |
| --- | --- | --- |
| `colour and palette search` | 12 | OKLab/sRGB metric, nearest-entry search over `PaletteData` |
| `clamped texel fetch` | 5 | `load_clamped`; clamp-to-edge, because out-of-bounds `textureLoad` returns zero and an unclamped kernel darkens a frame one radius wide |
| `linear -> sRGB transfer` and friends | 10 | the transfer function, both directions |
| `perceptual lightness` / `Rec.709 luminance` | 8 | `rec709_luminance`, `perceptual_lightness` (cube root), `lightness_to_linear_grey` (its exact inverse) |
| `gaussian kernel geometry` | 3 | tap count, sigma = radius/3, weight; the truncation renormalises so a flat field survives at any radius |
| `halftone dot areas` | 2 | closed-form dot area per shape; what makes a screen reproduce tone with no per-shape correction curve |
| `edge handling` | 4 | clamp / wrap / mirror for the displacement effects |
| `bilinear fetch` | 2 | fractional sampling written out, since there is no sampler on this path |
| `seeded hash` / `seeded hashing` / `integer hash` | 10 | a PCG-style integer hash plus `hash2`/`hash3`/`hash01` |
| `analytic signed distance fields` | 1 | F-INF-01's closed-form primitives and their gradient |
| `signed distance transform of the picture` | 1 | F-INF-01's other producer: subject mask, boundary seed, jump flood, and the read |

The two SDF blocks are the ones with a real diff behind them:
`web/src/gpu/sdf.ts` holds the canonical text and `sdf.test.ts` compares every
fenced copy against it byte for byte, so "keep identical across shaders" is a
check rather than a request. The transform block is also the only shared block
that declares **entry points and bindings** rather than only functions — it
claims bindings 6, 7 and 8, so a carrier's own scratch starts at 9, and it reads
`params.sdf_source`, `params.sdf_threshold`, `params.sdf_invert` and
`params.sdf_smooth` by name out of a struct it does not own. Build the offsets
with `sdfTransformUniformFields` rather than by hand.

**The hash is the one that drifted.** Those three fence names hold three
different implementations — each self-consistent within its own group, plus a
fourth unfenced copy in `datamosh-smear.wgsl`. Every one of them is a
deterministic function of pixel and seed, so no determinism rule is broken and
no picture is wrong; but it is one thing written four ways and a new shader
should not add a fifth. Copy the five-shader `seeded hash` block.

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
field it always did. No shader in the catalogue declares `normalized-time`, and
that is the rule working rather than an omission.

`seed` is likewise unused as a builtin: the eleven stochastic effects each
declare an explicit `seed` **parameter** instead, which is what
`web/src/types/registry.ts` says the glitch family should do — the seed is a
control the user turns, not ambient state. The builtin stays for a node that
needs the document seed without exposing one.

## Enums cross as ordinals

A shader receives an enum parameter as its **position in the descriptor's
`values` list**, restated at the top of the WGSL as a `const` block:

```wgsl
const SHAPE_ROUND   : u32 = 0u;
const SHAPE_SQUARE  : u32 = 1u;
```

Both sides therefore state the same fact, and both state the consequence: the
list is **append-only**. Inserting a value in the middle renumbers every
document already saved, and each of them then renders a different picture.

A `switch` over the ordinals still needs a `default` arm because WGSL requires
one. Write it as the last real case rather than as a catch-all: the packer
refuses anything that is not a declared value, so no other ordinal can arrive,
and a `default` that returns a neutral value would be a fallback branch for a
condition that cannot occur.

## Angles are in turns

Anything a modulator might bind to — tile rotation, emboss light angle, drag
angle, spiral rotation — is expressed in **turns**, not degrees or radians. A
parameter ramping 0 → 1 then lands exactly where it started, so an animated
rotation closes the loop by construction and the UI never has to know that 360
is special.

The halftone family's **screen angles are the exception and are in degrees**,
because 15 / 75 / 0 / 45 is the requirement's wording and a printer's, and
rewriting it as fractions of a turn would make the one number anybody checks
unrecognisable.

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
