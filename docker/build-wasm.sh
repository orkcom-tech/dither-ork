#!/usr/bin/env bash
# Builds core/ to WebAssembly and writes the package to web/src/wasm/pkg.
#
# Threads: the rayon pool needs WASM atomics and shared memory, which are only
# available on nightly with -Zbuild-std. RUSTFLAGS below turn them on, and the
# nightly toolchain is pinned by the image (see docker/wasm.Dockerfile) so an
# overnight compiler release cannot break a build with no local change.
#
# Modes:
#   once   build and exit. Used by `docker compose run --rm wasm` and by the
#          watcher for each rebuild, so it must exit — a mode that blocks here
#          would leave every incremental rebuild hanging.
#   watch  build, then rebuild on every change under core/crates.
set -euo pipefail

MODE="${1:-once}"
OUT_DIR="/app/web/src/wasm/pkg"
CRATE_DIR="/app/core/crates/dither-wasm"
TOOLCHAIN="${RUST_NIGHTLY:?RUST_NIGHTLY is not set — the image must pin it}"

export RUSTFLAGS='-C target-feature=+atomics,+bulk-memory,+mutable-globals'

log() { printf '[build-wasm] %s\n' "$*"; }

build() {
  log "building dither-wasm on ${TOOLCHAIN} -> ${OUT_DIR}"
  local start status
  start=$(date +%s)
  status=0
  rustup run "${TOOLCHAIN}" wasm-pack build "${CRATE_DIR}" \
    --target web \
    --out-dir "${OUT_DIR}" \
    --out-name dither_wasm \
    -- -Z build-std=panic_abort,std || status=$?

  if [ "${status}" -ne 0 ]; then
    # Never silent: say what failed and that the previous package is still in
    # place, so a stale artefact is not mistaken for a fresh one.
    log "FAILED after $(( $(date +%s) - start ))s (exit ${status}); ${OUT_DIR} left as it was"
    return "${status}"
  fi

  log "done in $(( $(date +%s) - start ))s"
}

case "${MODE}" in
  once)
    build
    ;;
  watch)
    # A first-build failure must not be fatal here: the watcher has to stay up
    # so that fixing the source triggers a rebuild instead of requiring a
    # restart of the whole service. The failure is logged above either way.
    build || log "initial build failed — watching anyway, fix the source to retry"
    log "watching /app/core/crates for changes"
    exec cargo watch \
      --workdir /app/core \
      --watch crates \
      --ignore target \
      --shell '/usr/local/bin/build-wasm.sh once'
    ;;
  *)
    log "unknown mode: ${MODE} (expected \"once\" or \"watch\")"
    exit 64
    ;;
esac
