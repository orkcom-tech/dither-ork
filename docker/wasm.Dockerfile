# Every version here is pinned on purpose.
#
# An unpinned `nightly` means the WASM build can break with no local change,
# from a compiler released overnight, on a toolchain the project only uses for
# -Zbuild-std. That failure is expensive to diagnose because nothing in the
# repository changed. Bumping these is a commit, which is the point: the bump
# is reviewable and revertible.
FROM rust:1.97-bookworm

# The stable toolchain only builds the two tools below; the WASM build itself
# runs on nightly. Pinned so a tool release cannot change the output either.
ARG WASM_PACK_VERSION=0.15.0
ARG CARGO_WATCH_VERSION=8.5.3

RUN rustup target add wasm32-unknown-unknown \
 && cargo install wasm-pack --locked --version "${WASM_PACK_VERSION}" \
 && cargo install cargo-watch --locked --version "${CARGO_WATCH_VERSION}"

# Nightly is required for the -Zbuild-std flags that enable WASM atomics and
# bulk-memory, which the rayon thread pool depends on. To bump: change the date,
# rebuild, and confirm `docker compose up` still reaches the smoke test.
ARG RUST_NIGHTLY=nightly-2026-08-01

RUN rustup toolchain install "${RUST_NIGHTLY}" --profile minimal \
 && rustup component add rust-src --toolchain "${RUST_NIGHTLY}" \
 && rustup target add wasm32-unknown-unknown --toolchain "${RUST_NIGHTLY}"

# CI gates on `cargo fmt --check` and `cargo clippy -D warnings`. The base image
# does not ship either component, so without this you cannot run locally what CI
# will fail you on — and finding that out from a red pipeline is the wrong place.
RUN rustup component add rustfmt clippy

# build-wasm.sh invokes the toolchain by name, so it has to agree with the pin
# above. Passing it through the environment keeps the two from drifting apart.
ENV RUST_NIGHTLY=${RUST_NIGHTLY}

COPY docker/build-wasm.sh /usr/local/bin/build-wasm.sh
RUN chmod +x /usr/local/bin/build-wasm.sh

WORKDIR /app
CMD ["/usr/local/bin/build-wasm.sh", "once"]
