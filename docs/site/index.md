# dither-ork documentation

A browser image ditherer. It opens a picture, runs it through a stack of effects,
and writes the result. Everything happens in the tab — no upload, no account, no
server round trip.

This site is the project's documentation. It is generated from the repository on
every push to `main`, from the same files a contributor reads in the tree.

## Where the app runs

**The app is at <https://dither-ork.pages.dev>, on Cloudflare Pages. It is not
here and it cannot be.**

GitHub Pages serves no custom response headers. The renderer's WASM core is built
with `+atomics`, so its linear memory is shared, so it needs `SharedArrayBuffer`
— and a browser exposes `SharedArrayBuffer` only to a cross-origin isolated
document, which needs two headers on every response:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them the capability check refuses to start, for every visitor, on every
browser. Not a degraded mode — a refusal, correctly, because a renderer that
cannot get its threads is a renderer that would produce the wrong picture slowly.

So the split is deliberate and permanent: **Cloudflare Pages hosts the
application**, because it sets arbitrary headers from a `_headers` file on the
free tier; **GitHub Pages hosts these documents**, which need no headers at all.
Netlify and Vercel also qualify for the app. Neither host is a fallback for the
other, and pointing this site at the built app would ship something that starts
for nobody.

CI asserts both headers are present in the build output on every run, because
`_headers` is a plain text file with no schema and a typo in it fails silently in
production.

## What is on this site

| Page                                    | What it answers                                                            |
| ---                                     | ---                                                                        |
| [Architecture](architecture.html)       | How the thing is put together, what is pinned, and which risks are known    |
| [API](api.html)                         | The contracts between the layers — WASM core, registry, document, GPU, worker |
| [Development](development.html)         | Running it, building it, testing it, and every command that does so         |
| [Requirements](requirements.html)       | Every requirement id in these documents, and the sections that discuss it   |

## What is not on this site, on purpose

**The effect catalogue and the user guide are in the app.** Both are generated
from the sealed effect registry at run time: the guide states no count of its
own, and the catalogue is enumerated from the descriptors rather than listed.
A snapshot of either published here would be correct on the day it shipped and
wrong, with no error anywhere, on the day an effect was added. Open the app and
press `?`.

**Screenshots are in the repository's README**, beside the outputs that produced
them.

## Getting the source

```bash
git clone https://github.com/orkcom-tech/dither-ork
cd dither-ork
docker compose up
```

The [Development](development.html) page is the rest of that story: what the two
compose services do, why the toolchain versions live in a Dockerfile, and how to
run each of the four test suites.
