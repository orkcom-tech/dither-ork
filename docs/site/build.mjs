/**
 * The documentation site.
 *
 * Four Markdown files in, five HTML files and one stylesheet out. No generator,
 * no configuration file, no npm dependency, no client-side JavaScript: the whole
 * site is static HTML that a browser renders on the first paint, which is the
 * only performance decision it needs.
 *
 * ## What it publishes, and what it deliberately does not
 *
 * The three documents in `docs/` are the site's content, rendered rather than
 * rewritten — a second copy of `ARCHITECTURE.md` phrased for the web would be a
 * second thing to keep true. `index.md` beside this file is the one page written
 * for the site, and `requirements.html` is built from the corpus.
 *
 * **The effect catalogue and the user guide are not here.** Both are generated
 * in the app from the sealed registry, so the only build that can state them
 * correctly is the one running them: the guide's own header records that a
 * chapter states no count of its own for exactly this reason. Publishing a
 * snapshot of either would produce a page that is right on the day it ships and
 * wrong, silently, on the day an effect is added. The site links to the app
 * instead and says why.
 *
 * ## Usage
 *
 *     node docs/site/build.mjs [--out DIR]
 *
 * Writes to `docs/site/dist` unless told otherwise. Exit code is non-zero when
 * any document contains Markdown outside the supported subset — see
 * `markdown.mjs`, which refuses rather than guesses.
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { escapeHtml, plainText, REQUIREMENT_PATTERN, renderMarkdown } from "./markdown.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

/** Where the app is actually served. Stated once; every page reads it here. */
const APP_URL = "https://dither-ork.pages.dev";
const REPO_URL = "https://github.com/orkcom-tech/dither-ork";

/**
 * The pages, in navigation order.
 *
 * `source` is relative to the repository root. A page with no source is built by
 * this file.
 */
const PAGES = [
  { slug: "index", nav: "Overview", source: "docs/site/index.md" },
  { slug: "architecture", nav: "Architecture", source: "docs/ARCHITECTURE.md" },
  { slug: "api", nav: "API", source: "docs/API.md" },
  { slug: "development", nav: "Development", source: "docs/DEVELOPMENT.md" },
  { slug: "requirements", nav: "Requirements", source: null },
];

/**
 * The requirement families, expanded.
 *
 * The two-letter code is what the documents write and what a reader has to
 * decode; the expansion is read off how each family is used across the corpus.
 * A code that appears in the documents and is not in this table stops the build,
 * because an index whose rows say "unknown" is an index nobody trusts twice.
 */
const FAMILIES = {
  AN: "Animation",
  CO: "Core and colour",
  DO: "Documents",
  ED: "Error diffusion",
  EX: "Export",
  GL: "Glitch",
  IN: "Input",
  OD: "Ordered dithering",
  PP: "Preprocessing",
  PT: "Pattern and halftone",
  SM: "Surprise Me",
  SP: "Special and stylise",
  ST: "Stack",
  UI: "Interface",
  BA: "Batch",
};

/**
 * Every requirement id in the corpus, and where it is written about.
 *
 * Scanned from the rendered documents rather than from the source tree. That is
 * the honest scope: this index answers "which document discusses F-PP-07", which
 * is a question about the documents, and it cannot go stale because it is
 * rebuilt from them. It does **not** claim to list what is implemented — the
 * registry is the only thing that knows that, and it is in the app.
 */
function buildRequirementIndex(rendered) {
  const found = new Map();
  for (const { page, sections } of rendered) {
    for (const section of sections) {
      for (const id of section.text.match(REQUIREMENT_PATTERN) ?? []) {
        const entry = found.get(id) ?? new Map();
        const key = `${page.slug}#${section.id}`;
        if (!entry.has(key)) {
          entry.set(key, { page, section });
        }
        found.set(id, entry);
      }
    }
  }

  const unknown = [...found.keys()]
    .map((id) => id.split("-")[1])
    .filter((family) => FAMILIES[family] === undefined);
  if (unknown.length > 0) {
    throw new Error(
      `requirement families ${[...new Set(unknown)].join(", ")} appear in the documents and ` +
        `are not in FAMILIES in docs/site/build.mjs. Name them, or the index says nothing.`,
    );
  }

  const byFamily = new Map();
  for (const id of [...found.keys()].sort()) {
    const family = id.split("-")[1];
    const rows = byFamily.get(family) ?? [];
    rows.push({ id, mentions: [...found.get(id).values()] });
    byFamily.set(family, rows);
  }
  return byFamily;
}

function requirementsHtml(byFamily) {
  const total = [...byFamily.values()].reduce((sum, rows) => sum + rows.length, 0);
  const parts = [
    '<h1 id="requirements">Requirements</h1>',
    `<p>Every requirement id written in the documents on this site — ${total} of them, ` +
      `in ${byFamily.size} families — and the sections that discuss each one. Rebuilt from the ` +
      `documents on every deploy, so it cannot drift from them.</p>`,
    "<p>This is an index of the <em>documents</em>. It does not say what is implemented: " +
      `the effect registry is the only thing that knows that, and it is in ` +
      `<a href="${APP_URL}">the app</a>.</p>`,
  ];

  for (const [family, rows] of [...byFamily.entries()].sort()) {
    parts.push(`<h2 id="f-${family.toLowerCase()}">${FAMILIES[family]} <span class="mono">F-${family}</span></h2>`);
    parts.push('<div class="scroll"><table><thead><tr><th>Id</th><th>Written about in</th></tr></thead><tbody>');
    for (const row of rows) {
      const links = row.mentions
        .map(
          (m) =>
            `<a href="${m.page.slug}.html#${m.section.id}">${escapeHtml(m.page.nav)} — ${escapeHtml(plainText(m.section.title))}</a>`,
        )
        .join("<br>");
      parts.push(`<tr><td id="${row.id.toLowerCase()}" class="mono">${row.id}</td><td>${links}</td></tr>`);
    }
    parts.push("</tbody></table></div>");
  }
  return parts.join("\n");
}

/**
 * Split a document into its `##` sections, keeping the raw text of each.
 *
 * The requirement index needs to say *where* an id is discussed, and "in
 * API.md" is not an answer somebody can click. Sections are the unit that is.
 */
function sectionsOf(source, toc) {
  const sections = [];
  const lines = source.split("\n");
  let current = { id: "top", title: "Introduction", text: "" };
  let seen = 0;
  for (const line of lines) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading !== null) {
      sections.push(current);
      const entry = toc[seen];
      seen += 1;
      current = { id: entry?.id ?? "top", title: entry?.title ?? heading[1], text: "" };
      continue;
    }
    current.text += `${line}\n`;
  }
  sections.push(current);
  return sections;
}

function shell({ page, title, body, toc }) {
  const nav = PAGES.map(
    (entry) =>
      `<a href="${entry.slug}.html"${entry.slug === page.slug ? ' aria-current="page"' : ""}>${entry.nav}</a>`,
  ).join("");

  const rail =
    toc.length === 0
      ? ""
      : `<nav class="toc" aria-label="On this page"><p>On this page</p><ul>${toc
          .map((entry) => `<li><a href="#${entry.id}">${escapeHtml(plainText(entry.title))}</a></li>`)
          .join("")}</ul></nav>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — dither-ork</title>
<meta name="description" content="Documentation for dither-ork: architecture, API contracts, development and requirement index.">
<link rel="stylesheet" href="style.css">
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header>
  <a class="wordmark" href="index.html">dither-ork <span>docs</span></a>
  <nav aria-label="Sections">${nav}</nav>
  <div class="away"><a href="${APP_URL}">Open the app</a><a href="${REPO_URL}">Source</a></div>
</header>
<main>
${rail}
<article id="content">
${body}
</article>
</main>
<footer>
  <p>Documentation only. The application runs at <a href="${APP_URL}">${APP_URL.replace("https://", "")}</a> — it cannot run on GitHub Pages, and <a href="index.html#where-the-app-runs">the Overview says why</a>.</p>
  <p>Built from the repository on every push to <code>main</code>. AGPL-3.0-or-later.</p>
</footer>
</body>
</html>
`;
}

/**
 * Prove the renderer refuses, before trusting it with the documents.
 *
 * `markdown.mjs` claims it fails on a construct outside its subset rather than
 * mangling it. That claim is worth exactly as much as the last time somebody
 * checked it, so it is checked on every build: the cases below are the failure
 * modes a hand-written renderer actually has, and each must throw. The whole
 * thing costs under a millisecond and turns "it refuses" from a comment into a
 * property.
 *
 * The `good` cases are the other half. A refusal that fires on valid Markdown is
 * the same outage as a silent mangle, arriving through the front door.
 */
function selfCheck() {
  const bad = [
    ["a blockquote", "# T\n\n> quoted\n"],
    ["a nested list", "# T\n\n- one\n  - two\n"],
    ["a raw HTML block", "# T\n\n<div>hello</div>\n"],
    ["a setext heading", "# T\n\nTitle\n=====\n"],
    ["a tab", "# T\n\nsome\ttext\n"],
    ["a table with no separator", "# T\n\n| a | b |\n| 1 | 2 |\n"],
    ["a ragged table row", "# T\n\n| a | b |\n| --- | --- |\n| 1 |\n"],
    ["an unterminated fence", "# T\n\n```ts\nconst x = 1;\n"],
    ["an unterminated code span", "# T\n\nan `open span\n"],
    ["a document with no title", "## Section\n\ntext\n"],
  ];
  for (const [what, source] of bad) {
    let threw = false;
    try {
      renderMarkdown(source, `self-check(${what})`);
    } catch {
      threw = true;
    }
    if (!threw) {
      throw new Error(`the renderer accepted ${what}; it is documented as refusing it`);
    }
  }

  const good = [
    ["a code span keeps its angle brackets", "# T\n\n`Record<K, V>`\n", "<code>Record&lt;K, V&gt;</code>"],
    ["strong beats emphasis", "# T\n\n**bold** and *thin*\n", "<strong>bold</strong> and <em>thin</em>"],
    ["a requirement id links", "# T\n\nSee F-PP-07.\n", 'href="requirements.html#f-pp-07"'],
    ["an id inside a code span does not", "# T\n\n`F-PP-07`\n", "<code>F-PP-07</code>"],
    ["a wrapped list item joins", "# T\n\n- one\n  two\n", "<li>one two</li>"],
    ["a table becomes a table", "# T\n\n| a |\n| --- |\n| 1 |\n", "<td>1</td>"],
  ];
  for (const [what, source, expected] of good) {
    const { html } = renderMarkdown(source, `self-check(${what})`);
    if (!html.includes(expected)) {
      throw new Error(`self-check "${what}" expected ${expected} in:\n  ${html}`);
    }
  }
}

function main() {
  selfCheck();

  const outIndex = process.argv.indexOf("--out");
  const outDir =
    outIndex >= 0 && process.argv[outIndex + 1] !== undefined
      ? resolve(process.argv[outIndex + 1])
      : join(here, "dist");

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const rendered = [];
  for (const page of PAGES) {
    if (page.source === null) continue;
    const source = readFileSync(join(repoRoot, page.source), "utf8");
    const { html, title, toc } = renderMarkdown(source, page.source);
    rendered.push({ page, html, title, toc, sections: sectionsOf(source, toc) });
  }

  const byFamily = buildRequirementIndex(rendered);

  for (const entry of rendered) {
    writeFileSync(
      join(outDir, `${entry.page.slug}.html`),
      shell({ page: entry.page, title: entry.title, body: entry.html, toc: entry.toc }),
    );
  }

  const requirementsPage = PAGES.find((p) => p.slug === "requirements");
  writeFileSync(
    join(outDir, "requirements.html"),
    shell({
      page: requirementsPage,
      title: "Requirements",
      body: requirementsHtml(byFamily),
      toc: [...byFamily.entries()]
        .sort()
        .map(([family]) => ({ id: `f-${family.toLowerCase()}`, title: FAMILIES[family] })),
    }),
  );

  cpSync(join(here, "style.css"), join(outDir, "style.css"));
  // GitHub Pages runs Jekyll over the artifact unless told not to, and Jekyll
  // drops files and directories whose names begin with an underscore.
  writeFileSync(join(outDir, ".nojekyll"), "");

  const requirementCount = [...byFamily.values()].reduce((sum, rows) => sum + rows.length, 0);
  console.log(
    `${rendered.length + 1} page(s) written to ${outDir}; ` +
      `${requirementCount} requirement id(s) indexed across ${byFamily.size} families`,
  );

  // Cheap and worth it: a link into another page of this site that names an
  // anchor which does not exist renders as a link that does nothing, silently
  // and forever. Every target this site can offer is known here, so every
  // reference to one is checked here — over the written files, so the header and
  // footer are checked too and not only the prose.
  const anchors = new Set();
  for (const entry of rendered) {
    anchors.add(`${entry.page.slug}.html`);
    for (const section of entry.sections) anchors.add(`${entry.page.slug}.html#${section.id}`);
  }
  anchors.add("requirements.html");
  for (const family of byFamily.keys()) anchors.add(`requirements.html#f-${family.toLowerCase()}`);
  for (const rows of byFamily.values()) {
    for (const row of rows) anchors.add(`requirements.html#${row.id.toLowerCase()}`);
  }

  const broken = [];
  for (const page of PAGES) {
    const file = join(outDir, `${page.slug}.html`);
    const written = readFileSync(file, "utf8");
    for (const match of written.matchAll(/href="([a-z-]+\.html(?:#[^"]*)?)"/g)) {
      if (!anchors.has(match[1])) broken.push(`${page.slug}.html -> ${match[1]}`);
    }
  }
  if (broken.length > 0) {
    throw new Error(`dead in-site links:\n  ${[...new Set(broken)].join("\n  ")}`);
  }
}

try {
  main();
} catch (error) {
  console.error(String(error?.stack ?? error));
  process.exit(1);
}
