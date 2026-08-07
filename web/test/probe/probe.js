// A manual verification harness for the running application.
//
// Not part of the build and not imported by anything: it is loaded by hand from
// the console (or by an agent driving the page) as an ES module. Everything it
// touches is the running application's own — the same document store, the same
// render worker, the same timeline store and the same animated-export adapters
// the export dialog was handed, reached through the DEV debug handle in
// `src/app/main.tsx` — plus the real source modules, imported from the dev
// server so nothing is a second copy of the logic under test.
//
//   const probe = await import("/probe/probe.js");
//   await probe.responsiveness(["brightness-contrast", "floyd-steinberg", "scanlines"]);
//
// Results are printed with a `PROBE` prefix so they can be read out of the
// console log, which survives page-level work that a return value does not.

const animation = await import("/src/animation/index.ts");
const timelineModule = await import("/src/ui/timeline/index.ts");
const animatedExport = await import("/src/export/animated/index.ts");

const handle = () => {
  const h = globalThis.__ditherOrk;
  if (!h) throw new Error("no debug handle: not a DEV build, or the viewport has not mounted");
  return h;
};

export const say = (name, value) => {
  console.log(`PROBE ${name} ${JSON.stringify(value)}`);
  results[name] = value;
  return value;
};

/**
 * Where every result lands, and why it is not just a return value.
 *
 * A driver that awaits a long call over a remote debugging channel loses the
 * answer when the channel drops, and opening a large image is long enough for
 * that to happen. So a step is *started* by one short call and *read* by
 * another: {@link start} never blocks the caller, {@link results} accumulates,
 * and `state` says whether anything is still running.
 */
export const results = {};
export const state = { running: null, done: [], failed: null };

/** Start a step without waiting for it. Poll {@link results} for the answer. */
export function start(name, ...args) {
  const fn = steps[name];
  if (typeof fn !== "function") throw new Error(`no probe step called "${name}"`);
  state.running = name;
  state.failed = null;
  void Promise.resolve()
    .then(() => fn(...args))
    .then(() => {
      state.done.push(name);
    })
    .catch((error) => {
      state.failed = { step: name, error: error instanceof Error ? error.message : String(error) };
      console.log(`PROBE ${name} FAILED ${state.failed.error}`);
    })
    .finally(() => {
      state.running = null;
    });
  return `started ${name}`;
}

/** Start a list of steps, each waiting for the last. */
export function startAll(plan) {
  state.running = plan.map((entry) => (Array.isArray(entry) ? entry[0] : entry)).join(" -> ");
  state.failed = null;
  void (async () => {
    try {
      for (const entry of plan) {
        const [name, ...args] = Array.isArray(entry) ? entry : [entry];
        const fn = steps[name];
        if (typeof fn !== "function") throw new Error(`no probe step called "${name}"`);
        await fn(...args);
        state.done.push(name);
      }
    } catch (error) {
      state.failed = { error: error instanceof Error ? error.message : String(error) };
      console.log(`PROBE FAILED ${state.failed.error}`);
    } finally {
      state.running = null;
    }
  })();
  return `started ${plan.length} step(s)`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openImage(path, name) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} came back ${response.status}`);
  const file = new File([await response.blob()], name, { type: "image/png" });
  await handle().session.openFile(file);
  await sleep(200);
  const snapshot = handle().store.getSnapshot();
  return say("openImage", {
    name,
    width: snapshot.source?.width ?? 0,
    height: snapshot.source?.height ?? 0,
  });
}

/**
 * Empty the stack and the timeline.
 *
 * Autosave restores the document on reload, so without this a probe run starts
 * on top of the last one's stack and measures something nobody built.
 */
export async function reset() {
  const h = handle();
  for (const track of [...h.timeline.getSnapshot().state.tracks]) {
    h.timeline.dispatch({ kind: "unbind", trackId: track.id });
  }
  for (const node of [...h.store.getSnapshot().document.stack]) {
    h.store.removeNode(node.id);
  }
  await sleep(100);
  return say("reset", {
    stack: h.store.getSnapshot().document.stack.length,
    tracks: h.timeline.getSnapshot().state.tracks.length,
    bindings: h.store.getSnapshot().document.bindings.length,
  });
}

/** The first bindable parameter of a node, and the numbers that make it move. */
function bindable(node) {
  const descriptor = handle().store.registry.require(node.effect);
  const param = descriptor.params.find(
    (p) => p.animatable && (p.type === "float" || p.type === "int") && p.legal[1] > p.legal[0],
  );
  if (!param) throw new Error(`no bindable parameter on ${node.effect}`);
  const [min, max] = param.legal;
  const centre = param.type === "int" ? Math.round(min + (max - min) / 2) : min + (max - min) / 2;
  return { param, centre, amount: (max - min) / 4 };
}

// --- 1. is the main thread free while a large render runs? ----------------
//
// The longest gap between consecutive animation frames is the measurement that
// matters: a render on the main thread is one long gap, and a render in a
// worker is not. Nothing here asks the worker how it feels — it watches the
// thread the interface is drawn on.
function watchFrames() {
  const gaps = [];
  let last = performance.now();
  let stop = false;

  // A `MessageChannel` ping-pong rather than `requestAnimationFrame`. rAF is
  // tied to compositing, so a window that is not being painted — a background
  // tab, or a remote-controlled pane whose stream has stopped — reports zero
  // frames and measures nothing. A port message is an ordinary macrotask: it is
  // delivered as soon as the main thread's task queue reaches it, and the gap
  // between two of them is exactly "how long was this thread unavailable".
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
    if (!stop) channel.port2.postMessage(0);
  };
  channel.port2.postMessage(0);

  // The browser's own answer to the same question, from a different mechanism.
  // A `longtask` entry is any main-thread task over 50 ms, which is precisely
  // what a render on this thread would be and what a render in a worker is not.
  const longTasks = [];
  let observer = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push(Math.round(entry.duration));
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    observer = null;
  }

  return {
    end() {
      stop = true;
      observer?.disconnect();
      const sorted = [...gaps].sort((a, b) => b - a);
      const round = (n) => Math.round(n * 10) / 10;
      return {
        ticks: gaps.length,
        maxGapMs: round(sorted[0] ?? 0),
        secondGapMs: round(sorted[1] ?? 0),
        medianGapMs: round(sorted[Math.floor(sorted.length / 2)] ?? 0),
        longTasksOver50ms: longTasks.sort((a, b) => b - a).slice(0, 5),
        longTaskObserverAvailable: observer !== null,
      };
    },
  };
}

export async function responsiveness(effects) {
  const h = handle();
  const store = h.store;
  for (const id of effects) store.addNode(id);

  // Let the preview pump finish reacting to those edits, so what is measured
  // below is one render and not the tail of four.
  await sleep(400);
  await h.session.render.render({
    document: store.getSnapshot().document,
    solo: null,
    quality: "full",
    factor: 1,
    lane: "export",
    present: "bytes",
  });
  await sleep(400);

  // Move the first node, so the measured render cannot be served from the node
  // cache. Without this the warm-up above has already produced every
  // intermediate and what is timed is a cache walk rather than a render.
  const first = store.getSnapshot().document.stack[0];
  if (first) {
    const descriptor = store.registry.require(first.effect);
    const param = descriptor.params.find((p) => p.type === "float" && p.legal[1] > p.legal[0]);
    if (param) {
      const [min, max] = param.legal;
      store.setNodeParam(first.id, param.key, min + (max - min) * 0.37, {});
    }
  }
  await sleep(300);

  const watch = watchFrames();
  const started = performance.now();
  let finished = false;
  const render = h.session.render
    .render({
      document: store.getSnapshot().document,
      solo: null,
      quality: "full",
      factor: 1,
      lane: "export",
      present: "bytes",
    })
    .then((value) => {
      finished = true;
      return value;
    });

  // While that runs, use the interface. Not a synthetic busy-loop: a real DOM
  // read and a real store write of the kind a person makes, and the latency of
  // each is the thing they would feel. Scheduled off a `MessageChannel` rather
  // than `setTimeout`, because a window that is not being painted has its timers
  // clamped to about a second and the measurement would be of that instead.
  const interactions = [];
  const channel = new MessageChannel();
  const nudge = () => {
    if (finished) return;
    const at = performance.now();
    const buttons = document.querySelectorAll(".ui-button").length;
    const rows = document.querySelectorAll("[data-testid], .stack__row").length;
    const node = store.getSnapshot().document.stack[interactions.length % effects.length];
    store.selectNode(node?.id ?? null);
    const selected = store.getSnapshot().selectedNodeId;
    interactions.push({ ms: performance.now() - at, buttons, rows, selected: selected !== null });
    channel.port2.postMessage(0);
  };
  channel.port1.onmessage = nudge;
  channel.port2.postMessage(0);

  const result = await render;
  const renderMs = Math.round(performance.now() - started);
  await sleep(200);
  const frames = watch.end();
  const latencies = interactions.map((i) => i.ms).sort((a, b) => b - a);
  const round = (n) => Math.round(n * 100) / 100;

  return say("responsiveness", {
    stack: effects,
    visibility: document.visibilityState,
    renderMs,
    workerMs: Math.round(result.totalMs),
    renderedAt: `${result.width}x${result.height}`,
    ...frames,
    interactionsDuringRender: interactions.length,
    slowestInteractionMs: round(latencies[0] ?? 0),
    medianInteractionMs: round(latencies[Math.floor(latencies.length / 2)] ?? 0),
    domNodesSeen: interactions[0]?.buttons ?? 0,
  });
}

// --- 2. does a bound parameter actually animate? --------------------------
//
// Binds through the timeline store's own action — the one the Bind Parameter
// button dispatches — then asks the plan for the value on several frames and
// renders two of them, comparing the pixels. Both halves matter: the numbers
// prove the modulator moves, the pixels prove the movement reaches the picture.
export async function animates(nodeIndex = 0) {
  const h = handle();
  const store = h.store;
  const timeline = h.timeline;

  const node = store.getSnapshot().document.stack[nodeIndex];
  if (!node) throw new Error("no node at that index; add one before binding");
  const { param, centre, amount } = bindable(node);

  store.setNodeParam(node.id, param.key, centre, {});
  await sleep(40);

  // Exactly the action the Bind Parameter button dispatches.
  timeline.dispatch({
    kind: "bind",
    nodeId: node.id,
    param: param.key,
    track: "modulator",
    base: centre,
    amount,
  });
  await sleep(80);

  const snapshot = timeline.getSnapshot();
  if (snapshot.plan === null) {
    return say("animates", { ok: false, why: snapshot.planError ?? "no plan was built" });
  }

  const valueAt = (frame) =>
    timelineModule
      .documentAtFrame(snapshot.plan, frame)
      .stack.find((n) => n.id === node.id).params[param.key];

  const frames = snapshot.frames;
  const sampled = [0, frames >> 2, frames >> 1, (3 * frames) >> 2].map((f) => ({
    frame: f,
    value: Math.round(valueAt(f) * 1e4) / 1e4,
  }));

  const render = async (frame) => {
    const result = await h.session.render.render({
      document: timelineModule.documentAtFrame(snapshot.plan, frame),
      solo: null,
      quality: "full",
      factor: 1,
      lane: "export",
      present: "bytes",
    });
    return result.image.data;
  };
  const a = await render(sampled[0].frame);
  const b = await render(sampled[1].frame);
  let differing = 0;
  for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i]) differing += 1;

  return say("animates", {
    ok: differing > 0,
    bound: `${node.effect}.${param.key}`,
    base: Math.round(centre * 1e4) / 1e4,
    sampled,
    valueAtSeam: Math.round(valueAt(frames) * 1e4) / 1e4,
    differingPixels: differing,
    totalPixels: a.length / 4,
  });
}

/**
 * Does a track a person made survive a save and a reload?
 *
 * Serialises the document the way "save .dork" does, parses it back, and checks
 * the binding is still there — and that the timeline rebuilds a track from it.
 */
export async function roundTrip() {
  const h = handle();
  const io = await import("/src/io/document/index.ts");
  const before = h.store.getSnapshot().document;
  const text = io.encodeDorkFile(before);
  const read = io.parseDorkFile(text, h.store.registry, "the probe's .dork");
  h.store.loadDocument(read, "reopened .dork");
  await sleep(200);
  const after = h.store.getSnapshot().document;
  return say("roundTrip", {
    bindingsInDocument: before.bindings.length,
    bindingsInFile: read.bindings.length,
    bindingsAfterReopen: after.bindings.length,
    tracksAfterReopen: h.timeline.getSnapshot().state.tracks.length,
    planRebuilt: h.timeline.getSnapshot().plan !== null,
    bytes: text.length,
  });
}

// --- 3. playback ----------------------------------------------------------
export async function playback(seconds = 2) {
  const timeline = handle().timeline;
  const seen = new Set();
  const off = timeline.subscribe(() => {
    const f = timeline.getSnapshot().preview.presentedFrame;
    if (f !== null) seen.add(f);
  });
  timeline.dispatch({ kind: "set-playing", playing: true });
  await sleep(seconds * 1000);
  const status = timeline.getSnapshot().preview;
  timeline.dispatch({ kind: "set-playing", playing: false });
  off();
  return say("playback", {
    engaged: status.engaged,
    distinctFramesPresented: seen.size,
    presented: status.playback.presented,
    dropped: status.playback.dropped,
    error: status.error,
  });
}

// --- 4. the loop seam -----------------------------------------------------
export async function seam() {
  const report = await handle().animated.validateLoop();
  return say("seam", {
    ok: report.ok,
    frames: report.frames,
    hashesCompared: report.hashes !== null,
    sameHash: report.hashes ? report.hashes.frame0 === report.hashes.frameN : null,
    issues: report.issues.map((i) => ({
      code: i.code,
      severity: i.severity,
      source: i.source,
      message: i.message,
    })),
  });
}

/**
 * A loop broken on purpose.
 *
 * Fractional cycles-per-loop is the one thing that stops frame N being frame 0
 * (F-AN-03), so it is what a deliberately broken loop is made of. Such a
 * document cannot be built through the timeline — the field refuses it — so it
 * arrives the way a real one would: as a document loaded from a file or a link.
 */
export async function brokenSeam() {
  const h = handle();
  const store = h.store;
  const node = store.getSnapshot().document.stack[0];
  const { param, amount } = bindable(node);

  const document = {
    ...store.getSnapshot().document,
    bindings: [
      {
        nodeId: node.id,
        param: param.key,
        shape: "sine",
        amount,
        cyclesPerLoop: 1.5,
        phase: 0,
        bipolar: true,
      },
    ],
  };

  const outcome = { binding: `${node.id}.${param.key}` };

  try {
    animation.planAnimation(document, store.registry);
    outcome.plan = "ACCEPTED — this is the defect";
  } catch (error) {
    outcome.plan = error.message;
  }

  try {
    const plan = { clock: animation.loopClock(document.clock) };
    outcome.serialised = JSON.stringify(document.bindings[0]);
    void plan;
  } catch (error) {
    outcome.serialised = error.message;
  }

  store.loadDocument(document, "a deliberately broken loop");
  await sleep(200);
  outcome.timelinePlanError = h.timeline.getSnapshot().planError;

  try {
    const report = await h.animated.validateLoop();
    outcome.exportGate = `ACCEPTED — ok=${report.ok} — this is the defect`;
  } catch (error) {
    outcome.exportGate = error.message;
  }

  return say("brokenSeam", outcome);
}

/**
 * The seam validator itself, on a plan whose cycle count is fractional.
 *
 * Reached by constructing the plan by hand, because `planAnimation` refuses to
 * build one — which is the finding, and is why this is a separate probe rather
 * than something `brokenSeam` can produce through the application.
 */
export async function seamValidatorDirect() {
  const h = handle();
  const store = h.store;
  const node = store.getSnapshot().document.stack[0];
  const { param, centre, amount } = bindable(node);
  const clock = animation.loopClock(store.getSnapshot().document.clock);

  const plan = {
    document: store.getSnapshot().document,
    clock,
    timing: animation.DEFAULT_TIMING,
    documentSeed: 0,
    variations: [],
    animatedNodes: [node.id],
    bindings: [
      {
        binding: {
          nodeId: node.id,
          param: param.key,
          shape: "sine",
          amount,
          cyclesPerLoop: 1.5,
          phase: 0,
          bipolar: true,
        },
        nodeId: node.id,
        param: param.key,
        effect: node.effect,
        descriptor: param,
        base: centre,
        amount,
        // The cast the branded type exists to make visible.
        spec: { shape: "sine", cycles: 1.5, phase: 0, bipolar: true, seed: 1 },
      },
    ],
  };

  const report = animation.validateLoopSeam(plan);
  return say("seamValidatorDirect", {
    ok: report.ok,
    issues: report.issues.map((i) => ({
      code: i.code,
      severity: i.severity,
      source: i.source,
      message: i.message,
    })),
  });
}

/**
 * Does the same seed reproduce the same document? — F-SM-02.
 *
 * Asks the generator, twice, with the same seed and the same base, and compares
 * the whole document. Two different seeds are generated too, because "identical"
 * proves nothing if the generator ignores the seed entirely.
 */
export async function surpriseSeed(seedText = "0123456789abcdef") {
  const h = handle();
  const surprise = await import("/src/surprise/index.ts");
  const base = h.store.getSnapshot().document;
  const registry = h.store.registry;

  const roll = (seed) =>
    surprise.generateSurprise({
      seed,
      registry,
      chaos: 0.5,
      locks: surprise.NO_LOCKS,
      base,
      palette: base.palette,
      animate: true,
    });

  const seed = BigInt(`0x${seedText}`);
  const first = roll(seed);
  const between = roll(seed + 1n);
  const second = roll(seed);

  const shape = (r) => ({
    stack: r.document.stack.map((n) => n.effect),
    bindings: r.document.bindings.length,
    palette: r.document.palette.colors.length / 3,
  });

  return say("surpriseSeed", {
    seed: seedText,
    identicalForSameSeed: JSON.stringify(first.document) === JSON.stringify(second.document),
    differsForOtherSeed: JSON.stringify(first.document) !== JSON.stringify(between.document),
    first: shape(first),
    other: shape(between),
    bytes: JSON.stringify(first.document).length,
  });
}

// --- 5. the animated GIF --------------------------------------------------
//
// Encodes through the application's own adapters and reads the bytes back
// rather than writing a file, because the file write is a native picker this
// cannot drive. Everything up to `writeToDestination` is the real path.
export async function gif(patch = {}) {
  const h = handle();
  const settings = {
    format: "gif",
    quality: 92,
    scale: 1,
    loop: true,
    columns: 8,
    codec: "vp9",
    bitrateKbps: 8000,
    ...patch,
  };
  const started = performance.now();
  const result = await animatedExport.encodeAnimation({
    source: h.animated,
    settings,
    gif: h.gif,
  });
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  globalThis.__lastGif = bytes;
  return say("gif", {
    file: describeGif(bytes),
    reportedFrames: result.frames,
    reportedBytes: result.bytes,
    paletteEntries: result.paletteEntries,
    indexed: result.indexed,
    playbackFps: Math.round(result.playbackFps * 100) / 100,
    notes: result.notes,
    ms: Math.round(performance.now() - started),
  });
}

/** The document palette, as packed sRGB triplets, for comparison with the file. */
export function documentPalette() {
  const colors = handle().store.getSnapshot().document.palette.colors;
  const out = [];
  for (let i = 0; i < colors.length; i += 3) out.push([colors[i], colors[i + 1], colors[i + 2]]);
  return out;
}

// --- 7. batch -------------------------------------------------------------
//
// Assembled exactly the way `ui/batch/BatchPanel.tsx` assembles it — same
// adapters, same pool, same `createBatchRun` — with a ZIP written to a
// `download` destination, which is the path a browser without File System
// Access already takes. The last file in the list is not an image, on purpose.
export async function batch(names = ["batch-1.png", "batch-2.png", "batch-broken.png", "batch-3.png", "batch-4.png"]) {
  const h = handle();
  const batchModule = await import("/src/batch/index.ts");
  // `ui/batch/session.ts` rather than the barrel: the barrel is a panel
  // registration surface and importing `ui/palette` through it would register
  // the palette panel a second time, which the shell refuses by design.
  const uiBatch = await import("/src/ui/batch/session.ts");

  const items = [];
  for (const [index, name] of names.entries()) {
    const response = await fetch(`/probe/images/${name}`);
    const blob = await response.blob();
    items.push({ id: `i${index}`, path: name, blob, bytes: blob.size });
  }

  const settings = {
    ...batchModule.DEFAULT_BATCH_SETTINGS,
    workers: 2,
  };

  // The panel is handed the boot-time report; nothing keeps it around for the
  // console, so this asks again. It costs one extra adapter request and gives
  // the same verdict.
  const { checkCapabilities } = await import("/src/lib/capabilities.ts");
  const report = await checkCapabilities();
  const pool = await uiBatch.poolFor(report, settings.workers, items.length);
  const run = batchModule.createBatchRun({
    items,
    // The same call `BatchPanel` makes: the frame at the playhead, so an
    // animated document is batchable rather than failing every item.
    document: timelineModule.frameDocument(h.timeline, h.store.getSnapshot().document),
    presetName: "probe",
    settings,
    output: { kind: "zip", destination: { kind: "download", name: "probe-batch.zip" }, name: "probe-batch.zip" },
    pool,
    decode: uiBatch.batchDecoderFor(h.session),
    extractor: null,
    modifiedAt: new Date(0),
  });

  // Held so a run that stalls can be inspected while it is stalled.
  globalThis.__batchRun = run;
  globalThis.__batchPool = pool;

  const seen = [];
  const off = run.subscribe(() => {
    const s = run.getSnapshot();
    seen.push(s.items.map((i) => `${i.path}:${i.state}:${i.stage}`).join(","));
  });
  const final = await run.start();
  off();
  await pool.dispose();

  return say("batch", {
    phase: final.phase,
    items: final.items.map((i) => ({
      path: i.path,
      state: i.state,
      stage: i.stage,
      outputName: i.outputName,
      extent: i.width === null ? null : `${i.width}x${i.height}`,
      outputBytes: i.outputBytes,
      ms: i.ms,
      error: i.error,
    })),
    done: final.done,
    failed: final.failed,
    summary: final.summary,
    runFailure: final.failure,
    distinctStateSnapshots: new Set(seen).size,
  });
}

// A GIF reader written here on purpose: verifying the encoder with the
// encoder's own report would prove nothing about the file.
export function describeGif(bytes) {
  const header = String.fromCharCode(...bytes.slice(0, 6));
  if (header !== "GIF89a" && header !== "GIF87a") {
    return { valid: false, header, byteLength: bytes.length };
  }
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  const packed = bytes[10];
  const hasGlobalTable = (packed & 0x80) !== 0;
  const tableEntries = hasGlobalTable ? 2 << (packed & 0x07) : 0;
  let at = 13;
  const globalTable = [];
  if (hasGlobalTable) {
    for (let i = 0; i < tableEntries; i += 1) {
      globalTable.push([bytes[at], bytes[at + 1], bytes[at + 2]]);
      at += 3;
    }
  }

  let frames = 0;
  let loops = null;
  const delays = [];
  let pendingDelay = null;
  while (at < bytes.length) {
    const marker = bytes[at];
    if (marker === 0x3b) break; // trailer
    if (marker === 0x21) {
      const label = bytes[at + 1];
      at += 2;
      if (label === 0xf9) {
        const size = bytes[at];
        pendingDelay = bytes[at + 2] | (bytes[at + 3] << 8);
        at += size + 1;
        at += 1; // block terminator
      } else if (label === 0xff) {
        const size = bytes[at];
        const name = String.fromCharCode(...bytes.slice(at + 1, at + 1 + size));
        at += size + 1;
        while (bytes[at] !== 0) {
          const blockSize = bytes[at];
          if (name.startsWith("NETSCAPE") && bytes[at + 1] === 1) {
            loops = bytes[at + 2] | (bytes[at + 3] << 8);
          }
          at += blockSize + 1;
        }
        at += 1;
      } else {
        while (bytes[at] !== 0) at += bytes[at] + 1;
        at += 1;
      }
      continue;
    }
    if (marker === 0x2c) {
      frames += 1;
      if (pendingDelay !== null) {
        delays.push(pendingDelay);
        pendingDelay = null;
      }
      const localPacked = bytes[at + 9];
      at += 10;
      if ((localPacked & 0x80) !== 0) at += 3 * (2 << (localPacked & 0x07));
      at += 1; // LZW minimum code size
      while (bytes[at] !== 0) at += bytes[at] + 1;
      at += 1;
      continue;
    }
    return { valid: false, why: `unexpected byte 0x${marker.toString(16)} at ${at}`, frames };
  }

  return {
    valid: true,
    header,
    width,
    height,
    byteLength: bytes.length,
    frames,
    globalTableEntries: tableEntries,
    globalTable,
    uniqueDelays: [...new Set(delays)],
    loops,
  };
}

/** The step table `start` and `startAll` dispatch through. */
const steps = {
  reset,
  openImage,
  responsiveness,
  animates,
  roundTrip,
  surpriseSeed,
  playback,
  seam,
  brokenSeam,
  seamValidatorDirect,
  gif,
  batch,
  documentPalette: async () => say("documentPalette", documentPalette()),
};

globalThis.__probe = { results, state, start, startAll, steps, describeGif };
console.log("PROBE ready {}");
