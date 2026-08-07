# Security

## What this application is

A static client-side application. It is HTML, JavaScript, WebAssembly and WGSL
shaders served as files.

- **No server.** There is no backend, no API, no database.
- **No network calls at runtime.** Your images are read with the File API,
  processed on your GPU and CPU, and written back with a download. Nothing is
  uploaded, because there is nowhere to upload it to.
- **No data collection.** No analytics, no telemetry, no error reporting, no
  cookies, no accounts.
- **What is kept on disk, and where.** Two files in the browser's origin-private
  file system — `autosave.dork.json`, so a document returns on reload, and
  `presets.dorkpresets.json` — plus one `localStorage` entry holding the light
  or dark choice. Neither file holds an image — the autosave record references
  the source it was built against rather than embedding it, and a preset is a
  recipe. Clearing site data removes all three.
- **Share links carry the recipe, not the picture.** The document travels in the
  URL fragment, which browsers do not send to servers, and the image is never
  included.

The consequences are worth stating plainly: an incident here cannot leak your
images, because they never left the machine, and there is no account to
compromise.

## What the attack surface actually is

- **Untrusted images.** Decoding is the browser's own image pipeline; the app
  receives pixels. A malformed `.dork` document is parsed and validated by
  `web/src/io/document`, and that is the one place where hostile input meets our
  own parser.
- **Share links.** A link's fragment is a document someone else wrote. It is
  validated by the same code path as a file, and it cannot contain an image or
  any code.
- **Dependencies.** Runtime dependencies are React, `react-dom` and `@dnd-kit`.
  Everything else is a build-time or test dependency, pinned in
  `web/package-lock.json` and `core/Cargo.lock`.

## Reporting

Report privately through
[GitHub Security Advisories](https://github.com/orkcom-tech/dither-ork/security/advisories/new).
Please do not open a public issue for a vulnerability.

Include what you did, what happened, and what you expected. A `.dork` file or a
share link that reproduces it is worth more than a description.

This is a personal project with one maintainer; expect a response in days, not
hours. Fixes land on `main` — there is no supported-version matrix, because
there is only ever the latest.
