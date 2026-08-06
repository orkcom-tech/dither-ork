/**
 * Proving the golden set can fail.
 *
 * A reference set that cannot fail is worse than none, because it produces
 * confidence without protection. `core/crates/dither-core/tests/golden.rs` makes
 * the same argument and answers it by measuring: it transposes a coefficient in
 * every kernel and asserts the result moves far more of the frame than a
 * rounding difference could. It can do that inside the test process because a
 * Rust kernel is a data table it can copy and edit.
 *
 * A WGSL shader is not. It is a string compiled by the browser, reached through
 * Vite's `?raw` import, and the only honest way to prove the harness catches a
 * change to one is to change one — for real, in the file the app ships, rebuild,
 * and watch the run go red. That is what this does.
 *
 * It is committed rather than done by hand once, for the reason this repository
 * gives everywhere else: a behavioural claim that is not in a file is not a
 * claim. Anyone can re-run it and see the same failure text.
 *
 * ## Usage
 *
 * From `web/`, inside the container that has Node:
 *
 * ```bash
 * node test/gpu-golden/perturb.mjs list
 * node test/gpu-golden/perturb.mjs apply halftone-screen-transpose
 * # rebuild, run the harness — it must fail
 * node test/gpu-golden/perturb.mjs restore
 * # rebuild, run the harness — it must pass again
 * ```
 *
 * `apply` copies the untouched file into `.perturb-backup/` first and refuses to
 * run if a backup is already there. `restore` puts every backup back byte for
 * byte and deletes the directory. A crashed run therefore leaves a state a
 * single `restore` fixes, rather than a shader nobody remembers editing.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const webRoot = resolve(here, "..", "..");
const backupDir = join(here, ".perturb-backup");

/**
 * The perturbations, each one a mistake somebody could actually make.
 *
 * Not "change a number until the picture moves". Each is a specific
 * transcription error of the kind the golden set exists to catch, and the two
 * named in the brief are both here: a transposed coefficient in a halftone
 * screen, and an off-by-one in a displacement kernel.
 */
const PERTURBATIONS = [
  {
    id: "halftone-screen-transpose",
    file: "src/shaders/clustered-dot.wgsl",
    what:
      "transposes the row and column index into the clustered-dot screen table — " +
      "the screen becomes its own transpose, which is a screen, at the wrong angle",
    find: "let rank = screens[base + u32(iy) * tile + u32(ix)];",
    replace: "let rank = screens[base + u32(ix) * tile + u32(iy)];",
  },
  {
    id: "displacement-off-by-one",
    file: "src/shaders/row-displacement.wgsl",
    what:
      "shifts the source column of every displaced row by one pixel — the effect " +
      "still displaces rows, by exactly one too many",
    find: "let source_x = resolve_coord(coord.x - offset, i32(params.width), params.edge);",
    replace: "let source_x = resolve_coord(coord.x - offset + 1, i32(params.width), params.edge);",
  },
  {
    id: "dither-spread-sign",
    file: "src/shaders/bayer-8.wgsl",
    what:
      "flips the sign of the threshold the Bayer tile contributes — the dither " +
      "still dithers and still reproduces tone on average, with the pattern inverted",
    find: "    (f - 0.5) + (shaped - 0.5) * params.spread + params.threshold_offset;",
    replace: "    (f - 0.5) + (0.5 - shaped) * params.spread + params.threshold_offset;",
  },
];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
}

function list() {
  for (const p of PERTURBATIONS) {
    console.log(`${p.id}\n  ${p.file}\n  ${p.what}\n`);
  }
}

function apply(id) {
  const perturbation = PERTURBATIONS.find((p) => p.id === id);
  if (perturbation === undefined) {
    throw new Error(`no perturbation named "${id}". Run \`list\` to see them.`);
  }
  if (existsSync(backupDir) && readdirSync(backupDir).length > 0) {
    throw new Error(
      `${backupDir} already holds a backup — a previous perturbation was never restored. ` +
        `Run \`restore\` first.`,
    );
  }

  const path = join(webRoot, perturbation.file);
  const before = readFileSync(path, "utf8");
  const occurrences = before.split(perturbation.find).length - 1;
  if (occurrences !== 1) {
    // The shader has been edited since this perturbation was written. Failing
    // here is right: silently perturbing nothing would print a green run and
    // read as proof of the opposite of what it proves.
    throw new Error(
      `"${perturbation.id}" expected to find exactly one occurrence of\n  ${perturbation.find}\n` +
        `in ${perturbation.file}, found ${occurrences}. The shader changed; update the ` +
        `perturbation to a line that still exists.`,
    );
  }

  mkdirSync(backupDir, { recursive: true });
  copyFileSync(path, join(backupDir, basename(perturbation.file)));
  writeFileSync(path, before.replace(perturbation.find, perturbation.replace), "utf8");

  console.log(`applied ${perturbation.id} to ${perturbation.file}`);
  console.log(`  ${perturbation.what}`);
  console.log(`  -  ${perturbation.find}`);
  console.log(`  +  ${perturbation.replace}`);
  console.log(`  sha256 ${sha256(join(backupDir, basename(perturbation.file)))} -> ${sha256(path)}`);
  console.log(
    `\nRebuild and run the harness. It MUST fail. Then run:\n` +
      `  node test/gpu-golden/perturb.mjs restore`,
  );
}

function restore() {
  if (!existsSync(backupDir)) {
    console.log("nothing to restore");
    return;
  }
  for (const name of readdirSync(backupDir)) {
    const perturbation = PERTURBATIONS.find((p) => basename(p.file) === name);
    if (perturbation === undefined) {
      throw new Error(`backup ${name} matches no known perturbation; restore it by hand`);
    }
    const path = join(webRoot, perturbation.file);
    copyFileSync(join(backupDir, name), path);
    console.log(`restored ${perturbation.file} (sha256 ${sha256(path)})`);
  }
  rmSync(backupDir, { recursive: true, force: true });
}

const [command, argument] = process.argv.slice(2);
try {
  if (command === "list") list();
  else if (command === "apply") apply(argument);
  else if (command === "restore") restore();
  else {
    console.error("usage: perturb.mjs list | apply <id> | restore");
    process.exit(2);
  }
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exit(1);
}
