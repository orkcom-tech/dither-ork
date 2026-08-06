#!/usr/bin/env bash
# Builds core/ to WebAssembly and writes the package to web/src/wasm/pkg.
#
# Threads: the rayon pool needs WASM atomics and shared memory, which are only
# available on nightly with -Zbuild-std. RUSTFLAGS below turn them on.
set -euo pipefail

MODE="${1:-once}"
OUT_DIR="/app/web/src/wasm/pkg"
CRATE_DIR="/app/core/crates/dither-wasm"

export RUSTFLAGS='-C target-feature=+atomics,+bulk-memory,+mutable-globals'

log() { printf '[build-wasm] %s\n' "$*"; }

build() {
  log "building dither-wasm -> ${OUT_DIR}"
  local start
  start=$(date +%s)
  rustup run nightly wasm-pack build "${CRATE_DIR}" \
    --target web \
    --out-dir "${OUT_DIR}" \
    --out-name dither_wasm \
    -- -Z build-std=panic_abort,std
  log "done in $(( $(date +%s) - start ))s"
}

build

if [ "${MODE}" = "watch" ]; then
  log "watching /app/core for changes"
  exec cargo watch \
    --workdir /app/core \
    --watch crates \
    --ignore target \
    --shell '/usr/local/bin/build-wasm.sh once'
fi

log "idle"
tail -f /dev/null
