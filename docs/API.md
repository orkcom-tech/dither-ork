# API

Contracts between the layers. Four surfaces: the WASM core, the node registry,
the `.dork` document, and the worker RPC.

Items marked **planned** are specified but not yet implemented in the scaffold.

---

## 1. WASM core

Compiled from `core/crates/dither-wasm`, generated into `web/src/wasm/pkg` by
the `wasm` compose service. Import and initialise before any other call:

```ts
import init, * as core from "./wasm/pkg/dither_wasm.js";
await init();
```

### `version(): string`

Version of the compiled core. Logged at startup so a stale WASM build is
visible rather than mysterious.

### `kernel_ids(): string`

Newline-separated ids of every registered error-diffusion kernel. The web layer
builds its effect list from this rather than keeping a parallel copy that can
drift out of sync.

```ts
const kernels = core.kernel_ids().split("\n").filter(Boolean);
// ["floyd-steinberg", "atkinson"]
```

### `dither_image(...): DitherOutput`

```ts
function dither_image(
  rgba: Uint8Array,        // 8-bit sRGB RGBA, width * height * 4 bytes
  width: number,
  height: number,
  palette_rgb: Uint8Array, // packed sRGB triplets, length % 3 === 0
  kernel_id: string,       // an id from kernel_ids()
  strength: number,        // 0..1; 0 is plain nearest-colour quantization
  serpentine: boolean,     // alternate scan direction per row
  metric: "oklab" | "srgb",
): DitherOutput;
```

Decodes to linear light, dithers, re-encodes to sRGB.

Throws (rejects) rather than panicking on bad input — a malformed call surfaces
as a JS error instead of an aborted WASM instance. Error cases: buffer length
mismatch, empty or misaligned palette, unknown kernel id, unknown metric.

**`metric` is a look control, not a correctness switch.** `oklab` is
perceptually correct; `srgb` reproduces what period-accurate tools did by doing
the maths in gamma space.

### `DitherOutput`

| Member | Type | Notes |
| --- | --- | --- |
| `width` | `number` | |
| `height` | `number` | |
| `pixels` | `Uint8Array` | 8-bit sRGB RGBA, ready for `ImageData` or a texture upload |
| `indices` | `Uint16Array` | one palette index per pixel |

Both buffers are returned deliberately. The **index map** is what makes
hue-targeted recolour, index remap, outline, dilate/erode and the SVG tracer
lossless and cheap; carrying it is a chosen memory cost.

Getters copy out of WASM memory. Read each one once and hold the result.

### Rust-side contract

`dither-core` has no web dependencies and must keep it that way — that boundary
is what makes a future native or CLI build a packaging exercise rather than a
rewrite.

```rust
pub fn dither(
    pixels: &[Rgba],          // linear light, unassociated alpha
    width: usize,
    height: usize,
    palette: &Palette,
    kernel: &Kernel,
    opts: Options,
) -> DitherResult;            // { pixels: Vec<Rgba>, indices: Vec<u16> }
```

Adding a kernel means adding a `Kernel` constant — an id, a name, a tap table
and a divisor — and listing it in `KERNELS`. No new code paths:

```rust
pub const FLOYD_STEINBERG: Kernel = Kernel {
    id: "floyd-steinberg",
    name: "Floyd-Steinberg",
    taps: &[tap!(1, 0, 7.0), tap!(-1, 1, 3.0), tap!(0, 1, 5.0), tap!(1, 1, 1.0)],
    divisor: 16.0,
};
```

Tap `dx` is mirrored automatically on right-to-left rows when serpentine
scanning is on, so tables are written exactly as published.

---

## 2. Node registry — **planned**

The registry is the single source of truth about effects. The UI builds its
effect list from it, the graph schedules from it, and the Surprise generator
samples from it. There is no second list anywhere.

```ts
interface EffectDescriptor {
  readonly id: string;                 // "floyd-steinberg", "halftone-cmyk"
  readonly name: string;
  readonly slot: "preprocess" | "dither" | "postprocess";
  readonly family: "error-diffusion" | "ordered" | "pattern" | "glitch" | "special";
  readonly execution: "wasm" | "gpu";
  readonly params: readonly ParamDescriptor[];
  /** Relative likelihood in Surprise Me. 1.0 is ordinary; niche effects sit lower. */
  readonly surpriseWeight: number;
}

interface ParamDescriptor {
  readonly key: string;
  readonly label: string;
  readonly type: "float" | "int" | "bool" | "enum";
  readonly legal: readonly [min: number, max: number];
  /**
   * The range Surprise Me samples. Narrower than `legal` on purpose — this is
   * what separates a usable random result from noise.
   */
  readonly surprise: readonly [min: number, max: number];
  readonly distribution: "uniform" | "log" | "normal";
  readonly default: number | boolean | string;
  readonly enumValues?: readonly string[];
  /** Whether a modulator or keyframe track may bind to it. */
  readonly animatable: boolean;
}
```

**Registry validation runs at build time.** A descriptor missing `surprise`,
`distribution` or `surpriseWeight` fails the build. That is what keeps Surprise
Me correct as effects are added, instead of degrading quietly.

---

## 3. `.dork` document

Defined in `web/src/types/document.ts`. A document is Source + Stack + Palette +
Clock + Bindings — the unit that is saved, shared by URL, applied across a
batch, and generated whole by Surprise Me.

```jsonc
{
  "schema": 1,
  "source": { "name": "photo.png", "width": 1600, "height": 1200 },
  "palette": {
    "id": "gameboy-dmg",
    "name": "Game Boy DMG",
    "colors": [8, 24, 32, 52, 104, 86, 136, 192, 112, 224, 248, 208],
    "metric": "oklab"
  },
  "clock": { "frames": 48, "fps": 24 },
  "stack": [
    {
      "id": "n1",
      "effect": "internal-resolution",
      "enabled": true,
      "opacity": 1,
      "blend": "normal",
      "params": { "factor": 4, "filter": "box" },
      "seed": 0
    },
    {
      "id": "n2",
      "effect": "floyd-steinberg",
      "enabled": true,
      "opacity": 1,
      "blend": "normal",
      "params": { "strength": 1, "serpentine": true },
      "seed": 991
    }
  ],
  "bindings": [
    {
      "nodeId": "n2",
      "param": "strength",
      "shape": "sine",
      "amount": 0.25,
      "cyclesPerLoop": 2,
      "phase": 0,
      "bipolar": true
    }
  ],
  "surpriseSeed": "7f3a1c92b04e5d68"
}
```

Rules that the schema encodes:

- **`colors` is packed sRGB triplets**, not hex strings — the same layout the
  WASM boundary takes, so no conversion sits between them.
- **`cyclesPerLoop` is an integer.** That single constraint is why frame `N`
  equals frame `0` and the loop closes without a crossfade. The UI snaps it; the
  loader rejects non-integers.
- **Every node carries a `seed`.** No node reads an unseeded RNG, which is what
  makes a document reproducible and the loop-seam test possible.
- **`source` is a reference, not the image.** The self-contained variant adds
  `source.dataUrl`. A share URL carries the recipe, never the picture.
- **`surpriseSeed`**, when present, reproduces the whole document exactly.

Normalized loop time:

```ts
normalizedTime(clock, frame) === (frame % clock.frames) / clock.frames  // never reaches 1
```

Documents are versioned. A newer `schema` than the build understands is
**refused**, not read on a best-effort basis.

---

## 4. Worker RPC — **planned**

Comlink interfaces. The main thread holds UI state only; it never renders.

```ts
interface RenderWorker {
  init(canvas: OffscreenCanvas): Promise<void>;
  setDocument(doc: DitherDocument): Promise<void>;
  /** Patch one parameter; invalidates that node and everything downstream. */
  setParam(nodeId: string, key: string, value: ParameterValue): Promise<void>;
  renderFrame(frame: number, quality: "preview" | "full"): Promise<RenderStats>;
  play(fps: number): Promise<void>;
  stop(): Promise<void>;
}

interface RenderStats {
  readonly frame: number;
  readonly ms: number;
  readonly nodesExecuted: number;
  readonly cacheHits: number;
  /** Bytes moved across the GPU/CPU boundary — the known perf ceiling. */
  readonly boundaryBytes: number;
}

interface ExportWorker {
  exportStill(doc: DitherDocument, format: StillFormat, scale: number): Promise<Blob>;
  exportAnimation(
    doc: DitherDocument,
    format: AnimatedFormat,
    scale: number,
    onProgress: (frame: number, total: number) => void,
  ): Promise<Blob>;
  exportVector(doc: DitherDocument, options: VectorOptions): Promise<Blob>;
  cancel(): Promise<void>;
}
```

`cancel()` actually stops the worker; it does not merely stop reporting.

Animated export re-evaluates only **bound** nodes per frame. Unbound nodes
render once and are reused across all frames.

---

## 5. Capability report

`web/src/lib/capabilities.ts`, implementing F-UI-12.

```ts
interface Capability {
  readonly id: "webgpu" | "sab" | "opfs" | "fsa";
  readonly label: string;
  readonly fatal: boolean;
  readonly state: "ok" | "missing";
  readonly detail: string;   // what this means for the user, one line
}

interface CapabilityReport {
  readonly capabilities: readonly Capability[];
  readonly fatalFailures: readonly Capability[];
  readonly usable: boolean;
  readonly adapterInfo?: GPUAdapterInfo;
}
```

| Capability | Fatal | On failure |
| --- | --- | --- |
| WebGPU | yes | unsupported screen naming the requirement |
| SharedArrayBuffer | yes | unsupported screen; in dev it means COOP/COEP are missing |
| OPFS | no | autosave and libraries fall back to IndexedDB |
| File System Access | no | batch degrades to multi-select in, ZIP out |

Non-fatal degradation is always **stated in the UI**. There are no silent
fallbacks.

---

## 6. Logging

`web/src/lib/log.ts`.

```ts
const log = logger("gpu", correlationId());
log.info("pass compiled", { effect: "bayer-8", ms: 1.4 });
await log.time("readback", () => device.queue.onSubmittedWorkDone());
```

Channels: `app`, `graph`, `gpu`, `wasm`, `export`, `batch`, `io`.
Levels: `debug`, `info`, `warn`, `error` — `debug` in dev, `info` in production.

`time()` logs duration on success **and** on failure, then rethrows. No error
path is silent and no `catch` is empty.
