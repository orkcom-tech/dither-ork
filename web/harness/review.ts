/**
 * Look at what the generator makes — the judging step, not a test.
 *
 * Draws N surprises across the chaos range as a contact sheet, and beside each
 * one **the document the same seed would have produced before step 4** — that
 * is, with `excludes.shape` set, which is exactly the chain generator. Same
 * seed, same chaos, same palette decision; the only difference is whether the
 * grammar was allowed a shape.
 *
 * It renders through the real path: the real registry, the real palette
 * decision resolved against the real core, the real render worker. Nothing here
 * approximates anything, because the question it answers is "is the picture
 * good", and an approximation of the picture cannot answer it.
 *
 * Not part of the application and not in the build — `vite build` bundles
 * `index.html` and nothing else, so this is a page the dev server serves and the
 * shipped site does not have, and it is outside `src/` so it is neither
 * typechecked nor tested with the application. Delete it when it stops earning
 * its place.
 *
 * Open http://localhost:5173/harness/review.html, choose an image, and read the
 * query string:
 *
 *   ?count=32&from=0&seed=<hex>   how many pairs, and where the seeds start
 *   ?chaos=1                      pin the slider; omit to sweep 0..1 across the sheet
 *   ?cols=4&scale=180             sheet layout
 *   ?src=/probe/images/batch-3.png  fetch the source instead of waiting for a click,
 *                                   so the sheet can be produced without a human
 *
 * `window.REPORT` holds one JSON line per pair afterwards: the shape, whether it
 * loops, and the mean absolute difference between the two renders — which is how
 * "the branch bought nothing" becomes a number rather than an impression.
 * `window.DONE` turns true when the sheet is finished and `window.FAILED` holds
 * the message if it is not, so an automated reader knows which it is looking at.
 */

import { discoverEffects } from "../src/registry/discovery";
import { createEffectRegistry, type EffectRegistry } from "../src/registry/registry";
import { decodeImage } from "../src/io/decode";
import { documentAtFrame, planAnimation, stillFrameFor } from "../src/animation";
import { RenderService } from "../src/worker";
import { checkCapabilities } from "../src/lib/capabilities";
import {
  NO_EXCLUDES,
  NO_LOCKS,
  decidePalette,
  generateSurprise,
  paletteFromExtraction,
  type PaletteDecision,
} from "../src/surprise";
import { extractFromSource, fetchBuiltinPalettes } from "../src/ui/palette/core";
import { DEFAULT_CLOCK, DEFAULT_PALETTE } from "../src/state/document";
import { DOCUMENT_SCHEMA_VERSION, type DitherDocument, type Palette } from "../src/types/document";

const status = document.getElementById("status") as HTMLParagraphElement;
const sheet = document.getElementById("sheet") as HTMLCanvasElement;

const params = new URLSearchParams(location.search);
const COUNT = Number(params.get("count") ?? 32);
const FROM = Number(params.get("from") ?? 0);
const SCALE = Number(params.get("scale") ?? 170);
const COLS = Number(params.get("cols") ?? 4);
const FIXED_CHAOS = params.get("chaos") === null ? null : Number(params.get("chaos"));
const BASE_SEED = BigInt(params.get("seed") ?? "0x51a7_0000_0000_0001".replace(/_/g, ""));

/** Mean absolute RGB difference between two renders, 0..1. `null` if either failed. */
function differenceOf(
  a: Uint8ClampedArray | null,
  b: Uint8ClampedArray | null,
): number | null {
  if (a === null || b === null || a.length !== b.length) return null;
  let total = 0;
  for (let i = 0; i < a.length; i += 4) {
    total += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    total += Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0));
    total += Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0));
  }
  return Math.round((total / ((a.length / 4) * 3 * 255)) * 10_000) / 10_000;
}

/**
 * One still of a document, at the frame a still of it should be taken at.
 *
 * **Not frame 0 for a feedback document**, and that is the whole reason this is a
 * function. A feedback node blends the previous frame at its own position into
 * this one, so at frame 0 there is nothing to blend and the node is the identity:
 * a sheet rendered at frame 0 judges every feedback document as though the
 * feedback had done nothing. It is the same lie the thumbnail and the viewport
 * were telling, and a review sheet that repeats it cannot see the shape it is
 * supposed to be judging.
 *
 * Frame N of a feedback document is the product of frames 0..N — the worker's
 * frame store serves the frame it holds and refuses any other — so the frames in
 * between are rendered and discarded, exactly as `ui/timeline/preview.ts` does.
 * `stillFrameFor` is 0 for everything that loops, so this costs one render for
 * every document that has no feedback node in it.
 */
async function renderStill(
  render: RenderService,
  registry: EffectRegistry,
  document: DitherDocument,
  factor: number,
) {
  const plan = planAnimation(document, registry);
  const at = stillFrameFor(plan);
  let frame = await render.render({
    document: documentAtFrame(plan, 0),
    solo: null,
    quality: "full",
    factor,
    frame: 0,
    lane: "export",
    present: "bytes",
  });
  for (let index = 1; index <= at; index += 1) {
    frame = await render.render({
      document: documentAtFrame(plan, index),
      solo: null,
      quality: "full",
      factor,
      frame: index,
      lane: "export",
      present: "bytes",
    });
  }
  return frame;
}

/**
 * The same document with the mask branch cut out, and nothing else changed.
 *
 * This is what makes "the branch bought nothing" measurable. The mask edge goes,
 * the `mask` key goes off the node that carried it, and every node that only
 * reached the picture through that edge goes with them. The main chain — its
 * effects, its ids, its parameters, its seeds — is untouched, so the difference
 * between rendering this and rendering the original is the mask and nothing else.
 */
function withoutBranch(document: DitherDocument): DitherDocument {
  const edges = document.edges.filter((edge) => edge.port !== "mask");

  // Everything reachable from the output through the remaining edges. Anything
  // else was branch.
  const keep = new Set<string>();
  const walk = (id: string | null): void => {
    if (id === null || keep.has(id)) return;
    keep.add(id);
    for (const edge of edges) if (edge.to === id) walk(edge.from);
  };
  walk(document.output);

  const stack = document.stack
    .filter((node) => keep.has(node.id))
    .map((node) => {
      if (node.mask === undefined) return node;
      const { mask: _dropped, ...rest } = node;
      return rest;
    });

  return {
    ...document,
    stack,
    edges: edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to)),
    bindings: document.bindings.filter((binding) => keep.has(binding.nodeId)),
  };
}

/** Mean RGB value of a render, 0..1. `null` when it did not render. */
function meanOf(a: Uint8ClampedArray | null): number | null {
  if (a === null) return null;
  let total = 0;
  for (let i = 0; i < a.length; i += 4) {
    total += (a[i] ?? 0) + (a[i + 1] ?? 0) + (a[i + 2] ?? 0);
  }
  return Math.round((total / ((a.length / 4) * 3 * 255)) * 10_000) / 10_000;
}

function say(text: string): void {
  status.textContent = text;
}

async function main(file: File): Promise<void> {
  say("loading the catalogue…");
  const registry = createEffectRegistry(discoverEffects());

  say("decoding the source…");
  const image = await decodeImage(file, file.name);

  say("reading the palette library from the core…");
  const library = await fetchBuiltinPalettes();

  say("starting the render worker…");
  const report = await checkCapabilities();
  const render = await RenderService.create({ report });
  await render.setSource(image);

  const base: DitherDocument = {
    schema: DOCUMENT_SCHEMA_VERSION,
    source: { name: image.name, width: image.width, height: image.height },
    stack: [],
    edges: [],
    output: null,
    palette: DEFAULT_PALETTE,
    clock: DEFAULT_CLOCK,
    bindings: [],
  };

  const resolvePalette = async (decision: PaletteDecision): Promise<Palette> => {
    if (decision.mode !== "extract") return decision.palette;
    const extraction = await extractFromSource(
      { name: image.name, width: image.width, height: image.height, surface: image.surface },
      decision.settings,
      decision.k,
    );
    return paletteFromExtraction(extraction.colors, decision.settings.method, decision.metric);
  };

  const cols = COLS;
  const rows = Math.ceil(COUNT / cols);
  const cell = SCALE;
  const label = 26;
  const pair = cell * 2 + 6;
  sheet.width = cols * (pair + 12);
  sheet.height = rows * (cell + label + 12);
  const ctx = sheet.getContext("2d");
  if (ctx === null) throw new Error("no 2d context");
  ctx.fillStyle = "#101014";
  ctx.fillRect(0, 0, sheet.width, sheet.height);

  const factor = Math.min(1, cell / Math.max(image.width, image.height));
  const notes: string[] = [];

  for (let i = 0; i < COUNT; i += 1) {
    const seed = BASE_SEED + BigInt(FROM + i) * 0x9e37_79b9_7f4a_7c15n;
    // Chaos walks the whole range across the sheet, so the judgement is over the
    // slider rather than over one setting of it.
    const chaos = FIXED_CHAOS ?? Math.round(((i % 8) / 7) * 100) / 100;
    say(`rendering ${i + 1}/${COUNT} (chaos ${chaos})…`);

    const decision = decidePalette(seed, { library });
    const palette = await resolvePalette(decision);

    const graph = generateSurprise({
      seed,
      registry,
      chaos,
      locks: NO_LOCKS,
      excludes: NO_EXCLUDES,
      base,
      palette,
      animate: false,
      blankCanvas: false,
    });
    const chain = generateSurprise({
      seed,
      registry,
      chaos,
      locks: NO_LOCKS,
      // The chain generator, exactly: the shape exclude is the pre-step-4 sentence.
      excludes: { ...NO_EXCLUDES, shape: true },
      base,
      palette,
      animate: false,
      blankCanvas: false,
    });

    const x = (i % cols) * (pair + 12) + 6;
    const y = Math.floor(i / cols) * (cell + label + 12) + 6;

    const failed: string[] = [];
    // Three renders, and the third is the one that measures the mask.
    //
    // graph-vs-chain does **not** isolate the branch: with `excludes.shape` the
    // generator and the feedback node are gone too, and the feedback draw shifts
    // the RNG stream, so a pair whose shape is "masked branch + feedback"
    // compares two different main chains. `unbranched` is the graph document with
    // the branch cut out and nothing else touched, so the difference between it
    // and `graph` is the mask and only the mask.
    //
    // The fourth render is the still itself, at frame 0, and it exists to put a
    // number on the other thing a still used to get wrong: a feedback node is the
    // identity at frame 0, so a thumbnail or a first view taken there is a picture
    // of the document *without* its trail. Rendered only for a document that has
    // one — for everything else `renderStill` already is frame 0 and the
    // difference would be zero by construction.
    const pixels: (Uint8ClampedArray | null)[] = [null, null, null, null];
    const hasFeedback = !graph.summary.loops;
    const runs = [graph.document, chain.document, withoutBranch(graph.document)];
    const names = ["graph", "chain", "unbranched", "graph@0"];
    for (const [k, document] of runs.entries()) {
      try {
        const frame = await renderStill(render, registry, document, factor);
        if (frame.image.kind !== "bytes") continue;
        pixels[k] = frame.image.data;
        // The third render is a measurement, not a picture: only the pair goes
        // on the sheet, so the layout is what it always was.
        if (k > 1) continue;
        const bitmap = await createImageBitmap(
          new ImageData(new Uint8ClampedArray(frame.image.data), frame.width, frame.height),
        );
        ctx.drawImage(bitmap, x + k * (cell + 6), y, cell, cell * (frame.height / frame.width));
        bitmap.close();
      } catch (error) {
        // A render that fails is a result, not a reason to stop looking: it is
        // recorded on the sheet in red and in the notes, and the sheet carries
        // on. Whether the failure is the generator's is decided by whether the
        // chain half fails too, which is the whole point of rendering the pair.
        failed.push(`${names[k]}: ${String(error)}`);
        if (k <= 1) {
          ctx.fillStyle = "#511";
          ctx.fillRect(x + k * (cell + 6), y, cell, cell);
        }
      }
    }

    if (hasFeedback) {
      try {
        const plan = planAnimation(graph.document, registry);
        const atZero = await render.render({
          document: documentAtFrame(plan, 0),
          solo: null,
          quality: "full",
          factor,
          frame: 0,
          lane: "export",
          present: "bytes",
        });
        if (atZero.image.kind === "bytes") pixels[3] = atZero.image.data;
      } catch (error) {
        failed.push(`graph@0: ${String(error)}`);
      }
    }

    ctx.fillStyle = "#8ad";
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillText(
      `${i + 1} c${chaos} ${graph.summary.shape}${graph.summary.loops ? "" : " ·no-loop"}`,
      x,
      y + cell + 12,
    );
    ctx.fillStyle = failed.length > 0 ? "#f66" : "#666";
    ctx.fillText(
      `${graph.document.stack.length}n vs ${chain.document.stack.length}n · ${graph.summary.dither}`,
      x,
      y + cell + 23,
    );

    notes.push(
      JSON.stringify({
        i: i + 1,
        seed: graph.summary.seed,
        chaos,
        shape: graph.summary.shape,
        loops: graph.summary.loops,
        branch: graph.summary.branch,
        graphNodes: graph.document.stack.length,
        chainNodes: chain.document.stack.length,
        dither: graph.summary.dither,
        palette: decision.mode,
        masked: graph.summary.maskedNode,
        maskedEffect:
          graph.document.stack.find((n) => n.id === graph.summary.maskedNode)?.effect ?? null,
        mask: graph.document.stack.find((n) => n.id === graph.summary.maskedNode)?.mask ?? null,
        // The branch, by effect and not by node id: "which generator rooted it"
        // is the question a mask that bought nothing has to answer.
        branchEffects: graph.document.edges
          .filter((e) => e.port === "mask")
          .map((e) => graph.document.stack.find((n) => n.id === e.from)?.effect ?? e.from),
        branchRoot: (() => {
          const feeder = graph.document.edges.find((e) => e.port === "mask")?.from;
          if (feeder === undefined) return null;
          // Walk back up the branch to its root, which the grammar guarantees is
          // a source node.
          let at: string | undefined = feeder;
          const seen = new Set<string>();
          while (at !== undefined && !seen.has(at)) {
            seen.add(at);
            const up: string | undefined = graph.document.edges.find(
              (e) => e.to === at && e.port === "in",
            )?.from;
            if (up === undefined) break;
            at = up;
          }
          return graph.document.stack.find((n) => n.id === at)?.effect ?? null;
        })(),
        stack: graph.document.stack.map((n) => `${n.id}:${n.effect}`),
        edges: graph.document.edges.map((e) => `${e.from}->${e.to}.${e.port}`),
        failed,
        // How different the two pictures actually are, 0..1, so "the branch
        // bought nothing" is a measurement rather than an impression. Identical
        // documents are exactly 0 by construction.
        difference: differenceOf(pixels[0], pixels[1]),
        // The number the branch has to earn: the same document with the branch
        // cut out. Null on a document that has no branch.
        maskDiff:
          graph.summary.branch > 0 ? differenceOf(pixels[0], pixels[2]) : null,
        // How much the still used to lie about feedback: the frame a still is now
        // taken at, against frame 0, which is what every still showed before.
        // Null on a looping document, where the two are the same render.
        feedbackStillDiff: hasFeedback ? differenceOf(pixels[0], pixels[3]) : null,
        // Mean channel value of the graph render, 0..1. A still that opens at
        // essentially zero is a black picture, whatever the document says.
        luma: meanOf(pixels[0]),
        chainLuma: meanOf(pixels[1]),
      }),
    );
  }

  say(`done — ${COUNT} pairs. Left of each pair: the graph generator. Right: chain only.`);
  // Read from the console by the reviewer.
  (window as unknown as { REPORT: string[] }).REPORT = notes;
  (window as unknown as { DONE: boolean }).DONE = true;
}

function run(file: File): void {
  main(file).catch((error: unknown) => {
    const message =
      error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    say(`failed: ${message}`);
    (window as unknown as { FAILED: string }).FAILED = message;
    // eslint-disable-next-line no-console
    console.error(error);
  });
}

const picker = document.getElementById("file") as HTMLInputElement;
picker.addEventListener("change", () => {
  const file = picker.files?.[0];
  if (file === undefined) return;
  run(file);
});

// `?src=` fetches the source itself, so the sheet can be produced without a
// human clicking a file picker. Same-origin only, because the dev server is the
// only thing serving this page and a cross-origin fetch would fail the COEP
// headers the app requires anyway.
const SRC = params.get("src");
if (SRC !== null) {
  say(`fetching ${SRC}…`);
  fetch(SRC)
    .then(async (response) => {
      if (!response.ok) throw new Error(`${SRC}: HTTP ${response.status}`);
      const blob = await response.blob();
      run(new File([blob], SRC.replace(/^.*\//, ""), { type: blob.type }));
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      say(`failed: ${message}`);
      (window as unknown as { FAILED: string }).FAILED = message;
    });
}
