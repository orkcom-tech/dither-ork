#!/usr/bin/env bash
# Keeps the node_modules volume honest.
#
# `node_modules` is a named volume so the host tree stays clean, but Docker only
# seeds a named volume while it is empty. Without this check, changing
# package.json would leave the volume holding the dependency set from whenever
# it was first created, and the only cure would be knowing to run
# `docker compose down -v` — a footgun that presents as an inexplicable build
# error rather than as a stale install.
#
# So: hash the lockfile, compare against the hash recorded at install time, and
# reinstall when they differ. Both branches log, because a silent reinstall is
# as confusing as a silent skip.
set -euo pipefail

LOCKFILE=/app/web/package-lock.json
STAMP=/app/web/node_modules/.dither-ork-lock-hash

log() { printf '[web] %s\n' "$*"; }

if [ ! -f "${LOCKFILE}" ]; then
  log "FATAL: ${LOCKFILE} is missing — the lockfile is committed and required"
  exit 1
fi

current=$(sha256sum "${LOCKFILE}" | cut -d' ' -f1)
installed=$(cat "${STAMP}" 2>/dev/null || echo "none")

if [ "${current}" != "${installed}" ]; then
  log "lockfile ${current:0:12} != installed ${installed:0:12} — running npm ci"
  npm ci --no-audit --no-fund
  printf '%s' "${current}" > "${STAMP}"
  log "dependencies installed at ${current:0:12}"
else
  log "dependencies up to date at ${current:0:12}"
fi

exec "$@"
