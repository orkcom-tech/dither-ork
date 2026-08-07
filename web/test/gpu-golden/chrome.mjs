/**
 * Launching headless Chromium and talking to it.
 *
 * No Playwright, no Puppeteer, no npm dependency at all: the whole interaction
 * is "open a page, call two functions on it, read the results back", which is a
 * handful of DevTools protocol methods over a WebSocket that Node has had built
 * in since 22. A browser automation library would add a second version to pin
 * beside the browser, and it is the browser version that decides what the
 * reference images look like.
 *
 * ## The flags, and which of them are load-bearing
 *
 * `--use-webgpu-adapter=swiftshader` is the one that matters. It forces Dawn onto
 * SwiftShader's Vulkan implementation — a CPU rasteriser with no driver
 * underneath it — so the result is a property of the Chromium build and not of
 * whatever GPU happens to be in the machine. docs/ARCHITECTURE.md records that
 * "WebGPU implementation variance across browsers and drivers produces small
 * visual differences"; a golden rendered on a real driver would encode one
 * vendor's variance and fail everywhere else.
 *
 * `--enable-unsafe-webgpu` is required with it. Chromium reports
 * `webgpu: unavailable_software` and returns no adapter at all when the GPU
 * stack is software-only, which is exactly the configuration this harness wants;
 * the switch is how a caller says it means it. (Measured: without it,
 * `requestAdapter()` resolves to `null` on this image every time.)
 *
 * `--no-sandbox` and `--disable-dev-shm-usage` are the usual container pair.
 * `--headless=new` is the full browser in headless mode; the old headless shell
 * has no GPU process and therefore no WebGPU.
 *
 * Everything else Chromium does by default is left alone. A flag added because
 * it "might help" is a flag nobody can remove later without re-blessing.
 *
 * ## Why the browser starts on `about:blank`
 *
 * It used to be launched straight at the harness URL, which made the page load a
 * race against the driver connecting to it. That race was lost on a GitHub
 * runner and won on a slower emulated laptop, and losing it produced the least
 * useful failure this repository has yet shipped:
 *
 *     TypeError: Cannot read properties of undefined (reading 'init')
 *
 * — the harness global was simply not there yet, and no diagnostics had been
 * subscribed to in time to say why. Now the browser opens a blank document, the
 * driver enables every domain that can carry an explanation, installs the
 * page-side error hooks, and only then navigates. Nothing that happens in the
 * harness document can happen before somebody is listening for it.
 *
 * ## What is listened to, and why each one
 *
 * - **`Runtime.consoleAPICalled`** — everything the page logs, with the stack of
 *   the call for anything at `error` level.
 * - **`Runtime.exceptionThrown`** — uncaught exceptions *and* unhandled promise
 *   rejections, with the real stack. A module that throws during top-level
 *   execution arrives here and nowhere else.
 * - **`Log.entryAdded`** — the browser's own log: failed subresource loads, CSP
 *   and CORS refusals, COEP blocking. This domain buffers entries and replays
 *   them on `Log.enable`, which is what makes an early failure recoverable at all.
 * - **`Network.loadingFailed` / `Network.responseReceived`** — a 404 or a
 *   `blockedReason` on the module bundle or the `.wasm` asset, named with its
 *   URL. "A missing asset under the relative base" is otherwise a blank page.
 *
 * All of it goes to stderr as it arrives, prefixed `[page]`, and is kept so a
 * failure can quote it. The rule this file now obeys: **the page is never
 * allowed to fail silently.**
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

/** The Chrome for Testing build the reference set is blessed against. */
export const PINNED_VERSION = readFileSync(join(here, "chrome-version.txt"), "utf8").trim();

/**
 * Where to find the browser.
 *
 * `DITHER_ORK_CHROME` first, because CI unpacks the pinned build to a path of
 * its own choosing. Then the location the harness Dockerfile installs it to.
 * There is no fallback to a system Chrome: a reference set blessed against
 * whatever version happened to be on the machine is not a reference set, and
 * silently using one would be exactly the "plausible-looking wrong result" this
 * repository refuses everywhere else.
 */
export function resolveChrome() {
  const fromEnv = process.env.DITHER_ORK_CHROME;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    if (!existsSync(fromEnv)) {
      throw new Error(`DITHER_ORK_CHROME points at ${fromEnv}, which does not exist`);
    }
    return fromEnv;
  }
  const installed = "/opt/chrome-linux64/chrome";
  if (existsSync(installed)) return installed;
  throw new Error(
    `no Chrome for Testing ${PINNED_VERSION} found. Set DITHER_ORK_CHROME, or run the ` +
      `harness through its Docker image — see docs/DEVELOPMENT.md, "GPU golden images".`,
  );
}

export const CHROME_FLAGS = [
  "--headless=new",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--enable-unsafe-webgpu",
  "--use-webgpu-adapter=swiftshader",
  // Nothing on the page needs the network, and a proxy probe or a component
  // update mid-run is a source of variance and of minutes.
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-component-update",
  "--disable-background-networking",
  "--disable-extensions",
];

/**
 * Page-side hooks, installed before the harness document exists.
 *
 * `Runtime.exceptionThrown` already reports both of these, and they are here
 * anyway: this version runs *inside* the page, so the message survives into
 * `__ditherOrkPageErrors` for a driver that connects late or reconnects, and an
 * `error` event fired for a subresource that failed to load carries a target the
 * protocol event does not.
 */
const PAGE_HOOKS = `
(() => {
  const store = (globalThis.__ditherOrkPageErrors ??= []);
  const describe = (value) =>
    value instanceof Error
      ? \`\${value.name}: \${value.message}\\n\${value.stack ?? "(no stack)"}\`
      : String(value);
  addEventListener("error", (event) => {
    const detail =
      event.error !== undefined && event.error !== null
        ? describe(event.error)
        : \`\${event.message ?? "load error"} at \${event.filename ?? "?"}:\${event.lineno ?? 0}\` +
          (event.target && event.target !== globalThis && event.target.src
            ? \` (loading \${event.target.src})\`
            : "");
    store.push(\`window error: \${detail}\`);
  }, true);
  addEventListener("unhandledrejection", (event) => {
    store.push(\`unhandled rejection: \${describe(event.reason)}\`);
  });
})();
`;

function remoteObjectText(object) {
  if (object === undefined || object === null) return "";
  if (object.unserializableValue !== undefined) return String(object.unserializableValue);
  if (object.value !== undefined) {
    return typeof object.value === "string" ? object.value : JSON.stringify(object.value);
  }
  return object.description ?? object.className ?? object.type ?? "";
}

function stackText(trace, indent = "    ") {
  if (trace === undefined || trace.callFrames === undefined) return "";
  return trace.callFrames
    .map(
      (frame) =>
        `${indent}at ${frame.functionName === "" ? "<anonymous>" : frame.functionName} ` +
        `(${frame.url === "" ? "<anonymous>" : frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`,
    )
    .join("\n");
}

function locationText(url, lineNumber, columnNumber) {
  if (url === undefined || url === "") return "";
  const line = lineNumber === undefined ? "" : `:${lineNumber + 1}`;
  const column = columnNumber === undefined ? "" : `:${columnNumber + 1}`;
  return ` (${url}${line}${column})`;
}

/**
 * How much of what the page says is echoed live.
 *
 * `all` during startup, because that is the phase whose failures had nowhere to
 * appear. `problems` once the harness is running, because ninety-six renders
 * times three debug lines is a log nobody reads — and a log nobody reads is the
 * same silence in a larger font. Nothing is *discarded* at either setting: the
 * full transcript is kept and quoted by any failure.
 */
const ECHO_LEVELS = ["all", "problems", "none"];

/** Lines that are echoed even at `problems`. */
function isProblem(line) {
  return (
    line.startsWith("UNCAUGHT") ||
    line.startsWith("console.error") ||
    line.startsWith("console.warning") ||
    line.startsWith("console.assert") ||
    line.startsWith("network: FAILED") ||
    line.startsWith("network: HTTP") ||
    /^log\[[^\]]*\/(error|warning)\]/.test(line)
  );
}

/** How many lines of transcript to keep. Enough for a whole run; bounded anyway. */
const MAX_DIAGNOSTICS = 4000;

/**
 * How long to wait for the browser to actually be gone before its profile
 * directory is removed.
 *
 * `kill()` returns when the signal is *delivered*, not when the browser process
 * and its renderer and GPU children have finished writing. Removing the
 * directory inside that window fails with `ENOTEMPTY`, and on a GitHub runner it
 * did — from a `finally`, where the throw replaced the run's real verdict with a
 * stack trace about a temporary directory. Waiting closes the window; the
 * retries below cover what is left of it, and the `catch` covers the rest.
 */
const EXIT_TIMEOUT_MS = 5_000;

/** One connected page, with the protocol calls the harness makes. */
export class Page {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #diagnostics = [];
  #dropped = 0;
  #requestUrls = new Map();
  #eventWaiters = [];
  #echo;

  constructor(socket, { echo = "all" } = {}) {
    this.#socket = socket;
    this.#echo = echo;
    socket.onmessage = (event) => this.#receive(String(event.data));
  }

  /**
   * Everything the page has said, in order.
   *
   * Console, uncaught exceptions, browser log entries and failed loads all land
   * in one list on purpose: the order they happened in is most of the diagnosis,
   * and three separate lists would have to be interleaved by a reader.
   */
  get diagnostics() {
    return this.#dropped === 0
      ? this.#diagnostics
      : [`(${this.#dropped} earlier line(s) dropped)`, ...this.#diagnostics];
  }

  /** Switch how much is echoed live. See {@link ECHO_LEVELS}. */
  setEcho(level) {
    if (!ECHO_LEVELS.includes(level)) {
      throw new Error(`unknown echo level "${level}"; expected one of ${ECHO_LEVELS.join(", ")}`);
    }
    this.#echo = level;
  }

  #record(line) {
    this.#diagnostics.push(line);
    if (this.#diagnostics.length > MAX_DIAGNOSTICS) {
      this.#diagnostics.shift();
      this.#dropped += 1;
    }
    if (this.#echo === "all" || (this.#echo === "problems" && isProblem(line))) {
      for (const part of line.split("\n")) process.stderr.write(`[page] ${part}\n`);
    }
  }

  #receive(text) {
    const message = JSON.parse(text);

    if (message.method !== undefined) {
      this.#event(message.method, message.params ?? {});
      for (const waiter of this.#eventWaiters.splice(0)) {
        if (waiter.method === message.method) waiter.resolve(message.params ?? {});
        else this.#eventWaiters.push(waiter);
      }
      return;
    }

    const id = message.id;
    if (id === undefined) return;
    const waiting = this.#pending.get(id);
    if (waiting === undefined) return;
    this.#pending.delete(id);
    if (message.error !== undefined) waiting.reject(new Error(JSON.stringify(message.error)));
    else waiting.resolve(message.result);
  }

  #event(method, params) {
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const args = (params.args ?? []).map(remoteObjectText).join(" ");
        const stack = params.type === "error" ? stackText(params.stackTrace) : "";
        this.#record(`console.${params.type}: ${args}${stack === "" ? "" : `\n${stack}`}`);
        return;
      }
      case "Runtime.exceptionThrown": {
        const details = params.exceptionDetails ?? {};
        const head =
          details.exception?.description ?? details.text ?? "an exception with no message";
        const where = locationText(details.url, details.lineNumber, details.columnNumber);
        const stack = stackText(details.stackTrace);
        this.#record(`UNCAUGHT ${head}${where}${stack === "" ? "" : `\n${stack}`}`);
        return;
      }
      case "Log.entryAdded": {
        const entry = params.entry ?? {};
        const where = locationText(entry.url, entry.lineNumber, undefined);
        const stack = stackText(entry.stackTrace);
        this.#record(
          `log[${entry.source ?? "?"}/${entry.level ?? "?"}] ${entry.text ?? ""}${where}` +
            (stack === "" ? "" : `\n${stack}`),
        );
        return;
      }
      case "Network.requestWillBeSent": {
        this.#requestUrls.set(params.requestId, params.request?.url ?? "?");
        return;
      }
      case "Network.responseReceived": {
        const status = params.response?.status ?? 0;
        if (status >= 400) {
          this.#record(`network: HTTP ${status} for ${params.response?.url ?? "?"}`);
        }
        return;
      }
      case "Network.loadingFailed": {
        const url = this.#requestUrls.get(params.requestId) ?? params.requestId;
        const blocked =
          params.blockedReason === undefined ? "" : ` blockedReason=${params.blockedReason}`;
        const cors =
          params.corsErrorStatus === undefined
            ? ""
            : ` cors=${params.corsErrorStatus.corsError ?? "?"}`;
        this.#record(
          `network: FAILED ${params.type ?? "?"} ${url} — ${params.errorText ?? "?"}${blocked}${cors}`,
        );
        return;
      }
      default:
        return;
    }
  }

  send(method, params = {}) {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Resolve when `method` next arrives, or reject after `timeoutMs`. */
  once(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#eventWaiters = this.#eventWaiters.filter((w) => w.resolve !== wrapped);
        reject(new Error(`${method} did not arrive within ${timeoutMs}ms`));
      }, timeoutMs);
      const wrapped = (params) => {
        clearTimeout(timer);
        resolve(params);
      };
      this.#eventWaiters.push({ method, resolve: wrapped });
    });
  }

  /**
   * Evaluate an expression and return its value.
   *
   * A thrown exception comes back as a rejected promise carrying the page's own
   * message and stack, not as `undefined`. The whole reason this harness exists
   * is that silence looks like success.
   */
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails !== undefined) {
      const details = result.exceptionDetails;
      const head = details.exception?.description ?? details.text ?? "the page threw with no message";
      const stack = stackText(details.stackTrace);
      throw new Error(`${head}${stack === "" ? "" : `\n${stack}`}`);
    }
    return result.result?.value;
  }

  /**
   * Poll `expression` until it is true, or fail saying what the page looked like.
   *
   * Polling rather than an event because the thing being waited for — a module
   * having finished its top-level execution and assigned a global — has no
   * protocol event of its own. `load` fires whether the module threw or not.
   */
  async waitFor(expression, { timeoutMs, what }) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // `evaluate` would throw on a reference to a global that is not there;
      // this expression cannot throw, so a `false` is genuinely "not yet".
      const ready = await this.evaluate(`Boolean(${expression})`);
      if (ready === true) return;
      // An uncaught exception means the answer is never going to change, and
      // spending the whole budget before saying so buries the one line that
      // explains the run under half a minute of nothing.
      const fatal = this.#diagnostics.filter((line) => line.startsWith("UNCAUGHT"));
      if (fatal.length > 0) {
        throw new Error(`${what} will never appear — the page threw:\n${fatal.join("\n")}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`${what} did not appear within ${timeoutMs}ms (waiting on: ${expression})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Facts about the document worth putting in every startup failure. */
  async context() {
    return this.evaluate(`(() => {
      const scripts = Array.from(document.querySelectorAll("script")).map((s) => s.src || "(inline)");
      return {
        href: location.href,
        readyState: document.readyState,
        crossOriginIsolated: globalThis.crossOriginIsolated === true,
        isSecureContext: globalThis.isSecureContext === true,
        sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
        webgpu: typeof navigator.gpu !== "undefined",
        scripts,
        pageErrors: globalThis.__ditherOrkPageErrors ?? [],
        harnessGlobal: typeof globalThis.__ditherOrkGolden,
      };
    })()`);
  }

  close() {
    this.#socket.close();
  }
}

/** The page context rendered for a human, for use in a failure message. */
export function describeContext(context) {
  if (context === null || context === undefined) return "the page context could not be read";
  const lines = [
    `url: ${context.href}`,
    `document.readyState: ${context.readyState}`,
    `crossOriginIsolated: ${context.crossOriginIsolated}  isSecureContext: ${context.isSecureContext}`,
    `SharedArrayBuffer: ${context.sharedArrayBuffer}  navigator.gpu: ${context.webgpu}`,
    `window.__ditherOrkGolden: ${context.harnessGlobal}`,
    `scripts: ${context.scripts.join(", ")}`,
  ];
  if (context.pageErrors.length > 0) {
    lines.push(`page-side errors:\n  ${context.pageErrors.join("\n  ")}`);
  }
  return lines.join("\n");
}

async function fetchJson(url, attempts, delayMs) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      last = new Error(`${url} -> HTTP ${response.status}`);
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`${url} never answered: ${String(last)}`);
}

/**
 * Launch the browser, subscribe to everything, then navigate to `url`.
 *
 * The order is the point and is described at the top of this file: domains
 * enabled and page hooks installed on a blank document, navigation second, so
 * the harness document cannot fail before anything is listening.
 *
 * The caller gets an async `close()` that kills the process, waits for it to be
 * gone, and then removes the profile directory. Leaving either behind turns a
 * second run in the same container into a confusing "profile in use" failure;
 * removing the directory before the process has finished with it is the
 * `ENOTEMPTY` described at {@link EXIT_TIMEOUT_MS}.
 */
export async function launch(url, { port = 9222, onStderr, loadTimeoutMs = 60_000 } = {}) {
  const binary = resolveChrome();
  const profile = mkdtempSync(join(tmpdir(), "dither-ork-golden-"));
  const child = spawn(
    binary,
    [
      ...CHROME_FLAGS,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    // Its own process group, so shutdown can kill the whole browser rather than
    // one process of it. Chrome forks a zygote, a GPU process and a renderer,
    // and none of them is a child of Node — signalling the launcher leaves them
    // running, still holding the profile directory open. That is what the
    // `ENOTEMPTY` at {@link EXIT_TIMEOUT_MS} actually was, and waiting longer
    // would not have fixed it.
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );

  const stderr = [];
  child.stderr.on("data", (data) => {
    const text = String(data);
    stderr.push(text);
    if (onStderr !== undefined) onStderr(text);
  });
  child.stdout.on("data", (data) => stderr.push(String(data)));

  let exited = null;
  const exit = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      resolve(exited);
    });
  });

  /**
   * Remove the profile directory, and never fail a run over it.
   *
   * `rmSync` retries `ENOTEMPTY` itself when asked, which covers a child that
   * outlived the wait by a few milliseconds. Anything that survives ten retries
   * is a leaked temporary directory in a container that is about to exit: worth
   * a line on stderr, and not worth a verdict.
   */
  const removeProfile = () => {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      process.stderr.write(
        `could not remove the browser profile at ${profile}: ${String(error)}\n` +
          `this is a temporary directory and does not affect the run's result.\n`,
      );
    }
  };

  /**
   * Kill the browser's whole process group, falling back to the launcher alone.
   *
   * `ESRCH` means it is already gone, which is the normal outcome of a second
   * call and not a problem to report.
   */
  const killGroup = () => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") child.kill("SIGKILL");
    }
  };

  const cleanup = async () => {
    if (exited === null) {
      killGroup();
      await Promise.race([
        exit,
        new Promise((resolve) => setTimeout(resolve, EXIT_TIMEOUT_MS)),
      ]);
    }
    removeProfile();
  };

  // Measured and reported on every run, not because anyone tunes it but because
  // these two numbers *are* the bug that produced this file's rewrite. On a
  // GitHub runner the debugging port answered 453 ms after spawn and the old
  // code evaluated at 509 ms, long before an 804 kB module had run; on an
  // emulated x86-64 container the port took 2.2 s, by which time the module had
  // finished, and the same code passed. Printing both means the next person to
  // see them far apart does not have to discover that story again.
  const spawnedAt = performance.now();

  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, 150, 200);
    const devtoolsAt = performance.now();
    const target = targets.find((t) => t.type === "page");
    if (target === undefined) {
      throw new Error("the browser started but exposed no page target");
    }

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error("could not open a DevTools websocket"));
    });

    const page = new Page(socket);
    // Every domain that can carry an explanation, before the document that
    // needs explaining exists. `Log.enable` also replays what the browser has
    // already buffered, which is how a failure that beat us here is recovered.
    await page.send("Runtime.enable");
    await page.send("Log.enable");
    await page.send("Network.enable");
    await page.send("Page.enable");
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HOOKS });

    const loaded = page.once("Page.loadEventFired", loadTimeoutMs);
    const navigation = await page.send("Page.navigate", { url });
    if (navigation.errorText !== undefined) {
      throw new Error(`navigating to ${url} failed: ${navigation.errorText}`);
    }
    await loaded;

    return {
      page,
      version: await fetchJson(`http://127.0.0.1:${port}/json/version`, 5, 200),
      timings: {
        devtoolsMs: Math.round(devtoolsAt - spawnedAt),
        loadedMs: Math.round(performance.now() - spawnedAt),
      },
      stderr,
      close: async () => {
        page.close();
        await cleanup();
      },
    };
  } catch (error) {
    await cleanup();
    const detail = exited === null ? "" : ` (browser exited: ${JSON.stringify(exited)})`;
    throw new Error(
      `could not drive the browser${detail}: ${String(error)}\n${stderr.join("").slice(-2000)}`,
    );
  }
}
