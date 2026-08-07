/**
 * Does the production build actually start?
 *
 * Every other suite in this repository runs against the source tree. `npm test`
 * imports modules through Vite's resolver, the GPU goldens build their own
 * harness bundle, and `cargo test` never sees the web at all. None of them loads
 * `web/dist`. So the class of defect that only exists *after* bundling — a
 * worker entry that does not resolve under the production base, an asset the
 * page cannot fetch, an import that only worked because the dev server rewrote
 * it — was invisible to all three, and shipped.
 *
 * This is the missing check, and it is deliberately narrow: serve the real
 * `web/dist` with the headers `web/dist/_headers` asks for, open it in the
 * pinned browser, and require that the application reaches a running editor
 * session. It asserts nothing about pixels — that is the GPU goldens' job. It
 * asserts that the thing boots.
 *
 * ## What counts as booted, and why each part is required
 *
 * 1. **No startup screen.** `StartupFailureScreen` and `UnsupportedScreen` both
 *    render an `h1.screen__title`. Its presence is the failure, and its text is
 *    quoted into the verdict, so the report names what the user would have seen.
 * 2. **The shell is on screen.** `.shell` is `App`'s root element. Absent, the
 *    page rendered nothing at all, which a "no failure screen" check alone would
 *    happily call a pass.
 * 3. **`editor session ready` was logged.** The shell can mount before the
 *    render worker has come up. This line is emitted by `state/session.ts` after
 *    the worker has started, its GPU device is live and the WASM core has
 *    reported its version — so it is the one statement that the render path
 *    exists, and it is emitted at `info`, which production logging keeps.
 * 4. **Nothing failed on the wire and nothing was uncaught.** A 404 on a chunk,
 *    a COEP refusal or a top-level throw fails the run even when the DOM looks
 *    right, because those are how this fails next time.
 *
 * ## Why the headers come out of `dist/_headers`
 *
 * Because that file is what production is configured by, and it has no schema —
 * Cloudflare Pages drops a malformed rule rather than rejecting it. CI already
 * greps the file and the deploy re-checks the served response; this closes the
 * remaining gap by *using* it: the browser gets exactly the `/*` block the build
 * emitted, so a build that stops emitting cross-origin isolation fails here as
 * a dead application rather than in production as one.
 *
 * ## Running it
 *
 *     docker build -t dither-ork-gpu-golden web/test/gpu-golden
 *     docker run --rm -v "$PWD/web:/app/web" dither-ork-gpu-golden node test/boot/run.mjs
 *
 * The browser image is the GPU goldens' — one pinned Chrome for Testing in this
 * repository, not two. `DITHER_ORK_CHROME` points at a build outside the image.
 *
 * Set `DITHER_ORK_BOOT_URL` to point the same check at a deployed origin instead
 * of the local build. Nothing is served in that mode and `_headers` is not read:
 * the site's own response headers decide whether the document is cross-origin
 * isolated, which is the thing worth checking about a deployment. This is how a
 * deploy is verified — the assertion is the same one, against the real host.
 */

import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describeContext, launch, PINNED_VERSION } from "../gpu-golden/chrome.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
/** `web/` */
const webRoot = resolve(here, "..", "..");
const distRoot = join(webRoot, "dist");

/**
 * How long the application gets to reach a running session.
 *
 * SwiftShader compiles every WGSL pass on a CPU rasteriser, so device bring-up
 * in this environment is seconds rather than the tens of milliseconds a real
 * driver takes. Generous on purpose: a slow browser must not be reported as a
 * broken build. A genuine failure does not wait for the deadline — a startup
 * screen or an uncaught exception ends the wait immediately.
 */
const BOOT_TIMEOUT_MS = 60_000;

/** The line `state/session.ts` logs once the worker, device and core are up. */
const READY_LINE = "editor session ready";

/**
 * Requests the *browser or the host* makes, which the build never asked for.
 *
 * `/favicon.ico` is Chrome's own speculative fetch for a document with no icon
 * link; `/cdn-cgi/` is Cloudflare's analytics endpoint, injected into the
 * response after the build produced it. Neither is a module, an asset or a
 * capability, and neither failing has any bearing on whether the application
 * starts. Everything else the page asks for and does not get is a failure —
 * that is the whole point of watching the network here.
 */
const IGNORED_REQUESTS = ["/favicon.ico", "/cdn-cgi/"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
};

/**
 * The response headers `dist/_headers` asks for on `/*`.
 *
 * Parsed rather than hard-coded, for the reason in the file header: the point is
 * to serve what the build emitted. The format is Cloudflare's — a line in column
 * zero is a path pattern, indented lines under it are `Name: value` headers —
 * and only the `/*` block is read, because that is the only rule this file has
 * ever contained and a second one would be a change worth failing on.
 */
function headersFromBuild() {
  const path = join(distRoot, "_headers");
  if (!existsSync(path)) {
    throw new Error(
      `${path} is missing from the build output. Production is configured by that file; ` +
        `without it the deployed application is not cross-origin isolated and cannot start.`,
    );
  }
  const headers = {};
  let inGlobal = false;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      inGlobal = raw.trim() === "/*";
      continue;
    }
    if (!inGlobal) continue;
    const at = raw.indexOf(":");
    if (at === -1) throw new Error(`_headers has a malformed rule line: ${raw.trim()}`);
    headers[raw.slice(0, at).trim()] = raw.slice(at + 1).trim();
  }
  const required = ["Cross-Origin-Opener-Policy", "Cross-Origin-Embedder-Policy"];
  const missing = required.filter((name) => headers[name] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `_headers does not set ${missing.join(" and ")} on /*. SharedArrayBuffer would be ` +
        `absent and the capability check would refuse to start the application.`,
    );
  }
  return headers;
}

/** Serve `web/dist` exactly as the build asks to be served. */
function serve(root, headers) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const path = join(root, decodeURIComponent(requested));
    // A 404 here is a finding, not plumbing: it is precisely how a bundled
    // worker or a WASM asset goes missing from the production output. It is
    // reported to the browser and recorded by the driver's network listener.
    if (!path.startsWith(root) || !existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end(`not found: ${requested}`);
      return;
    }
    response.writeHead(200, {
      ...headers,
      "Content-Type": MIME[extname(path)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(path).pipe(response);
  });
  return new Promise((resolveListening) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveListening({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** What the page looks like right now, in the terms this check cares about. */
const VERDICT = `(() => {
  const root = document.getElementById("root");
  const title = document.querySelector(".screen__title");
  const detail = Array.from(document.querySelectorAll(".screen__detail"))
    .map((node) => node.textContent.trim())
    .filter((text) => text.length > 0);
  const rows = Array.from(document.querySelectorAll(".screen__table tbody tr")).map((row) =>
    Array.from(row.children).map((cell) => cell.textContent.trim()).join(" — "),
  );
  return {
    rendered: root === null ? -1 : root.childElementCount,
    screenTitle: title === null ? null : title.textContent.trim(),
    screenDetail: detail,
    screenRows: rows,
    shell: document.querySelector(".shell") !== null,
  };
})()`;

/** Either a local server over `web/dist`, or a deployed origin to point at. */
async function target() {
  const deployed = process.env.DITHER_ORK_BOOT_URL;
  if (deployed !== undefined && deployed.length > 0) {
    process.stderr.write(`checking the deployed origin ${deployed}\n`);
    return { origin: deployed, close: async () => {} };
  }
  if (!existsSync(join(distRoot, "index.html"))) {
    throw new Error(
      `${distRoot} has no index.html. This check runs against the production build; ` +
        `run \`npm run build\` in web/ first, or set DITHER_ORK_BOOT_URL to a deployed origin.`,
    );
  }
  const headers = headersFromBuild();
  const site = await serve(distRoot, headers);
  process.stderr.write(
    `serving ${distRoot} at ${site.origin} with ` +
      Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}`)
        .join(", ") +
      "\n",
  );
  return site;
}

async function main() {
  const site = await target();

  const browser = await launch(site.origin, { port: 9223 });
  const { page } = browser;
  const version = browser.version?.Browser ?? "unknown";
  process.stderr.write(`browser: ${version} (pinned ${PINNED_VERSION})\n`);
  process.stderr.write(
    `devtools in ${browser.timings.devtoolsMs}ms, page load in ${browser.timings.loadedMs}ms\n`,
  );

  const failures = [];
  let verdict = null;
  try {
    // React renders exactly one of four things into #root: the shell, the
    // unsupported screen, the startup failure screen, or nothing. Waiting for
    // "one of them is there" rather than for the shell alone is what lets a
    // failure be *reported* instead of timing out with no explanation.
    await page.waitFor(
      `document.querySelector(".shell") || document.querySelector(".screen__title")`,
      { timeoutMs: BOOT_TIMEOUT_MS, what: "the application shell or a startup screen" },
    );
    verdict = await page.evaluate(VERDICT);

    if (verdict.screenTitle !== null) {
      const detail = [...verdict.screenDetail, ...verdict.screenRows];
      failures.push(
        `the application showed a startup screen: "${verdict.screenTitle}"` +
          (detail.length === 0 ? "" : `\n  ${detail.join("\n  ")}`),
      );
    }
    if (!verdict.shell) {
      failures.push("the application shell (.shell) never rendered");
    }

    // The shell can be on screen before the render worker is up, so the session
    // is waited for separately — and only when the shell is actually there,
    // because after a startup screen it is never coming and the wait would
    // spend the whole budget saying nothing.
    if (verdict.shell) {
      const deadline = Date.now() + BOOT_TIMEOUT_MS;
      while (!page.diagnostics.some((line) => line.includes(READY_LINE))) {
        if (Date.now() >= deadline) {
          failures.push(
            `the render worker never came up: "${READY_LINE}" was not logged within ` +
              `${BOOT_TIMEOUT_MS}ms. The shell renders before the session exists, so a page ` +
              `that looks right can still have no render path.`,
          );
          break;
        }
        await new Promise((done) => setTimeout(done, 100));
      }
    }
  } catch (error) {
    failures.push(String(error instanceof Error ? error.message : error));
  }

  const uncaught = page.diagnostics.filter((line) => line.startsWith("UNCAUGHT"));
  if (uncaught.length > 0) failures.push(`uncaught in the page:\n  ${uncaught.join("\n  ")}`);

  const network = page.diagnostics
    .filter((line) => line.startsWith("network: FAILED") || line.startsWith("network: HTTP"))
    .filter((line) => !IGNORED_REQUESTS.some((pattern) => line.includes(pattern)));
  if (network.length > 0) {
    failures.push(`the build asked for something it did not get:\n  ${network.join("\n  ")}`);
  }

  const context = await page.context().catch(() => null);
  await browser.close();
  await site.close();

  if (failures.length > 0) {
    process.stderr.write(
      `\nthe production build did not boot.\n\n${failures.join("\n\n")}\n\n` +
        `${describeContext(context)}\n\n` +
        `page transcript:\n  ${page.diagnostics.join("\n  ")}\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `the production build boots: shell rendered, no startup screen, ` +
      `"${READY_LINE}" logged, nothing failed to load.\n`,
  );
}

await main();
