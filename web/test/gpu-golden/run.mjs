/**
 * Golden-image harness for the parallel catalogue.
 *
 * `core/crates/dither-core/tests/golden.rs` calls golden images "the only
 * defence against a plausible-looking coefficient typo", and the argument
 * transfers whole to the GPU side: a halftone screen is a table of dot areas
 * transcribed from a printer's practice, a displacement kernel is an index
 * arithmetic expression, and getting either subtly wrong still produces a
 * picture. The whole parallel catalogue had nothing but a human looking at a
 * page.
 *
 * This file is the Node half. `harness.ts` renders inside headless Chromium
 * against a software adapter and hands frames back; everything about the
 * reference tree — what is expected, what is compared, what is rewritten — lives
 * here, so there is exactly one place that decides whether an image is being
 * checked or replaced.
 *
 * ## Shape, deliberately the same as the CPU harness
 *
 * - **Generated fixture, stored outputs.** `fixture.ts` is code a reviewer can
 *   read; the fixture's own PNG is written beside the references so a change to
 *   the generator is one image diff instead of eighty-eight unexplained ones.
 * - **A stated tolerance with the reasoning for it**, below.
 * - **An environment-variable re-bless mode that says so loudly**, on the real
 *   stderr, because a harness nobody can regenerate is a harness that gets
 *   deleted the first time a deliberate change lands.
 * - **Orphan detection.** A stored reference that no registered effect produces
 *   fails the run. That is what makes "an effect that stops being discovered
 *   fails loudly" true rather than aspirational: the catalogue is enumerated
 *   from the registry, so an effect that vanishes takes its planned renders with
 *   it and leaves its references behind with nothing to match them.
 *
 * ## The tolerance, and why it is one code value rather than zero
 *
 * The CPU harness compares byte for byte and argues, correctly for it, that
 * there is no rounding slack to allow: every output pixel there is a palette
 * colour, so the only thing that can differ is a *decision*, and decisions do
 * not differ by a little.
 *
 * The GPU catalogue is not like that. Half of it — blur, glow, vignette, warp,
 * emboss, chromatic aberration — writes continuous colour, computed in
 * `rgba16float` through `exp`, `pow`, `sqrt` and trigonometry, and encoded to
 * eight bits at the end. Those are exactly the operations a compiler is free to
 * contract or reassociate, and SwiftShader's JIT emits code for whatever
 * instruction set it finds at runtime — a GitHub Actions runner with FMA and one
 * without can legitimately land a smooth gradient one code value either side of a
 * rounding boundary. Demanding zero would make the job flaky on a difference
 * that is not a defect, and a flaky golden set is one people learn to re-bless
 * without looking.
 *
 * So: **every channel of every pixel must be within {@link MAX_CHANNEL_DELTA} of
 * the reference.** That is 1/255 of full scale, four hundred times smaller than
 * the smallest defect worth catching. `perturb.mjs` measures the margin rather
 * than asserting it exists — a one-cell transposition in a halftone screen moves
 * a third of the frame by tens of levels, and the numbers are in the report.
 *
 * What the tolerance costs is stated too: a defect that moves every pixel by
 * exactly one level — an `amount` parameter off by a fraction of a percent —
 * passes. Nothing else in the suite would catch that either, and the harness
 * prints every image that differs at all, so drift is visible in the log even
 * when it passes.
 */

import { createServer } from "node:http";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describeContext, launch, PINNED_VERSION } from "./chrome.mjs";
import { decodePng, encodePng } from "./png.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
/** `web/` */
const webRoot = resolve(here, "..", "..");
const distRoot = join(here, "dist");
const referenceRoot = join(webRoot, "fixtures", "gpu");

/** Set to anything but `0` to rewrite the reference tree. */
const BLESS_VAR = "DITHER_ORK_BLESS";

/**
 * Directory to drop the frames a failing run actually produced, if set.
 *
 * A failure message says a third of the frame moved; it cannot say the halftone
 * screen came out rotated. CI sets this and uploads the directory when the job
 * goes red, so the first thing a reviewer sees is the picture beside the
 * reference rather than a number they have to reproduce locally to understand.
 * Unset, nothing is written — a check run must not leave files behind.
 */
const ARTIFACT_VAR = "DITHER_ORK_GOLDEN_ARTIFACTS";

/** Largest per-channel difference an image may carry and still pass. */
const MAX_CHANNEL_DELTA = 1;

/**
 * How long to wait for the harness module to finish its top-level execution.
 *
 * The page's `load` event has already fired by the time this is waited on, so
 * under any normal outcome the global is there on the first poll. The budget is
 * generous because the alternative — assuming — is what produced the failure
 * this exists to prevent, and a slow runner must not be diagnosed as a broken
 * module.
 */
const HARNESS_READY_TIMEOUT_MS = 30_000;

/**
 * The adapter the reference set is valid for.
 *
 * Asserted, not assumed. A run that silently picked up a real GPU would produce
 * a set that encodes one driver's behaviour and fails on every other machine —
 * and it would produce it quietly, which is worse than producing nothing.
 */
const REQUIRED_ADAPTER_ARCHITECTURE = "swiftshader";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serve the built harness with cross-origin isolation.
 *
 * Both headers are mandatory and neither is decoration: the WASM core is built
 * with atomics, so its memory is shared, so it will not instantiate without
 * `SharedArrayBuffer`, which browsers expose only to a cross-origin isolated
 * document. Without them the ordered dithers cannot get a threshold tile and
 * the five ordered dithers have no passes at all. It is the same pair
 * `web/vite.config.ts` sends and `web/public/_headers` ships.
 */
function serve(root) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const path = join(root, decodeURIComponent(requested));
    if (!path.startsWith(root) || !existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end(`not found: ${requested}`);
      return;
    }
    response.writeHead(200, {
      "Content-Type": MIME[extname(path)] ?? "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cache-Control": "no-store",
    });
    createReadStream(path).pipe(response);
  });
  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () => res({ server, port: server.address().port }));
  });
}

function blessRequested() {
  const value = process.env[BLESS_VAR];
  return value !== undefined && value.length > 0 && value !== "0";
}

/**
 * Write a banner straight to stderr.
 *
 * Named for the CPU harness's `announce`, and here for the same reason: a bless
 * run succeeds, and a message saying "everything you were checking has just been
 * overwritten" must not be something a reader has to go looking for.
 */
function announce(message) {
  const bar = "=".repeat(78);
  process.stderr.write(`\n${bar}\n${BLESS_VAR}: ${message}\n${bar}\n`);
}

function goldenPath(effect, variant) {
  return join(referenceRoot, "golden", effect, `${variant}.png`);
}

function sourcePath(fixtureId) {
  return join(referenceRoot, "source", `${fixtureId}.png`);
}

function writePng(path, rgba, width, height) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodePng(rgba, width, height));
}

function walkPng(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkPng(path));
    else if (entry.name.endsWith(".png")) out.push(path);
  }
  return out;
}

/**
 * How two frames differ, or `null` when they are inside tolerance and identical.
 *
 * Reports the count, the fraction, the largest per-channel difference and the
 * first differing pixel, for the reason the CPU harness gives: a handful of
 * pixels is a divergence that started at one decision, a large fraction is a
 * changed coefficient, and the two are diagnosed completely differently.
 */
function compare(reference, got, width) {
  let differing = 0;
  let worst = 0;
  let first = null;

  for (let i = 0; i < reference.length; i += 4) {
    let pixelWorst = 0;
    for (let c = 0; c < 4; c += 1) {
      const delta = Math.abs(reference[i + c] - got[i + c]);
      if (delta > pixelWorst) pixelWorst = delta;
    }
    if (pixelWorst === 0) continue;
    differing += 1;
    if (pixelWorst > worst) worst = pixelWorst;
    if (first === null) {
      const p = i / 4;
      first = {
        x: p % width,
        y: Math.floor(p / width),
        want: Array.from(reference.subarray(i, i + 4)),
        have: Array.from(got.subarray(i, i + 4)),
      };
    }
  }

  if (differing === 0) return null;
  const total = reference.length / 4;
  return {
    differing,
    total,
    percent: (100 * differing) / total,
    worst,
    first,
    exceeds: worst > MAX_CHANNEL_DELTA,
  };
}

function describe(diff) {
  return (
    `${diff.differing} of ${diff.total} pixels differ (${diff.percent.toFixed(2)}%), ` +
    `largest channel delta ${diff.worst}/255; first at (${diff.first.x}, ${diff.first.y}): ` +
    `reference [${diff.first.want.join(", ")}], this build [${diff.first.have.join(", ")}]`
  );
}

/** How far a frame moved from the fixture, and how bright it came out. */
function vitals(fixture, frame) {
  let changed = 0;
  let luma = 0;
  const pixels = frame.length / 4;
  for (let i = 0; i < frame.length; i += 4) {
    if (
      Math.abs(frame[i] - fixture[i]) > 1 ||
      Math.abs(frame[i + 1] - fixture[i + 1]) > 1 ||
      Math.abs(frame[i + 2] - fixture[i + 2]) > 1
    ) {
      changed += 1;
    }
    luma += (0.2126 * frame[i] + 0.7152 * frame[i + 1] + 0.0722 * frame[i + 2]) / 255;
  }
  return { changed: changed / pixels, luma: luma / pixels };
}

/**
 * Refuse a reference pair that records nothing.
 *
 * The failure a golden set cannot catch is the one it was blessed against: an
 * effect that returns its input, or a black rectangle, is stored as the truth
 * and passes forever. `web/src/main.ts` flags both by eye on its proof page;
 * this is the same check with the eye removed, and it runs in bless mode too —
 * which is the only place it can do any good.
 *
 * Judged across both variants rather than each one. The identity at defaults is
 * a legitimate opening state for a rearrangement node — a channel swap opens
 * with every output reading its own channel — so it is only a finding when the
 * far end of the surprise range does nothing either.
 *
 * `MOVED` is deliberately low. It is not a claim about how much an effect should
 * change; it is the line below which the reference contains no information about
 * the shader at all.
 */
function vacuous(byEffect) {
  const MOVED = 0.005;
  const LIT = 0.01;
  const found = [];
  for (const [effect, seen] of byEffect) {
    const movedMost = Math.max(...seen.map((s) => s.changed));
    const brightest = Math.max(...seen.map((s) => s.luma));
    if (movedMost < MOVED) {
      found.push(
        `${effect}: returned its input unchanged at its declared defaults AND at the far end ` +
          `of its surprise range (${(movedMost * 100).toFixed(3)}% of pixels moved). Its ` +
          `reference images record nothing about the shader.`,
      );
    } else if (brightest < LIT) {
      found.push(
        `${effect}: rendered an almost black frame in every variant (mean luminance ` +
          `${(brightest * 100).toFixed(2)}%). A reference of a black rectangle passes forever.`,
      );
    }
  }
  return found;
}

async function main() {
  const bless = blessRequested();
  const artifactSetting = process.env[ARTIFACT_VAR];
  const artifactRoot =
    artifactSetting === undefined || artifactSetting.length === 0
      ? null
      : resolve(artifactSetting);

  if (!existsSync(join(distRoot, "index.html"))) {
    throw new Error(
      `the harness is not built. Run:\n  npx vite build --config test/gpu-golden/vite.config.ts\n` +
        `from web/, then run this again.`,
    );
  }

  const { server, port } = await serve(distRoot);
  const url = `http://127.0.0.1:${port}/`;
  console.log(`serving ${relative(webRoot, distRoot)} on ${url}`);

  const browser = await launch(url, {
    port: 10000 + Math.floor(Math.random() * 40000),
  });
  const failures = [];
  const drifted = [];
  /** Per effect, one entry per variant. Feeds the vacuity check below. */
  const vitalsByEffect = new Map();
  let checked = 0;
  let written = 0;

  /**
   * Everything the page has said, laid out for a failure message.
   *
   * Called from every startup failure path rather than composed at each one, so
   * there is no path that reports less than another. `run.mjs` used to print an
   * anonymous `TypeError` and nothing else; the cost of that was measured in
   * hours.
   */
  const pageReport = async (headline) => {
    const context = await browser.page.context().catch((error) => {
      process.stderr.write(`could not read the page context: ${String(error)}\n`);
      return null;
    });
    const recorded = await browser.page
      .evaluate("window.__ditherOrkGoldenError ?? null")
      .catch(() => null);
    const diagnostics = browser.page.diagnostics;
    return new Error(
      `${headline}\n\n` +
        `page:\n${describeContext(context)
          .split("\n")
          .map((l) => `  ${l}`)
          .join("\n")}\n\n` +
        (recorded === null ? "" : `the harness recorded:\n  ${recorded.split("\n").join("\n  ")}\n\n`) +
        (diagnostics.length === 0
          ? "the page produced no console output, no exceptions and no failed loads at all — " +
            "which usually means the module never ran.\n"
          : `everything the page said, in order:\n  ${diagnostics.join("\n").split("\n").join("\n  ")}\n`),
    );
  };

  try {
    console.log(
      `browser: ${browser.version.Browser} (pinned ${PINNED_VERSION}) — ` +
        `devtools answered ${browser.timings.devtoolsMs}ms after spawn, ` +
        `document loaded at ${browser.timings.loadedMs}ms`,
    );

    // Asserted before anything is asked of the harness, because the failure it
    // catches — the WASM core's shared memory refusing to instantiate without
    // SharedArrayBuffer — surfaces deep inside `init()` as something else
    // entirely. `serve()` above sends both headers; this is the page confirming
    // it actually got them.
    const context = await browser.page.context().catch(() => null);
    if (context === null) {
      throw await pageReport(
        "the page could not even be interrogated — it has no live execution context. The " +
          "navigation failed, or the renderer died.",
      );
    }
    console.log(
      `page: ${context.href} readyState=${context.readyState} ` +
        `crossOriginIsolated=${context.crossOriginIsolated} ` +
        `SharedArrayBuffer=${context.sharedArrayBuffer} navigator.gpu=${context.webgpu}`,
    );
    if (context.crossOriginIsolated !== true || context.sharedArrayBuffer !== true) {
      throw await pageReport(
        `the harness page is not cross-origin isolated, so SharedArrayBuffer is unavailable and ` +
          `the WASM core — built with +atomics, so its memory is shared — cannot instantiate. ` +
          `Every response must carry Cross-Origin-Opener-Policy: same-origin and ` +
          `Cross-Origin-Embedder-Policy: require-corp.`,
      );
    }

    // The module is deferred, so `load` has fired and it has either finished or
    // thrown. Waiting a little past that covers nothing but a slow machine; the
    // failure below is the one that used to read "Cannot read properties of
    // undefined (reading 'init')".
    try {
      await browser.page.waitFor("window.__ditherOrkGolden", {
        timeoutMs: HARNESS_READY_TIMEOUT_MS,
        what: "window.__ditherOrkGolden",
      });
    } catch (error) {
      throw await pageReport(
        `the harness module never assigned window.__ditherOrkGolden — it threw during top-level ` +
          `execution, or it never loaded. ${String(error)}`,
      );
    }

    let info;
    try {
      info = await browser.page.evaluate("window.__ditherOrkGolden.init()");
    } catch (error) {
      throw await pageReport(`the harness page failed to start: ${String(error)}`);
    }

    // Startup is over and it is the only phase whose failures were invisible.
    // From here the page logs three debug lines per render; keeping them all on
    // stderr would bury the one that matters. Nothing stops being recorded.
    browser.page.setEcho("problems");

    const architecture = String(info.adapter.architecture ?? "");
    if (!architecture.includes(REQUIRED_ADAPTER_ARCHITECTURE)) {
      throw new Error(
        `the adapter reports architecture "${architecture}", not "${REQUIRED_ADAPTER_ARCHITECTURE}". ` +
          `Reference images are only reproducible on the software rasteriser; a set blessed on ` +
          `a real driver encodes that driver's behaviour. Check the browser flags in chrome.mjs.`,
      );
    }
    console.log(
      `adapter: ${info.adapter.vendor}/${architecture} — palette ${info.palette.id} ` +
        `(${info.palette.entries} entries), fixture ${info.fixture.id} ` +
        `${info.fixture.width}x${info.fixture.height}`,
    );
    console.log(
      `registry reports ${info.registry.gpu} gpu effect(s) of ${info.registry.total}; ` +
        `${info.plan.length} render(s) planned`,
    );
    if (info.plan.length === 0) {
      throw new Error(
        "the registry reported no gpu effects at all — discovery is broken, and a harness " +
          "that compares nothing would pass",
      );
    }

    if (bless) {
      announce(
        `REWRITING the reference tree at ${relative(webRoot, referenceRoot)}\n` +
          `${BLESS_VAR} is set, so nothing is being checked — every reference below is being\n` +
          `replaced with whatever this build produces. Review the diff before committing it.`,
      );
      // Wholesale, so an effect that has been renamed or removed does not leave
      // a stale reference behind that nothing reads and nobody notices.
      for (const dir of [join(referenceRoot, "source"), join(referenceRoot, "golden")]) {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // The fixture itself. Nothing reads it back as input — the input is always
    // the generator — but a reviewer can see what the catalogue was fed.
    const fixtureRgba = new Uint8Array(Buffer.from(info.fixture.rgba, "base64"));
    const fixtureFile = sourcePath(info.fixture.id);
    if (bless) {
      writePng(fixtureFile, fixtureRgba, info.fixture.width, info.fixture.height);
      written += 1;
    } else {
      checked += 1;
      // The fixture is generated by deterministic integer arithmetic in
      // `fixture.ts`, so it cannot land inside the tolerance without landing on
      // it exactly. Any difference at all means the generator changed, which is
      // a decision to make deliberately rather than a rounding budget to spend.
      const outcome = settle(fixtureFile, fixtureRgba, info.fixture.width, info.fixture.height);
      if (typeof outcome === "string") {
        failures.push(outcome);
      } else if (outcome !== null) {
        failures.push(
          `${outcome.note} — the fixture generator produces integers, so this is a change to ` +
            `fixture.ts and every reference below it needs re-blessing.`,
        );
      }
    }

    for (let i = 0; i < info.plan.length; i += 1) {
      const planned = info.plan[i];
      const label = `${planned.effect}/${planned.variant}`;
      const progress = `[${String(i + 1).padStart(3)}/${info.plan.length}]`;

      const result = await browser.page.evaluate(`window.__ditherOrkGolden.render(${i})`);
      if (result.ok !== true) {
        failures.push(`${label}: the effect did not render — ${result.error}`);
        console.log(`${progress} ${label} FAILED TO RENDER`);
        continue;
      }

      const rgba = new Uint8Array(Buffer.from(result.rgba, "base64"));
      const seen = vitalsByEffect.get(planned.effect) ?? [];
      seen.push(vitals(fixtureRgba, rgba));
      vitalsByEffect.set(planned.effect, seen);

      const path = goldenPath(planned.effect, planned.variant);
      if (bless) {
        writePng(path, rgba, info.fixture.width, info.fixture.height);
        written += 1;
        console.log(`${progress} ${label} written`);
        continue;
      }

      checked += 1;
      const outcome = settle(path, rgba, info.fixture.width, info.fixture.height);
      if (outcome === null) {
        console.log(`${progress} ${label} identical`);
      } else if (typeof outcome === "string") {
        failures.push(outcome);
        console.log(`${progress} ${label} MISMATCH`);
        if (artifactRoot !== null) {
          writePng(
            join(artifactRoot, planned.effect, `${planned.variant}.actual.png`),
            rgba,
            info.fixture.width,
            info.fixture.height,
          );
          if (existsSync(path)) {
            mkdirSync(join(artifactRoot, planned.effect), { recursive: true });
            writeFileSync(
              join(artifactRoot, planned.effect, `${planned.variant}.reference.png`),
              readFileSync(path),
            );
          }
        }
      } else {
        drifted.push(outcome.note);
        console.log(`${progress} ${label} within tolerance — ${outcome.note}`);
      }
    }

    // Runs in both modes. In check mode it catches an effect that has quietly
    // become a no-op since it was blessed; in bless mode it is the only thing
    // standing between a broken shader and a reference image of its output.
    for (const finding of vacuous(vitalsByEffect)) failures.push(finding);

    if (!bless) {
      const expected = new Set([
        sourcePath(info.fixture.id),
        ...info.plan.map((p) => goldenPath(p.effect, p.variant)),
      ]);
      for (const found of walkPng(referenceRoot)) {
        if (!expected.has(found)) {
          failures.push(
            `${relative(webRoot, found)}: orphaned reference — no registered effect and variant ` +
              `produces this path. An effect was renamed, removed, or has stopped being ` +
              `discovered. Delete it, or re-bless.`,
          );
        }
      }
    }
  } finally {
    browser.close();
    server.close();
  }

  if (bless) {
    announce(
      `wrote ${written} reference image(s) under ${relative(webRoot, referenceRoot)}. ` +
        `Re-run without ${BLESS_VAR} to verify them.`,
    );
    if (failures.length > 0) {
      // Written and then refused, in that order on purpose: the images are on
      // disk so the finding can be looked at, and the exit code is non-zero so
      // nothing downstream treats the tree as blessed.
      console.error(
        `\nThe tree was written, but ${failures.length} of the effect(s) in it produced a ` +
          `reference that records nothing. Do not commit this until each is understood:\n\n` +
          failures.map((f) => `  ${f}`).join("\n") +
          "\n",
      );
      return 1;
    }
    return 0;
  }

  if (drifted.length > 0) {
    console.log(
      `\n${drifted.length} image(s) differ from their reference but stay within the ` +
        `${MAX_CHANNEL_DELTA}/255 tolerance. That is allowed and it is not nothing — if this ` +
        `count grows, the environment has stopped being pinned:\n  ${drifted.join("\n  ")}`,
    );
  }

  if (failures.length > 0) {
    console.error(
      `\n${failures.length} of ${checked} reference image(s) did not match:\n\n` +
        failures.map((f) => `  ${f}`).join("\n") +
        (artifactRoot === null
          ? ""
          : `\n\nThe frames this build produced, beside their references, are in ${artifactRoot}.`) +
        `\n\nIf this change is intended, regenerate with:\n` +
        `  ${BLESS_VAR}=1 node test/gpu-golden/run.mjs\n`,
    );
    return 1;
  }

  console.log(
    `\n${checked} reference image(s) matched, ` +
      `${drifted.length === 0 ? "byte for byte" : `${drifted.length} within tolerance`}.`,
  );
  return 0;
}

/**
 * Compare one image against its reference.
 *
 * Returns `null` when identical, `{ note }` when it differs inside tolerance,
 * and a string when it is a failure. Three outcomes rather than a boolean
 * because "differs but passes" is real information and swallowing it would hide
 * the environment drifting out from under the set.
 */
function settle(path, rgba, width, height) {
  if (!existsSync(path)) {
    return (
      `${relative(webRoot, path)}: no reference image. Generate one with ${BLESS_VAR}=1 ` +
      `and review it before committing.`
    );
  }

  let reference;
  try {
    reference = decodePng(readFileSync(path));
  } catch (error) {
    return `${relative(webRoot, path)}: unreadable reference — ${String(error)}`;
  }

  if (reference.width !== width || reference.height !== height) {
    return (
      `${relative(webRoot, path)}: reference is ${reference.width}x${reference.height}, ` +
      `this build produced ${width}x${height}`
    );
  }

  const diff = compare(reference.rgba, rgba, width);
  if (diff === null) return null;
  if (diff.exceeds) return `${relative(webRoot, path)}: ${describe(diff)}`;
  return { note: `${relative(webRoot, path)}: ${describe(diff)}` };
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`\ngpu golden harness failed: ${error?.stack ?? String(error)}`);
    process.exit(1);
  });
