FROM rust:1.83-bookworm

# wasm-pack drives wasm-bindgen; wasm32-unknown-unknown is the build target.
RUN rustup target add wasm32-unknown-unknown \
 && cargo install wasm-pack --locked \
 && cargo install cargo-watch --locked

# Nightly is required for the -Zbuild-std flags that enable WASM atomics and
# bulk-memory, which the rayon thread pool depends on.
RUN rustup toolchain install nightly \
 && rustup component add rust-src --toolchain nightly \
 && rustup target add wasm32-unknown-unknown --toolchain nightly

COPY docker/build-wasm.sh /usr/local/bin/build-wasm.sh
RUN chmod +x /usr/local/bin/build-wasm.sh

WORKDIR /app
CMD ["/usr/local/bin/build-wasm.sh", "once"]
