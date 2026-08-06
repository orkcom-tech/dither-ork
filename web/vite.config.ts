import { defineConfig } from "vite";

/**
 * Cross-origin isolation is not optional here.
 *
 * The WASM thread pool needs SharedArrayBuffer, which browsers only expose when
 * the document is cross-origin isolated, which requires exactly these two
 * response headers. Without them `crossOriginIsolated` is false, the startup
 * capability check (F-UI-12) fails, and the app refuses to start rather than
 * silently running single-threaded.
 *
 * Production hosting must set the same pair — see docs/ARCHITECTURE.md,
 * "Hosting". GitHub Pages cannot, which is why it is not an option.
 */
const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
} as const;

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 5173,
    headers: crossOriginIsolationHeaders,
    watch: {
      // The container bind-mounts the source tree; native FS events do not
      // cross that boundary reliably on macOS and Windows hosts.
      usePolling: true,
      interval: 300,
    },
  },
  preview: {
    port: 4173,
    headers: crossOriginIsolationHeaders,
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    // The WASM package is generated into the tree by the `wasm` service and is
    // not a node_modules dependency; pre-bundling it breaks the glue code.
    exclude: ["./src/wasm/pkg/dither_wasm.js"],
  },
  build: {
    target: "esnext",
  },
});
