import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/** This directory, resolved from the module rather than from the working
 * directory — the build is run from `web/` in CI and from wherever a developer
 * happens to be standing locally, and a root that depends on that is a build
 * that works on one machine. */
const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * Build configuration for the GPU golden harness page.
 *
 * Separate from `web/vite.config.ts` for the same reason `vitest.config.ts` is:
 * that file configures *serving the app* — cross-origin isolation headers for
 * the dev server, polled watching across the Docker bind mount, the WASM
 * package exclusion from dependency pre-bundling — and none of it should be
 * able to change what the reference images are rendered from.
 *
 * The harness is built rather than served from the dev server on purpose. A
 * reference set produced from a hot-reloading server is a reference set whose
 * inputs include whatever was in the module graph at that moment; a build is one
 * artifact, produced the same way locally and in CI.
 *
 * Vite is what makes this possible at all: the registry finds effects with
 * `import.meta.glob` and every effect imports its WGSL with `?raw`, so a runner
 * that did not go through Vite's transform pipeline would be testing a different
 * module graph than the app has.
 */
export default defineConfig({
  root: here,
  // Relative, so the built page works from any static server root.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Same target as the app. The GPU layer uses top-level await and modern
    // syntax; downlevelling it here would test transpiled code the app does not
    // ship.
    target: "esnext",
    // The harness is read by a machine, not stepped through in a debugger, and
    // an unminified bundle makes a shader compilation error name a real file.
    minify: false,
    sourcemap: false,
  },
});
