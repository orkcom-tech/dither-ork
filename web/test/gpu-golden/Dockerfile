# The pinned environment the GPU reference images are valid for.
#
# docs/ARCHITECTURE.md, "Determinism": "GPU results are deterministic per
# device. Golden-image tests for the CPU path run anywhere; the GPU goldens need
# a pinned environment, since WebGPU implementation variance across drivers is
# real." This image is that environment, and it contains exactly two pinned
# things: a Node base image, and one build of Chrome for Testing.
#
# `--platform=linux/amd64` is not a portability oversight, it is the point.
# Chrome for Testing ships no linux-arm64 build, and more importantly the whole
# value of the reference set is that every machine renders it with the same
# SwiftShader code. An arm64 build would be a second reference set.
#
# The base is `node:22-bookworm-slim`, the same image `docker/web.Dockerfile`
# uses, so the harness runner's Node is pinned the way this repository already
# pins Node rather than by a second mechanism. Bookworm also matters: the
# dependency names Chrome declares are Debian's pre-t64 ones, and they resolve
# on bookworm exactly as written.
FROM --platform=linux/amd64 node:22-bookworm-slim

# Version lives in chrome-version.txt and nowhere else, so the Dockerfile, the
# runner's assertion and the CI job all read one file. Changing it means
# re-blessing, which is why it is a reviewable one-line diff.
COPY chrome-version.txt /tmp/chrome-version.txt

RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates unzip wget; \
    version="$(tr -d '[:space:]' < /tmp/chrome-version.txt)"; \
    wget -q -O /tmp/chrome.zip \
      "https://storage.googleapis.com/chrome-for-testing-public/${version}/linux64/chrome-linux64.zip"; \
    unzip -q /tmp/chrome.zip -d /opt; \
    rm /tmp/chrome.zip; \
    # The build ships its own dependency list. Reading it beats maintaining a
    # copy that goes stale the first time Chrome picks up a new library.
    sed -e 's/ (.*)//' -e 's/ |.*//' /opt/chrome-linux64/deb.deps \
      | xargs apt-get install -y --no-install-recommends; \
    rm -rf /var/lib/apt/lists/*; \
    /opt/chrome-linux64/chrome --version

ENV DITHER_ORK_CHROME=/opt/chrome-linux64/chrome
WORKDIR /app/web
# Nothing from node_modules is imported by the runner — it is Node built-ins and
# two local modules — so this image never needs an install.
CMD ["node", "test/gpu-golden/run.mjs"]
