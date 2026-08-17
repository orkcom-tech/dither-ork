import { describe, expect, it } from "vitest";

import type { ContentHash, CpuColorSurface } from "../types/graph";
import { DOCUMENT_SCHEMA_VERSION, type DitherDocument, type Palette } from "../types/document";
import type { SourceImage } from "../io";
import { createBatchRun, failuresOf } from "./run";
import { DEFAULT_BATCH_SETTINGS } from "./types";
import type {
  BatchInputFile,
  BatchOutput,
  BatchRenderPool,
  BatchRenderRequest,
  BatchRenderedFrame,
  BatchRunRequest,
  BatchSettings,
} from "./types";

/**
 * Everything below drives the real pipeline — the real queue transitions, the
 * real naming, the real `encodeExport` and the real ZIP writer — through the
 * four interfaces `types.ts` declares. Nothing here stands in for logic that
 * ships: the pool returns a picture instead of asking a GPU for one, and the
 * directory is a `Map` instead of a disk. That is the whole point of the
 * interfaces, and it is what makes F-BA-06's "one corrupt file must not kill
 * the run" a statement a test can make.
 */

const MONO: Palette = {
  id: "mono",
  name: "Mono",
  colors: [0, 0, 0, 255, 255, 255],
  metric: "oklab",
};

function documentOf(): DitherDocument {
  return {
    schema: DOCUMENT_SCHEMA_VERSION,
    source: null,
    stack: [],
    edges: [],
    output: null,
    palette: MONO,
    clock: { frames: 1, fps: 12 },
    bindings: [],
  };
}

function surface(pixels: number): CpuColorSurface {
  return {
    residency: "cpu",
    r: new Float32Array(pixels),
    g: new Float32Array(pixels),
    b: new Float32Array(pixels),
    a: new Float32Array(pixels).fill(1),
  };
}

function image(name: string, width: number, height: number): SourceImage {
  return {
    name,
    format: "png",
    width,
    height,
    surface: surface(width * height),
    hash: `hash:${name}` as ContentHash,
    byteLength: 4,
  };
}

function file(path: string, id = path): BatchInputFile {
  return { id, path, blob: new Blob([new Uint8Array([1, 2, 3])]), bytes: 3 };
}

/**
 * A frame of two colours, so `encodeExport` takes the indexed-PNG path and the
 * whole encoder runs rather than a corner of it.
 */
function frame(width: number, height: number): BatchRenderedFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const value = i % 2 === 0 ? 0 : 255;
    data[i * 4] = value;
    data[i * 4 + 1] = value;
    data[i * 4 + 2] = value;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

interface RecordingPool extends BatchRenderPool {
  readonly seen: readonly string[];
  readonly documents: readonly DitherDocument[];
}

function poolOf(size = 1, onRender?: (request: BatchRenderRequest) => void): RecordingPool {
  const seen: string[] = [];
  const documents: DitherDocument[] = [];
  return {
    size,
    seen,
    documents,
    tracer: {
      trace: () => {
        throw new Error("this test does not export SVG");
      },
    },
    async render(request: BatchRenderRequest): Promise<BatchRenderedFrame> {
      onRender?.(request);
      seen.push(request.image.name);
      documents.push(request.document);
      // A tick, so the lanes genuinely interleave rather than running to
      // completion one at a time inside a single microtask drain.
      await Promise.resolve();
      return frame(request.image.width, request.image.height);
    },
    dispose: () => Promise.resolve(),
  };
}

/** An in-memory directory: the same three calls a real handle answers. */
function directoryOf(): {
  readonly output: BatchOutput;
  readonly written: Map<string, Blob>;
} {
  const written = new Map<string, Blob>();
  const handle = {
    kind: "directory" as const,
    name: "out",
    getFileHandle(name: string): Promise<FileSystemFileHandle> {
      return Promise.resolve({
        kind: "file" as const,
        name,
        createWritable: () =>
          Promise.resolve({
            write: (blob: Blob) => {
              written.set(name, blob);
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
            abort: () => Promise.resolve(),
          } as unknown as FileSystemWritableFileStream),
      } as unknown as FileSystemFileHandle);
    },
  } as unknown as FileSystemDirectoryHandle;
  return { output: { kind: "directory", handle, name: "out" }, written };
}

/** An in-memory file handle, for the archive path. */
function archiveOf(): { readonly output: BatchOutput; read: () => Blob | null } {
  let blob: Blob | null = null;
  const handle = {
    kind: "file" as const,
    name: "batch.zip",
    createWritable: () =>
      Promise.resolve({
        write: (value: Blob) => {
          blob = value;
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
        abort: () => Promise.resolve(),
      } as unknown as FileSystemWritableFileStream),
  } as unknown as FileSystemFileHandle;
  return {
    output: {
      kind: "zip",
      destination: { kind: "file-system-access", handle },
      name: "batch.zip",
    },
    read: () => blob,
  };
}

const MODIFIED = new Date(Date.UTC(2021, 0, 2, 3, 4, 6));

function request(overrides: Partial<BatchRunRequest> = {}): BatchRunRequest {
  const items = overrides.items ?? [file("a.png"), file("b.png")];
  return {
    items,
    document: documentOf(),
    presetName: "study",
    settings: DEFAULT_BATCH_SETTINGS,
    output: directoryOf().output,
    pool: poolOf(),
    decode: (_blob, name) => Promise.resolve(image(name, 4, 4)),
    extractor: null,
    modifiedAt: MODIFIED,
    ...overrides,
  };
}

function settingsWith(patch: Partial<BatchSettings>): BatchSettings {
  return { ...DEFAULT_BATCH_SETTINGS, ...patch };
}

describe("createBatchRun", () => {
  it("applies one document to every image and writes one file each", async () => {
    const directory = directoryOf();
    const pool = poolOf();
    const run = createBatchRun(
      request({ output: directory.output, pool, items: [file("a.png"), file("b.png")] }),
    );

    const final = await run.start();

    expect(final.phase).toBe("finished");
    expect(final.done).toBe(2);
    expect(final.failed).toBe(0);
    expect(pool.seen).toEqual(["a.png", "b.png"]);
    expect([...directory.written.keys()]).toEqual(["a-dither.png", "b-dither.png"]);
    for (const item of final.items) {
      expect(item.state).toBe("done");
      expect(item.stage).toBe("finished");
      expect(item.width).toBe(4);
      expect(item.height).toBe(4);
      expect(item.outputBytes).toBeGreaterThan(0);
    }
  });

  it("hands each render the document with that image's source ref", async () => {
    const pool = poolOf();
    await createBatchRun(request({ pool })).start();
    expect(pool.documents.map((document) => document.source?.name)).toEqual([
      "a.png",
      "b.png",
    ]);
    // The recipe itself is untouched.
    for (const document of pool.documents) {
      expect(document.palette).toEqual(MONO);
      expect(document.stack).toEqual([]);
    }
  });

  it("keeps going when one file cannot be decoded, and says which and why", async () => {
    const directory = directoryOf();
    const run = createBatchRun(
      request({
        output: directory.output,
        items: [file("good-1.png"), file("broken.png"), file("good-2.png")],
        decode: (_blob, name) =>
          name === "broken.png"
            ? Promise.reject(new Error('"broken.png" is not an image this can open.'))
            : Promise.resolve(image(name, 4, 4)),
      }),
    );

    const final = await run.start();

    expect(final.phase).toBe("finished");
    expect(final.done).toBe(2);
    expect(final.failed).toBe(1);
    expect(final.failure).toBeNull();
    const failed = failuresOf(final.items);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.path).toBe("broken.png");
    expect(failed[0]?.error).toContain("not an image");
    // The two good ones were still written.
    expect([...directory.written.keys()]).toEqual(["good-1-dither.png", "good-2-dither.png"]);
  });

  it("keeps going when one render fails", async () => {
    const pool = poolOf(1, (item) => {
      if (item.image.name === "bad.png") throw new Error("the stack could not be honoured");
    });
    const final = await createBatchRun(
      request({ pool, items: [file("ok.png"), file("bad.png")] }),
    ).start();
    expect(final.done).toBe(1);
    expect(final.failed).toBe(1);
    expect(failuresOf(final.items)[0]?.error).toContain("could not be honoured");
  });

  it("refuses a second file that would overwrite the first, rather than overwriting it", async () => {
    const directory = directoryOf();
    const final = await createBatchRun(
      request({
        output: directory.output,
        // Distinct inputs, one output name: exactly the case `plan.ts` cannot
        // check when the template depends on the picture's own extent.
        items: [file("one/beach.png", "1"), file("two/beach.png", "2")],
        settings: settingsWith({ template: "{name}" }),
      }),
    ).start();

    expect(final.done).toBe(1);
    expect(final.failed).toBe(1);
    expect(directory.written.size).toBe(1);
    expect(failuresOf(final.items)[0]?.error).toContain("{index}");
  });

  it("uses the extractor's palette per image when asked, and never silently falls back", async () => {
    const pool = poolOf();
    const perImage: Palette = { id: "x", name: "X", colors: [1, 2, 3], metric: "srgb" };
    const final = await createBatchRun(
      request({
        pool,
        settings: settingsWith({ palette: "per-image" }),
        extractor: {
          detail: "test",
          extract: (source) =>
            Promise.resolve({ ...perImage, name: `X for ${source.name}` }),
        },
      }),
    ).start();

    expect(final.done).toBe(2);
    expect(pool.documents.map((document) => document.palette.name)).toEqual([
      "X for a.png",
      "X for b.png",
    ]);
  });

  it("fails every item rather than using the document palette when the extractor is missing", async () => {
    const final = await createBatchRun(
      request({ settings: settingsWith({ palette: "per-image" }), extractor: null }),
    ).start();
    expect(final.done).toBe(0);
    expect(final.failed).toBe(2);
    expect(failuresOf(final.items)[0]?.error).toContain("no extractor");
  });

  it("writes an archive whose entries are in queue order whatever order the lanes finished in", async () => {
    const archive = archiveOf();
    // Three lanes over three images, the first of which takes the longest.
    const delays = new Map([
      ["c.png", 0],
      ["b.png", 4],
      ["a.png", 8],
    ]);
    const pool: BatchRenderPool = {
      size: 3,
      tracer: {
        trace: () => {
          throw new Error("this test does not export SVG");
        },
      },
      async render(item: BatchRenderRequest): Promise<BatchRenderedFrame> {
        await new Promise((resolve) => setTimeout(resolve, delays.get(item.image.name) ?? 0));
        return frame(item.image.width, item.image.height);
      },
      dispose: () => Promise.resolve(),
    };

    const final = await createBatchRun(
      request({
        pool,
        output: archive.output,
        items: [file("a.png"), file("b.png"), file("c.png")],
      }),
    ).start();

    expect(final.done).toBe(3);
    const blob = archive.read();
    expect(blob).not.toBeNull();
    const bytes = new Uint8Array(await (blob as Blob).arrayBuffer());
    const text = new TextDecoder("latin1").decode(bytes);
    // Names appear in the local headers in the order they were added.
    expect(text.indexOf("a-dither.png")).toBeLessThan(text.indexOf("b-dither.png"));
    expect(text.indexOf("b-dither.png")).toBeLessThan(text.indexOf("c-dither.png"));
  });

  it("cancels the rest of the queue and marks them cancelled, not failed", async () => {
    const directory = directoryOf();
    let run: ReturnType<typeof createBatchRun> | null = null;
    const pool = poolOf(1, (item) => {
      if (item.image.name === "b.png") run?.cancel();
    });
    run = createBatchRun(
      request({
        pool,
        output: directory.output,
        items: [file("a.png"), file("b.png"), file("c.png")],
      }),
    );

    const final = await run.start();

    expect(final.phase).toBe("cancelled");
    expect(final.done).toBe(1);
    expect(final.failed).toBe(0);
    expect(final.cancelled).toBe(2);
    expect(final.items.map((item) => item.state)).toEqual(["done", "cancelled", "cancelled"]);
  });

  it("publishes a snapshot per transition, and the snapshot identity changes each time", async () => {
    const run = createBatchRun(request());
    const seen: string[] = [];
    let previous = run.getSnapshot();
    const off = run.subscribe(() => {
      const next = run.getSnapshot();
      expect(next).not.toBe(previous);
      previous = next;
      seen.push(next.items.map((item) => `${item.state}:${item.stage}`).join("|"));
    });

    await run.start();
    off();

    expect(seen.length).toBeGreaterThan(4);
    expect(seen.some((line) => line.includes("running:rendering"))).toBe(true);
    expect(seen.some((line) => line.includes("running:encoding"))).toBe(true);
  });

  it("summarises what happened", async () => {
    const final = await createBatchRun(request()).start();
    expect(final.summary).not.toBeNull();
    expect(final.summary?.total).toBe(2);
    expect(final.summary?.done).toBe(2);
    expect(final.summary?.outputBytes).toBeGreaterThan(0);
    expect(final.summary?.delivery).toContain("out");
  });

  it("refuses to be started twice", async () => {
    const run = createBatchRun(request());
    await run.start();
    await expect(run.start()).rejects.toThrow("already been started");
  });

  it("records a run-level failure separately from the item errors", async () => {
    const handle = {
      kind: "file" as const,
      name: "batch.zip",
      createWritable: () => Promise.reject(new Error("the disk is full")),
    } as unknown as FileSystemFileHandle;

    const final = await createBatchRun(
      request({
        output: {
          kind: "zip",
          destination: { kind: "file-system-access", handle },
          name: "batch.zip",
        },
      }),
    ).start();

    expect(final.phase).toBe("failed");
    expect(final.failure).toContain("disk is full");
    // The items themselves all succeeded — the run is what went wrong.
    expect(final.failed).toBe(0);
    expect(final.done).toBe(2);
  });
});
