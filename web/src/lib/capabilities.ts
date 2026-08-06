/**
 * F-UI-12 — startup capability check.
 *
 * One check on load that reports exactly which requirement is unmet, rather
 * than failing somewhere deeper with a confusing symptom.
 *
 * Fatal: WebGPU and SharedArrayBuffer. There is no WebGL2 fallback and no
 * single-threaded fallback — see docs/ARCHITECTURE.md, "Platform support
 * policy". Non-fatal: File System Access and OPFS degrade stated capabilities
 * visibly (batch drops to multi-select in / ZIP out), never silently.
 */

import { logger } from "./log";

const log = logger("app");

export type CapabilityState = "ok" | "missing";

export interface Capability {
  readonly id: string;
  readonly label: string;
  readonly fatal: boolean;
  readonly state: CapabilityState;
  /** What this means for the user, in one line. */
  readonly detail: string;
}

export interface CapabilityReport {
  readonly capabilities: readonly Capability[];
  readonly fatalFailures: readonly Capability[];
  readonly usable: boolean;
  /** Present only when WebGPU is available. */
  readonly adapterInfo?: GPUAdapterInfo;
}

async function checkWebGpu(): Promise<{ cap: Capability; info?: GPUAdapterInfo }> {
  const base = { id: "webgpu", label: "WebGPU", fatal: true } as const;

  if (!("gpu" in navigator)) {
    return {
      cap: {
        ...base,
        state: "missing",
        detail: "navigator.gpu is undefined — this browser does not expose WebGPU.",
      },
    };
  }

  let adapter: GPUAdapter | null = null;
  try {
    adapter = await navigator.gpu.requestAdapter();
  } catch (error) {
    log.error("requestAdapter threw", { error: String(error) });
  }

  if (adapter === null) {
    return {
      cap: {
        ...base,
        state: "missing",
        detail:
          "navigator.gpu exists but no adapter was returned — usually a driver or GPU-blocklist issue.",
      },
    };
  }

  return {
    cap: {
      ...base,
      state: "ok",
      detail: describeAdapter(adapter.info),
    },
    info: adapter.info,
  };
}

function describeAdapter(info: GPUAdapterInfo | undefined): string {
  if (!info) return "adapter acquired";
  const parts = [info.vendor, info.architecture, info.device].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return parts.length > 0 ? parts.join(" / ") : "adapter acquired";
}

function checkSharedArrayBuffer(): Capability {
  const isolated = globalThis.crossOriginIsolated === true;
  const hasSab = typeof SharedArrayBuffer !== "undefined";

  if (isolated && hasSab) {
    return {
      id: "sab",
      label: "SharedArrayBuffer",
      fatal: true,
      state: "ok",
      detail: "cross-origin isolated — the WASM thread pool is available.",
    };
  }

  return {
    id: "sab",
    label: "SharedArrayBuffer",
    fatal: true,
    state: "missing",
    detail: isolated
      ? "cross-origin isolated but SharedArrayBuffer is absent."
      : "not cross-origin isolated — the server is not sending COOP: same-origin and COEP: require-corp.",
  };
}

function checkOpfs(): Capability {
  const ok =
    typeof navigator.storage?.getDirectory === "function";
  return {
    id: "opfs",
    label: "OPFS",
    fatal: false,
    state: ok ? "ok" : "missing",
    detail: ok
      ? "origin private file system available for documents and autosave."
      : "no OPFS — autosave and the preset library fall back to IndexedDB.",
  };
}

function checkFileSystemAccess(): Capability {
  const ok = "showDirectoryPicker" in globalThis;
  return {
    id: "fsa",
    label: "File System Access",
    fatal: false,
    state: ok ? "ok" : "missing",
    detail: ok
      ? "batch can read a folder and write results back to it."
      : "no directory access — batch is multi-select in, ZIP out.",
  };
}

export async function checkCapabilities(): Promise<CapabilityReport> {
  const { cap: webgpu, info } = await checkWebGpu();
  const capabilities: Capability[] = [
    webgpu,
    checkSharedArrayBuffer(),
    checkOpfs(),
    checkFileSystemAccess(),
  ];

  const fatalFailures = capabilities.filter(
    (c) => c.fatal && c.state === "missing",
  );

  for (const c of capabilities) {
    const line = `${c.label}: ${c.state}`;
    if (c.state === "ok") log.info(line, { detail: c.detail });
    else if (c.fatal) log.error(line, { detail: c.detail });
    else log.warn(line, { detail: c.detail });
  }

  const report: CapabilityReport = {
    capabilities,
    fatalFailures,
    usable: fatalFailures.length === 0,
    ...(info ? { adapterInfo: info } : {}),
  };
  return report;
}
