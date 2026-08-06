import { defineConfig } from "vitest/config";

/**
 * Test runner configuration.
 *
 * Separate from `vite.config.ts` rather than folded into it, because everything
 * that file configures is about serving the app — cross-origin isolation
 * headers, polled file watching across the Docker bind mount, the WASM package
 * exclusion from dependency pre-bundling. None of it applies to a test process,
 * and inheriting it would mean a change made for the dev server could quietly
 * change how tests run. Vitest prefers this file when it exists, so the two
 * configurations never merge.
 *
 * What is *not* here is as deliberate:
 *
 * - **No `globals: true`.** Every test file imports `describe`/`it`/`expect`
 *   explicitly, so `tsc --noEmit` type-checks the tests with the same strictness
 *   as the source without the tsconfig needing a `types` entry it would then
 *   have to keep in sync.
 * - **No DOM environment.** Nothing under test touches `document` or `window`;
 *   the registry, the hash and the cache are deliberately free of browser
 *   dependencies, and running them in a real Node environment is what keeps that
 *   true. A test that needs a DOM is a signal that a layer has grown one.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // One process per file. Module state is not shared between test files, so a
    // file that changes the global log level cannot leak that into another.
    isolate: true,
    // Fail rather than hang: everything here is pure computation over a few
    // kilobytes, so a test that takes seconds has gone wrong.
    testTimeout: 10_000,
  },
});
