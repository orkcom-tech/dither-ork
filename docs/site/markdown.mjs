/**
 * The Markdown subset the documents actually use, and nothing else.
 *
 * A generator was not brought in for this. The three documents are 150 kB of
 * headings, paragraphs, fenced code, pipe tables and flat lists, written by one
 * hand in one style; a dependency to render them would be a second version to
 * pin, a second changelog to read, and a second thing that can break the
 * published site between two runs that changed no prose.
 *
 * The rule that makes a hand-written renderer safe rather than merely small:
 * **it refuses what it does not understand.** A construct outside the subset —
 * a blockquote, a nested list, a raw HTML block, a setext heading, a tab — stops
 * the build naming the file and the line. The alternative is the failure mode a
 * hand-written renderer is famous for: a table that silently renders as a
 * paragraph of pipes, on a page nobody re-reads after the first review.
 *
 * The subset, measured against the corpus rather than guessed:
 *
 * | Construct        | Where it is used                                |
 * | ---              | ---                                             |
 * | ATX headings     | 102 across the three documents                  |
 * | fenced code      | 84 fences, 7 languages                           |
 * | pipe tables      | 90 rows, no alignment colons                     |
 * | flat lists       | 136 unordered, 33 ordered, no nesting            |
 * | `---` rules      | 6, all in API.md                                 |
 * | inline           | code spans, `**strong**`, `*emphasis*`, autolinks |
 *
 * `_underscore emphasis_` is deliberately **not** supported. It appears nowhere
 * in the corpus, and supporting it would mangle every `snake_case` identifier
 * that is written outside a code span.
 */

export class MarkdownError extends Error {
  constructor(where, message) {
    super(`${where}: ${message}`);
    this.name = "MarkdownError";
  }
}

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

export function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (character) => HTML_ESCAPES[character]);
}

/** A heading's anchor: lowercase, words joined by hyphens, nothing else. */
export function slug(text) {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A heading as a label: no markup, just the words.
 *
 * The contents rail and the requirement index reference headings by name, and a
 * label is not prose — rendering `` `.dork` `` as a bordered code chip inside a
 * one-line link would be louder than the link, and leaving the backticks in is
 * how "3. `.dork` document" ends up on screen with its punctuation showing.
 */
export function plainText(text) {
  return text.replace(/`/g, "").replace(/\*\*?/g, "");
}

/** Requirement ids, exactly as the documents write them. */
export const REQUIREMENT_PATTERN = /\bF-[A-Z]{2}-[0-9]{2}\b/g;

/**
 * Inline markup, in the one order that composes.
 *
 * Code spans come out first and are never looked at again — a `<`, a `|` or a
 * `*` inside one is content, and every other rule here would corrupt it. What is
 * left is HTML-escaped once, then rewritten, with each finished fragment parked
 * behind a placeholder so a later rule cannot reach inside it. That is what
 * keeps a requirement id inside a link's text from being turned into a second,
 * nested link.
 */
function inline(text, where, options) {
  // NUL delimits a placeholder because prose cannot contain one, so a finished
  // fragment cannot be reached into by a later rule and cannot be forged by the
  // source. The restore at the bottom is the only thing that reads them.
  const parked = [];
  const park = (html) => {
    parked.push(html);
    return `\u0000${parked.length - 1}\u0000`;
  };

  // 1. Code spans, by their own backtick run, so ``a ` b`` works.
  let out = "";
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf("`", at);
    if (open < 0) {
      out += text.slice(at);
      break;
    }
    out += text.slice(at, open);
    let run = 0;
    while (text[open + run] === "`") run += 1;
    const fence = "`".repeat(run);
    const close = text.indexOf(fence, open + run);
    if (close < 0) {
      throw new MarkdownError(where, `unterminated code span (${fence})`);
    }
    out += park(`<code>${escapeHtml(text.slice(open + run, close))}</code>`);
    at = close + run;
  }

  out = escapeHtml(out);

  // 2. Links, then autolinks. Both park their whole result.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) =>
    park(`<a href="${href}">${label}</a>`),
  );
  out = out.replace(/&lt;([a-z][a-z0-9+.-]*:\/\/[^\s&]+)&gt;/g, (_, href) =>
    park(`<a href="${href}">${href}</a>`),
  );

  // 3. Emphasis. Strong before em, or `**x**` is read as an em wrapping `*x*`.
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");

  // 4. Requirement ids, on whatever plain text is left — never inside a code
  // span or a link, which is the whole point of parking those first.
  if (options.linkRequirements) {
    out = out.replace(REQUIREMENT_PATTERN, (id) =>
      park(`<a class="req" href="requirements.html#${id.toLowerCase()}">${id}</a>`),
    );
  }

  return out.replace(/\u0000(\d+)\u0000/g, (_, index) => parked[Number(index)]);
}

function refuse(line, where) {
  if (line.includes("\t")) {
    throw new MarkdownError(where, "a tab; this renderer measures indentation in spaces");
  }
  if (/^>/.test(line)) {
    throw new MarkdownError(where, "a blockquote, which the subset does not cover");
  }
  if (/^\s+([-*]|\d+\.)\s/.test(line)) {
    throw new MarkdownError(where, "an indented list item; the subset covers flat lists only");
  }
  if (/^<\/?[a-zA-Z][a-zA-Z0-9-]*(\s|\/?>)/.test(line)) {
    throw new MarkdownError(where, "a raw HTML block, which the subset does not cover");
  }
  if (/^(=+|-{4,})\s*$/.test(line)) {
    throw new MarkdownError(where, "a setext heading; write headings with #");
  }
}

/** Split a table row into cells, dropping the leading and trailing pipes. */
function cells(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

/**
 * Render one document.
 *
 * Returns the body HTML, the `# ` title, and the `## ` headings for a contents
 * rail. The rail is built here rather than by a second pass over the output
 * because the slugs have to be the same in both places, and computing them
 * twice is how they stop being.
 */
export function renderMarkdown(source, file, { linkRequirements = true } = {}) {
  const lines = source.split("\n");
  const html = [];
  const toc = [];
  let title = null;
  let index = 0;

  const where = () => `${file}:${index + 1}`;
  const text = (value) => inline(value, where(), { linkRequirements });

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    // Fenced code. Taken before anything else, since its contents are not
    // Markdown and must not be measured against the refusals below.
    const fence = /^```([a-zA-Z]*)\s*$/.exec(line);
    if (fence !== null) {
      const language = fence[1];
      const opened = index;
      const body = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      if (index >= lines.length) {
        throw new MarkdownError(`${file}:${opened + 1}`, "unterminated code fence");
      }
      index += 1;
      const classes = language === "" ? "" : ` class="language-${language}"`;
      html.push(`<pre><code${classes}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    refuse(line, where());

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = heading[1].length;
      const raw = heading[2].trim();
      const id = slug(raw);
      if (level === 1 && title === null) title = raw;
      else if (level === 2) toc.push({ id, title: raw });
      html.push(`<h${level} id="${id}">${text(raw)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^-{3}\s*$/.test(line)) {
      html.push("<hr>");
      index += 1;
      continue;
    }

    // Tables. A header row is only a table when the next line is the separator;
    // otherwise it is a paragraph that happens to start with a pipe, and calling
    // it a table would eat the rest of the section.
    if (line.startsWith("|")) {
      const next = lines[index + 1] ?? "";
      if (!/^\|(\s*:?-{3,}:?\s*\|)+$/.test(next.trim())) {
        throw new MarkdownError(where(), "a table row with no `| --- |` separator under it");
      }
      const header = cells(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].startsWith("|")) {
        const row = cells(lines[index]);
        if (row.length !== header.length) {
          throw new MarkdownError(
            where(),
            `${row.length} cells in a table whose header has ${header.length}`,
          );
        }
        rows.push(row);
        index += 1;
      }
      html.push(
        `<div class="scroll"><table><thead><tr>${header
          .map((cell) => `<th>${text(cell)}</th>`)
          .join("")}</tr></thead><tbody>${rows
          .map((row) => `<tr>${row.map((cell) => `<td>${text(cell)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }

    // Lists. One item runs until the next marker or a blank line; a wrapped
    // line is indented, which `refuse` above would have rejected as a nested
    // item, so it is consumed here where the context makes it unambiguous.
    const bullet = /^([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet !== null) {
      const ordered = /\d/.test(bullet[1]);
      const items = [];
      while (index < lines.length) {
        const start = /^([-*]|\d+\.)\s+(.*)$/.exec(lines[index]);
        if (start === null) break;
        if (/\d/.test(start[1]) !== ordered) {
          throw new MarkdownError(where(), "an ordered and an unordered item in one list");
        }
        const item = [start[2]];
        index += 1;
        while (index < lines.length && /^\s+\S/.test(lines[index])) {
          // An indented line inside a list item is a wrapped line — unless it
          // starts with a marker, in which case it is a nested list, and
          // appending it as prose would render "one - two" and lose the
          // structure without an error anywhere.
          if (/^\s+([-*]|\d+\.)\s/.test(lines[index])) {
            throw new MarkdownError(where(), "a nested list item; the subset covers flat lists only");
          }
          item.push(lines[index].trim());
          index += 1;
        }
        items.push(item.join(" "));
      }
      const tag = ordered ? "ol" : "ul";
      html.push(
        `<${tag}>${items.map((item) => `<li>${text(item)}</li>`).join("")}</${tag}>`,
      );
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() !== "") {
      const current = lines[index];
      if (/^(#{1,6}\s|```|\||[-*]\s|\d+\.\s|-{3}\s*$)/.test(current)) break;
      refuse(current, where());
      paragraph.push(current.trim());
      index += 1;
    }
    if (paragraph.length === 0) {
      throw new MarkdownError(where(), `nothing consumed this line: ${lines[index]}`);
    }
    html.push(`<p>${text(paragraph.join(" "))}</p>`);
  }

  if (title === null) {
    throw new MarkdownError(file, "no `# ` title; every page needs one");
  }
  return { html: html.join("\n"), title, toc };
}
