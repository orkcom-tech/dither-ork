/**
 * The adapter between the editor session and the surprise generator.
 *
 * `web/src/surprise/` knows nothing about a document store, a render service or
 * a palette editor — it is pure, and that is what lets it be tested against the
 * real sixty-seven-effect catalogue with no browser. This file is the single
 * place the two meet, in the same arrangement `ui/export/session.ts` uses for
 * the export module.
 *
 * It does four things the generator cannot:
 *
 * 1. **Resolves the extracted palette mode.** `decidePalette` produces settings —
 *    algorithm, K, seed — and stops, because running the clustering means calling
 *    into WASM with the decoded image.
 * 2. **Applies the document.** One `loadDocument`, so a surprise is one undo
 *    step, and the palette editor follows through the session's own bridge.
 * 3. **Renders the history thumbnail** (F-SM-10).
 * 4. **Coalesces a hammered shortcut** (F-SM-12). See {@link SurpriseEngine.surprise}.
 */

import { logger } from "../../lib/log";
import type { DitherDocument, Palette } from "../../types/document";
import { documentAtFrame, planAnimation, stillFrameFor } from "../../animation";
import type { EffectRegistry } from "../../registry";
import type { EditorSession } from "../../state";
import { isAbandoned } from "../../worker";
import {
  decidePalette,
  describePaletteDecision,
  formatSeed,
  generateSurprise,
  mintSeed,
  paletteFromExtraction,
  rerollNodeParams,
  type PaletteDecision,
  type SurpriseExcludes,
  type SurpriseLocks,
  type SurpriseResult,
} from "../../surprise";
import { extractFromSource } from "../palette/core";
import type { PaletteStore } from "../palette/store";
import { probeModulatorSupport, type ModulatorSupport } from "./capability";
import { readiness, type Readiness } from "./model";

const log = logger("app");

/**
 * Longest side of a history thumbnail, in device-independent pixels.
 *
 * The strip shows twelve of them, so this is what they are drawn at rather than
 * a source that gets scaled down in CSS: rendering at display size is what makes
 * the thumbnail cost a fraction of a millisecond instead of a full frame.
 */
export const THUMBNAIL_MAX_SIDE = 192;

export interface SurpriseRun {
  readonly result: SurpriseResult;
  readonly palette: PaletteDecision;
}

export interface StackEntry {
  readonly id: string;
  readonly effect: string;
  readonly name: string;
}

export interface SurpriseEngine {
  readonly registry: EffectRegistry;
  /** Whether this build renders modulator bindings. Probed once, at construction. */
  readonly modulators: ModulatorSupport;
  /** Whether a surprise can run right now, and what is missing if it cannot. */
  ready(): Readiness;
  /** The stack as the per-node dice list shows it (F-SM-08). */
  stack(): readonly StackEntry[];
  /**
   * Generate and apply one or more surprises.
   *
   * **`onApplied` fires once per surprise that reached the screen**, which is
   * not always once per call: a hammered shortcut coalesces several presses into
   * fewer runs (see the implementation), and reporting only the last would leave
   * a document that was on screen missing from the history. The promise settles
   * when nothing more is outstanding, and rejects only on a real failure — a
   * stack the registry refuses, an extraction the core could not run.
   */
  surprise(options: {
    readonly chaos: number;
    readonly locks: SurpriseLocks;
    readonly excludes: SurpriseExcludes;
    readonly onApplied: (run: SurpriseRun) => void;
  }): Promise<void>;
  /** Re-roll one node's parameters and seed (F-SM-08). One undo step. */
  reroll(nodeId: string, chaos: number): void;
  /** Put a history entry back on screen (F-SM-10). One undo step. */
  restore(document: DitherDocument, label: string): void;
  /**
   * Render a PNG data URL of a document, for the history strip.
   *
   * The document is **planned** before it is rendered, which is two fixes in one
   * call. `buildRenderGraph` refuses a document carrying modulator bindings, and a
   * surprise draws them whenever animation is on — so this used to fail for nearly
   * every surprise the feature makes and the strip said "no preview". And the
   * frame it renders is `stillFrameFor(plan)` rather than 0, because a feedback
   * node is the identity at frame 0 and a thumbnail of one was a picture of the
   * document without its trail.
   *
   * Never rejects: a thumbnail is a nicety and a failure to make one is recorded
   * on the entry rather than surfaced as an error over the picture.
   */
  thumbnail(document: DitherDocument): Promise<
    { readonly url: string; readonly problem: null } | { readonly url: null; readonly problem: string }
  >;
}

export interface SurpriseEngineOptions {
  readonly session: EditorSession;
  readonly registry: EffectRegistry;
  readonly palette: PaletteStore;
}

export function createSurpriseEngine(options: SurpriseEngineOptions): SurpriseEngine {
  const { session, registry, palette } = options;
  const store = session.store;

  // Probed once. The answer is a property of the build, not of the moment.
  const modulators = probeModulatorSupport(registry);

  /** Resolve a decision into the palette the document will carry. */
  const resolvePalette = async (decision: PaletteDecision): Promise<Palette> => {
    if (decision.mode !== "extract") return decision.palette;

    const source = palette.getSnapshot().source;
    if (source === null) {
      // `ready()` is checked before every run, so this is unreachable through
      // the UI; it is stated rather than assumed because the alternative is an
      // extraction against nothing, which the core would refuse with a message
      // about a buffer rather than about an image.
      throw new Error("a palette was to be extracted, but no image is open");
    }

    // The full `k` is asked of the core, not `k` less locked swatches: a
    // surprise builds a palette rather than re-extracting around one somebody
    // pinned, and the palette lock (F-SM-06) is how a pinned palette survives.
    const extraction = await extractFromSource(source, decision.settings, decision.k);
    return paletteFromExtraction(extraction.colors, decision.settings.method, decision.metric);
  };

  /**
   * Single-flight with coalescing, for F-SM-12's "designed to be hammered".
   *
   * A press while one is running does not queue a second extraction behind the
   * first — it marks that another is wanted. When the running one finishes, one
   * more goes, with a fresh seed. So hammering the key produces a steady stream
   * of surprises rather than a backlog of clustering runs against a
   * two-megapixel image, and never drops the last press.
   */
  let running: Promise<void> | null = null;
  let coalesced = 0;

  const runOnce = async (
    chaos: number,
    locks: SurpriseLocks,
    excludes: SurpriseExcludes,
  ): Promise<SurpriseRun> => {
    const verdict = ready();
    if (!verdict.ready) throw new Error(verdict.reason);

    const seed = mintSeed();
    // A blank canvas (F-INF-01's starting point) is transparent black, so there
    // is nothing in it to extract a palette from and nothing for a chain of
    // filters to work on. Both halves of the surprise are told, once, from the
    // one fact that says so — the decoded source's own format.
    const blankCanvas = store.getSnapshot().source?.format === "blank";
    const decision = decidePalette(seed, {
      library: palette.getSnapshot().library,
      extractable: !blankCanvas,
    });
    const resolved = await resolvePalette(decision);

    const result = generateSurprise({
      seed,
      registry,
      chaos,
      locks,
      excludes,
      base: store.document,
      palette: resolved,
      // What the build can do; `excludes.animation` is what the user asked for.
      // Two different facts, and the panel says two different things about them.
      animate: modulators.renderable,
      // What the picture is. On a blank canvas the grammar must put a generator
      // at the head or the surprise renders nothing — see `surprise/shape.ts`.
      blankCanvas,
    });

    // One `loadDocument`, so the whole surprise is one undo step and the palette
    // editor follows through the session's bridge rather than being written
    // separately — two writes would be two undo steps and a moment where the
    // document and the editor disagree.
    store.loadDocument(result.document, `Surprise ${formatSeed(seed)}`);
    log.info("surprise applied", {
      seed: result.summary.seed,
      palette: describePaletteDecision(decision),
      nodes: result.document.stack.length,
    });
    return { result, palette: decision };
  };

  const ready = (): Readiness => {
    const snapshot = palette.getSnapshot();
    const status = snapshot.libraryStatus;
    return readiness({
      hasSource: store.getSnapshot().source !== null,
      libraryReady: status.kind === "ready" && snapshot.library.length > 0,
      libraryFailure: status.kind === "failed" ? status.message : null,
    });
  };

  return {
    registry,
    modulators,
    ready,

    stack(): readonly StackEntry[] {
      return store.document.stack.map((node) => ({
        id: node.id,
        effect: node.effect,
        name: registry.get(node.effect)?.name ?? node.effect,
      }));
    },

    async surprise({ chaos, locks, excludes, onApplied }): Promise<void> {
      if (running !== null) {
        coalesced += 1;
        log.debug("surprise coalesced into the one already running", { waiting: coalesced });
        return running;
      }

      const attempt = (async (): Promise<void> => {
        onApplied(await runOnce(chaos, locks, excludes));
        // Drain the presses that arrived while that was running — one more run
        // rather than one per press. The point is a steady stream of surprises,
        // not a backlog of palette extractions against a two-megapixel image.
        // Every run is reported as it lands, so a document that was on screen is
        // never missing from the history.
        while (coalesced > 0) {
          const waiting = coalesced;
          coalesced = 0;
          log.debug("running one more surprise for the presses that arrived", { waiting });
          onApplied(await runOnce(chaos, locks, excludes));
        }
      })();

      running = attempt;
      try {
        await attempt;
      } finally {
        running = null;
        coalesced = 0;
      }
    },

    reroll(nodeId: string, chaos: number): void {
      const next = rerollNodeParams({
        document: store.document,
        registry,
        nodeId,
        seed: mintSeed(),
        chaos,
      });
      const name = registry.get(next.stack.find((node) => node.id === nodeId)?.effect ?? "")?.name;
      store.loadDocument(next, `Reroll ${name ?? nodeId}`);
    },

    restore(document: DitherDocument, label: string): void {
      store.loadDocument(document, label);
    },

    async thumbnail(document: DitherDocument): Promise<
      { readonly url: string; readonly problem: null } | { readonly url: null; readonly problem: string }
    > {
      const source = store.getSnapshot().source;
      if (source === null) {
        return { url: null, problem: "no image is open" };
      }
      const factor = Math.min(1, THUMBNAIL_MAX_SIDE / Math.max(source.width, source.height));

      try {
        // Planned, not handed over as written, and this is the fix for a strip
        // that said "no preview" against almost every entry.
        //
        // `buildRenderGraph` **refuses** a document carrying modulator bindings —
        // a bound parameter has a value only for a particular frame — and a
        // surprise draws bindings whenever animation is on, which is the default.
        // So the thumbnail render was throwing a `DocumentError` for nearly every
        // surprise this feature makes, and the entry recorded the reason and
        // showed the seed instead of a picture.
        const plan = planAnimation(document, registry);
        // Frame 0 for a looping document, and a frame inside the loop for a
        // feedback one — see `stillFrameFor`. A feedback node is the identity at
        // frame 0, so the thumbnail was a picture of the document *without* its
        // trail: the one shape a chain cannot make, shown as though it had done
        // nothing.
        const at = stillFrameFor(plan);

        let frame = await session.render.render({
          document: documentAtFrame(plan, 0),
          solo: null,
          quality: "preview",
          factor,
          frame: 0,
          // The export lane, deliberately. A preview is superseded the moment a
          // newer one arrives, and a shortcut designed to be hammered produces
          // newer previews constantly — so a thumbnail in the preview lane would
          // be missing exactly when the history is most worth having. Export
          // renders are never superseded; the running preview they preempt is
          // re-queued rather than failed, so the screen still lands where the
          // viewport asked for it. The cost is one 192-pixel render.
          lane: "export",
          present: "bytes",
        });

        // Frame N of a feedback document is the product of frames 0..N, and the
        // worker's frame store serves the frame it holds and refuses any other
        // rather than inventing a history — so the frames in between are
        // rendered and thrown away, exactly as `ui/timeline/preview.ts` does for
        // a scrub. `at` is 0 for every document that loops, so this loop does not
        // run at all for them and a thumbnail costs what it always did.
        if (at > 0) {
          log.debug("thumbnail replays a feedback document", {
            frame: at,
            frames: plan.clock.frames,
            why: "a feedback node is the identity at frame 0",
          });
        }
        for (let index = 1; index <= at; index += 1) {
          frame = await session.render.render({
            document: documentAtFrame(plan, index),
            solo: null,
            quality: "preview",
            factor,
            frame: index,
            lane: "export",
            present: "bytes",
          });
        }

        if (frame.image.kind !== "bytes") {
          return { url: null, problem: "the thumbnail render came back as a bitmap" };
        }
        return { url: toPngDataUrl(frame.image.data, frame.width, frame.height), problem: null };
      } catch (error) {
        // Not swallowed and not surfaced as a failure over the picture: the
        // surprise itself worked, and the entry says why it has no picture.
        if (isAbandoned(error)) {
          log.debug("thumbnail render abandoned", { why: error.message });
          return { url: null, problem: "the thumbnail render was cancelled" };
        }
        const message = error instanceof Error ? error.message : String(error);
        log.warn("a history thumbnail could not be rendered", { error: message });
        return { url: null, problem: message };
      }
    },
  };
}

/**
 * RGBA bytes as a PNG data URL.
 *
 * A canvas rather than `export/png.ts`: that encoder exists to write *indexed*
 * PNGs, which no browser will do and which an exported file needs, and it takes
 * a colour census first. A thumbnail is thrown away when the entry falls off the
 * strip, so the browser's own encoder is the right tool and the one that costs
 * nothing to maintain.
 */
function toPngDataUrl(data: Uint8ClampedArray, width: number, height: number): string {
  const canvas = window.document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("a 2D canvas context was refused, so no thumbnail could be encoded");
  }
  // Copied into a fresh `ArrayBuffer` rather than cast. `RenderedImage`'s bytes
  // are typed `Uint8ClampedArray<ArrayBufferLike>`, and `ImageData` takes only
  // an `ArrayBuffer`-backed view — `SharedArrayBuffer` is very much in scope in
  // this build, since the WASM thread pool needs it. A cast would compile and be
  // wrong the day a frame arrives on shared memory; the copy is 110 kB at
  // thumbnail size and happens once per surprise.
  context.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  return canvas.toDataURL("image/png");
}
