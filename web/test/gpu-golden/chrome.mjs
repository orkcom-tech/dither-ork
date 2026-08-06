/**
 * Launching headless Chromium and talking to it.
 *
 * No Playwright, no Puppeteer, no npm dependency at all: the whole interaction
 * is "open a page, call two functions on it, read the results back", which is
 * three DevTools protocol methods over a WebSocket that Node has had built in
 * since 22. A browser automation library would add a second version to pin
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

/** One connected page, with the three protocol calls the harness makes. */
export class Page {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #consoleLines = [];

  constructor(socket) {
    this.#socket = socket;
    socket.onmessage = (event) => this.#receive(String(event.data));
  }

  get consoleLines() {
    return this.#consoleLines;
  }

  #receive(text) {
    const message = JSON.parse(text);
    if (message.method === "Runtime.consoleAPICalled") {
      const args = (message.params.args ?? [])
        .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? a.type)))
        .join(" ");
      this.#consoleLines.push(`${message.params.type}: ${args}`);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      this.#consoleLines.push(
        `uncaught: ${details.exception?.description ?? details.text}`,
      );
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

  send(method, params = {}) {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Evaluate an expression and return its value.
   *
   * A thrown exception comes back as a rejected promise carrying the page's own
   * message, not as `undefined`. The whole reason this harness exists is that
   * silence looks like success.
   */
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails !== undefined) {
      const details = result.exceptionDetails;
      throw new Error(
        details.exception?.description ?? details.text ?? "the page threw with no message",
      );
    }
    return result.result?.value;
  }

  close() {
    this.#socket.close();
  }
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
 * Launch the browser on `url` and hand back the connected page.
 *
 * The caller gets a `close()` that kills the process and removes the profile
 * directory. Leaving either behind turns a second run in the same container into
 * a confusing "profile in use" failure.
 */
export async function launch(url, { port = 9222, onStderr } = {}) {
  const binary = resolveChrome();
  const profile = mkdtempSync(join(tmpdir(), "dither-ork-golden-"));
  const child = spawn(
    binary,
    [...CHROME_FLAGS, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, url],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const stderr = [];
  child.stderr.on("data", (data) => {
    const text = String(data);
    stderr.push(text);
    if (onStderr !== undefined) onStderr(text);
  });
  child.stdout.on("data", (data) => stderr.push(String(data)));

  let exited = null;
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });

  const cleanup = () => {
    child.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
  };

  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, 150, 200);
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
    // Console and uncaught exceptions are forwarded so a page that dies during
    // startup says why, rather than timing out with nothing to read.
    await page.send("Runtime.enable");

    return {
      page,
      version: await fetchJson(`http://127.0.0.1:${port}/json/version`, 5, 200),
      stderr,
      close: () => {
        page.close();
        cleanup();
      },
    };
  } catch (error) {
    cleanup();
    const detail = exited === null ? "" : ` (browser exited: ${JSON.stringify(exited)})`;
    throw new Error(
      `could not drive the browser${detail}: ${String(error)}\n${stderr.join("").slice(-2000)}`,
    );
  }
}
